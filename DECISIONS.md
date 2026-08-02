# Decisions

## 1. Numeric precision (A4)

Every price/quantity computation - comparison, sum, VWAP, OHLC - runs through
a small BigInt-based decimal module (`server/src/decimal.ts`, mirrored in
`core/decimal.mjs` for the client), not `Number`. Strings are parsed into
`{unscaled: bigint, scale: number}`, so addition/subtraction/multiplication
are exact, and comparison is numeric rather than lexicographic. Division
(VWAP, slippage) is fundamentally not exact for arbitrary rationals, so I
compute it to `dp + 12` guard digits before rounding half-away-from-zero to
the required precision - correctly rounded, not falsely claimed exact.

Rejected: floating point (fails the 15-decimal-place probe by construction);
`decimal.js`/`big.js` (a real dependency for ~120 lines of logic, and the
client core is meant to be dependency-free plain JS so it stays trivially
bundleable and testable without a device).

## 2. Backpressure vs. contiguous seq (A5)

Policy: below a soft buffered-bytes threshold, everything sends normally.
Above it, book deltas are merged into one pending frame per client
(conflate-to-latest, nothing lost, just batched) and trade prints are
dropped outright (recoverable from candles). Candles and status are never
dropped. Above a hard threshold, the client gets `SLOW_CONSUMER` and is
closed. Critically, `seq` is assigned to a frame only at the moment it is
actually written to that session's socket (`session.ts`), never at
generation time - so whatever gets shed, what the client receives is still
exactly contiguous, which is the tension PROTOCOL.md calls out directly.

Rejected: dropping deltas with no merge (client book silently drifts,
discoverable only by chance) and an unbounded queue (explicitly forbidden).

## 3. Chart data path (B4)

The server computes 1s candles server-side (A3) and streams them; the
client's `createAggregator` rolls those into 5s/1m. The chart itself never
touches React state: candle series and price live in Reanimated shared
values (`makeMutable`, not `useState`), and the scrub gesture writes into
those same shared values directly from the UI thread's worklet. The price
header is drawn with Skia's own `<Text>` rather than RN `<Text>`, for one
reason - during a scrub, the displayed price has to track the gesture at UI
thread speed, and routing it through React would mean a JS round trip every
frame of the drag, which is exactly the lag the brief calls out. Only
low-frequency state (connection status, resume token) goes through React,
via a tiny external store.

Rejected: `setState` per tick (fails the 200msg/s budget by design) and
`Animated.Text`/`TextInput` tricks for the price label (more moving parts
for one component, when Skia was already the chart's renderer).

## 4. Cold start and resync share one state machine (A2)

`DepthSyncEngine` treats "have never synced yet" and "lost sync mid-stream"
as the same state (`needsResync`): both buffer incoming diffs and both
resolve the same way - fetch a snapshot, discard buffered diffs it already
covers, verify the first remaining one actually bridges it, apply. This
means cold-start ordering (buffer before snapshot, never the reverse) falls
out of the design rather than needing separate code paths, and a live gap
gets exactly the same rate-limited, self-throttled recovery a cold start
does.

## 5. Got wrong first: gap detection didn't distinguish stale from lost

First version treated any diff whose `U` didn't exactly equal
`lastAppliedU + 1` as a gap, full stop. Against the tape this fired 29
times - it was treating already-applied duplicates and stale re-deliveries
as sequence loss instead of discarding them, forcing a resync that wasn't
needed. Fixed by discarding anything with `u <= lastAppliedU` instead of
resyncing on it (`server/src/depthSync.ts`).

Fixing that surfaced a second, more serious bug the fast-check property test
(C2) caught directly: `server.ts` was broadcasting a `book` delta to clients
for *every* diff the server received, including ones `handleDiff` had just
silently discarded as stale or buffered for a resync. The client would apply
a delta the server's own book never applied - a real server/client
divergence the public tape's own gap never happened to expose, because
`handleDiff` didn't yet report *what actually happened* to the frame.
Fixed by having it return `'applied' | 'stale' | 'buffered'` and only
broadcasting on `'applied'`.
Commit: [391703e](./commit/391703e) (`git show 391703e`).
