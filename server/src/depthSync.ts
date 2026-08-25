// Binance's documented "how to manage a local order book correctly"
// procedure: buffer diffs, fetch a snapshot, discard buffered events already
// covered by it, verify the first remaining one actually bridges the
// snapshot, then apply. On any sequence gap in the live stream, do it again
// rather than limping on with a book that silently drifted.
//
// Snapshot fetches are rate limited (Binance 429s and then bans an IP that
// hammers it). `maybeResync` self-throttles to at most one attempt per
// SNAPSHOT_MIN_INTERVAL_MS of *logical* time, so a burst of gaps costs one
// resync, not one request per message in the burst.

import { OrderBook, BookInvariantError } from './orderbook.js';
import type { DepthUpdate, SnapshotData } from './types.js';

export interface SnapshotFetcher {
  fetchSnapshot(): Promise<SnapshotData>;
}

export const SNAPSHOT_MIN_INTERVAL_MS = 1000;

export class DepthSyncEngine {
  readonly book = new OrderBook();

  private buffer: DepthUpdate[] = [];
  private lastAppliedU: number | null = null;
  private needsResync = true;
  private lastSnapshotAttemptAt = -Infinity;

  resyncCount = 0;
  snapshotRequests = 0;
  lastResyncAt: number | null = null;

  constructor(
    private readonly source: SnapshotFetcher,
    private readonly onResynced: () => void,
  ) {}

  get usable(): boolean {
    return !this.needsResync;
  }

  forceResync(): void {
    this.needsResync = true;
  }

  /**
   * Feed one live depth diff. Returns whether it was actually applied to the
   * book - the caller (server.ts) must only broadcast a `book` delta to
   * clients when this returns 'applied'. A diff that was discarded as stale
   * or buffered for a resync changed nothing server-side, so forwarding it
   * anyway would apply a delta to the client's book that the server's own
   * book never applied - exactly the kind of silent drift A2 forbids.
   */
  handleDiff(update: DepthUpdate): 'applied' | 'stale' | 'buffered' {
    if (this.needsResync) {
      this.buffer.push(update);
      return 'buffered';
    }

    if (this.lastAppliedU !== null) {
      if (update.u <= this.lastAppliedU) {
        // Entirely covered by what we already applied - a duplicate or a
        // stale re-delivery, not loss. Discard silently; this is not a gap.
        return 'stale';
      }
      if (update.U !== this.lastAppliedU + 1) {
        console.error(
          `[orderbook] sequence gap: expected U=${this.lastAppliedU + 1}, got U=${update.U}. Resynchronising.`,
        );
        this.needsResync = true;
        this.buffer.push(update);
        return 'buffered';
      }
    }

    if (!this.tryApply(() => this.book.applyDiff(update), 'applying live diff')) return 'buffered';
    this.lastAppliedU = update.u;
    return 'applied';
  }

  /** Call after every upstream tick. No-ops unless a resync is due. */
  async maybeResync(nowMs: number): Promise<void> {
    if (!this.needsResync) return;
    if (nowMs - this.lastSnapshotAttemptAt < SNAPSHOT_MIN_INTERVAL_MS) return;

    this.lastSnapshotAttemptAt = nowMs;
    this.snapshotRequests++;

    let snapshot: SnapshotData;
    try {
      snapshot = await this.source.fetchSnapshot();
    } catch {
      return; // rate limited or transiently unavailable; retry next eligible tick
    }

    const dedup = dedupeAndSort(this.buffer.filter((u) => u.u > snapshot.lastUpdateId));

    const first = dedup[0];
    if (first && first.U > snapshot.lastUpdateId + 1) {
      // The snapshot is already behind the buffer. Keep what we have and try
      // a fresher snapshot next time; do not apply a book we know has a hole.
      this.buffer = dedup;
      return;
    }

    if (!this.tryApply(() => this.book.applySnapshot(snapshot), 'applying resync snapshot')) {
      this.buffer = [];
      return;
    }

    let cursor = snapshot.lastUpdateId;
    let consumed = 0;
    for (const u of dedup) {
      if (u.u <= cursor) {
        consumed++; // fully covered already; stale, not a hole
        continue;
      }
      if (u.U !== cursor + 1) break; // hole inside the buffered run itself
      if (!this.tryApply(() => this.book.applyDiff(u), 'applying buffered diff')) break;
      cursor = u.u;
      consumed++;
    }

    this.lastAppliedU = cursor;
    this.buffer = dedup.slice(consumed);
    this.needsResync = this.buffer.length > 0;
    this.resyncCount++;
    this.lastResyncAt = nowMs;
    this.onResynced();
  }

  private tryApply(fn: () => void, context: string): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      if (err instanceof BookInvariantError) {
        console.error(`[orderbook] invariant violated ${context}: ${err.message}`);
        this.needsResync = true;
        return false;
      }
      throw err;
    }
  }
}

function dedupeAndSort(updates: DepthUpdate[]): DepthUpdate[] {
  const sorted = [...updates].sort((a, b) => a.U - b.U || a.u - b.u);
  const out: DepthUpdate[] = [];
  for (const u of sorted) {
    const prev = out.at(-1);
    if (prev?.U === u.U && prev.u === u.u) continue; // duplicated message
    out.push(u);
  }
  return out;
}
