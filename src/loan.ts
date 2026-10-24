import { formatUnits, parseAbi, type Address } from "viem";
import { chain, PRICE_FEED_ADDRESS, TROVE_MANAGER_ADDRESS } from "./config.js";
import { publicClient } from "./client.js";
import { getMusdDecimals } from "./musd.js";

export const LIQUIDATION_LTV_PERCENT = 90;

const troveManagerAbi = parseAbi([
  "function getTroveColl(address _borrower) view returns (uint256)",
  "function getTroveDebt(address _borrower) view returns (uint256)",
  "function getTroveStatus(address _borrower) view returns (uint8)",
  "function DECIMAL_PRECISION() view returns (uint256)",
]);
const priceFeedAbi = parseAbi([
  "function fetchPrice() view returns (uint256)",
]);

export interface LoanHealth {
  collateralBtc: number;
  debtMusd: number;
  btcPriceUsd: number;
  collateralValueUsd: number;
  ltvPercent: number;
  liquidationLtvPercent: number;
  distanceToLiquidationPercent: number;
  troveActive: boolean;
  rawValues: {
    collateral: string;
    debt: string;
    btcPrice: string;
    decimalPrecision: string;
    troveStatus: number;
    musdDecimals: number;
    collateralDecimals: number;
    priceDecimals: number;
  };
}

function precisionDecimals(precision: bigint): number {
  if (precision <= 0n) throw new Error("TroveManager returned invalid DECIMAL_PRECISION");
  let remaining = precision;
  let decimals = 0;
  while (remaining % 10n === 0n) {
    remaining /= 10n;
    decimals += 1;
  }
  if (remaining !== 1n) {
    throw new Error("TroveManager DECIMAL_PRECISION is not a power of ten");
  }
  return decimals;
}

function asFiniteNumber(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is outside the supported numeric range`);
  return result;
}

export async function getLoanHealth(
  borrower: Address,
  cachedMusdDecimals?: number,
): Promise<LoanHealth> {
  const [
    collateralRaw,
    debtRaw,
    statusRaw,
    priceRaw,
    precision,
    musdDecimals,
  ] = await Promise.all([
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "getTroveColl",
      args: [borrower],
    }),
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "getTroveDebt",
      args: [borrower],
    }),
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "getTroveStatus",
      args: [borrower],
    }),
    publicClient.readContract({
      address: PRICE_FEED_ADDRESS,
      abi: priceFeedAbi,
      functionName: "fetchPrice",
    }),
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "DECIMAL_PRECISION",
    }),
    cachedMusdDecimals === undefined ? getMusdDecimals() : cachedMusdDecimals,
  ]);

  const collateralDecimals = chain.nativeCurrency.decimals;
  const priceDecimals = precisionDecimals(precision);
  const troveStatus = Number(statusRaw);
  const troveActive = troveStatus === 1 && collateralRaw > 0n;
  const collateralBtc = asFiniteNumber(
    formatUnits(collateralRaw, collateralDecimals),
    "Collateral",
  );
  const debtMusd = asFiniteNumber(formatUnits(debtRaw, musdDecimals), "Debt");
  const btcPriceUsd = asFiniteNumber(formatUnits(priceRaw, priceDecimals), "BTC price");
  const collateralValueUsd = collateralBtc * btcPriceUsd;
  const ltvPercent =
    troveActive && collateralValueUsd > 0
      ? (debtMusd / collateralValueUsd) * 100
      : 0;

  return {
    collateralBtc,
    debtMusd,
    btcPriceUsd,
    collateralValueUsd,
    ltvPercent,
    liquidationLtvPercent: LIQUIDATION_LTV_PERCENT,
    distanceToLiquidationPercent: LIQUIDATION_LTV_PERCENT - ltvPercent,
    troveActive,
    rawValues: {
      collateral: collateralRaw.toString(),
      debt: debtRaw.toString(),
      btcPrice: priceRaw.toString(),
      decimalPrecision: precision.toString(),
      troveStatus,
      musdDecimals,
      collateralDecimals,
      priceDecimals,
    },
  };
}
