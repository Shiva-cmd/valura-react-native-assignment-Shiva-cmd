#!/usr/bin/env node
//
// Client core conformance harness.
//
//   node verify-client.mjs
//   node verify-client.mjs --fixtures fixtures/client.public.json
//
// Imports the four modules described in CLIENT_CONTRACT.md and drives them
// against fixtures. No device, no simulator, no rendering. Exit code 0 passes.
//
// Same rule as the server verifier: we grade against a second fixture set you
// have never seen. Passing this one is the floor.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Report } from './lib/assertions.mjs';
import { makeRng } from './lib/prng.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const fixturePath = arg('--fixtures', 'fixtures/client.public.json');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

// --- locate the candidate's core -------------------------------------------

let corePath = arg('--core');
if (!corePath) {
  corePath = './core/index.mjs';
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    if (pkg.clientCore) corePath = pkg.clientCore;
  } catch {
    /* no package.json, fall back to the default */
  }
}

let core;
try {
  core = await import(pathToFileURL(resolve(corePath)).href);
} catch (err) {
  console.error(`${RED}could not load your client core from ${corePath}${OFF}`);
  console.error(`Set "clientCore" in package.json, or put it at ./core/index.mjs.`);
  console.error(`\n${err.message}`);
  process.exit(1);
}

const required = ['createConnection', 'createBook', 'estimateFill', 'createAggregator'];
const missing = required.filter((n) => typeof core[n] !== 'function');
if (missing.length) {
  console.error(`${RED}${corePath} is missing: ${missing.join(', ')}${OFF}`);
  console.error('See CLIENT_CONTRACT.md.');
  process.exit(1);
}

const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
const report = new Report();

console.log(`${BOLD}verifying client core${OFF} ${corePath}`);
console.log(`${DIM}fixtures: ${fixturePath}${OFF}\n`);

// --- helpers ---------------------------------------------------------------

const show = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + '...' : s;
};

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function expectEqual(name, actual, expected) {
  report.assert(same(actual, expected), name, `got ${show(actual)}\n        want ${show(expected)}`);
}

// --- 1. connection ---------------------------------------------------------

for (const c of fixtures.connection) {
  let states;
  let token;
  try {
    const conn = core.createConnection({ ...c.options });
    states = c.events.map((e) => conn.send(e));
    token = conn.resumeToken();
  } catch (err) {
    report.fail(`connection: ${c.name}`, `threw: ${err.message}`);
    continue;
  }
  expectEqual(`connection: ${c.name}`, states, c.expectStates);
  expectEqual(`connection: ${c.name} (resume token)`, token, c.expectResumeToken);
}

// --- 2. backoff ------------------------------------------------------------

{
  const { options, seed, calls } = fixtures.backoff;
  const max = options.maxBackoffMs;
  let delays;
  try {
    const conn = core.createConnection({ ...options, random: makeRng(seed) });
    delays = Array.from({ length: calls }, () => conn.nextBackoffMs());
  } catch (err) {
    report.fail('backoff: schedule', `threw: ${err.message}`);
    delays = null;
  }

  if (delays) {
    const finite = delays.every((d) => Number.isFinite(d) && d >= 0);
    report.assert(finite, 'backoff: every delay is a non-negative number', show(delays));

    if (finite) {
      report.assert(
        delays[0] <= 2000,
        'backoff: the first retry is not made to wait',
        `first delay is ${delays[0]}ms, must be at most 2000ms`,
      );
      report.assert(
        delays.every((d) => d <= max),
        `backoff: nothing exceeds maxBackoffMs (${max})`,
        show(delays),
      );
      report.assert(
        delays[delays.length - 1] > delays[0],
        'backoff: the schedule grows',
        `first ${delays[0]}ms, last ${delays[delays.length - 1]}ms. A flat retry loop hammers a server that is already unwell.`,
      );
      const distinct = new Set(delays).size;
      report.assert(
        distinct >= 5,
        'backoff: is jittered',
        `only ${distinct} distinct values in ${calls} attempts: ${show(delays)}. ` +
          `Without jitter every disconnected client retries in lockstep and arrives as one thundering herd.`,
      );
    }
  }
}

