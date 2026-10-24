import { describe, expect, it } from "vitest";
import { createInMemoryRateLimiter } from "./rate-limit";

describe("in-memory rate limiter", () => {
  it("allows requests until the sliding window is full and reports retry time", () => {
    let now = 10_000;
    const limit = createInMemoryRateLimiter(2, 60_000, () => now);
    expect(limit("192.0.2.1").limited).toBe(false);
    expect(limit("192.0.2.1").limited).toBe(false);
    expect(limit("192.0.2.1")).toEqual({
      limited: true,
      retryAfterSeconds: 60,
    });
    now += 60_000;
    expect(limit("192.0.2.1").limited).toBe(false);
  });
});
