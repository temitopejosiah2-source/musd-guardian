import { describe, expect, it } from "vitest";
import { bufferPercent, ltvAtPrice, priceAtLtv } from "./risk.js";

describe("risk price functions", () => {
  it("calculates threshold prices, buffers, and LTV at a price", () => {
    expect(priceAtLtv(850, 1, 85)).toBe(1000);
    expect(bufferPercent(1000, 900)).toBeCloseTo(10);
    expect(ltvAtPrice(850, 1, 950)).toBeCloseTo(89.4737, 3);
  });

  it("handles zero debt and invalid or zero inputs without throwing", () => {
    expect(priceAtLtv(0, 1, 90)).toBe(0);
    expect(ltvAtPrice(0, 1, 100)).toBe(0);
    expect(priceAtLtv(1, 0, 90)).toBeNull();
    expect(ltvAtPrice(1, 1, 0)).toBeNull();
    expect(bufferPercent(0, 1)).toBeNull();
    expect(priceAtLtv(Number.NaN, 1, 90)).toBeNull();
    expect(bufferPercent(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns a negative buffer when the target is already breached", () => {
    expect(bufferPercent(100, 120)).toBe(-20);
  });
});
