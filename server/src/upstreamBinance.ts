// Live upstream: one combined-stream WebSocket to Binance for depth diffs and
// trades, regardless of how many of our own clients are attached (A1), plus
// the REST depth snapshot endpoint, self-rate-limited the same way the replay
// tape enforces it so a resync storm cannot get an IP banned mid soak test.
//
// Not exercised by verify.mjs (that always runs --replay); this is what makes
// `npm run serve` without --replay talk to the real exchange.

import type { SnapshotData } from './types.js';
import type { UpstreamEvent, UpstreamSource } from './upstream.js';

const COMBINED_STREAM_URL = (symbol: string) =>
  `wss://stream.binance.com:9443/stream?streams=${symbol}@depth@100ms/${symbol}@trade`;
const REST_DEPTH_URL = (symbolUpper: string) =>
  `https://api.binance.com/api/v3/depth?symbol=${symbolUpper}&limit=1000`;

const SNAPSHOT_MIN_INTERVAL_MS = 1000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export class RateLimitError extends Error {
  constructor() {
    super('snapshot fetch attempted before the minimum interval elapsed');
    this.name = 'RateLimitError';
  }
}

export function createBinanceUpstream(symbol: string): UpstreamSource {
  const symbolLower = symbol.toLowerCase();
  const symbolUpper = symbol.toUpperCase();
  let lastSnapshotAt = -Infinity;

  return {
    async *events(): AsyncGenerator<UpstreamEvent> {
      let attempt = 0;
      for (;;) {
        const queue: UpstreamEvent[] = [];
        let notify: (() => void) | null = null;
        let closed = false;

        const push = (event: UpstreamEvent): void => {
          queue.push(event);
          notify?.();
        };

        const ws = new WebSocket(COMBINED_STREAM_URL(symbolLower));
        ws.onopen = () => {
          attempt = 0;
        };
        ws.onmessage = (ev: MessageEvent) => {
          try {
            const parsed = JSON.parse(String(ev.data)) as { stream: string; data: unknown };
            push({ kind: 'message', ts: Date.now(), stream: parsed.stream, data: parsed.data });
          } catch {
            push({ kind: 'raw', ts: Date.now(), payload: String(ev.data) });
          }
        };
        ws.onclose = () => {
          closed = true;
          push({ kind: 'disconnect', ts: Date.now() });
          notify?.();
        };
        ws.onerror = () => {
          /* onclose follows */
        };

        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
          while (queue.length > 0) {
            yield queue.shift() as UpstreamEvent;
          }
        }

        attempt++;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        yield { kind: 'reconnect', ts: Date.now() };
      }
    },

    async fetchSnapshot(): Promise<SnapshotData> {
      const since = Date.now() - lastSnapshotAt;
      if (since < SNAPSHOT_MIN_INTERVAL_MS) throw new RateLimitError();

      const res = await fetch(REST_DEPTH_URL(symbolUpper));
      if (!res.ok) {
        lastSnapshotAt = Date.now(); // a 429/418 still counts as a request against the rate limit
        throw new Error(`depth snapshot request failed: ${res.status}`);
      }
      const body = (await res.json()) as { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] };
      lastSnapshotAt = Date.now();
      return { lastUpdateId: body.lastUpdateId, bids: body.bids, asks: body.asks };
    },
  };
}
