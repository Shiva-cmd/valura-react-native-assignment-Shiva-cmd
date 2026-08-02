# React Native Engineer, Round 2

## Real-Time Crypto Trading Panel

**Time budget:** about 20 hours for the required parts, across at least three
calendar days. Two sections are marked optional and add roughly 6 more.
**Deadline:** 5 August 2026, 23:59 IST
**Starter kit:** this repository. Read [README.md](README.md), then
[PROTOCOL.md](PROTOCOL.md).
**Submit:** through this form: https://forms.gle/79Sa228e7aNyLGzQ8
It takes your public Git repo link and your screen recording link. Both are
required, and the form is the only submission channel. The recording is
specified in C3: 5 minutes maximum, one take, no cuts.

---

## Read this first

Use Claude, Cursor, Copilot, whatever you like. We do. We are not going to
police it and we are not impressed by candidates who avoid it.

You should understand what this is calibrated for. A model will produce a
working version of the obvious brief, "stream Binance prices into a chart", in
about ten minutes. So that is not the assignment. What follows has correctness
requirements that models reliably get wrong, a wire protocol you must conform to
rather than invent, performance budgets you have to measure rather than claim,
a grading tape you will never see, and a final round where you extend your own
code live with us watching.

Generate as much of it as you want. Just make sure you understand every line
before you push, because in round three you will be alone with it.

---

## What you are building

A real-time BTCUSDT trading panel, Robinhood inspired. A Node backend that
consumes Binance public WebSocket streams, and a React Native client that
consumes your backend over the protocol we give you. No real trading.

The interesting part is not the pipe. It is what happens when the pipe breaks.

---

## Part A: Backend

Node.js. TypeScript required, `strict: true`, no `any` in the domain layer.

The wire format is specified in [PROTOCOL.md](PROTOCOL.md). It is fixed.
Implement it exactly.

### A1. One upstream, many clients

Your server holds **one** connection to Binance regardless of how many clients
attach. Ten clients connect, Binance still sees one socket.

`/health` must report `upstreamConnections: 1` with five clients attached, and
your README must show that output.

### A2. Maintain a real order book

Consume the BTCUSDT depth diff stream and maintain a correct local L2 book.
Binance documents the snapshot-and-buffer synchronisation procedure and its
sequence number rules under "How to manage a local order book correctly". Follow
it. This is most of the difficulty in Part A, it is fully documented, and there
is no excuse for guessing.

Specifically:

- **Cold start ordering matters.** There is a correct order in which to start
  buffering and fetch the snapshot. Getting it backwards produces a book that
  looks fine and is quietly wrong.
- **Detect sequence gaps.** Never apply a diff you cannot prove is contiguous.
- **On a gap, resynchronise** from a fresh snapshot. Do not limp on with a
  corrupt book.
- **Rate limit your snapshot fetches.** Binance will 429 and then IP ban you for
  hammering the REST endpoint. A resync loop with no backoff will get you banned
  during your own soak test. `/health` exposes `snapshotRequests`; we will look
  at it.
- **Invariants**: no zero quantity level is ever stored, and best bid is always
  strictly below best ask. Assert these in code, loudly.

### A3. Candles

Aggregate trades into 1 second OHLCV candles server side.

- The series is **monotonic and gapless**. A second with no trades emits a flat
  candle at the previous close, volume `"0"`, count `0`. Never a hole.
- Bucket by **trade time, not receive time**. These differ, and the difference
  is visible under replay.

### A4. Numbers

Binance sends prices and quantities as decimal strings. Some values carry more
significant digits than an IEEE 754 double holds.

Your server must not corrupt a number anywhere between ingest and delivery.
`PROTOCOL.md` requires strings on the wire, which handles transport. It does not
handle what you do in between: aggregation, comparison, sorting, and OHLC
calculation all have to preserve exactness.

Pick an approach, implement it, and state the guarantee in `DECISIONS.md`. The
grading tape contains values chosen specifically to break the naive one.

