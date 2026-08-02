// The non-React core of the app. Owns the WebSocket, the four client-core
// state machines, and the candle aggregators. Everything React touches is
// either the low-frequency Store (connection status, resume info) or a
// Reanimated shared value (price ticks, candle series) that the chart reads
// on the UI thread without ever going through a React re-render.
//
// This is where the client core (../../../core/*.mjs - the exact modules
// verify-client.mjs checks) gets wired to a real socket. Nothing here
// duplicates that logic; it only drives it.

import { makeMutable, type SharedValue } from 'react-native-reanimated';
import { createConnection, createBook, createAggregator } from '../../../core/index.mjs';
import { Store } from './store';
import { DEFAULT_PORT, DEPTH, MAX_BACKOFF_MS, STALE_AFTER_MS, SYMBOL, defaultServerHost } from './config';
import type { Candle, Envelope, ErrorData, HelloData, SnapshotData, StatusData, TradeData } from './protocolTypes';
import { markConnectStart, markFirstLive, markLiveAfterForeground } from '../metrics/instrumentation';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'stale';
export type Interval = 1000 | 5000 | 60000;

export interface EngineState {
  connState: ConnState;
  upstream: StatusData['upstream'] | 'unknown';
  lastError: string | null;
  resyncCount: number;
  bookVersion: number; // bumped on every applied book/snapshot frame
  interval: Interval;
}

interface ConnectionCore {
  readonly state: ConnState;
  send(event: { type: 'open' } | { type: 'frame'; frame: unknown; now: number } | { type: 'close' } | { type: 'error' } | { type: 'tick'; now: number }): ConnState;
  nextBackoffMs(): number;
  resumeToken(): { sessionId: string; lastSeq: number } | null;
}

interface BookCore {
  readonly usable: boolean;
  readonly lastUpdateId: number;
  apply(envelope: unknown): { ok: boolean; gap: boolean; reason?: string };
  top(n: number): { bids: [string, string][]; asks: [string, string][] };
}

interface AggregatorCore {
  push(candle: Candle): Candle;
  series(): Candle[];
}

// createConnection is plain JS (core/connection.mjs, no static types - the
// same module verify-client.mjs exercises). This is the one place that
// boundary gets cast; everything else in this file is fully typed against
// the interfaces above.
function newConnectionCore(): ConnectionCore {
  return createConnection({
    staleAfterMs: STALE_AFTER_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
  }) as unknown as ConnectionCore;
}

function newAggregators(): Record<Interval, AggregatorCore> {
  return {
    1000: createAggregator(1000),
    5000: createAggregator(5000),
    60000: createAggregator(60000),
  };
}

const CHART_POINT_CAP = 300;

export class TradingEngine {
  readonly store = new Store<EngineState>({
    connState: 'connecting',
    upstream: 'unknown',
    lastError: null,
    resyncCount: 0,
    bookVersion: 0,
    interval: 1000,
  });

  // High-frequency, UI-thread-only outputs. The chart reads these directly;
  // updating them never triggers a React render.
  readonly livePrice: SharedValue<number> = makeMutable(0);
  readonly closes: SharedValue<number[]> = makeMutable<number[]>([]);
  readonly candleTimes: SharedValue<number[]> = makeMutable<number[]>([]);

  // Scrub state, set directly by the chart's gesture worklet (UI thread) and
  // read by both the chart (marker) and the price header (scrubbed value).
  readonly scrubActive: SharedValue<boolean> = makeMutable(false);
  readonly scrubIndex: SharedValue<number> = makeMutable(-1);

  readonly book: BookCore = createBook();

  private connection: ConnectionCore = newConnectionCore();

  private aggregators: Record<Interval, AggregatorCore> = newAggregators();

  private ws: WebSocket | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByApp = false;
  private host = defaultServerHost();
  private port = DEFAULT_PORT;

  setServer(host: string, port: number): void {
    this.host = host;
    this.port = port;
  }

