import { isAddress } from "viem";

export type HealthLevel = "SAFE" | "WARNING" | "DANGER" | "NO_LOAN";

export interface HealthMetrics {
  collateralBtc: number;
  debtMusd: number;
  btcPriceUsd: number;
  troveActive: boolean;
}

export function validateAddress(value: string): `0x${string}` | null {
  const trimmed = value.trim();
  return isAddress(trimmed) ? (trimmed as `0x${string}`) : null;
}

export function calculateLtv(
  debtMusd: number,
  collateralBtc: number,
  btcPriceUsd: number,
): number {
  if (
    !Number.isFinite(debtMusd) ||
    !Number.isFinite(collateralBtc) ||
    !Number.isFinite(btcPriceUsd) ||
    debtMusd < 0 ||
    collateralBtc <= 0 ||
    btcPriceUsd <= 0
  ) {
    return 0;
  }
  return (debtMusd / (collateralBtc * btcPriceUsd)) * 100;
}

export function liquidationPrice(
  debtMusd: number,
  collateralBtc: number,
  liquidationLtvPercent = 90,
): number | null {
  if (
    !Number.isFinite(debtMusd) ||
    !Number.isFinite(collateralBtc) ||
    !Number.isFinite(liquidationLtvPercent) ||
    debtMusd <= 0 ||
    collateralBtc <= 0 ||
    liquidationLtvPercent <= 0 ||
    liquidationLtvPercent > 100
  ) {
    return null;
  }
  return debtMusd / (collateralBtc * (liquidationLtvPercent / 100));
}

export function classifyLevel(
  health: HealthMetrics,
  warnLtv: number,
  dangerLtv: number,
): HealthLevel {
  if (!health.troveActive) return "NO_LOAN";
  const ltv = calculateLtv(health.debtMusd, health.collateralBtc, health.btcPriceUsd);
  if (ltv >= dangerLtv) return "DANGER";
  if (ltv >= warnLtv) return "WARNING";
  return "SAFE";
}

export function formatNumber(
  value: number,
  maximumFractionDigits = 2,
  locale = "en-US",
): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
