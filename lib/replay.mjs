// Tape reader and replay source.
//
// This is plumbing. It is provided so that every submission parses the tape
// identically and nobody loses points to an ambiguity in our file format.
// Everything interesting is still yours to build.
//
// In replay mode your server reads upstream events from here instead of
// connecting to Binance. The tape carries logical timestamps. Those timestamps
// are your clock. Do not call Date.now() anywhere on the path to output.

import { readFileSync } from 'node:fs';

/**
 * Snapshot fetches are rate limited, exactly as Binance rate limits the REST
 * depth endpoint. Ask for one sooner than this after a successful fetch and you
 * get a 429 instead. There is no way around it other than backing off.
 */
export const SNAPSHOT_MIN_INTERVAL_MS = 1000;

export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`429 too many requests, retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.code = 429;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * One recorded upstream event.
 *
 * kind === 'message'    parsed Binance payload, in `data`, from `stream`
 * kind === 'raw'        an unparsed frame, in `payload`. May not be valid JSON.
 * kind === 'disconnect' upstream socket dropped
 * kind === 'reconnect'  upstream socket available again
 * kind === 'end'        tape exhausted, always the final event
 */

export class ReplaySource {
  #events;
  #snapshots;
  #cursor = 0;
  #snapshotCursor = 0;
  #now = 0;
  #lastSnapshotAt = -Infinity;

  constructor(lines) {
    this.#events = [];
    this.#snapshots = [];

    for (const [i, line] of lines.entries()) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (err) {
        throw new Error(`tape line ${i + 1} is not valid JSON: ${err.message}`);
      }

      if (entry.kind === 'snapshot') {
        this.#snapshots.push(entry);
        continue;
      }

      if (entry.kind === 'bloat') {
        // Expanded here so the tape file stays small. Arrives at your server as
        // one very large frame.
        this.#events.push({
          kind: 'raw',
          ts: entry.ts,
          payload: '{"e":"depthUpdate","pad":"' + 'x'.repeat(entry.bytes) + '"}',
        });
        continue;
      }

      this.#events.push(entry);
    }

    const lastTs = this.#events.length
      ? this.#events[this.#events.length - 1].ts
      : 0;
    this.#events.push({ kind: 'end', ts: lastTs });
  }

  static fromFile(path) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    return new ReplaySource(lines);
  }

  /** Current logical time, in ms. Advances as you consume events. */
  now() {
    return this.#now;
  }

  /**
   * Async iterator over upstream events, in tape order, as fast as your server
   * can consume them. Snapshot entries are not yielded here. They are served by
   * fetchSnapshot().
   */
  async *events() {
    while (this.#cursor < this.#events.length) {
      const event = this.#events[this.#cursor++];
      this.#now = event.ts;
      yield event;
    }
  }

  /**
   * The replay equivalent of GET /api/v3/depth.
   *
   * Returns the first snapshot in the tape at or after the current logical
   * time, which is what a live REST call would give you. Throws RateLimitError
   * if you ask again within SNAPSHOT_MIN_INTERVAL_MS of the last success.
   *
   * Counts towards `snapshotRequests` in /health whether it succeeds or not.
   * Both outcomes are requests as far as the exchange is concerned.
   */
  async fetchSnapshot() {
    const since = this.#now - this.#lastSnapshotAt;
    if (since < SNAPSHOT_MIN_INTERVAL_MS) {
      throw new RateLimitError(SNAPSHOT_MIN_INTERVAL_MS - since);
    }

    while (
      this.#snapshotCursor < this.#snapshots.length &&
      this.#snapshots[this.#snapshotCursor].ts < this.#now
    ) {
      this.#snapshotCursor++;
    }

    const entry = this.#snapshots[this.#snapshotCursor];
    if (!entry) {
      throw new Error(
        'no snapshot available at or after logical time ' + this.#now,
      );
    }

    this.#snapshotCursor++;
    this.#lastSnapshotAt = this.#now;
    return entry.data;
  }

  /** Total snapshots present in the tape. Diagnostics only. */
  get snapshotCount() {
    return this.#snapshots.length;
  }
}
