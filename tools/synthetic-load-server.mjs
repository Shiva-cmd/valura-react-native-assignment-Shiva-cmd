// Dev-only tool for B5's "sustained 60fps while receiving 200 messages per
// second" budget. Not part of the shipped server (server/src), not counted
// in the runtime dependency budget beyond `ws` (already a real dependency).
//
// Why this exists: the live Binance feed doesn't reliably sustain 200 msg/s,
// and `--replay` mode intentionally has no real-time pacing (it drains the
// whole tape in under a second), so neither can produce a sustained,
// wall-clock-paced 200/s load to observe frame drops against. This speaks
// just enough of PROTOCOL.md to satisfy the real client unmodified: hello,
// snapshot (with a plausible book + 300s trailing candles), then a paced
// stream of book/trade frames at a controlled combined rate.
//
// Usage: stop the real server, then `node tools/synthetic-load-server.mjs`,
// then point the app at localhost:8080 as usual (no client changes needed).

import { WebSocketServer } from 'ws';

const PORT = 8080;
const SYMBOL = 'BTCUSDT';
const RATE_PER_SEC = 200;
const BATCH_MS = 25;
const MSGS_PER_BATCH = Math.round((RATE_PER_SEC * BATCH_MS) / 1000); // 5

const BASE_PRICE = 62000;
const now = () => Date.now();

function randPrice(center, spread) {
  return (center + (Math.random() - 0.5) * spread).toFixed(2);
}
function randQty() {
  return (Math.random() * 2 + 0.001).toFixed(8);
}

// A handful of synthetic price levels we jitter every tick, like real depth diffs.
function makeBookLevels(center, count, sign) {
  const levels = [];
  for (let i = 0; i < count; i++) {
    levels.push([randPrice(center + sign * i * 5, 2), randQty()]);
  }
  return levels;
}

function makeTrailingCandles(count) {
  const candles = [];
  let c = BASE_PRICE;
  const start = now() - count * 1000;
  for (let i = 0; i < count; i++) {
    const o = c;
    c = c + (Math.random() - 0.5) * 20;
    const h = Math.max(o, c) + Math.random() * 5;
    const l = Math.min(o, c) - Math.random() * 5;
    candles.push({
      t: start + i * 1000,
      o: o.toFixed(2),
      h: h.toFixed(2),
      l: l.toFixed(2),
      c: c.toFixed(2),
      v: (Math.random() * 3).toFixed(8),
      n: Math.floor(Math.random() * 20),
    });
  }
  return candles;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[synthetic-load] listening on ws://localhost:${PORT}/stream, target ${RATE_PER_SEC} msg/s`);

wss.on('connection', (ws) => {
  let seq = 0;
  let sentInWindow = 0;
  const counterTimer = setInterval(() => {
    console.log(`[synthetic-load] sent ${sentInWindow} msgs in last 1000ms`);
    sentInWindow = 0;
  }, 1000);
  ws.on('close', () => clearInterval(counterTimer));

  const send = (type, data, ts = now()) => {
    seq += 1;
    sentInWindow += 1;
    ws.send(JSON.stringify({ v: 1, seq, type, ts, data }));
  };

  let tradeId = 0;
  let batchTimer = null;

  const stopBatching = () => {
    if (batchTimer) clearInterval(batchTimer);
    batchTimer = null;
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.op !== 'subscribe' && msg.op !== 'resume') return;

    const sessionId = 'synthetic-session';
    send('hello', { sessionId, symbols: [SYMBOL], resumed: false, serverTime: now() });
    send('snapshot', {
      symbol: SYMBOL,
      lastUpdateId: 1,
      bids: makeBookLevels(BASE_PRICE - 1, 25, -1),
      asks: makeBookLevels(BASE_PRICE + 1, 25, 1),
      candles: makeTrailingCandles(300),
    });

    stopBatching();
    batchTimer = setInterval(() => {
      for (let i = 0; i < MSGS_PER_BATCH; i++) {
        // 4 book deltas per trade, roughly matching real depth-diff-heavy traffic.
        if (i % 5 === 4) {
          tradeId += 1;
          send('trade', {
            symbol: SYMBOL,
            id: tradeId,
            p: randPrice(BASE_PRICE, 40),
            q: randQty(),
            t: now(),
            m: Math.random() < 0.5,
          });
        } else {
          send('book', {
            bids: makeBookLevels(BASE_PRICE - 1, 2, -1),
            asks: makeBookLevels(BASE_PRICE + 1, 2, 1),
          });
        }
      }
    }, BATCH_MS);
  });

  ws.on('close', stopBatching);
  ws.on('error', stopBatching);
});
