import type { ProtectAction } from "./protect";

export function calculateTargetAmount(
  action: ProtectAction,
  collateralBtc: number,
  debtMusd: number,
  btcPriceUsd: number,
  targetLtv: number,
): number {
  if (
    !Number.isFinite(collateralBtc) || collateralBtc <= 0 ||
    !Number.isFinite(debtMusd) || debtMusd < 0 ||
    !Number.isFinite(btcPriceUsd) || btcPriceUsd <= 0 ||
    !Number.isFinite(targetLtv) || targetLtv <= 0 || targetLtv >= 90
  ) return 0;
  const desiredDebt = collateralBtc * btcPriceUsd * targetLtv / 100;
  const desiredCollateral = debtMusd / (btcPriceUsd * targetLtv / 100);
  return action === "add_collateral"
    ? Math.max(0, desiredCollateral - collateralBtc)
    : Math.max(0, debtMusd - desiredDebt);
}
