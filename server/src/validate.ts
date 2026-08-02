// Upstream is not trustworthy (A7). Everything that reaches the domain layer
// from a `message` or parsed `raw` frame goes through here first. Anything
// that fails is rejected and counted; nothing here ever throws on bad input.

import { isDecimalString, isNegative } from './decimal.js';
import type { DepthUpdateMessage, TradeMessage } from './upstream.js';

/** Frames larger than this are rejected before we even attempt to parse them. */
export const MAX_RAW_FRAME_BYTES = 2_000_000;

function isLevelArray(v: unknown): v is [string, string][] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (lvl) =>
      Array.isArray(lvl) &&
      lvl.length === 2 &&
      isDecimalString(lvl[0]) &&
      isDecimalString(lvl[1]) &&
      !isNegative(lvl[0]) &&
      !isNegative(lvl[1]),
  );
}

export function validateDepthUpdate(data: unknown): DepthUpdateMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.e !== 'depthUpdate') return null;
  if (typeof d.U !== 'number' || !Number.isFinite(d.U)) return null;
  if (typeof d.u !== 'number' || !Number.isFinite(d.u)) return null;
  if (d.u < d.U) return null;
  if (!isLevelArray(d.b) || !isLevelArray(d.a)) return null;
  return { e: 'depthUpdate', U: d.U, u: d.u, b: d.b, a: d.a };
}

export function validateTrade(data: unknown): TradeMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.e !== 'trade') return null;
  if (typeof d.p !== 'string' || !isDecimalString(d.p) || isNegative(d.p)) return null;
  if (typeof d.q !== 'string' || !isDecimalString(d.q) || isNegative(d.q)) return null;
  if (typeof d.T !== 'number' || !Number.isFinite(d.T)) return null;
  if (typeof d.m !== 'boolean') return null;
  return { e: 'trade', p: d.p, q: d.q, T: d.T, m: d.m };
}

export function validateSnapshot(data: unknown): { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] } | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.lastUpdateId !== 'number' || !Number.isFinite(d.lastUpdateId)) return null;
  if (!isLevelArray(d.bids) || !isLevelArray(d.asks)) return null;
  return { lastUpdateId: d.lastUpdateId, bids: d.bids, asks: d.asks };
}

/** Best-effort parse of a raw wire frame that may not even be JSON. */
export function parseRawPayload(payload: string): unknown | null {
  if (Buffer.byteLength(payload, 'utf8') > MAX_RAW_FRAME_BYTES) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
