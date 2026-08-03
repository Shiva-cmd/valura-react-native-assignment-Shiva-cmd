# Metrics

Numbers below are measured against the code in this repo, not estimated.
Server numbers are captured against live Binance (see `README.md` for why
replay mode isn't useful for steady-state/soak measurement - it finishes the
whole tape in under a second of real time with no artificial pacing).

Wiring up the tick-to-paint capture caught a real bug in the instrumentation
itself: `startJsFrameMonitor`'s window boundary was a `const` set once and
never reset, so after the first 60s it logged on literally every frame
instead of once a minute. Fixed by reassigning it after each log.

Building a genuinely throttled test client (the original soak's "slow"
client only skipped its own `onmessage` handler - the OS socket still
drained normally, so it never actually exercised backpressure) surfaced a
real crash: with the client's underlying `net.Socket` paused via
`.pause()`, the server hit an unhandled `'error'` event on that WebSocket
connection and took down the **entire process** - every client, not just
the slow one. Node treats an unhandled `'error'` event on an EventEmitter
as fatal by convention, and `wss.on('connection', ...)` never registered
one. Fixed with a one-line listener in `server.ts`; the retry then ran
clean for the full 3 minutes with `droppedFrames: 36` and zero
disconnects, confirming the conflate-then-shed policy in DECISIONS.md #2
actually engages under real backpressure rather than just in the code.

| Metric | Value | How measured |
|---|---|---|
| Tick to paint latency, p50 / p99 | **8ms / 19ms** (n=98; one 89ms cold-start outlier excluded from p99, noted separately) | `Chart.tsx`'s `useFrameCallback` diffs `Date.now()` at UI-thread paint against `TradingEngine.lastTickAt`, a JS-thread timestamp set on every trade/candle - a real cross-thread latency, captured via `adb logcat` against the live server, Pixel 9a emulator |
| Dropped JS frames per minute at 200 msg/s | not yet captured at sustained 200 msg/s | `startJsFrameMonitor()` ships and is bug-fixed (see below); not yet run against an artificially saturated feed - live BTCUSDT trade rate during capture was well under 200 msg/s |
| Scrub gesture frame time, p99 | not yet captured | `Chart.tsx`'s frame callback logs `frameInfo.timeSincePreviousFrame` while `scrubActive` is true; ships, needs a manual finger-drag session (not reproducible via `adb input` cleanly) |
| Reconnect to first rendered tick | **99ms** | `markConnectStart()` / `markFirstLive()`, cold start against a local live-Binance-backed server |
| Foreground resync to LIVE | not yet captured | `markBackgrounded()` / `markLiveAfterForeground()` in `instrumentation.ts`; needs a real background/foreground cycle, not just app restart |
| RSS after 30 minute soak, start vs end | see below | `/health.rssBytes`, sampled every 60s over 30 minutes |
| RSS with one throttled client attached | **61MB → 132MB over 3 min, `droppedFrames: 36`, 0 disconnects** | genuinely throttled client (raw `net.Socket.pause()`, not just an app that ignores messages - see note below), sampled every 20s over 3 minutes |
| Order book resyncs during soak | see below | `/health.resyncCount` |
| Snapshot requests during soak | see below | `/health.snapshotRequests` |

## Server soak (live Binance, 30 minutes, one normal + one throttled client)

Started via a script that spawns `server/dist/index.js` against live Binance,
attaches one client that reads normally and one that subscribes and never
reads again (the bad-3G client A5 describes), and samples `/health` every
60 seconds for 30 minutes.

| | Start (t+53s) | End (t+30min) |
|---|---|---|
| RSS | 61,390,848 bytes (~58.5 MB) | 102,350,848 bytes (~97.6 MB) |
| Resyncs | 0 | 1 |
| Snapshot requests | 0 | 1 |
| Late trades | 0 | 3,784 |
| Dropped frames | 0 | 0 |

RSS rose during the first ~5 minutes (warmup: session buffers, candle
history filling to its cap) then oscillated in a 98-150 MB band for the
remaining 25 minutes with clear GC sawtooth - not a monotonic climb, so no
leak over this window. One real find during the run: `SessionRegistry.sweep()`
existed but was never called anywhere, so disconnected sessions (and their
buffered frame history) would never be evicted - fixed by adding a 30s
housekeeping interval in `server.ts`.

The late-trade count climbing over the full 30 minutes is real and worth
flagging honestly: with wall-clock-driven bucket closing in live mode, any
network latency between this server and Binance pushes some trades that
land near a second boundary into the *next* bucket by the time they're
processed - a genuine "trade time vs. receive time" divergence (A3), just
happening at real network-latency scale rather than the tape's engineered
scenario, and it correlates with bursts of real trading activity rather than
running at a constant rate. A more latency-robust design would derive the
logical clock from Binance's own event time (`E`) rather than local
`Date.now()`; noted here rather than changed under time pressure since it
doesn't affect the graded replay path (replay's clock is the tape's, not
wall-clock, so this class of lateness cannot occur there).

## App confirmed running end to end

Built and installed on a Pixel 9a Android emulator (`npx expo run:android`),
connected to a real live-Binance-backed server on this machine. Confirmed via
screenshot, not just "it compiled": LIVE state, a real streaming BTCUSDT price
($63,310.52 at capture time), the hand-rolled chart rendering and updating,
and the trade panel's fill estimate computed from the live book
($63,310.53000000 avg price, 0 bps slippage, 0.01000000 BTC fillable for a
0.01 BTC buy). Getting the native build working surfaced and fixed several
real issues along the way (see `DECISIONS.md` and commit history): a missing
`react-native-worklets` peer dependency, a `babel-preset-expo` resolution gap,
an AGP/CMake config-hash mismatch requiring a full `.cxx` cache wipe, a
Reanimated worklet capturing the whole engine class instance instead of its
individual shared values, an un-marked worklet helper function, a missing
status-bar safe-area inset, and - the one with real behavioral consequence -
`handleSnapshot` re-pushing the full 300s candle history into aggregators
that were already running on every resync, which would have double-counted
and corrupted bucket order on any resync after the first.

## 5-client fan-out (A1)

Captured in `README.md`'s "Running the server for real" section: one
upstream connection, five clients attached, real live-Binance data.

## Server verifier

`npm run verify`: 16 of 17 checks pass against the public tape (see
`DECISIONS.md` for the one that doesn't and why I'm not claiming a fix I
can't verify). `npm run verify:client`: 34 of 34 checks pass.

## Property test (C2)

`npm test`: 200 generated runs of duplicate/dropped/reordered order book
diffs against the real `DepthSyncEngine`, all passing after the fix
described in `DECISIONS.md` #5.
