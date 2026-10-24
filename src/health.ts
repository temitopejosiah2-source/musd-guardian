import { logError, logInfo } from "./security.js";
import { validateEnvironment } from "./env.js";
import { getWatchAddress } from "./config.js";
import { getLoanHealth } from "./loan.js";

async function main(): Promise<void> {
  validateEnvironment();
  const health = await getLoanHealth(getWatchAddress());
  logInfo(`Trove active: ${health.troveActive}`);
  logInfo(`Collateral: ${health.collateralBtc} BTC`);
  logInfo(`Debt: ${health.debtMusd} MUSD`);
  logInfo(`BTC price: $${health.btcPriceUsd}`);
  logInfo(`Collateral value: $${health.collateralValueUsd}`);
  logInfo(`LTV: ${health.ltvPercent.toFixed(2)}%`);
  logInfo(`Liquidation LTV: ${health.liquidationLtvPercent}%`);
  logInfo(
    `Distance to liquidation: ${health.distanceToLiquidationPercent.toFixed(2)} percentage points`,
  );
  logInfo(`Raw contract values: ${JSON.stringify(health.rawValues)}`);
  logInfo(
    "Formula: LTV = debt MUSD / (collateral BTC × BTC/USD price) × 100; distance = 90% liquidation LTV − current LTV.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logError(`Health query failed: ${message}`);
  process.exitCode = 1;
});
