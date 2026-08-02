// Deliberately incomplete stub server.
//
// It exists so you can confirm the harness works end to end before you have
// written anything:
//
//   npm install
//   npm run verify        <- should start, connect, and fail loudly
//
// If verify.mjs reports failures rather than crashing, your setup is fine and
// the rest is on you.
//
// What this stub does: opens a WebSocket, answers `subscribe` with a hello and
// one hardcoded snapshot, then stops. It never opens the tape, never maintains
// a book, and never emits a candle. Delete it and point `npm run serve` at your
// own server.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const tapePath = arg('--replay');
const port = Number(arg('--port', '8080'));

console.error(
  `[stub] listening on ${port}` +
    (tapePath ? `, ignoring tape ${tapePath} because this is a stub` : ''),
);

let clients = 0;

const http = createServer((req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        upstreamConnections: 0, // a real server holds exactly one
        clientCount: clients,
        resyncCount: 0,
        lastResyncAt: null,
        snapshotRequests: 0,
        rejectedFrames: 0,
        lateTrades: 0,
        droppedFrames: 0,
        uptimeMs: Math.round(process.uptime() * 1000),
        rssBytes: process.memoryUsage().rss,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: '/stream' });

wss.on('connection', (ws) => {
  clients++;
  let seq = 0;
  const send = (type, data) =>
    ws.send(JSON.stringify({ v: 1, seq: ++seq, type, ts: 1730000000000, data }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.op !== 'subscribe') return;

    send('hello', {
      sessionId: 'stub01',
      symbols: ['BTCUSDT'],
      resumed: false,
      serverTime: 1730000000000,
    });

    send('snapshot', {
      symbol: 'BTCUSDT',
      lastUpdateId: 1,
      bids: [['99999.00000000', '1.00000000']],
      asks: [['100001.00000000', '1.00000000']],
      candles: [],
    });

    // A real server would now replay the tape. This one has nothing to say, so
    // it closes and lets the verifier tell you everything that is missing.
    setTimeout(() => ws.close(1000, 'stub'), 50);
  });

  ws.on('close', () => clients--);
});

http.listen(port);
