import { describe, expect, it } from "vitest";
import {
  calculateLtv,
  classifyLevel,
  formatAddress,
  formatNumber,
  liquidationPrice,
  validateAddress,
} from "./format";

describe("dashboard pure functions", () => {
  it("computes loan-to-value from debt and collateral value", () => {
    expect(calculateLtv(2000, 0.045, 83_500)).toBeCloseTo(53.23, 2);
  });

  it("returns zero LTV for invalid or absent collateral inputs", () => {
    expect(calculateLtv(2000, 0, 83_500)).toBe(0);
    expect(calculateLtv(Number.NaN, 1, 83_500)).toBe(0);
  });

  it("computes the price that reaches the liquidation LTV", () => {
    expect(liquidationPrice(2000, 0.045)).toBeCloseTo(49_382.72, 2);
  });

  it("rejects a liquidation price for invalid values", () => {
    expect(liquidationPrice(0, 0.045)).toBeNull();
    expect(liquidationPrice(100, 0.045, 0)).toBeNull();
  });

  it("classifies the configured warning and danger thresholds", () => {
    expect(classifyLevel(
      { collateralBtc: 1, debtMusd: 700, btcPriceUsd: 1_000, troveActive: true },
      70,
      80,
    )).toBe("WARNING");
    expect(classifyLevel(
      { collateralBtc: 1, debtMusd: 800, btcPriceUsd: 1_000, troveActive: true },
      70,
      80,
    )).toBe("DANGER");
  });

  it("classifies safe and inactive loans", () => {
    expect(classifyLevel(
      { collateralBtc: 1, debtMusd: 100, btcPriceUsd: 1_000, troveActive: true },
      70,
      80,
    )).toBe("SAFE");
    expect(classifyLevel(
      { collateralBtc: 0, debtMusd: 0, btcPriceUsd: 1_000, troveActive: false },
      70,
      80,
    )).toBe("NO_LOAN");
  });

  it("validates EVM addresses without accepting malformed strings", () => {
    expect(validateAddress("0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765")).not.toBeNull();
    expect(validateAddress("not-an-address")).toBeNull();
    expect(validateAddress("")).toBeNull();
  });

  it("formats values with bounded precision and grouping", () => {
    expect(formatNumber(2001.8415, 2)).toBe("2,001.84");
    expect(formatNumber(Number.NaN)).toBe("—");
  });

  it("shortens addresses for activity labels", () => {
    expect(formatAddress("0x1234567890abcdef")).toBe("0x1234…cdef");
  });
});
