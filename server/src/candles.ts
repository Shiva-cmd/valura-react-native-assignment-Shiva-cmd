// 1-second OHLCV aggregation, bucketed by trade time (A3). The bucket clock
// is advanced by every upstream event's timestamp, not a wall-clock timer, so
// a second with literally no trades still closes and emits a flat candle at
// the previous close - the series is monotonic and gapless by construction,
// never by patching holes after the fact.

import { compare, add, roundTo } from './decimal.js';
import type { Candle } from './types.js';

interface Accumulator {
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

export class CandleEngine {
  private openSecond: number | null = null;
  private lastClose: string | null = null;
  private acc: Accumulator | null = null;
  private readonly ring: Candle[] = [];
  private readonly ringCap = 300;

  lateTrades = 0;

  constructor(private readonly onClose: (candle: Candle) => void) {}

  /** Seed the first close before any trade has happened, e.g. from a book mid. */
  bootstrap(price: string): void {
    this.lastClose ??= price;
  }

  /** Advance the logical clock to `nowMs`, closing every fully elapsed second. */
  advance(nowMs: number): void {
    if (this.openSecond === null) {
      this.openSecond = Math.floor(nowMs / 1000) * 1000;
      return;
    }
    while (nowMs >= this.openSecond + 1000) {
      this.closeBucket();
      this.openSecond += 1000;
      this.acc = null;
    }
  }

  onTrade(trade: { p: string; q: string; T: number }): void {
    this.advance(trade.T);
    const bucket = Math.floor(trade.T / 1000) * 1000;

    if (this.openSecond === null || bucket < this.openSecond) {
      this.lateTrades++;
      return;
    }

    if (!this.acc) {
      this.acc = { o: trade.p, h: trade.p, l: trade.p, c: trade.p, v: trade.q, n: 1 };
      return;
    }

    this.acc.h = compare(trade.p, this.acc.h) > 0 ? trade.p : this.acc.h;
    this.acc.l = compare(trade.p, this.acc.l) < 0 ? trade.p : this.acc.l;
    this.acc.c = trade.p;
    this.acc.v = add(this.acc.v, trade.q);
    this.acc.n += 1;
  }

  /** Trailing candles for a fresh snapshot, oldest first. */
  history(): Candle[] {
    return [...this.ring];
  }

  private closeBucket(): void {
    const t = this.openSecond as number;
    const base = this.lastClose ?? '0';
    const candle: Candle = this.acc
      ? { t, o: this.acc.o, h: this.acc.h, l: this.acc.l, c: this.acc.c, v: roundTo(this.acc.v, 8), n: this.acc.n }
      : { t, o: base, h: base, l: base, c: base, v: '0', n: 0 };

    this.lastClose = candle.c;
    this.ring.push(candle);
    if (this.ring.length > this.ringCap) this.ring.shift();
    this.onClose(candle);
  }
}
