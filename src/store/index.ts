import type { Store } from "./types.js";
import { FileStore } from "./file.js";
import { MemoryStore } from "./memory.js";
import { UpstashStore } from "./redis.js";

export async function createStore(): Promise<Store> {
  const configured = process.env.STORE?.trim();
  const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL?.trim());
  const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN?.trim());
  const hasRedis = hasUrl && hasToken;
  const selected = configured || (hasRedis ? "redis" : "file");
  if (!configured && hasUrl !== hasToken) {
    throw new Error("Both Upstash Redis REST variables must be configured together");
  }
  if (selected === "memory") return new MemoryStore();
  if (selected === "file") return FileStore.open();
  if (selected === "redis") {
    if (!hasRedis) throw new Error("STORE=redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    const store = new UpstashStore();
    await store.initialize();
    return store;
  }
  throw new Error("STORE must be redis, file, or memory");
}

export type {
  Store,
  StoreLimits,
  ChatSettings,
  HealthLevel,
  PriceSample,
  StoredLevel,
  Subscription,
} from "./types.js";
