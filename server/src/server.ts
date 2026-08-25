// Orchestration: one upstream feed, fanned out to any number of client
// sessions over PROTOCOL.md. Everything domain-specific (book sync, candles,
// decimal math) lives elsewhere; this file wires it to sockets.

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { ManualClock, WallClock, type Clock } from './clock.js';
import { DepthSyncEngine } from './depthSync.js';
import { CandleEngine } from './candles.js';
import { ClientSession, SessionRegistry } from './session.js';
import { buildHealth } from './health.js';
import { validateDepthUpdate, validateTrade, parseRawPayload } from './validate.js';
import { isDepthUpdateMessage, isTradeMessage, type UpstreamSource } from './upstream.js';
import type { Candle, ClientOp, PriceLevel, UpstreamStatus } from './types.js';

const DEFAULT_DEPTH = 50;
const SESSION_RETENTION_MS = 120_000;

function newSessionId(): string {
  return randomBytes(6).toString('hex');
}

export interface ServerOptions {
  mode: 'replay' | 'live';
  port: number;
  symbol?: string;
  source: UpstreamSource;
  /** Only present in replay mode: lets us drive the logical clock from tape timestamps. */
  replayNow?: () => number;
}

export interface RunningServer {
  http: HttpServer;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const symbol = opts.symbol ?? 'BTCUSDT';
  const clock: Clock = opts.mode === 'replay' ? new ManualClock() : new WallClock();
  const manualClock = clock instanceof ManualClock ? clock : null;

  const startedAtWallMs = Date.now();
  const registry = new SessionRegistry(SESSION_RETENTION_MS);
  const wsToSession = new WeakMap<WebSocket, ClientSession>();

  let upstreamConnections = 0;
  let upstreamStatus: UpstreamStatus = 'connected';
  let resolveFirstSync!: () => void;
  let firstSyncDone = false;
  const firstSyncReady = new Promise<void>((resolve) => {
    resolveFirstSync = resolve;
  });

  let rejectedFrames = 0;
  let snapshotStreamStarted = false;
  let lastStatusEmitAt = -Infinity;

  const candleEngine = new CandleEngine((candle) => broadcastCandle(candle));
  const depthSync = new DepthSyncEngine(opts.source, () => onResynced());

  function totalDropped(): number {
    let total = 0;
    for (const s of registry.all()) total += s.droppedFrames;
    return total;
  }

  function liveSessions(): ClientSession[] {
    return registry.all().filter((s) => s.ws !== null);
  }

  function onResynced(): void {
    const { bids } = depthSync.book.top(1);
    if (bids[0]) candleEngine.bootstrap(bids[0][0]);
    if (!firstSyncDone) {
      firstSyncDone = true;
      resolveFirstSync();
    }
    broadcastSnapshotToAll();
    emitStatus(true);
  }

  function buildSnapshotPayload(depth: number): {
    symbol: string;
    lastUpdateId: number;
    bids: PriceLevel[];
    asks: PriceLevel[];
    candles: Candle[];
  } {
    const { bids, asks } = depthSync.book.top(depth);
    return { symbol, lastUpdateId: depthSync.book.lastUpdateId, bids, asks, candles: candleEngine.history() };
  }

  function broadcastSnapshotToAll(): void {
    for (const session of liveSessions()) {
      session.sendAlways('snapshot', buildSnapshotPayload(DEFAULT_DEPTH), clock.now());
    }
  }

  function broadcastBookDelta(bids: PriceLevel[], asks: PriceLevel[]): void {
    if (bids.length === 0 && asks.length === 0) return;
    for (const session of liveSessions()) {
      session.queueBookDelta(bids, asks);
      session.flushBook(clock.now());
    }
  }

  function broadcastTrade(data: { symbol: string; id: number; p: string; q: string; t: number; m: boolean }): void {
    for (const session of liveSessions()) {
      session.sendTrade(data, clock.now());
    }
  }

  function broadcastCandle(candle: Candle): void {
    const ts = candle.t + 1000;
    for (const session of liveSessions()) {
      session.sendAlways('candle', { symbol, closed: true, ...candle }, ts);
    }
  }