// --- 3. book ---------------------------------------------------------------

for (const c of fixtures.book) {
  let results;
  let top;
  let usable;
  let lastUpdateId;
  try {
    const book = core.createBook();
    results = c.frames.map((f) => {
      const r = book.apply(f) ?? {};
      return { ok: !!r.ok, gap: !!r.gap };
    });
    top = book.top(c.topN);
    usable = book.usable;
    lastUpdateId = book.lastUpdateId;
  } catch (err) {
    report.fail(`book: ${c.name}`, `threw: ${err.message}`);
    continue;
  }
  expectEqual(`book: ${c.name} (apply results)`, results, c.expect);
  expectEqual(`book: ${c.name} (top of book)`, top, c.expectTop);
  expectEqual(`book: ${c.name} (usable)`, usable, c.expectUsable);
  expectEqual(`book: ${c.name} (lastUpdateId)`, lastUpdateId, c.expectLastUpdateId);
}

// --- 4. fill estimation ----------------------------------------------------

for (const c of fixtures.fill) {
  let actual;
  try {
    const book = core.createBook();
    for (const f of c.frames) book.apply(f);
    actual = core.estimateFill(book, c.side, c.quantity);
  } catch (err) {
    report.fail(`fill: ${c.name}`, `threw: ${err.message}`);
    continue;
  }
  expectEqual(`fill: ${c.name}`, actual, c.expect);
}

// --- 5. aggregation --------------------------------------------------------

for (const c of fixtures.aggregate) {
  let series;
  try {
    const agg = core.createAggregator(c.intervalMs);
    for (const k of c.candles) agg.push(k);
    series = agg.series();
  } catch (err) {
    report.fail(`aggregate: ${c.name}`, `threw: ${err.message}`);
    continue;
  }
  expectEqual(`aggregate: ${c.name}`, series, c.expectSeries);
}

// --- 6. aggregation cost ---------------------------------------------------

{
  const make = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = (100000 + (i % 97) * 0.01).toFixed(8);
      out.push({ t: 1730000000000 + i * 1000, o: p, h: p, l: p, c: p, v: '0.10000000', n: 1 });
    }
    return out;
  };

  const timePushes = (candles) => {
    const agg = core.createAggregator(60000);
    const started = process.hrtime.bigint();
    for (const k of candles) agg.push(k);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const small = make(15000);
  const large = make(30000);

  try {
    timePushes(small.slice(0, 2000)); // warm up the JIT

    let ratio = Infinity;
    let best = null;
    for (let i = 0; i < 3; i++) {
      const a = timePushes(small);
      const b = timePushes(large);
      const r = b / Math.max(a, 0.001);
      if (r < ratio) {
        ratio = r;
        best = { a, b };
      }
    }

    report.assert(
      ratio < 2.8,
      'aggregate: push is O(1) amortised',
      `doubling the input multiplied the time by ${ratio.toFixed(1)}x ` +
        `(${best.a.toFixed(0)}ms for 15k, ${best.b.toFixed(0)}ms for 30k). ` +
        `Linear work would be about 2x. Anything near 4x means push() re-reduces ` +
        `the whole series every call, which is what drops frames when the user ` +
        `switches interval on a live chart.`,
    );
  } catch (err) {
    report.fail('aggregate: push is O(1) amortised', `threw: ${err.message}`);
  }
}

// --- report ----------------------------------------------------------------

for (const c of report.checks) {
  const mark = c.ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${c.name}`);
  if (!c.ok && c.detail) console.log(`        ${DIM}${c.detail}${OFF}`);
}

console.log('');
if (report.ok) {
  console.log(`${GREEN}${BOLD}all ${report.checks.length} checks passed${OFF}`);
  console.log(`${DIM}The holdout fixtures are stricter. This is the floor, not the bar.${OFF}`);
  process.exit(0);
}
console.log(`${RED}${BOLD}${report.failures.length} of ${report.checks.length} checks failed${OFF}`);
process.exit(1);
