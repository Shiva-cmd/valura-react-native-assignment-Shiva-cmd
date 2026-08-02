# Wire protocol v1

**This specification is fixed.** You implement it, you do not design it. The
verifier asserts against it byte for byte and rejects anything that deviates.

Conforming to a spec someone else wrote is part of the job. It is also, quite
deliberately, harder than inventing your own.

---

## Transport

WebSocket, text frames, one JSON object per frame. No batching of multiple
envelopes into one frame.

Client connects to `ws://<host>:<port>/stream`.

---

## Numbers

**Every price and every quantity is a JSON string.** Always. In every message,
in every direction, including inside arrays.

```json
"67231.12000000"     ✅
67231.12             ❌ rejected by the verifier
```

Strings are preserved exactly as received from upstream. You do not re-format,
trim trailing zeros, round, or normalise them. If upstream says
`"0.00000001000000"`, that is what reaches the client.

Timestamps are integer milliseconds since epoch, as JSON numbers.

---

## Envelope

Every server to client frame:

```json
{
  "v": 1,
  "seq": 12345,
  "type": "book",
  "ts": 1730000000123,
  "data": { }
}
```

- `v` is always `1`.
- `seq` is a per-session counter, starts at `1` on the `hello` frame, increments
  by exactly one per frame sent to that client. No gaps, no reuse.
- `ts` is the server's send time. In replay mode it is the tape's logical time,
  not the wall clock.

---

## Client to server

### `subscribe`

```json
{ "op": "subscribe", "symbol": "BTCUSDT", "depth": 50 }
```

### `resume`

Sent instead of `subscribe` when reconnecting.

```json
{ "op": "resume", "sessionId": "a1b2c3", "lastSeq": 12345 }
```

The server either replays everything after `lastSeq` from its buffer, or, if
that data is no longer buffered, responds with a fresh `hello` carrying a new
`sessionId` followed by a full `snapshot`. Either is correct. Silently dropping
the client is not, and neither is pretending the resume worked when it did not.

### `ping`

```json
{ "op": "ping", "id": 7 }
```

Server replies `{"v":1,"seq":N,"type":"pong","ts":...,"data":{"id":7}}`.

---

## Server to client

### `hello`

Always `seq: 1`. Always the first frame.

```json
{
  "v": 1, "seq": 1, "type": "hello", "ts": 1730000000000,
  "data": {
    "sessionId": "a1b2c3",
    "symbols": ["BTCUSDT"],
    "resumed": false,
    "serverTime": 1730000000000
  }
}
```

### `snapshot`

Full state. Sent after `hello`, and again after any resynchronisation.

```json
{
  "v": 1, "seq": 2, "type": "snapshot", "ts": 1730000000010,
  "data": {
    "symbol": "BTCUSDT",
    "lastUpdateId": 4409381721,
    "bids": [["67231.12000000", "0.45300000"], ["67231.11000000", "1.02000000"]],
    "asks": [["67231.13000000", "0.12000000"]],
    "candles": [
      { "t": 1729999999000, "o": "67230.00", "h": "67232.10",
        "c": "67231.12", "l": "67229.50", "v": "3.44100000", "n": 118 }
    ]
  }
}
```

- `bids` descending by price. `asks` ascending. Strictly ordered, no duplicate
  price levels.
- At most `depth` levels per side, as requested in `subscribe`.
- `candles` is the trailing 300 seconds, oldest first, contiguous.

### `book`

Incremental delta. Only changed levels.

```json
{
  "v": 1, "seq": 3, "type": "book", "ts": 1730000000110,
  "data": {
    "symbol": "BTCUSDT",
    "lastUpdateId": 4409381725,
    "bids": [["67231.12000000", "0.60000000"], ["67231.09000000", "0"]],
    "asks": []
  }
}
```

A quantity of `"0"` means delete that level. The client is expected to apply it.
The server must never emit a stored zero level in a `snapshot`.

### `trade`

```json
{
  "v": 1, "seq": 4, "type": "trade", "ts": 1730000000115,
  "data": {
    "symbol": "BTCUSDT", "id": 3847221,
    "p": "67231.12000000", "q": "0.00230000",
    "t": 1730000000112, "m": true
  }
}
```

`t` is trade time. `m` is true when the buyer is the market maker.

### `candle`

One frame per second per symbol, always, without exception.

