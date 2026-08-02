// Deliberately incomplete client core.
//
// It exists so `npm run verify:client` runs from a clean clone and fails with
// specific, readable errors rather than a stack trace. That proves your setup
// works before you have written anything.
//
// Every function here has the right shape and the wrong behaviour. Delete this
// directory, write your own, and point `clientCore` in package.json at it.
//
// See CLIENT_CONTRACT.md.

export function createConnection({ staleAfterMs = 2000, maxBackoffMs = 30000 } = {}) {
  let state = 'connecting';
  return {
    get state() {
      return state;
    },
    send(event) {
      // Real one tracks the last frame time, notices silence, and remembers the
      // session so it can resume instead of restarting cold.
      if (event.type === 'frame') state = 'live';
      if (event.type === 'close' || event.type === 'error') state = 'reconnecting';
      return state;
    },
    nextBackoffMs() {
      return 1000; // fixed, unjittered, and therefore a thundering herd
    },
    resumeToken() {
      return null;
    },
  };
}

export function createBook() {
  const bids = [];
  const asks = [];
  return {
    lastUpdateId: 0,
    usable: false,
    apply() {
      // Real one validates seq continuity and refuses to stay usable after a gap.
      return { ok: true, gap: false };
    },
    top(n) {
      return { bids: bids.slice(0, n), asks: asks.slice(0, n) };
    },
  };
}

export function estimateFill() {
  // Real one walks the book, computes an exact VWAP, and says so when the
  // order is bigger than the depth available.
  return { avgPrice: '0', slippageBps: 0, filledQuantity: '0', insufficientDepth: true };
}

export function createAggregator() {
  return {
    push() {
      return null;
    },
    series() {
      return [];
    },
  };
}