  start(): void {
    this.closedByApp = false;
    markConnectStart();
    this.openSocket();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => {
        const state = this.connection.send({ type: 'tick', now: Date.now() });
        this.syncConnState(state);
      }, 400);
    }
  }

  /** Used on app foreground and on detected gaps: abandon everything buffered, reconnect clean. */
  hardReset(): void {
    this.closeSocketQuiet();
    this.connection = newConnectionCore();
    this.store.set({ connState: 'connecting' });
    markConnectStart();
    this.openSocket();
  }

  stop(): void {
    this.closedByApp = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocketQuiet();
  }

  setInterval(interval: Interval): void {
    this.store.set({ interval });
    this.rebuildChartSeries();
  }

  private closeSocketQuiet(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  private openSocket(): void {
    const url = `ws://${this.host}:${this.port}/stream`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      const state = this.connection.send({ type: 'open' });
      this.syncConnState(state);
      const token = this.connection.resumeToken();
      if (token) {
        ws.send(JSON.stringify({ op: 'resume', sessionId: token.sessionId, lastSeq: token.lastSeq }));
      } else {
        ws.send(JSON.stringify({ op: 'subscribe', symbol: SYMBOL, depth: DEPTH }));
      }
    };

    ws.onmessage = (event: { data: string }) => {
      this.handleMessage(event.data);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // stale handler from a socket we already replaced
      this.ws = null;
      const state = this.connection.send({ type: 'close' });
      this.syncConnState(state);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows any error on RN's WebSocket; nothing else to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByApp || this.reconnectTimer) return;
    const delay = this.connection.nextBackoffMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByApp) this.openSocket();
    }, delay);
  }

  private syncConnState(state: ConnState): void {
    if (state === this.store.get().connState) return;
    this.store.set({ connState: state });
    if (state === 'live') {
      markFirstLive();
      markLiveAfterForeground();
    }
  }

  private handleMessage(raw: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return; // malformed frame from a well-behaved server should not happen; ignore defensively
    }

    const state = this.connection.send({ type: 'frame', frame: envelope, now: Date.now() });
    this.syncConnState(state);

    switch (envelope.type) {
      case 'snapshot':
        this.handleSnapshot(envelope);
        break;
      case 'book':
        this.handleBookDelta(envelope);
        break;
      case 'trade':
        this.handleTrade(envelope.data as TradeData);
        break;
      case 'candle':
        this.handleCandle(envelope.data as Candle & { symbol: string; closed: boolean });
        break;
      case 'status':
        this.handleStatus(envelope.data as StatusData);
        break;
      case 'error':
        this.handleError(envelope.data as ErrorData);
        break;
      case 'hello':
        this.handleHello(envelope.data as HelloData);
        break;
      default:
        break;
    }
  }

  private handleHello(_data: HelloData): void {
    this.store.set({ lastError: null });
  }

  private handleSnapshot(envelope: Envelope): void {
    // The book needs the real envelope (seq included) - CLIENT_CONTRACT.md:
    // transport `seq` is how gap detection works, and a snapshot resets the
    // expected sequence to this frame's seq + 1 for every frame after it.
    this.book.apply(envelope);
    const data = envelope.data as SnapshotData;
    // A snapshot arrives both on first connect and on every resync. Its
    // `candles` is always the trailing 300s, so re-pushing it into
    // aggregators that are already running (a resync, not the first
    // connect) would double count and, worse, hand createAggregator a
    // timestamp earlier than its already-open bucket - corrupting bucket
    // order. Rebuilding fresh aggregators here makes every snapshot a clean
    // restart of candle history, first connect or not.
    this.aggregators = newAggregators();
    for (const agg of Object.values(this.aggregators)) {
      for (const candle of data.candles) agg.push(candle);
    }
    this.rebuildChartSeries();
    const last = data.candles.at(-1);
    if (last) this.livePrice.value = Number(last.c);
    this.bumpBookVersion();
  }

  private handleBookDelta(envelope: Envelope): void {
    const result = this.book.apply(envelope);
    if (result.gap) {
      // Our own session's frame numbering broke - vanishingly rare given the
      // server's contiguous-seq guarantee, but if it happens the book is no
      // longer real (per CLIENT_CONTRACT.md) and limping on is not an option.
      this.hardReset();
      return;
    }
    this.bumpBookVersion();
  }

  private handleTrade(data: TradeData): void {
    this.livePrice.value = Number(data.p);
  }

  private handleCandle(data: Candle): void {
    const active = this.aggregators[this.store.get().interval];
    active.push(data);
    for (const [key, agg] of Object.entries(this.aggregators)) {
      if (Number(key) !== this.store.get().interval) agg.push(data);
    }
    this.rebuildChartSeries();
  }

  private handleStatus(data: StatusData): void {
    this.store.set({ upstream: data.upstream, resyncCount: data.resyncCount });
  }

  private handleError(data: ErrorData): void {
    this.store.set({ lastError: `${data.code}: ${data.message}` });
  }

  private bumpBookVersion(): void {
    this.store.set({ bookVersion: this.store.get().bookVersion + 1 });
  }

  private rebuildChartSeries(): void {
    const series = this.aggregators[this.store.get().interval].series();
    const windowed = series.slice(-CHART_POINT_CAP);
    this.closes.value = windowed.map((c) => Number(c.c));
    this.candleTimes.value = windowed.map((c) => c.t);
  }
}

export const engine = new TradingEngine();
