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

---

## This submission

Everything below is my own documentation, added to the starter kit above.

### Running the server for real

```bash
npm install
npm run build            # tsc -p server, strict mode
npm run serve -- --replay tapes/pathological.ndjson --port 8080   # replay mode
# or, with no --replay, connects to the real Binance combined stream:
npm run serve -- --port 8080
```

`npm run serve` runs `tsc` then starts `server/dist/index.js`, so it works from
a clean clone with no separate build step to remember. `SERVE_CMD` still
overrides it for the verifier per the kit's own contract.

`/health` with 5 clients attached, captured against **live Binance** (replay
mode finishes the whole tape in under a second of real time with no artificial
pacing, so it isn't a useful way to demonstrate steady-state fan-out - this is
the actual long-running server):

```json
{
  "upstreamConnections": 1,
  "clientCount": 5,
  "resyncCount": 1,
  "lastResyncAt": 1785690070260,
  "snapshotRequests": 1,
  "rejectedFrames": 0,
  "lateTrades": 2,
  "droppedFrames": 0,
  "uptimeMs": 7583,
  "rssBytes": 87244800
}
```

One upstream connection, five clients, one cold-start resync (the initial
snapshot), and two late trades already visible in ~7.5s of a real feed - which
is the exact scenario A3 is about (trade time vs. receive time diverging).

### Running the React Native app

```bash
cd app
npm install
npm run android   # or: npx expo run:android / run:ios
```

The app talks to `ws://10.0.2.2:8080/stream` by default on Android (the
documented alias an emulator uses to reach the host machine's `localhost`),
and `ws://localhost:8080/stream` on iOS/web. Start the server first. See
`app/src/engine/config.ts` to point at a different host.

Confirmed running end to end on a Pixel 9a Android emulator, LIVE state, real
streaming BTCUSDT price and chart, fill estimate against the live book - see
`METRICS.md`.

**If the first native build fails** with a ninja error like `libworklets.so
... missing and no known rule to make it`: this is an AGP/CMake config-hash
mismatch between native modules (hit once during development, on a fresh
dependency add), not a code issue. Fix: `cd app/android && ./gradlew clean`,
then delete every `.cxx` directory under `app/node_modules/*/android/` and
`app/android`, then `npx expo run:android` again. `android/` isn't committed
(standard for a generated Expo native project), so this can resurface on a
first prebuild in a new environment.

The app imports the client core directly from `../core/*.mjs` at the repo
root (Metro is configured in `app/metro.config.js` to reach outside the Expo
project and resolve `.mjs`) - it is not a reimplementation, it's the exact
module `verify-client.mjs` checks.

### Binance streams used

`btcusdt@depth@100ms` (depth diffs, 100ms is the fastest cadence Binance
offers without a paid tier) and `btcusdt@trade` (individual trades, needed to
bucket by trade time rather than receive time - `aggTrade` would have merged
same-price-same-side trades and quietly changed the candle high/low in edge
cases). Rejected `bookTicker` (best bid/ask only - explicitly disallowed,
it isn't depth) and any 1s/1m kline stream (would have made A3 - "aggregate
trades into candles yourself" - moot).

### Dependencies

Server runtime dependency, one, excluding types:

| Package | Why |
|---|---|
| `ws` | WebSocket server; Node's built-in `WebSocket` is client-only |

Everything else (order book sync, candle aggregation, decimal arithmetic,
backpressure, replay) is hand-written - see `server/src/`. `typescript`,
`@types/node`, `@types/ws`, and `fast-check` are dev-only (build/test, not
shipped).

App dependencies beyond the Expo/RN baseline: `@shopify/react-native-skia`
(the hand-rolled chart's renderer), `react-native-reanimated` +
`react-native-worklets` (UI-thread shared values and the scrub gesture),
`react-native-gesture-handler` (the pan gesture itself). All four are named
explicitly by the brief (B5) as the allowed rendering/animation primitives.

### Known limitations

- **Candle series golden hash**: `verify.mjs` passes 16 of 17 checks. The one
  failure is the exact SHA-256 of the candle series over the fixed window -
  every structural check passes (contiguity, the 15-decimal precision probe,
  the numeric-crossing probe, full window coverage), and the series matches
  two independent from-scratch reference computations (one sorted by true
  trade time, one captured directly off the wire) byte-for-byte. I could not
  isolate what differs from the hidden reference without seeing it, and I'd
  rather say that plainly than guess at a fix that only tunes to this one
  tape. See `DECISIONS.md`.
- **RTL (B7)**: implemented (`I18nManager.forceRTL` via the toggle in the
  header) but only lightly exercised - I did not do a full pass checking
  every screen element mirrors correctly under a real Arabic locale.
- **Interval switching (B5, optional)**: wired end to end (1s/5s/1m all run
  live via `createAggregator`, switching is instant since all three have been
  aggregating the whole time), but only checked on-device for a few minutes
  at a time, not across a long soak.
- No settings UI for the server address; it's a constant in `config.ts`.

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
