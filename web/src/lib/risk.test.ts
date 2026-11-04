import { describe, expect, it } from "vitest";
import { bufferPercent, ltvAtPrice, priceAtLtv } from "./risk";

describe("risk price functions", () => {
  it("computes target prices, buffers, and LTV at a price", () => {
    expect(priceAtLtv(850, 1, 85)).toBeCloseTo(1_000);
    expect(bufferPercent(1_000, 900)).toBeCloseTo(10);
    expect(ltvAtPrice(850, 1, 950)).toBeCloseTo(89.4737, 3);
  });

  it("returns null for zero collateral and invalid numeric inputs", () => {
    expect(priceAtLtv(1, 0, 90)).toBeNull();
    expect(ltvAtPrice(1, 0, 100)).toBeNull();
    expect(bufferPercent(0, 10)).toBeNull();
    expect(priceAtLtv(Number.NaN, 1, 90)).toBeNull();
    expect(ltvAtPrice(1, 1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(bufferPercent(100, Number.NaN)).toBeNull();
  });

  it("handles zero debt and negative buffers without throwing", () => {
    expect(priceAtLtv(0, 1, 90)).toBe(0);
    expect(ltvAtPrice(0, 1, 100)).toBe(0);
    expect(bufferPercent(100, 120)).toBe(-20);
  });
});
