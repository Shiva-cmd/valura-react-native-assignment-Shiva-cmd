// Seeded PRNG, so backoff jitter can be tested reproducibly. mulberry32.
//
// The harness injects this as the `random` option to createConnection. That is
// the only reason your connection machine takes a `random` parameter: injected
// randomness is testable randomness.

export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
