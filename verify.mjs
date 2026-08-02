#!/usr/bin/env node
//
// Protocol verifier.
//
//   node verify.mjs                          run the public tape
//   node verify.mjs --tape tapes/other.ndjson
//   SERVE_CMD="node dist/server.js" node verify.mjs
//
// It starts your server twice in replay mode, drives a client over
// PROTOCOL.md, and checks what came back. Exit code 0 means pass.
//
// Passing this is necessary. It is not sufficient: we grade against a second
// tape you have never seen, containing pathologies this one does not. Build the
// general thing rather than tuning to this file.

import { readFileSync } from 'node:fs';
import { runReplay } from './lib/harness.mjs';
import {
  Report,
  canonical,
  sha256,
  checkProtocol,
  checkProbes,
  checkGolden,
  checkHealth,
} from './lib/assertions.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const tape = arg('--tape', 'tapes/pathological.ndjson');
const expectedPath = arg('--expected', tape.replace(/\.ndjson$/, '.expected.json'));
const verbose = args.includes('--verbose');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

console.log(`${BOLD}verifying${OFF} ${tape}`);
console.log(`${DIM}serve command: ${process.env.SERVE_CMD ?? 'npm run serve --'}${OFF}\n`);

const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const report = new Report();

let runA;
let runB;
try {
  process.stdout.write(`${DIM}run 1 of 2...${OFF}`);
  runA = await runReplay(tape, { quiet: !verbose });
  process.stdout.write(` ${runA.frames.length} frames\n`);

  process.stdout.write(`${DIM}run 2 of 2...${OFF}`);
  runB = await runReplay(tape, { quiet: !verbose });
  process.stdout.write(` ${runB.frames.length} frames\n\n`);
} catch (err) {
  console.error(`\n${RED}could not complete a replay run${OFF}\n${err.message}`);
  process.exit(1);
}

if (runA.frames.length === 0) {
  console.error(`${RED}the server sent no frames at all.${OFF}`);
  console.error(runA.stderr.slice(-2000));
  process.exit(1);
}

checkProtocol(runA.frames, report);
checkProbes(runA.frames, expected, report);
checkGolden(runA.frames, expected, report);
checkHealth(runA.health, report);

// Determinism. Two replays of the same tape must produce the same bytes. If
// this fails you have a wall clock, a random value, or an ordering that depends
// on real time somewhere on the path to output.
const a = sha256(canonical(runA.frames));
const b = sha256(canonical(runB.frames));
if (a === b) {
  report.pass('two replays of the same tape produce identical output');
} else {
  let where = 'lengths differ';
  const n = Math.min(runA.frames.length, runB.frames.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(runA.frames[i]) !== JSON.stringify(runB.frames[i])) {
      where =
        `first divergence at frame ${i} (seq ${runA.frames[i].seq}, type ${runA.frames[i].type})\n` +
        `      run 1: ${JSON.stringify(runA.frames[i]).slice(0, 220)}\n` +
        `      run 2: ${JSON.stringify(runB.frames[i]).slice(0, 220)}`;
      break;
    }
  }
  report.fail('two replays of the same tape produce identical output', where);
}

for (const c of report.checks) {
  const mark = c.ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${c.name}`);
  if (!c.ok && c.detail) console.log(`        ${DIM}${c.detail}${OFF}`);
}

const failed = report.failures.length;
console.log('');
if (failed === 0) {
  console.log(`${GREEN}${BOLD}all ${report.checks.length} checks passed${OFF}`);
  console.log(
    `${DIM}Remember: the holdout tape is stricter. This is the floor, not the bar.${OFF}`,
  );
  process.exit(0);
}

console.log(`${RED}${BOLD}${failed} of ${report.checks.length} checks failed${OFF}`);
process.exit(1);