### A5. Backpressure

One client is on bad 3G and cannot drain as fast as you produce.

Your server must not grow an unbounded send queue. Choose a policy: conflate to
latest book state, drop intermediate frames, disconnect with `SLOW_CONSUMER`,
something else. State which and why. Your soak test must show flat memory with
one artificially throttled client attached.

Note the tension with `PROTOCOL.md`: `seq` must increment by exactly one per
frame *sent*. Whatever you shed, the sequence the client actually receives stays
contiguous. Think about what that implies for your design.

### A6. Late joiners converge

A client connecting at minute zero and one connecting at minute ten must hold
identical book state at minute eleven. A late joiner gets a `snapshot` then
deltas, never a bare delta tail.

### A7. Hostile input

Upstream is not trustworthy. Malformed JSON, a truncated frame, a field that
changes type, a negative quantity, an absurdly large message. None of these may
crash your process or corrupt the book. Reject, count, carry on.

### A8. Deterministic replay

```bash
npm run serve -- --replay tapes/pathological.ndjson
```

In replay mode the server reads recorded upstream messages from file rather than
connecting to Binance, and produces **byte identical output on every run**.

This means no wall clock and no randomness anywhere on the path to output. Your
clock is an injected dependency, not a global. So is your ID generation. If you
find that awkward to retrofit, that is the requirement doing its job.

### A9. The verifier

The starter repo ships `tapes/pathological.ndjson` and `verify.mjs`:

```bash
node verify.mjs
```

The tape contains out of order messages, duplicates, a sequence gap, a
thousand message burst, a mid-stream disconnect, hostile frames, and high
precision values.

**We grade against a second tape you have never seen.** It contains everything
the public tape does, plus pathologies it does not. Passing the public tape is
necessary and not sufficient. Do not tune to it. Build the general thing.

The same is true of `verify-client.mjs` and its fixtures. Both verifiers are
hard gates, on both the public and the hidden inputs. Failing any of the four
ends the review.

---

## Part B: React Native client

Expo or bare, your call.

### B1. The client core

Four pure modules, specified in `CLIENT_CONTRACT.md`, verified by
`npm run verify:client`:

| Module | What it owns |
|---|---|
| `createConnection` | Connection state machine, staleness, backoff schedule, resume token |
| `createBook` | Applying snapshots and deltas, detecting `seq` gaps |
| `estimateFill` | VWAP across the book, slippage, insufficient depth |
| `createAggregator` | Rolling 1s candles into 5s and 1m, incrementally |

This is the only place we tell you how to structure anything, and we do it for
one reason: logic that can be tested without a device is logic anyone can
trust. A trading client whose state machine only exists inside a React component
is one nobody can verify, including you. Everything above these four modules is
entirely yours.

Read the contract properly. It is precise about the edges, and the edges are
where the points are.

### B2. Wire it up

The core is pure. The app is not. You still have to:

- Open a real socket and drive the state machine from it.
- Back off using `nextBackoffMs()` between attempts, with jitter.
- Reconnect with the `resume` op and your `resumeToken()`, and handle the case
  where the server says the resume is too old.
- Show three honest states: **LIVE**, **RECONNECTING**, **STALE**.
- Act on a `gap` result. Your book is no longer real, so stop presenting it as
  though it is and get a fresh snapshot.

### B3. Stale data must look stale

No tick for more than 2 seconds: the price display visually degrades and the
buy/sell controls disable.

A trading UI that keeps showing a confident price after the feed died is worse
than one showing nothing at all. We care about this more than we care about your
animations.

### B4. App lifecycle

Background the app for two minutes and foreground it.

It must not replay two minutes of buffered frames into the renderer, and it must
not come back showing a stale price as live. Resync. Getting this wrong is the
single most common failure in shipped React Native trading apps, including ones
you have used.

### B5. Chart, hand rolled