  function emitStatus(force: boolean): void {
    const now = clock.now();
    if (!force && now - lastStatusEmitAt < 1000) return;
    lastStatusEmitAt = now;
    for (const session of liveSessions()) {
      session.sendAlways(
        'status',
        {
          upstream: upstreamStatus,
          resyncCount: depthSync.resyncCount,
          lastResyncAt: depthSync.lastResyncAt,
          droppedFrames: totalDropped(),
        },
        now,
      );
    }
  }

  let tradeIdCounter = 0;

  function handleParsedMessage(data: unknown): void {
    if (isDepthUpdateMessage(data)) {
      const diff = validateDepthUpdate(data);
      if (!diff) {
        rejectedFrames++;
        return;
      }
      const outcome = depthSync.handleDiff(diff);
      if (outcome === 'applied') {
        broadcastBookDelta(diff.b, diff.a);
      }
      // a 'buffered' or 'stale' outcome changed nothing server-side, so
      // nothing is forwarded; resync (if newly triggered) happens from the
      // main loop tick, and clients are caught up via the resync snapshot
      return;
    }

    if (isTradeMessage(data)) {
      const trade = validateTrade(data);
      if (!trade) {
        rejectedFrames++;
        return;
      }
      tradeIdCounter++;
      broadcastTrade({ symbol, id: tradeIdCounter, p: trade.p, q: trade.q, t: trade.T, m: trade.m });
      candleEngine.onTrade({ p: trade.p, q: trade.q, T: trade.T });
      return;
    }

    rejectedFrames++;
  }

  async function runUpstreamLoop(): Promise<void> {
    upstreamConnections = 1;
    for await (const event of opts.source.events()) {
      manualClock?.set(event.ts);
      candleEngine.advance(clock.now());

      switch (event.kind) {
        case 'message':
          handleParsedMessage(event.data);
          break;
        case 'raw': {
          const parsed = parseRawPayload(event.payload);
          if (parsed === null) {
            rejectedFrames++;
          } else {
            handleParsedMessage(parsed);
          }
          break;
        }
        case 'disconnect':
          upstreamStatus = 'reconnecting';
          emitStatus(true);
          break;
        case 'reconnect':
          upstreamStatus = 'degraded';
          depthSync.forceResync();
          emitStatus(true);
          break;
        case 'end':
          upstreamStatus = 'replay_complete';
          emitStatus(true);
          await closeAllClients();
          return;
      }

      await depthSync.maybeResync(clock.now());
      if (upstreamStatus === 'degraded' && depthSync.usable) upstreamStatus = 'connected';
      emitStatus(false);
    }
  }

  function ensureUpstreamStarted(): void {
    if (snapshotStreamStarted) return;
    snapshotStreamStarted = true;
    runUpstreamLoop().catch((err: unknown) => {
      console.error('[upstream] fatal error in upstream loop:', err);
    });
  }

  async function closeAllClients(): Promise<void> {
    for (const session of liveSessions()) {
      session.ws?.close(1000, 'replay complete');
      session.markClosed();
    }
  }

  async function sendFreshHelloAndSnapshot(ws: WebSocket, depth: number): Promise<void> {
    ensureUpstreamStarted();
    await firstSyncReady;
    const sessionId = newSessionId();
    const session = new ClientSession(sessionId, ws, clock.now());
    registry.add(session);
    wsToSession.set(ws, session);
    session.sendAlways('hello', { sessionId, symbols: [symbol], resumed: false, serverTime: clock.now() }, clock.now());
    session.sendAlways('snapshot', buildSnapshotPayload(depth), clock.now());
  }

  function sendError(ws: WebSocket, code: string, message: string): void {
    const session = wsToSession.get(ws);
    const ts = clock.now();
    if (session) {
      session.sendAlways('error', { code, message }, ts);
    } else {
      // No session yet (bad first frame): construct a minimal one-off envelope.
      try {
        ws.send(JSON.stringify({ v: 1, seq: 1, type: 'error', ts, data: { code, message } }));
      } catch {
        /* socket already gone */
      }
    }
  }

