// Shared interface between the replay tape and a live Binance connection.
// depthSync.ts and server.ts are written against this and never know which
// one they're talking to.

import type { SnapshotData } from './types.js';

export interface DepthUpdateMessage {
  e: 'depthUpdate';
  U: number;
  u: number;
  b: [string, string][];
  a: [string, string][];
}

export interface TradeMessage {
  e: 'trade';
  p: string;
  q: string;
  T: number;
  m: boolean;
  t?: number;
}

export type UpstreamEvent =
  | { kind: 'message'; ts: number; stream: string; data: unknown }
  | { kind: 'raw'; ts: number; payload: string }
  | { kind: 'disconnect'; ts: number }
  | { kind: 'reconnect'; ts: number }
  | { kind: 'end'; ts: number };

export interface UpstreamSource {
  events(): AsyncGenerator<UpstreamEvent>;
  fetchSnapshot(): Promise<SnapshotData>;
}

export function isDepthUpdateMessage(data: unknown): data is DepthUpdateMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.e === 'depthUpdate' && typeof d.U === 'number' && typeof d.u === 'number' && Array.isArray(d.b) && Array.isArray(d.a);
}

export function isTradeMessage(data: unknown): data is TradeMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.e === 'trade' &&
    typeof d.p === 'string' &&
    typeof d.q === 'string' &&
    typeof d.T === 'number' &&
    typeof d.m === 'boolean'
  );
}
