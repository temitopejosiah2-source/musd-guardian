import { beforeEach, vi } from "vitest";

const failUnexpectedFetch: typeof fetch = async () => {
  throw new Error("Unexpected network request in test; mock fetch explicitly.");
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("UPSTASH_") || key.startsWith("TELEGRAM_")) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  delete process.env.RPC_URL;
  process.env.STORE = "memory";
  vi.stubGlobal("fetch", failUnexpectedFetch);
});
