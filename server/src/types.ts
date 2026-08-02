// Domain types. No `any` here or in any file that imports only from here.

export type PriceLevel = [string, string];

export interface SnapshotData {
  lastUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface DepthUpdate {
  U: number;
  u: number;
  b: PriceLevel[];
  a: PriceLevel[];
}

export interface TradeData {
  id: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

export type UpstreamStatus = 'connected' | 'reconnecting' | 'degraded' | 'replay_complete';

export interface HealthStats {
  upstreamConnections: number;
  clientCount: number;
  resyncCount: number;
  lastResyncAt: number | null;
  snapshotRequests: number;
  rejectedFrames: number;
  lateTrades: number;
  droppedFrames: number;
  uptimeMs: number;
  rssBytes: number;
}

export type ErrorCode = 'BAD_REQUEST' | 'UNKNOWN_SYMBOL' | 'RESUME_TOO_OLD' | 'SLOW_CONSUMER' | 'INTERNAL';

// --- client -> server ops ---------------------------------------------------

export interface SubscribeOp {
  op: 'subscribe';
  symbol: string;
  depth: number;
}

export interface ResumeOp {
  op: 'resume';
  sessionId: string;
  lastSeq: number;
}

export interface PingOp {
  op: 'ping';
  id: number;
}

export type ClientOp = SubscribeOp | ResumeOp | PingOp;

// --- server -> client envelope ----------------------------------------------

export type FrameType = 'hello' | 'snapshot' | 'book' | 'trade' | 'candle' | 'status' | 'pong' | 'error';

export interface Envelope<T = unknown> {
  v: 1;
  seq: number;
  type: FrameType;
  ts: number;
  data: T;
}
