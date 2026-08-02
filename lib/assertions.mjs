// Protocol assertions.
//
// Everything here is checked against the frames your server actually sent. Most
// of it is self-checking: the verifier does not need to know the right answer to
// tell that a sequence has a hole in it or that a price arrived as a number.
//
// The one place it does compare against a stored answer is the candle series,
// and that is stored as a hash. There is no correct order book in this file for
// you to read, which is deliberate. Building it is the assignment.

import { createHash } from 'node:crypto';

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const isDecStr = (v) => typeof v === 'string' && DECIMAL_RE.test(v);

export class Report {
  constructor() {
    this.checks = [];
  }

  pass(name, detail = '') {
    this.checks.push({ name, ok: true, detail });
  }

  fail(name, detail) {
    this.checks.push({ name, ok: false, detail });
  }

  assert(ok, name, detail) {
    if (ok) this.pass(name);
    else this.fail(name, detail);
    return ok;
  }

  get failures() {
    return this.checks.filter((c) => !c.ok);
  }

  get ok() {
    return this.failures.length === 0;
  }
}

/** Session ids may be random. Everything else must be reproducible. */
export function canonical(frames) {
  return JSON.stringify(
    frames.map((f) => {
      if (f?.data && typeof f.data === 'object' && 'sessionId' in f.data) {
        return { ...f, data: { ...f.data, sessionId: '<session>' } };
      }
      return f;
    }),
  );
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical form of the candle series inside a fixed window. */
export function candleSeries(frames, [from, to]) {
  const seen = new Map();
  for (const f of frames) {
    if (f.type !== 'candle') continue;
    const c = f.data;
    if (c.t < from || c.t > to) continue;
    seen.set(c.t, [c.t, c.o, c.h, c.l, c.c, c.v, c.n]);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

// ---------------------------------------------------------------------------

export function checkProtocol(frames, report) {
  // 1. envelope and sequence
  let seqOk = true;
  for (const [i, f] of frames.entries()) {
    if (f.__unparseable) {
      report.fail('frames are valid JSON', `frame ${i}: ${f.__unparseable}`);
      return;
    }
    if (f.v !== 1) {
      report.fail('envelope v is 1', `frame ${i} has v=${JSON.stringify(f.v)}`);
      return;
    }
    if (typeof f.ts !== 'number' || !Number.isInteger(f.ts)) {
      report.fail('envelope ts is an integer', `frame ${i} ts=${JSON.stringify(f.ts)}`);
      return;
    }
    if (f.seq !== i + 1) {
      report.fail(
        'seq starts at 1 and increments by exactly 1',
        `frame ${i} has seq=${f.seq}, expected ${i + 1}`,
      );
      seqOk = false;
      break;
    }
  }
  if (seqOk) report.pass('seq starts at 1 and increments by exactly 1', `${frames.length} frames`);

  // 2. hello first, snapshot before any market data
  report.assert(
    frames[0]?.type === 'hello',
    'first frame is hello',
    `got ${frames[0]?.type}`,
  );
  const firstMarket = frames.findIndex((f) =>
    ['book', 'trade', 'candle'].includes(f.type),
  );
  const firstSnap = frames.findIndex((f) => f.type === 'snapshot');
  report.assert(
    firstSnap !== -1 && (firstMarket === -1 || firstSnap < firstMarket),
    'a snapshot precedes any book, trade or candle frame',
    firstSnap === -1
      ? 'no snapshot was ever sent'
      : `snapshot at ${firstSnap}, first market frame at ${firstMarket}`,
  );

  // 3. every price and quantity is a string
  const badNumber = [];
  for (const f of frames) {
    const d = f.data ?? {};
    if (f.type === 'snapshot' || f.type === 'book') {
      for (const side of ['bids', 'asks']) {
        for (const lvl of d[side] ?? []) {
          if (!isDecStr(lvl?.[0]) || !isDecStr(lvl?.[1])) {
            badNumber.push(`${f.type} seq ${f.seq}: ${JSON.stringify(lvl)}`);
          }
        }
      }
    }
    if (f.type === 'trade' && (!isDecStr(d.p) || !isDecStr(d.q))) {
      badNumber.push(`trade seq ${f.seq}: p=${JSON.stringify(d.p)} q=${JSON.stringify(d.q)}`);
    }
    if (f.type === 'candle') {
      for (const k of ['o', 'h', 'l', 'c', 'v']) {
        if (!isDecStr(d[k])) {
          badNumber.push(`candle seq ${f.seq}: ${k}=${JSON.stringify(d[k])}`);
        }
      }
    }
  }
  report.assert(
    badNumber.length === 0,
    'every price and quantity is a decimal string',
    badNumber.slice(0, 5).join('; ') + (badNumber.length > 5 ? ` (+${badNumber.length - 5} more)` : ''),
  );

  // 4. candle series is contiguous, one second apart, no duplicates
  const candles = frames.filter((f) => f.type === 'candle').map((f) => f.data);
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const step = candles[i].t - candles[i - 1].t;
    if (step !== 1000) gaps.push(`${candles[i - 1].t} then ${candles[i].t} (step ${step})`);
  }
  report.assert(
    candles.length > 0 && gaps.length === 0,
    'candle t increases by exactly 1000, no gaps and no duplicates',
    candles.length === 0 ? 'no candles were sent' : gaps.slice(0, 5).join('; '),
  );

  // 5 and 6. reconstruct the book from what was sent, check it stays sane
  const bids = new Map();
  const asks = new Map();
  const crossed = [];
  const zeroInSnapshot = [];
  const cmp = (a, b) => {
    const [ai, af = ''] = a.split('.');
    const [bi, bf = ''] = b.split('.');
    if (ai.length !== bi.length) return ai.length - bi.length;
    if (ai !== bi) return ai < bi ? -1 : 1;
    const n = Math.max(af.length, bf.length);
    const ap = af.padEnd(n, '0');
    const bp = bf.padEnd(n, '0');
    return ap === bp ? 0 : ap < bp ? -1 : 1;
  };
  const isZero = (q) => /^-?0(\.0*)?$/.test(q);

  for (const f of frames) {
    if (f.type === 'snapshot') {
      bids.clear();
      asks.clear();
      for (const [p, q] of f.data.bids ?? []) {
        if (isZero(q)) zeroInSnapshot.push(`seq ${f.seq}: bid ${p}`);
        else bids.set(p, q);
      }
      for (const [p, q] of f.data.asks ?? []) {
        if (isZero(q)) zeroInSnapshot.push(`seq ${f.seq}: ask ${p}`);
        else asks.set(p, q);
      }
    } else if (f.type === 'book') {
      for (const [p, q] of f.data.bids ?? []) (isZero(q) ? bids.delete(p) : bids.set(p, q));
      for (const [p, q] of f.data.asks ?? []) (isZero(q) ? asks.delete(p) : asks.set(p, q));
    } else {
      continue;
    }

    let bb = null;
    for (const p of bids.keys()) if (bb === null || cmp(p, bb) > 0) bb = p;
    let ba = null;
    for (const p of asks.keys()) if (ba === null || cmp(p, ba) < 0) ba = p;
    if (bb !== null && ba !== null && cmp(bb, ba) >= 0) {
      crossed.push(`seq ${f.seq}: bid ${bb} >= ask ${ba}`);
    }
  }

  report.assert(
    crossed.length === 0,
    'best bid stays strictly below best ask',
    crossed.slice(0, 3).join('; ') + (crossed.length > 3 ? ` (+${crossed.length - 3} more)` : ''),
  );
  report.assert(
    zeroInSnapshot.length === 0,
    'no zero quantity level ever appears in a snapshot',
    zeroInSnapshot.slice(0, 3).join('; '),
  );
}

export function checkProbes(frames, expected, report) {
  const candles = frames.filter((f) => f.type === 'candle').map((f) => f.data);

  // Long significand survives untouched. parseFloat loses it and nothing
  // downstream can put it back.
  const probe = expected.precisionProbe;
  const hit = candles.find((c) => c.h === probe.price);
  report.assert(
    Boolean(hit),
    'a fifteen decimal place price survives to the candle high, byte for byte',
    `expected some candle with h === ${JSON.stringify(probe.price)}. ` +
      `Closest candles: ${candles
        .filter((c) => c.h.startsWith(probe.price.split('.')[0]))
        .slice(0, 3)
        .map((c) => c.h)
        .join(', ') || 'none'}`,
  );

  // Digit-count crossing. Lexicographic comparison ranks "99999.98" above
  // "100000.02" and produces the wrong high for this second.
  const cross = expected.crossingProbe;
  const crossCandle = candles.find((c) => c.h === cross.high);
  report.assert(
    Boolean(crossCandle),
    'the high of a candle spanning 100000.00 is compared numerically, not lexicographically',
    `expected some candle with h === ${JSON.stringify(cross.high)}. ` +
      `If you see h === "99999.98000000" instead, you are comparing price strings directly.`,
  );
}

export function checkGolden(frames, expected, report) {
  const series = candleSeries(frames, expected.candleWindow);
  const expectedCount =
    (expected.candleWindow[1] - expected.candleWindow[0]) / 1000 + 1;

  if (!report.assert(
    series.length === expectedCount,
    'the candle window is fully covered',
    `expected ${expectedCount} candles between ${expected.candleWindow[0]} and ${expected.candleWindow[1]}, got ${series.length}`,
  )) {
    return;
  }

  const hash = sha256(JSON.stringify(series));
  report.assert(
    hash === expected.candleSeriesSha256,
    'the candle series matches the expected result',
    `got ${hash}, expected ${expected.candleSeriesSha256}. ` +
      `The series is wrong somewhere: check bucketing by trade time, flat candles for silent seconds, and exact price comparison.`,
  );
}

export function checkHealth(health, report) {
  if (!report.assert(Boolean(health), '/health responds', 'no response from /health')) return;
  report.assert(
    health.upstreamConnections === 1,
    '/health reports exactly one upstream connection',
    `got ${JSON.stringify(health.upstreamConnections)}`,
  );
  report.assert(
    Number.isInteger(health.resyncCount) && health.resyncCount >= 1,
    '/health reports at least one resync, because the tape contains a gap',
    `got resyncCount=${JSON.stringify(health.resyncCount)}. A tape with a deliberate sequence gap that produces zero resyncs means the gap was never detected.`,
  );
  if (
    !report.assert(
      Number.isInteger(health.snapshotRequests),
      '/health reports snapshotRequests',
      `got ${JSON.stringify(health.snapshotRequests)}`,
    )
  ) {
    return;
  }

  // Snapshot fetches are rate limited. A server that retries a refused fetch
  // immediately, rather than backing off, makes hundreds of requests to recover
  // from a handful of gaps. Against the real REST endpoint that is how you
  // collect a 418 and then an IP ban.
  const budget = health.resyncCount + 10;
  report.assert(
    health.snapshotRequests <= budget,
    'snapshot fetches are backed off rather than retried in a loop',
    `${health.snapshotRequests} requests for ${health.resyncCount} resyncs. ` +
      `Anything above ${budget} means a refused fetch is being retried immediately.`,
  );
}
