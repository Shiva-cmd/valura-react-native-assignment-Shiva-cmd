# AI usage

Generated end to end with Claude Code (Sonnet 5), working directly in this
repo across an extended session: architecture, implementation, debugging,
and this documentation. Every file under `core/`, `server/`, `app/`,
`tests/`, and the docs (`README.md` additions, `DECISIONS.md`, this file)
came out of that session, driven by conversation rather than typed by hand
line by line.

What that looked like concretely:

- **Read first, then built**: the model read `README.md`, `PROTOCOL.md`,
  and `CLIENT_CONTRACT.md` in full before writing anything, and worked out
  the exact fixture semantics (e.g. how gap detection interacts with
  `lastUpdateId`, the precise VWAP rounding rule) by hand-tracing the
  fixtures rather than guessing.
- **Verified as it went, not after**: the client core and server were built
  against `verify-client.mjs`/`verify.mjs` iteratively - write, run, read
  the failure, fix - rather than written once and hoped to pass.
- **The property test caught a real bug it didn't go looking for**: fixing
  an over-eager gap detector introduced a server/client divergence (broadcasting
  deltas the server had itself discarded as stale). The fast-check test
  surfaced this directly; it wasn't anticipated when the fix was written.
  See `DECISIONS.md` #5.
- **The one thing that didn't get resolved**: the exact candle-series hash
  in `verify.mjs` doesn't match, despite the series passing every other
  check and matching two independent reference computations byte-for-byte.
  The session tried several concrete hypotheses (late-trade handling,
  duplicate messages, precision, bucket alignment) and ruled each out with
  direct evidence rather than declaring victory - documented as a known
  limitation instead of a silent gap.
- **Real numbers, not estimates**: the `/health` output in the README and
  the instrumentation in `app/src/metrics/` were run against the actual
  server (including live Binance for the 5-client demo, since replay mode
  finishes too fast for a steady-state snapshot), not written from
  expectation.

What I have not yet done as the candidate: sat with every file end to end
the way I will need to before round 3. That review - understanding the
depth-sync reconciliation, the backpressure policy, and the chart's
UI-thread data path well enough to extend any of it live - is the next
thing on my list, not something I'm claiming already happened.
