#!/usr/bin/env node
//
// Runs both verifiers and reports both results.
//
// Deliberately not `verify && verify:client`. On a clean clone the server
// verifier fails against the stub, and a chained && would stop there, so you
// would never find out the client harness works. Both always run.

import { spawnSync } from 'node:child_process';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

const steps = [
  { name: 'server', script: 'verify.mjs' },
  { name: 'client core', script: 'verify-client.mjs' },
];

const results = [];
for (const step of steps) {
  console.log(`${BOLD}=== ${step.name} ===${OFF}`);
  const r = spawnSync(process.execPath, [step.script], { stdio: 'inherit' });
  results.push({ ...step, ok: r.status === 0 });
  console.log('');
}

console.log(`${BOLD}summary${OFF}`);
for (const r of results) {
  console.log(`  ${r.ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`}  ${r.name}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${RED}${BOLD}${failed.length} of ${results.length} verifiers failed${OFF}`);
  process.exit(1);
}
console.log(`\n${GREEN}${BOLD}both verifiers passed${OFF}`);
