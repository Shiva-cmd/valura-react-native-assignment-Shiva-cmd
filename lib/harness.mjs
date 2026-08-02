// Test harness: start your server in replay mode, drive one protocol client,
// collect every frame it receives. Shared by verify.mjs.
//
// The command used to start your server is, by default:
//
//   npm run serve -- --replay <tape> --port <port>
//
// Override it with the SERVE_CMD environment variable if your setup differs,
// but the default has to work, because that is what we run when we grade.

import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';

const DEFAULT_SERVE = 'npm run serve --';

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (open) return true;
    await delay(100);
  }
  return false;
}

/**
 * Run one replay and return every frame the client received.
 *
 * @returns {Promise<{frames: object[], health: object|null, stderr: string}>}
 */
export async function runReplay(tapePath, { timeoutMs = 120000, quiet = true } = {}) {
  const port = await freePort();
  const cmd = process.env.SERVE_CMD ?? DEFAULT_SERVE;
  const full = `${cmd} --replay ${JSON.stringify(tapePath)} --port ${port}`;

  const child = spawn(full, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.on('data', (d) => {
    if (!quiet) process.stderr.write(d);
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (!quiet) process.stderr.write(d);
  });

  const kill = () => {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
      else child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  try {
    const up = await waitForPort(port);
    if (!up) throw new Error(`server never listened on ${port}.\n--- stderr ---\n${stderr}`);

    const frames = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error(`replay did not finish within ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onopen = () =>
        ws.send(JSON.stringify({ op: 'subscribe', symbol: 'BTCUSDT', depth: 50 }));
      ws.onmessage = (e) => {
        try {
          frames.push(JSON.parse(e.data));
        } catch {
          frames.push({ __unparseable: String(e.data).slice(0, 200) });
        }
      };
      ws.onerror = () => {
        /* close handles it */
      };
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    let health = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      health = await res.json();
    } catch {
      /* health is checked separately, absence is its own finding */
    }

    return { frames, health, stderr };
  } finally {
    kill();
  }
}
