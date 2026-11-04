export type ServiceName = "telegram" | "rpc" | "redis";

export interface ServiceState {
  lastSuccessAt: string | null;
  outage: boolean;
}

export class ExponentialBackoff {
  private failures = 0;

  constructor(
    private readonly initialMs = 1_000,
    private readonly maximumMs = 60_000,
    private readonly jitter = 0.2,
  ) {}

  nextDelay(random = Math.random): number {
    const base = Math.min(this.maximumMs, this.initialMs * 2 ** this.failures);
    this.failures += 1;
    return Math.round(base * (1 - this.jitter + random() * this.jitter * 2));
  }

  reset(): void {
    this.failures = 0;
  }
}

export class ServiceStatusTracker {
  private readonly state = new Map<ServiceName, { lastSuccessAt: number | null; outageStartedAt: number | null }>([
    ["telegram", { lastSuccessAt: null, outageStartedAt: null }],
    ["rpc", { lastSuccessAt: null, outageStartedAt: null }],
    ["redis", { lastSuccessAt: null, outageStartedAt: null }],
  ]);

  constructor(
    private readonly logOutageStart: (message: string) => void,
    private readonly logOutageEnd: (message: string) => void,
  ) {}

  failed(service: ServiceName, now = Date.now()): void {
    const state = this.stateFor(service);
    if (state.outageStartedAt !== null) return;
    state.outageStartedAt = now;
    this.logOutageStart(`network trouble: ${service} (outage started)`);
  }

  succeeded(service: ServiceName, now = Date.now()): void {
    const state = this.stateFor(service);
    state.lastSuccessAt = now;
    if (state.outageStartedAt === null) return;
    const durationMs = Math.max(0, now - state.outageStartedAt);
    state.outageStartedAt = null;
    this.logOutageEnd(`network trouble ended: ${service} after ${formatDuration(durationMs)} (outage ended)`);
  }

  snapshot(): Record<ServiceName, ServiceState> {
    return {
      telegram: this.snapshotService("telegram"),
      rpc: this.snapshotService("rpc"),
      redis: this.snapshotService("redis"),
    };
  }

  private snapshotService(service: ServiceName): ServiceState {
    const state = this.stateFor(service);
    return {
      lastSuccessAt: state.lastSuccessAt === null ? null : new Date(state.lastSuccessAt).toISOString(),
      outage: state.outageStartedAt !== null,
    };
  }

  private stateFor(service: ServiceName) {
    const state = this.state.get(service);
    if (!state) throw new Error("Unknown service status");
    return state;
  }
}

export type LockRenewalResult = "renewed" | "lost" | "unavailable";

export function stopIfLockLost(
  result: LockRenewalResult,
  stop: () => void,
  setExitCode: (code: number) => void,
): boolean {
  if (result !== "lost") return false;
  setExitCode(1);
  stop();
  return true;
}

export async function retryLockRenewal(
  renew: () => Promise<LockRenewalResult>,
  options: {
    lastSuccessAt: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
    ttlMs?: number;
    safetyMarginMs?: number;
    attempts?: number;
  },
): Promise<"renewed" | "lost" | "retry"> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const ttlMs = options.ttlMs ?? 60_000;
  const safetyMarginMs = options.safetyMarginMs ?? 10_000;
  const attempts = options.attempts ?? 3;
  const expiryAgeMs = ttlMs - safetyMarginMs;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = expiryAgeMs - (now() - options.lastSuccessAt);
    if (remainingMs <= 0) return "lost";
    try {
      const result = await withTimeout(renew(), Math.min(timeoutMs, remainingMs));
      if (result === "renewed") return "renewed";
      if (result === "lost") return "lost";
    } catch {
      // Renewal failures are retried while the last successful lease is still safe.
    }

    if (now() - options.lastSuccessAt >= expiryAgeMs) return "lost";
    if (attempt + 1 < attempts) {
      const remainingAfterFailure = expiryAgeMs - (now() - options.lastSuccessAt);
      if (remainingAfterFailure <= 0) return "lost";
      await wait(Math.min(250 * 2 ** attempt, remainingAfterFailure));
    }
  }

  return now() - options.lastSuccessAt >= expiryAgeMs ? "lost" : "retry";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Lock renewal timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
