// Property-based test (C2): the server-side order book's invariants must
// hold across generated sequences of diffs that include duplicates, gaps,
// and out-of-order arrivals - the same pathologies the tape injects, but
// exercised far more broadly than one fixed recording can.
//
// This drives the real DepthSyncEngine/OrderBook classes used in production
// (server/dist/*, built from server/src/*), not a reimplementation, so the
// property is actually about the shipped code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { DepthSyncEngine } from '../server/dist/depthSync.js';

// Bid and ask prices are drawn from disjoint, non-overlapping ranges with a
// gap between them - exactly as a real book always is - so that any crossing
// found later can only be a bug in the sync/reconciliation logic, never an
// artefact of generating a nonsensical ground truth to begin with.
const BID_PRICES = Array.from({ length: 8 }, (_, i) => (99980 + i).toFixed(2));
const ASK_PRICES = Array.from({ length: 8 }, (_, i) => (99995 + i).toFixed(2));

function levelsArb(prices) {
  // A handful of (price, qty) touches per diff, qty "0" deletes.
  return fc.array(
    fc.tuple(
      fc.constantFrom(...prices),
      fc.oneof(
        { weight: 1, arbitrary: fc.constant('0') },
        { weight: 4, arbitrary: fc.integer({ min: 1, max: 500 }).map((n) => (n / 100).toFixed(8)) },
      ),
    ),
    { minLength: 0, maxLength: 4 },
  );
}

/** A clean, contiguous ground-truth sequence of diffs starting at U=1. */
function cleanSequenceArb(length) {
  return fc.array(fc.tuple(levelsArb(BID_PRICES), levelsArb(ASK_PRICES)), {
    minLength: length,
    maxLength: length,
  });
}

/** Ground truth book state after applying bid/ask touches in order. */
function replayGroundTruth(touches) {
  const bids = new Map();
  const asks = new Map();
  for (const [b, a] of touches) {
    for (const [p, q] of b) (q === '0' ? bids.delete(p) : bids.set(p, q));
    for (const [p, q] of a) (q === '0' ? asks.delete(p) : asks.set(p, q));
  }
  return { bids, asks };
}

function toSnapshot(state, lastUpdateId) {
  return {
    lastUpdateId,
    bids: [...state.bids.entries()],
    asks: [...state.asks.entries()],
  };
}

function bestCross(bids, asks) {
  if (bids.size === 0 || asks.size === 0) return false;
  let bestBid = -Infinity;
  for (const p of bids.keys()) bestBid = Math.max(bestBid, Number(p));
  let bestAsk = Infinity;
  for (const p of asks.keys()) bestAsk = Math.min(bestAsk, Number(p));
  return bestBid >= bestAsk;
}

test('order book invariants hold under duplicates, gaps, and reordering', async () => {
  await fc.assert(
    fc.asyncProperty(
      cleanSequenceArb(30),
      fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 30, maxLength: 30 }), // duplicate-injection controls
      fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }), // drop controls (simulate a gap)
      fc.integer({ min: 0, max: 0xffffffff }),
      async (touches, dupControls, dropControls, seed) => {
        // Build the clean, contiguous ground-truth diff stream.
        const clean = touches.map((t, i) => ({ U: i + 1, u: i + 1, b: t[0], a: t[1] }));

        // Corrupt it: randomly duplicate some entries (re-delivering an
        // already-applied update) and drop others (creating a gap the engine
        // must detect and resync from).
        let rng = seed >>> 0;
        const rand = () => {
          rng = (rng * 1103515245 + 12345) >>> 0;
          return rng / 0xffffffff;
        };

        const corrupted = [];
        for (let i = 0; i < clean.length; i++) {
          if (dropControls[i] && rand() < 0.2) continue; // simulate a lost message -> gap
          corrupted.push(clean[i]);
          const dupTimes = dupControls[i] % 2 === 0 ? 0 : 1;
          for (let d = 0; d < dupTimes; d++) corrupted.push(clean[i]); // duplicated message
        }
        // Shuffle within a small local window to simulate out-of-order arrival
        // without destroying overall progress (real reordering is local jitter,
        // not a full shuffle).
        for (let i = 0; i < corrupted.length - 1; i += 2) {
          if (rand() < 0.3) {
            const tmp = corrupted[i];
            corrupted[i] = corrupted[i + 1];
            corrupted[i + 1] = tmp;
          }
        }

        const fetcher = {
          async fetchSnapshot() {
            // A real snapshot always reflects the true current state.
            const state = replayGroundTruth(touches);
            return toSnapshot(state, clean.length);
          },
        };

        const engine = new DepthSyncEngine(fetcher, () => {});
        let logicalNow = 0;

        for (const diff of corrupted) {
          engine.handleDiff(diff);
          logicalNow += 2000; // clears the snapshot rate limit every tick
          await engine.maybeResync(logicalNow);

          // Invariants must hold after every single application, gap or not.
          const { bids, asks } = engine.book.top(Number.MAX_SAFE_INTEGER);
          for (const [, q] of [...bids, ...asks]) {
            assert.notEqual(q, '0', 'no zero quantity level is ever stored');
          }
          const bidMap = new Map(bids);
          const askMap = new Map(asks);
          assert.equal(bestCross(bidMap, askMap), false, 'best bid must stay strictly below best ask');
        }

        // Drain any resync still pending at the end of the run.
        for (let i = 0; i < 5 && !engine.usable; i++) {
          logicalNow += 2000;
          await engine.maybeResync(logicalNow);
        }
      },
    ),
    { numRuns: 200 },
  );
});