```json
{
  "v": 1, "seq": 5, "type": "candle", "ts": 1730000001000,
  "data": {
    "symbol": "BTCUSDT", "closed": true,
    "t": 1730000000000, "o": "67230.00", "h": "67232.10",
    "c": "67231.12", "l": "67229.50", "v": "3.44100000", "n": 118
  }
}
```

A second with no trades still emits a frame: `o`, `h`, `l`, `c` all equal to the
previous close, `v` is `"0"`, `n` is `0`. The `t` values across consecutive
`candle` frames must increase by exactly 1000. The verifier checks this.

### `status`

```json
{
  "v": 1, "seq": 6, "type": "status", "ts": 1730000000200,
  "data": {
    "upstream": "connected",
    "resyncCount": 1,
    "lastResyncAt": 1730000000150,
    "droppedFrames": 0
  }
}
```

`upstream` is one of `connected`, `reconnecting`, `degraded`, `replay_complete`.
Emitted on every state change, and at most once per second otherwise.

### `error`

```json
{
  "v": 1, "seq": 7, "type": "error", "ts": 1730000000300,
  "data": { "code": "RESUME_TOO_OLD", "message": "human readable" }
}
```

Codes: `BAD_REQUEST`, `UNKNOWN_SYMBOL`, `RESUME_TOO_OLD`, `SLOW_CONSUMER`,
`INTERNAL`.

---

## `/health`

`GET /health` returns:

```json
{
  "upstreamConnections": 1,
  "clientCount": 5,
  "resyncCount": 1,
  "lastResyncAt": 1730000000150,
  "snapshotRequests": 3,
  "rejectedFrames": 0,
  "lateTrades": 0,
  "droppedFrames": 0,
  "uptimeMs": 1800000,
  "rssBytes": 91234304
}
```

- `snapshotRequests` counts every attempt, including ones the exchange refused.
  A refusal is still a request as far as your rate limit is concerned.
- `rejectedFrames` counts upstream frames you discarded as malformed or invalid.
- `lateTrades` counts trades that arrived after their candle had already closed.

---

## Replay mode

Your server must support exactly this, because it is what the verifier runs:

```bash
npm run serve -- --replay <tape.ndjson> --port <n>
```

Both flags are required. `lib/replay.mjs` reads the tape for you.

**Time.** The tape carries logical timestamps. They are your clock, including
the `ts` on every envelope you send. Nothing on the path to output may call
`Date.now()` or produce a random value, because two replays of one tape must
produce byte identical output. Session ids are the single exception and are
excluded from the comparison.

**Start.** Begin replaying when the first client subscribes, not at process
start. Otherwise the tape races your first connection and the run stops being
reproducible.

**Snapshots.** There is no REST endpoint in replay mode. Snapshots come from the
tape via `ReplaySource.fetchSnapshot()`, which enforces the same shape of limit
the real endpoint does: one success per second of logical time, and a
`RateLimitError` if you ask sooner. Handle it. Resyncing in a tight loop is how
you get a production IP banned by an exchange.

**Late trades.** A trade whose `T` falls inside a candle you have already closed
and sent cannot be applied retroactively. Discard it and count it in
`lateTrades`. You can only reach this case if you bucket by trade time to begin
with.

**End.** When the tape is exhausted, emit a final `status` with
`"upstream": "replay_complete"`, then close every client connection with code
`1000`. The verifier waits for that close.

---

## Invariants the verifier asserts

Violate any of these and the run fails.

1. Every frame is valid JSON with `v: 1` and an integer `ts`.
2. `seq` starts at 1 and increments by exactly 1, per client session.
3. The first frame is `hello`, and a `snapshot` arrives before any `book`,
   `trade` or `candle`.
4. Every price and quantity is a decimal string.
5. Best bid stays strictly below best ask, across the whole run, in the book
   reconstructed from your own snapshot and deltas.
6. No level with quantity `"0"` ever appears in a `snapshot`.
7. `candle.t` increases by exactly 1000, with no gaps and no duplicates.
8. A fifteen decimal place price from the tape reaches a candle high unchanged,
   compared as strings.
9. The high of the candle spanning 100000.00 is chosen numerically. Comparing
   price strings directly picks `"99999.98000000"` and fails here.
10. The candle series over a fixed window hashes to the expected value.
11. Two replays of the same tape produce identical output.
12. `/health` reports one upstream connection and at least one resync, because
    the tape contains a deliberate sequence gap.
9. Two replay runs of the same tape produce byte identical output.
