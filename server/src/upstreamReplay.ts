// Adapts lib/replay.mjs (shared plumbing, plain JS - see README.md) to the
// UpstreamSource interface. This is the one file allowed to touch that
// module directly; everything downstream sees a fully typed interface.
//
// Loaded via a computed (non-literal) dynamic import specifier so tsc treats
// it as opaque rather than pulling a plain-JS file from outside `rootDir`
// into the compiled program - which otherwise collides trying to emit a
// transformed copy over the original starter-kit file.

import type { SnapshotData } from './types.js';
import type { UpstreamEvent, UpstreamSource } from './upstream.js';

interface RawReplaySource {
  now(): number;
  events(): AsyncGenerator<UpstreamEvent>;
  fetchSnapshot(): Promise<SnapshotData>;
}

interface ReplayModule {
  ReplaySource: { fromFile(path: string): RawReplaySource };
  RateLimitError: new (...args: unknown[]) => Error;
}

export interface ReplayUpstream extends UpstreamSource {
  now(): number;
}

async function loadReplayModule(): Promise<ReplayModule> {
  const specifier = new URL('../../lib/replay.mjs', import.meta.url).href;
  return (await import(specifier)) as ReplayModule;
}

export async function createReplayUpstream(tapePath: string): Promise<ReplayUpstream> {
  const { ReplaySource } = await loadReplayModule();
  const source = ReplaySource.fromFile(tapePath);

  return {
    now: () => source.now(),
    events: () => source.events(),
    fetchSnapshot: () => source.fetchSnapshot(),
  };
}
