// VWAP fill estimation across the local book. See CLIENT_CONTRACT.md section 3.
//
// Computed entirely in exact decimal arithmetic (see decimal.mjs). The
// fixtures include prices/quantities chosen so that routing this through
// Number silently produces a different eighth decimal place.

import { compare, add, sub, mul, divRound, roundTo, isNegative } from './decimal.mjs';

const EMPTY_SIDE = { avgPrice: '0', slippageBps: 0, filledQuantity: '0', insufficientDepth: true };

export function estimateFill(book, side, quantity) {
  const { bids, asks } = book.top(Number.MAX_SAFE_INTEGER);
  const levels = side === 'buy' ? asks : bids;

  if (levels.length === 0) {
    return { ...EMPTY_SIDE };
  }

  let remaining = quantity;
  let notional = '0';
  let filled = '0';

  for (const [price, qty] of levels) {
    if (compare(remaining, '0') <= 0) break;
    const take = compare(qty, remaining) <= 0 ? qty : remaining;
    notional = add(notional, mul(price, take));
    filled = add(filled, take);
    remaining = sub(remaining, take);
  }

  const insufficientDepth = compare(remaining, '0') > 0;
  const bestTouch = levels[0][0];
  const avgPrice = compare(filled, '0') > 0 ? divRound(notional, filled, 8) : '0';

  const rawSlip =
    side === 'buy'
      ? divRound(mul('10000', sub(avgPrice, bestTouch)), bestTouch, 8)
      : divRound(mul('10000', sub(bestTouch, avgPrice)), bestTouch, 8);

  let slipRounded = roundTo(rawSlip, 0);
  if (isNegative(slipRounded)) slipRounded = '0';

  return {
    avgPrice,
    slippageBps: Number(slipRounded),
    filledQuantity: roundTo(filled, 8),
    insufficientDepth,
  };
}
