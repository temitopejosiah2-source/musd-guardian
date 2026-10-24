import { AsyncLocalStorage } from "node:async_hooks";

const requestSignal = new AsyncLocalStorage<AbortSignal>();

export function getRequestSignal(): AbortSignal | undefined {
  return requestSignal.getStore();
}

export async function withRequestBudget<T>(
  durationMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  try {
    return await requestSignal.run(controller.signal, operation);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
