// Wire types per PROTOCOL.md, client side. Deliberately minimal - the app
// only needs enough shape to route frames to the right handler; the actual
// state machines (createConnection/createBook/etc.) live in the client core.

export type PriceLevel = [string, string];

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

export interface Envelope<T = unknown> {
  v: 1;
  seq: number;
  type: 'hello' | 'snapshot' | 'book' | 'trade' | 'candle' | 'status' | 'pong' | 'error';
  ts: number;
  data: T;
}

export interface HelloData {
  sessionId: string;
  symbols: string[];
  resumed: boolean;
  serverTime: number;
}

export interface SnapshotData {
  symbol: string;
  lastUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  candles: Candle[];
}

export interface BookData {
  symbol: string;
  lastUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface TradeData {
  symbol: string;
  id: number;
  p: string;
  q: string;
  t: number;
  m: boolean;
}

export interface StatusData {
  upstream: 'connected' | 'reconnecting' | 'degraded' | 'replay_complete';
  resyncCount: number;
  lastResyncAt: number | null;
  droppedFrames: number;
}

export interface ErrorData {
  code: 'BAD_REQUEST' | 'UNKNOWN_SYMBOL' | 'RESUME_TOO_OLD' | 'SLOW_CONSUMER' | 'INTERNAL';
  message: string;
}
