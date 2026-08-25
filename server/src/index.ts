#!/usr/bin/env node
import { createReplayUpstream } from './upstreamReplay.js';
import { startServer } from './server.js';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function main(): Promise<void> {
  const replayPath = arg('--replay');
  const port = Number(arg('--port', '8080'));

  if (replayPath) {
    const source = await createReplayUpstream(replayPath);
    await startServer({ mode: 'replay', port, source });
    console.error(`[server] replay mode: tape=${replayPath} port=${port}`);
    return;
  }

  const { createBinanceUpstream } = await import('./upstreamBinance.js');
  const source = createBinanceUpstream('btcusdt');
  await startServer({ mode: 'live', port, source });
  console.error(`[server] live mode: port=${port}`);
}

main().catch((err: unknown) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