**No charting library.** Not `react-native-chart-kit`, not Victory, not
`wagmi-charts`, not a WebView with Lightweight Charts inside it. You may use
`react-native-skia` or `react-native-reanimated` as rendering and animation
primitives, and you draw the chart yourself.

- **Budget: sustained 60fps while receiving 200 messages per second**, on a mid
  range Android device or equivalent emulator. If you cannot hit it, say so with
  numbers and explain what you would do next. That is worth more than a claim we
  do not believe.
- **Interval switching** (*optional, roughly 3 hours*): 1s, 5s, 1m, driven by
  your `createAggregator`. The module is required and verified either way. This
  is about wiring it to a control and re-rendering without a stall.
- **Scrub**: press and drag along the chart to inspect a point, with the price
  header showing that point's value and the change recalculated from it. This is
  Robinhood's signature interaction. Gesture tracking runs on the UI thread. A
  scrub that round trips through JS state per frame will visibly lag and you
  will see it in your own numbers.

The naive approach to all of this is `setState` per tick. It will not hold the
budget, and your instrumentation will tell you so before we do.

### B6. Trade panel

Robinhood inspired. Clean type, dark palette, prominent price, buy and sell.

One functional requirement: as the user enters a quantity, show the **estimated
fill price and slippage** from your `estimateFill`, computed against the live
book. Buying 0.01 BTC and buying 40 BTC must show visibly different estimates,
and the estimate must move as the book
moves.

If the order would consume more depth than you hold, say so rather than
extrapolating.

No order submission. The estimate is the point: it makes the order book load
bearing rather than decorative.

### B7. RTL (*optional, roughly 3 hours*)

The whole panel renders correctly with `I18nManager.forceRTL(true)`. Numerals
stay LTR, layout mirrors, the chart does not.

We ship to the UAE and every screen we build works in Arabic, so this is real
work rather than a curiosity. It is optional here only because it is expensive
to retrofit and we would rather you spent the time on the core. If you do it,
say so in the README and it counts.

---

## Part C: Prove it

### C1. `METRICS.md`

Numbers you measured, with instrumentation you shipped in the code. Not
estimates.

| Metric | Yours | How you measured it |
|---|---|---|
| Tick to paint latency, p50 / p99 | | |
| Dropped JS frames per minute at 200 msg/s | | |
| Scrub gesture frame time, p99 | | |
| Reconnect to first rendered tick | | |
| Foreground resync to LIVE | | |
| RSS after 30 minute soak, start vs end | | |
| RSS with one throttled client attached | | |
| Order book resyncs during soak | | |
| Snapshot requests during soak | | |

A number without a method is not a number.

### C2. One test that matters

You do not need broad coverage. `verify-client.mjs` already covers your core.
What it cannot cover is the shape of input nobody thought of.

So: **one property based test** over your server side order book, asserting its
invariants across generated sequences of diffs including duplicates, gaps and
out of order arrivals. `fast-check` or equivalent. One good property beats forty
example tests, and it is the kind of test that finds the bug you did not think
of.

### C3. Recording, 5 minutes maximum, one take

No cuts, no edits. This sequence, in order:

1. App live, chart moving, scrub working.
2. Kill the backend. Client goes RECONNECTING then STALE, controls disable.
3. Restart it. Client recovers to LIVE with no manual app restart.
4. Background the app, wait, foreground it. It resyncs.

That takes about 90 seconds. Use whatever remains of the 5 minutes however you
like: walk through a decision you are proud of, show the optional sections if
you built them, or stop at 90 seconds. Going over 5 minutes, cutting, or editing
fails the requirement.

Upload it anywhere link-shareable (YouTube unlisted, Loom, Drive) and make sure
the link opens without a permission request. A video we cannot open is a video
that was not submitted.

### C4. `DECISIONS.md`, 800 words maximum

Five decisions. For each: what you chose, what you rejected, why. One of the
five must be something you got wrong first and had to change. Link the commit.

