import type { HealthStats } from './types.js';

export interface HealthSources {
  upstreamConnections: number;
  clientCount: number;
  resyncCount: number;
  lastResyncAt: number | null;
  snapshotRequests: number;
  rejectedFrames: number;
  lateTrades: number;
  droppedFrames: number;
  startedAtMs: number;
}

export function buildHealth(sources: HealthSources): HealthStats {
  return {
    upstreamConnections: sources.upstreamConnections,
    clientCount: sources.clientCount,
    resyncCount: sources.resyncCount,
    lastResyncAt: sources.lastResyncAt,
    snapshotRequests: sources.snapshotRequests,
    rejectedFrames: sources.rejectedFrames,
    lateTrades: sources.lateTrades,
    droppedFrames: sources.droppedFrames,
    uptimeMs: Date.now() - sources.startedAtMs,
    rssBytes: process.memoryUsage().rss,
  };
}
