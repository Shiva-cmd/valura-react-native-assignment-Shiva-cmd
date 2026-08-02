[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/nd13OCix)
# Crypto trading panel, starter kit

Everything here exists so you spend your time on the assignment rather than on
guessing what we meant.

**The assignment itself is [ASSIGNMENT.md](ASSIGNMENT.md).** Read that first.
This file only covers the kit.

```
ASSIGNMENT.md                  the brief: what to build, how it is scored
PROTOCOL.md                    the wire format. Fixed. Implement it exactly.
CLIENT_CONTRACT.md             the four client modules the harness imports

verify.mjs                     server verifier. Hard gate.
tapes/pathological.ndjson      a recorded upstream session with injected faults
tapes/pathological.expected.json  the expected result, as hashes
lib/replay.mjs                 tape reader. Use it.
lib/harness.mjs                starts your server and drives a client
lib/assertions.mjs             the checks verify.mjs runs
stub/server.mjs                a deliberately broken server, so you can confirm setup

verify-client.mjs              client verifier. Hard gate.
fixtures/client.public.json    inputs and expected outputs for your core
lib/prng.mjs                   seeded random, injected so backoff jitter is testable
example-core/index.mjs         a deliberately broken client core, same purpose
```

## Quick start

```bash
npm install
npm run verify:all
```

Both verifiers run against the stubs and both fail, loudly and specifically.
That is the correct result: it proves the harness works before you have written
anything.

Then point `npm run serve` at your server, point `clientCore` in `package.json`
at your core, and run it again.

```bash
npm run verify         # server, against the tape
npm run verify:client  # client core, against the fixtures
```

Both are gates. A flawless server with an unverifiable client fails the review,
and so does the reverse.

## The contract

The verifier runs exactly this:

```bash
npm run serve -- --replay tapes/pathological.ndjson --port <port>
```

Your server must accept both flags. If your build step means that command does
not work directly, you can override it locally:

```bash
SERVE_CMD="node dist/server.js" npm run verify
```

but `npm run serve` has to work from a clean clone, because that is what we run
when we grade.

## What the tape contains

`tapes/pathological.ndjson` is a recorded upstream session, one JSON object per
line, with faults injected deliberately:

- a duplicated message
- messages arriving out of sequence order
- a sequence gap, which requires a resynchronisation
- a burst of a thousand messages in two hundred milliseconds
- a mid-stream disconnect and reconnect
- frames that are not valid JSON, and frames with the wrong field types
- two consecutive seconds with no trades at all
- prices chosen to break the obvious approach to handling numbers

None of these are unusual. All of them happen against the real Binance streams,
which is why the assignment is about them.

## Read this part

**What you can see is not what you are graded on.** We grade with a second tape
and a second fixture set, each containing everything the public ones do plus
cases they do not. Passing `npm run verify:all` is necessary and it is not
sufficient.

So do not special-case these files. Anything that looks like tuning to the
public inputs rather than solving the general problem reads as exactly what it
is, and it is listed in the brief as an automatic stop.

Concretely, the hidden cases are boundaries: an order that fills the book
exactly rather than overflowing it, a timeout at the threshold rather than past
it, a frame type you did not expect on a sequence you are counting. Handle the
general case and they cost you nothing.

## Line format

```json
{"kind":"snapshot","ts":1730000000000,"data":{"lastUpdateId":1000000,"bids":[["p","q"]],"asks":[["p","q"]]}}
{"kind":"message","ts":1730000000100,"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","U":1,"u":4,"b":[],"a":[]}}
{"kind":"message","ts":1730000000160,"stream":"btcusdt@trade","data":{"e":"trade","p":"99998.10000000","q":"0.5","T":1730000000158,"m":true}}
{"kind":"raw","ts":1730000017000,"payload":"{\"e\":\"depthUpdate\",\"s\":\"BTCUSDT\",\"U\":"}
{"kind":"disconnect","ts":1730000014000}
{"kind":"reconnect","ts":1730000014600}
```

`kind: "snapshot"` lines are not part of the stream. They are served by
`ReplaySource.fetchSnapshot()`, which is the replay stand-in for the REST depth
endpoint, rate limited the same way. `kind: "raw"` lines are frames exactly as
they came off the socket, and may not be valid JSON. `payload` is what your
parser gets handed.

The `message` payloads are the real Binance field names. Their documentation for
the depth diff stream and for maintaining a local order book is the reference,
and reading it carefully is most of Part A.

## Notes

- Node 22 or newer. The verifier uses the built-in `WebSocket` client.
- The only dependency here is `ws`, and only the stub uses it. Your server can
  use whatever you like.
- `tapes/pathological.expected.json` holds hashes rather than expected output,
  so there is nothing in this repo to copy an answer from. Regenerating it to
  make the verifier pass would be self-defeating: we grade with our own copy.

Questions before you start are welcome and asking good ones counts in your
favour.
