// Rolls 1s candles into a coarser interval. See CLIENT_CONTRACT.md section 4.
//
// push() is O(1) amortised: it either mutates the in-progress bucket or
// appends a finished one to `series`, and never re-scans history. Re-reducing
// the whole buffer on every push is the naive approach the harness measures
// against (20k vs 40k pushes) and is exactly what stalls an interval switch on
// a live device.

import { compare, add, roundTo } from './decimal.mjs';

export function createAggregator(intervalMs) {
  const series = [];
  let current = null;

  function bucketStart(t) {
    return Math.floor(t / intervalMs) * intervalMs;
  }

  return {
    push(candle) {
      const t = bucketStart(candle.t);

      if (current && current.t === t) {
        current.h = compare(candle.h, current.h) > 0 ? candle.h : current.h;
        current.l = compare(candle.l, current.l) < 0 ? candle.l : current.l;
        current.c = candle.c;
        current.v = roundTo(add(current.v, candle.v), 8);
        current.n += candle.n;
      } else {
        if (current) series.push(current);
        current = {
          t,
          o: candle.o,
          h: candle.h,
          l: candle.l,
          c: candle.c,
          v: roundTo(candle.v, 8),
          n: candle.n,
        };
      }

      return { ...current };
    },

    series() {
      return current ? [...series, current] : [...series];
    },
  };
}
