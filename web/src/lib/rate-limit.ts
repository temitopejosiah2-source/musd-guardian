import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_TRACKED_IPS = 10_000;

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
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(MAX_REQUESTS, "1 m"),
      prefix: "musd-guardian:api",
    });
  }
  return redisLimiter;
}

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const limiter = getRedisLimiter();
  if (!limiter) return inMemoryLimit(ip);
  const result = await limiter.limit(ip);
  return {
    limited: !result.success,
    retryAfterSeconds: result.success
      ? 0
      : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
  };
}
