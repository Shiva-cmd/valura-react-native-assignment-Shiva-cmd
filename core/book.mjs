// Local L2 book. Applies snapshots and deltas, detects transport sequence
// loss. See CLIENT_CONTRACT.md section 2.
//
// The transport `seq` (the envelope counter, not lastUpdateId) is what proves
// contiguity: every envelope on the wire advances it, snapshot included, so a
// gap between any two frames - not just book frames - is loss.

import { compare, isZero } from './decimal.mjs';

function applyLevels(map, levels) {
  for (const [price, qty] of levels ?? []) {
    if (isZero(qty)) map.delete(price);
    else map.set(price, qty);
  }
}

export function createBook() {
  let bids = new Map();
  let asks = new Map();
  let expectedSeq = null;
  let lastUpdateId = 0;
  let usable = false;

  return {
    get lastUpdateId() {
      return lastUpdateId;
    },
    get usable() {
      return usable;
    },

    apply(envelope) {
      const { type, seq, data } = envelope ?? {};

      if (type === 'snapshot') {
        bids = new Map((data?.bids ?? []).map(([p, q]) => [p, q]));
        asks = new Map((data?.asks ?? []).map(([p, q]) => [p, q]));
        lastUpdateId = data?.lastUpdateId ?? lastUpdateId;
        expectedSeq = seq + 1;
        usable = true;
        return { ok: true, gap: false };
      }

      const gap = expectedSeq !== null && seq !== expectedSeq;
      expectedSeq = seq + 1;

      if (gap) {
        usable = false;
        return { ok: false, gap: true, reason: 'sequence gap' };
      }

      if (type === 'book') {
        applyLevels(bids, data?.bids);
        applyLevels(asks, data?.asks);
        lastUpdateId = data?.lastUpdateId ?? lastUpdateId;
      }

      return { ok: true, gap: false };
    },

    top(n) {
      const bidArr = [...bids.entries()].sort((a, b) => compare(b[0], a[0])).slice(0, n);
      const askArr = [...asks.entries()].sort((a, b) => compare(a[0], b[0])).slice(0, n);
      return { bids: bidArr, asks: askArr };
    },
  };
}
