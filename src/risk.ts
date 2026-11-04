export function priceAtLtv(debt: number, collateral: number, ltvPercent: number): number | null {
  if (
    !Number.isFinite(debt) || !Number.isFinite(collateral) || !Number.isFinite(ltvPercent) ||
    debt < 0 || collateral <= 0 || ltvPercent <= 0
  ) return null;
  return debt / (collateral * ltvPercent / 100);
}

export function bufferPercent(currentPrice: number, targetPrice: number): number | null {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(targetPrice) || currentPrice <= 0 || targetPrice < 0) {
    return null;
  }
  return (currentPrice - targetPrice) / currentPrice * 100;
}

export function ltvAtPrice(debt: number, collateral: number, price: number): number | null {
  if (
    !Number.isFinite(debt) || !Number.isFinite(collateral) || !Number.isFinite(price) ||
    debt < 0 || collateral <= 0 || price <= 0
  ) return null;
  return debt / (collateral * price) * 100;
}
