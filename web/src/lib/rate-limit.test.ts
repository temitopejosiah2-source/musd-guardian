import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryRateLimiter,
  createRateLimitChecker,
  type RateLimitResult,
} from "./rate-limit";

const allowFallback = (): RateLimitResult => ({ limited: false, retryAfterSeconds: 0 });

afterEach(() => {
  vi.useRealTimers();
});

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

  it("falls back when the Upstash backend throws and redacts the warning", async () => {
    const fallback = vi.fn(allowFallback);
    const warn = vi.fn();
    const check = createRateLimitChecker(
      () => ({ limit: async () => { throw new Error("WRONGPASS private-token"); } }),
      fallback,
      () => 100_000,
      warn,
    );

    await expect(check("192.0.2.1")).resolves.toEqual(allowFallback());
    await expect(check("192.0.2.1")).resolves.toEqual(allowFallback());
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining("private-token"));
  });

  it("falls back after the 1500 ms backend timeout", async () => {
    vi.useFakeTimers();
    const fallback = vi.fn(allowFallback);
    const warn = vi.fn();
    const check = createRateLimitChecker(
      () => ({ limit: () => new Promise(() => {}) }),
      fallback,
      () => Date.now(),
      warn,
    );
    const result = check("192.0.2.1");

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(result).resolves.toEqual(allowFallback());
    expect(fallback).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls back on the Upstash WRONGPASS authentication error", async () => {
    const fallback = vi.fn(allowFallback);
    const warn = vi.fn();
    const check = createRateLimitChecker(
      () => ({ limit: async () => { throw new Error("WRONGPASS invalid username-password pair"); } }),
      fallback,
      () => 100_000,
      warn,
    );

    await expect(check("192.0.2.1")).resolves.toEqual(allowFallback());
    expect(fallback).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).not.toContain("WRONGPASS");
  });

  it("preserves actual backend limit hits and retry times", async () => {
    const check = createRateLimitChecker(
      () => ({ limit: async () => ({ success: false, reset: 103_000 }) }),
      vi.fn(allowFallback),
      () => 100_000,
      vi.fn(),
    );

    await expect(check("192.0.2.1")).resolves.toEqual({
      limited: true,
      retryAfterSeconds: 3,
    });
  });
});
