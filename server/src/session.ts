// Per-client session: outgoing seq counter, resume buffer, and the
// backpressure policy (A5).
//
// Policy: a client's own outgoing frames go straight out while its socket
// drains normally. Once its `bufferedAmount` crosses SOFT_LIMIT_BYTES, book
// deltas stop being sent individually and instead accumulate into one pending
// merged delta (conflate to latest state) until the socket drains below the
// limit; trade prints are dropped outright for that client in the meantime,
// since price history is still available from candles. Candles and status
// are never dropped. If bufferedAmount stays above HARD_LIMIT_BYTES, the
// client is not fast enough to keep at all: send SLOW_CONSUMER and close.
//
// Whatever gets shed, `seq` is only ever assigned to a frame at the moment it
// is actually written to this session's socket, so what the client receives
// is always contiguous - the tension PROTOCOL.md calls out under A5.

import type { WebSocket } from 'ws';
import type { Envelope, FrameType, PriceLevel } from './types.js';

export const SOFT_LIMIT_BYTES = 256 * 1024;
export const HARD_LIMIT_BYTES = 8 * 1024 * 1024;
const HISTORY_CAP = 5000;

export class ClientSession {
  readonly sessionId: string;
  ws: WebSocket | null;
  private seq = 0;
  private history: Envelope[] = [];
  private pendingBids = new Map<string, string>();
  private pendingAsks = new Map<string, string>();
  private hasPendingBook = false;
  private closed = false;

  droppedFrames = 0;
  lastSeenAt: number;

  constructor(sessionId: string, ws: WebSocket, now: number) {
    this.sessionId = sessionId;
    this.ws = ws;
    this.lastSeenAt = now;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isSlow(): boolean {
    return (this.ws?.bufferedAmount ?? 0) >= HARD_LIMIT_BYTES;
  }

  /** Always sent: hello, snapshot, status, pong, error, and (per protocol) candles. */
  sendAlways(type: FrameType, data: unknown, ts: number): void {
    this.write(type, data, ts);
  }

  /** Trade prints are shed under backpressure rather than queued. */
  sendTrade(data: unknown, ts: number): void {
    if (!this.ws || this.ws.bufferedAmount >= SOFT_LIMIT_BYTES) {
      this.droppedFrames++;
      return;
    }
    this.write('trade', data, ts);
  }

  /** Book deltas are merged (conflated) rather than dropped: nothing is lost, just batched. */
  queueBookDelta(bids: PriceLevel[], asks: PriceLevel[]): void {
    for (const [p, q] of bids) this.pendingBids.set(p, q);
    for (const [p, q] of asks) this.pendingAsks.set(p, q);
    this.hasPendingBook = true;
  }

  /** Flush the merged book delta if the socket has room. Call this often. */
  flushBook(ts: number): void {
    if (!this.hasPendingBook || !this.ws) return;
    if (this.ws.bufferedAmount >= SOFT_LIMIT_BYTES) {
      this.droppedFrames++;
      return;
    }
    const bids = [...this.pendingBids.entries()] as PriceLevel[];
    const asks = [...this.pendingAsks.entries()] as PriceLevel[];
    this.pendingBids.clear();
    this.pendingAsks.clear();
    this.hasPendingBook = false;
    this.write('book', { bids, asks }, ts);
  }

  private write(type: FrameType, data: unknown, ts: number): void {
    if (!this.ws || this.closed) return;
    const env: Envelope = { v: 1, seq: ++this.seq, type, ts, data };
    this.history.push(env);
    if (this.history.length > HISTORY_CAP) this.history.shift();
    try {
      this.ws.send(JSON.stringify(env));
    } catch {
      /* socket already gone; the close handler will clean up */
    }
  }

  /** Frames after `lastSeq`, if still buffered. `null` means resume is too old. */
  framesAfter(lastSeq: number): Envelope[] | null {
    if (this.history.length === 0) return lastSeq === this.seq ? [] : null;
    const oldestBuffered = this.history[0]?.seq ?? this.seq + 1;
    if (lastSeq < oldestBuffered - 1) return null;
    return this.history.filter((f) => f.seq > lastSeq);
  }

  detach(): void {
    this.ws = null;
  }

  markClosed(): void {
    this.closed = true;
    this.ws = null;
  }
}

/** Retains sessions briefly after disconnect so `resume` can find them. */
export class SessionRegistry {
  private sessions = new Map<string, ClientSession>();
  private readonly retentionMs: number;

  constructor(retentionMs = 120_000) {
    this.retentionMs = retentionMs;
  }

  add(session: ClientSession): void {
    this.sessions.set(session.sessionId, session);
  }

  get(sessionId: string): ClientSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): ClientSession[] {
    return [...this.sessions.values()];
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => s.ws !== null).length;
  }

  /** Evict sessions that disconnected more than retentionMs ago (by `now`). */
  sweep(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.ws === null && now - session.lastSeenAt > this.retentionMs) {
        this.sessions.delete(id);
      }
    }
  }
}