Three we specifically want: your numeric precision guarantee (A4), your
backpressure policy and how it coexists with contiguous `seq` (A5), and your
chart data path (B4).

Being concise is part of the test.

### C5. `AI.md`, half a page

Which parts you generated, which you wrote, which you generated and then
rewrote.

This does not affect your score. It is not a trap and there is no right answer.
It tells us which file to open in round three, and it means we do not waste that
call asking you to explain something you never claimed to have written by hand.
Everyone uses these tools. Engineers who are straight about how are easier to
work with.

---

## What we will not accept

Concrete, so there is no ambiguity later:

- An order book built from `bookTicker` (best bid/ask only) presented as depth.
- An order book "maintained" by re-fetching the REST snapshot on a timer.
- Diffs applied without validating the sequence numbers.
- A charting library behind a thin wrapper, or a WebView.
- A client core that exists only to satisfy the harness, with the app's real
  logic duplicated inside components. We read both.
- `METRICS.md` numbers with no corresponding instrumentation in the code.
- A `git log` that is one commit, or three commits in one evening.
- Code tuned to `pathological.ndjson` or `client.public.json` specifically
  rather than to the general problem.

Any of these means we stop reading. Shipping less, and saying so plainly in the
README, always scores better.

---

## Ground rules

**Commits.** At least 20 commits across at least three calendar days, pushed
incrementally rather than in one burst. We read the history. It is the cheapest
signal we have and we use it first.

**Dependencies.** Budget of 10 runtime dependencies on the server, excluding
types. List each in the README with one line on why it earns its place. We are
not testing asceticism, we are testing whether you chose or whether you
accumulated.

**README.md.** How to run both halves from a clean clone on a machine that is
not yours. Which Binance streams you chose and what you rejected. Known
limitations, honestly listed.

**Running out of time.** Cut in this order, from the bottom: B7 RTL, then B5
interval switching, then C2. Both are marked optional and neither is a gate.

Never cut the client core or Part A correctness. Those are the gates, and an
honest README saying what you left undone beats a complete submission with a
fake order book. We will find the fake order book.

---

## Round 3: live extension, 45 minutes

If you clear the gates, we get on a call. You share your screen, we hand you a
change to your own code, and you make it. Assistants off for that 45 minutes.

We are not testing recall, and we are not going to ask you to invert a binary
tree. We are testing whether you can navigate a codebase you are supposed to
have written. If you built this properly it is a comfortable 45 minutes and
honestly a pleasant conversation.

---

## Scoring

**Hard gates.** Failing any one ends the review, whatever the rest looks like.

- `npm run verify` passes, the server tape
- `npm run verify:client` passes, the client fixtures
- Both again against a second tape and a second fixture set you have not seen
- Order book genuinely maintained from the diff stream with sequence validation
- One upstream connection, demonstrated at `/health`
- Commit history spans at least three days

Note that the gates are on both halves. A flawless server with an unverifiable
client fails, and so does the reverse. That is deliberate: we are hiring someone
to build the client, and the server is there to make the client's job real.

| Area | Points |
|---|---|
| Client core: connection machine, gap detection, fill estimation, aggregation | 20 |
| Chart: hand rolled, scrub, frame budget | 16 |
| Trade panel: Robinhood quality, live fill estimate, RTL if you did it | 12 |
| Order book correctness and protocol conformance | 16 |
| Server resilience: backpressure, resync backoff, hostile input | 9 |
| Measurement: real instrumentation, real numbers, honest limitations | 7 |
| Code structure, the property test, typing, dependency discipline, commits | 5 |
| Live extension round | 15 |
| **Total** | **100** |

Roughly half the marks are React Native, because that is the job. Visual polish
on its own is 12 of 100: a beautiful app over a fake book scores below a plain
app over a correct one, and it is not close.

Questions welcome before you start, and asking good ones counts in your favour.
Good luck.
