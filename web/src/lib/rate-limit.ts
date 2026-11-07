import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_TRACKED_IPS = 10_000;
const UPSTASH_TIMEOUT_MS = 1_500;
const WARNING_INTERVAL_MS = 60_000;
const FALLBACK_WARNING = "Upstash API rate limiter unavailable; using in-memory limiting for this request.";

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

export function createInMemoryRateLimiter(
  maxRequests: number,
  windowMs: number,
  now: () => number = Date.now,
): (key: string) => RateLimitResult {
  const entries = new Map<string, number[]>();
  return (key) => {
    const timestamp = now();
    const recent = (entries.get(key) ?? []).filter(
      (entry) => timestamp - entry < windowMs,
    );
    if (recent.length >= maxRequests) {
      entries.set(key, recent);
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((recent[0]! + windowMs - timestamp) / 1000),
        ),
      };
    }
    recent.push(timestamp);
    entries.set(key, recent);
    if (entries.size > MAX_TRACKED_IPS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return { limited: false, retryAfterSeconds: 0 };
  };
}

const inMemoryLimit = createInMemoryRateLimiter(MAX_REQUESTS, WINDOW_MS);
let redisLimiter: Ratelimit | undefined;

function getRedisLimiter(): Ratelimit | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url && !token) return null;
  if (!url || !token) throw new Error("Rate-limit configuration is incomplete");
  if (!redisLimiter) {
    redisLimiter = new Ratelimit({
      redis: Redis.fromEnv({
        signal: () => AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
      }),
      limiter: Ratelimit.slidingWindow(MAX_REQUESTS, "1 m"),
      prefix: "musd-guardian:api",
    });
  }
  return redisLimiter;
}

interface RateLimitBackend {
  limit(key: string): Promise<{ success: boolean; reset: number }>;
}

export function createRateLimitChecker(
  getBackend: () => RateLimitBackend | null,
  fallback: (key: string) => RateLimitResult = inMemoryLimit,
  now: () => number = Date.now,
  warn: (message: string) => void = (message) => console.warn(message),
): (key: string) => Promise<RateLimitResult> {
  let lastWarningAt: number | undefined;

  function warnOncePerMinute(): void {
    const timestamp = now();
    if (lastWarningAt === undefined || timestamp - lastWarningAt >= WARNING_INTERVAL_MS) {
      lastWarningAt = timestamp;
      warn(FALLBACK_WARNING);
    }
  }

  return async (key) => {
    let backend: RateLimitBackend | null;
    try {
      backend = getBackend();
    } catch {
      warnOncePerMinute();
      return fallback(key);
    }
    if (!backend) return fallback(key);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        backend.limit(key),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Rate-limit backend timed out")), UPSTASH_TIMEOUT_MS);
        }),
      ]);
      return {
        limited: !result.success,
        retryAfterSeconds: result.success
          ? 0
          : Math.max(1, Math.ceil((result.reset - now()) / 1000)),
      };
    } catch {
      warnOncePerMinute();
      return fallback(key);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export const checkRateLimit = createRateLimitChecker(getRedisLimiter);