  async function handleSubscribe(ws: WebSocket, msg: Extract<ClientOp, { op: 'subscribe' }>): Promise<void> {
    if (typeof msg.symbol !== 'string' || typeof msg.depth !== 'number' || !Number.isFinite(msg.depth)) {
      sendError(ws, 'BAD_REQUEST', 'subscribe requires a string symbol and numeric depth');
      return;
    }
    if (msg.symbol.toUpperCase() !== symbol) {
      sendError(ws, 'UNKNOWN_SYMBOL', `unknown symbol ${msg.symbol}`);
      return;
    }
    await sendFreshHelloAndSnapshot(ws, Math.max(1, Math.min(1000, Math.trunc(msg.depth))));
  }

  async function handleResume(ws: WebSocket, msg: Extract<ClientOp, { op: 'resume' }>): Promise<void> {
    if (typeof msg.sessionId !== 'string' || typeof msg.lastSeq !== 'number') {
      sendError(ws, 'BAD_REQUEST', 'resume requires sessionId and lastSeq');
      return;
    }
    const existing = registry.get(msg.sessionId);
    const frames = existing?.framesAfter(msg.lastSeq) ?? null;
    if (!existing || frames === null) {
      sendError(ws, 'RESUME_TOO_OLD', 'session unknown or no longer buffered');
      await sendFreshHelloAndSnapshot(ws, DEFAULT_DEPTH);
      return;
    }
    existing.ws = ws;
    existing.lastSeenAt = clock.now();
    wsToSession.set(ws, existing);
    for (const frame of frames) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket already gone */
      }
    }
  }

  function handlePing(ws: WebSocket, msg: Extract<ClientOp, { op: 'ping' }>): void {
    const session = wsToSession.get(ws);
    if (!session) {
      sendError(ws, 'BAD_REQUEST', 'ping before subscribe');
      return;
    }
    session.sendAlways('pong', { id: msg.id }, clock.now());
  }

  async function handleClientOp(ws: WebSocket, msg: ClientOp): Promise<void> {
    switch (msg.op) {
      case 'subscribe':
        return handleSubscribe(ws, msg);
      case 'resume':
        return handleResume(ws, msg);
      case 'ping':
        return handlePing(ws, msg);
      default:
        sendError(ws, 'BAD_REQUEST', 'unknown op');
    }
  }

  // --- HTTP + WS wiring -------------------------------------------------

  const http = createHttpServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      const health = buildHealth({
        upstreamConnections,
        clientCount: registry.liveCount(),
        resyncCount: depthSync.resyncCount,
        lastResyncAt: depthSync.lastResyncAt,
        snapshotRequests: depthSync.snapshotRequests,
        rejectedFrames,
        lateTrades: candleEngine.lateTrades,
        droppedFrames: totalDropped(),
        startedAtMs: startedAtWallMs,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: '/stream' });

  wss.on('connection', (ws: WebSocket) => {
    // A slow/backpressured client's socket can error asynchronously (e.g.
    // ETIMEDOUT once the OS gives up on an unacknowledged write). An
    // EventEmitter's unhandled 'error' event is fatal to the whole process
    // by Node convention - without this listener, one bad client takes down
    // every other client's session too. `close` still follows and does the
    // real cleanup; this only stops the crash.
    ws.on('error', () => {
      /* handled by the close listener below */
    });

    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'BAD_REQUEST', 'invalid JSON');
        return;
      }
      if (typeof msg !== 'object' || msg === null || typeof (msg as { op?: unknown }).op !== 'string') {
        sendError(ws, 'BAD_REQUEST', 'missing op');
        return;
      }
      void handleClientOp(ws, msg as ClientOp);
    });

    ws.on('close', () => {
      const session = wsToSession.get(ws);
      if (session) {
        session.lastSeenAt = clock.now();
        session.detach();
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, resolve));

  // Housekeeping only - evicts sessions disconnected long enough ago that a
  // resume can no longer succeed anyway. Real wall-clock timing is fine here
  // (unlike everything upstream of an outgoing frame): it never touches
  // protocol output, only when we stop holding onto a dead session's buffer.
  const sweepTimer = setInterval(() => registry.sweep(Date.now()), 30_000);

  return {
    http,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(sweepTimer);
        wss.close();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
