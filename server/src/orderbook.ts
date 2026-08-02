// Local L2 order book. Pure data structure: given a snapshot and a
// contiguous run of diffs, maintains bids/asks and asserts the invariants
// that make it a real book rather than a re-fetched REST snapshot with a
// diff-shaped name (see "What we will not accept" in ASSIGNMENT.md).

import { compare, isZero } from './decimal.js';
import type { PriceLevel, SnapshotData, DepthUpdate } from './types.js';

export class BookInvariantError extends Error {}

export class OrderBook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private currentLastUpdateId = 0;

  get lastUpdateId(): number {
    return this.currentLastUpdateId;
  }

  applySnapshot(data: SnapshotData): void {
    const bids = new Map<string, string>();
    for (const [p, q] of data.bids) if (!isZero(q)) bids.set(p, q);
    const asks = new Map<string, string>();
    for (const [p, q] of data.asks) if (!isZero(q)) asks.set(p, q);

    this.bids = bids;
    this.asks = asks;
    this.currentLastUpdateId = data.lastUpdateId;
    this.assertInvariants();
  }

  applyDiff(update: DepthUpdate): void {
    applyLevels(this.bids, update.b);
    applyLevels(this.asks, update.a);
    this.currentLastUpdateId = update.u;
    this.assertInvariants();
  }

  top(n: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    const bidArr = [...this.bids.entries()].sort((a, b) => compare(b[0], a[0])).slice(0, n) as PriceLevel[];
    const askArr = [...this.asks.entries()].sort((a, b) => compare(a[0], b[0])).slice(0, n) as PriceLevel[];
    return { bids: bidArr, asks: askArr };
  }

  private assertInvariants(): void {
    for (const [price, qty] of this.bids) {
      if (isZero(qty)) throw new BookInvariantError(`zero quantity level stored on bid side at ${price}`);
    }
    for (const [price, qty] of this.asks) {
      if (isZero(qty)) throw new BookInvariantError(`zero quantity level stored on ask side at ${price}`);
    }
    const { bids, asks } = this.top(1);
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid && bestAsk && compare(bestBid[0], bestAsk[0]) >= 0) {
      throw new BookInvariantError(`crossed book: best bid ${bestBid[0]} >= best ask ${bestAsk[0]}`);
    }
  }
}

function applyLevels(map: Map<string, string>, levels: PriceLevel[]): void {
  for (const [price, qty] of levels) {
    if (isZero(qty)) map.delete(price);
    else map.set(price, qty);
  }
}
