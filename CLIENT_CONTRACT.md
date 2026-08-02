# Client core contract

Four pure modules your app is built on. `verify-client.mjs` imports them
directly and drives them against fixtures, with no simulator and no rendering.

This is the only place we tell you how to structure anything. We do it because
logic that can be tested without a device is logic you can actually trust, and
because a trading client whose state machine only exists inside a React
component is a trading client nobody can verify. Everything above these four
modules is yours.

## Where they live

Point at your entry with a `clientCore` field in `package.json`:

```json
{ "clientCore": "./core/index.mjs" }
```

Default if absent: `./core/index.mjs`. If you write TypeScript, point at built
output and make sure `npm run build` runs before `npm run verify:client`.

These modules must not import React, React Native, or anything that touches a
native module. They run in plain Node.

## Numbers

Same rule as the wire protocol: **prices and quantities are decimal strings, in
and out.** Never a JavaScript number. The fixtures contain values that do not
survive a round trip through a double, and the harness compares with string
equality.

---

## 1. `createConnection(options)`

The connection state machine. Pure: no sockets, no timers. You feed it events,
it tells you what state you are in and how long to wait before reconnecting.

```js
export function createConnection({
  staleAfterMs = 2000,
  maxBackoffMs = 30000,
  random = Math.random,   // injected so tests are reproducible
} = {})
```

Returns an object with:

| Member | Type | Meaning |
|---|---|---|
| `state` | getter | `'connecting' \| 'live' \| 'reconnecting' \| 'stale'` |
| `send(event)` | fn | Apply an event. Returns the new state. |
| `nextBackoffMs()` | fn | Delay before the next reconnect attempt. Advances the schedule. |
| `resumeToken()` | fn | `{ sessionId, lastSeq }` or `null` |

Events:

```js
{ type: 'open' }                  // socket opened
{ type: 'frame', frame, now }     // a protocol envelope arrived
{ type: 'close' }                 // socket closed
{ type: 'error' }                 // socket errored
{ type: 'tick', now }             // wall clock advanced, no frame
```

Required behaviour:

- Initial state is `connecting`.
- A `hello` frame moves you to `live`.
- `close` or `error` moves you to `reconnecting`, from any state.
- In `live`, a `tick` more than `staleAfterMs` after the last frame moves you to
  `stale`. Any frame moves you back to `live`.
- `resumeToken()` returns the `sessionId` from the last `hello` and the highest
  `seq` you have seen, so a reconnect can resume instead of restarting cold. It
  returns `null` only before the first `hello`.

Required backoff properties, asserted over eight consecutive
`nextBackoffMs()` calls:

- The first is at most 2000ms. Do not make a user wait thirty seconds for the
  first retry.
- Every value is at most `maxBackoffMs`.
- The underlying schedule grows. The eighth is meaningfully larger than the
  first.
- **At least five of the eight are distinct.** A fixed schedule reconnects a
  thousand clients in lockstep and hits your own server as a thundering herd.
  Jitter it. `random` is injected so this is testable.
- After a successful `open` followed by a `hello`, the schedule resets.

---

## 2. `createBook()`

Applies what the server sends and notices when it has lost frames.

```js
export function createBook()
```

| Member | Type | Meaning |
|---|---|---|
| `apply(envelope)` | fn | Returns `{ ok, gap, reason? }` |
| `top(n)` | fn | `{ bids, asks }`, at most `n` levels each |
| `lastUpdateId` | getter | From the last applied frame |
| `usable` | getter | `false` once a gap is seen, until the next `snapshot` |

Takes the **whole envelope**, not just `data`, because the transport `seq` is
how you detect loss.

Required behaviour:

- A `snapshot` frame replaces all state and sets `usable` to `true`.
- A `book` frame applies deltas. Quantity `"0"` deletes the level.
- If a frame's `seq` is not exactly one more than the previous frame's, return
  `{ ok: false, gap: true }` and set `usable` to `false`. Keep it false until a
  `snapshot` arrives. A client that keeps rendering a book it knows it has lost
  frames from is displaying a price that is not real.
- Frame types other than `snapshot` and `book` still advance the expected `seq`.
  They are frames on the same wire.
- `top(n)`: bids descending by price, asks ascending, numerically. No zero
  quantity levels. Fewer than `n` if the book is thinner than that.

Ordering is compared **numerically**, not lexicographically. The fixtures
include a book spanning 100000.00, where string comparison puts
`"99999.98000000"` above `"100000.02000000"` and produces a visibly wrong top of
book.

---

## 3. `estimateFill(book, side, quantity)`

The number under the buy and sell buttons. Walks the book and tells the user
what they would actually pay.

```js
export function estimateFill(book, side, quantity)
```

- `book`: the object returned by `createBook()`
- `side`: `'buy'` or `'sell'`
- `quantity`: a decimal string

Returns:

```js
{
  avgPrice: "100000.31250000",   // VWAP, 8 dp, half up
  slippageBps: 31,               // integer, non-negative
  filledQuantity: "2.50000000",  // 8 dp
  insufficientDepth: false
}
```

Required behaviour:

- `buy` consumes asks ascending. `sell` consumes bids descending.
- `avgPrice` is the volume weighted average across every level consumed,
  including a partial fill of the last one. Computed exactly, then rounded to
  eight decimal places, half away from zero.
- `slippageBps` is how much worse than the touch the user does:
  - buy: `10000 * (avgPrice - bestAsk) / bestAsk`
  - sell: `10000 * (bestBid - avgPrice) / bestBid`

  Computed from the **rounded** `avgPrice` you return, so the two agree, then
  rounded to an integer half away from zero. Never negative.
- If the book cannot fill the order, set `insufficientDepth: true`, return the
  VWAP over what is available, and set `filledQuantity` to what was available.
  Do not extrapolate past the end of the book. A UI that quotes a price for
  size that is not there is worse than one that says it does not know.
- If the relevant side is empty, return
  `{ avgPrice: "0", slippageBps: 0, filledQuantity: "0", insufficientDepth: true }`.

Computing this in floating point will fail the fixtures. The numbers are chosen
so that it does.

---

## 4. `createAggregator(intervalMs)`

Rolls 1 second candles into the interval the user selected.

```js
export function createAggregator(intervalMs)   // 5000, 60000, ...
```

| Member | Type | Meaning |
|---|---|---|
| `push(candle)` | fn | Feed one closed 1s candle. Returns the current bucket. |
| `series()` | fn | Every bucket so far, oldest first |

A bucket starts at `Math.floor(candle.t / intervalMs) * intervalMs` and:

- `o` is the first candle's `o`
- `h` is the numeric maximum of the candles' `h`
- `l` is the numeric minimum of the candles' `l`
- `c` is the last candle's `c`
- `v` is the exact sum of the candles' `v`, 8 dp
- `n` is the sum of the candles' `n`
- `t` is the bucket start

Required behaviour:

- **`push` must be O(1) amortised.** The harness pushes 20,000 candles, then
  40,000, and compares the time taken. Re-reducing the whole buffer on every
  push is O(n) per call, shows up as a quadratic curve, and fails. It is also
  what makes an interval switch drop frames on a real device, which is the
  actual reason we care.
- `h` and `l` are chosen by numeric comparison. Same crossing trap as the book.
- `series()` is contiguous. Never a hole.
