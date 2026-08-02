// Connection state machine. Pure: no sockets, no timers. See
// CLIENT_CONTRACT.md section 1.

export function createConnection({
  staleAfterMs = 2000,
  maxBackoffMs = 30000,
  random = Math.random,
} = {}) {
  let state = 'connecting';
  let sessionId = null;
  let lastSeq = null;
  let lastFrameAt = null;
  let attempt = 0;

  // Equal-jitter exponential backoff. The floor half of the range grows with
  // `attempt`, which is what guarantees the schedule trends upward even though
  // each individual delay is randomised - a fixed schedule reconnects every
  // disconnected client in lockstep and hits the server as a thundering herd.
  const BASE_MS = 250;

  function handleFrame(frame, now) {
    lastFrameAt = now;
    if (typeof frame.seq === 'number') {
      lastSeq = lastSeq === null ? frame.seq : Math.max(lastSeq, frame.seq);
    }

    if (frame.type === 'hello') {
      sessionId = frame.data?.sessionId ?? sessionId;
      attempt = 0; // successful handshake resets the backoff schedule
      state = 'live';
      return;
    }

    if (state === 'stale') {
      state = 'live';
    }
  }

  return {
    get state() {
      return state;
    },

    send(event) {
      switch (event.type) {
        case 'open':
          state = 'connecting';
          break;
        case 'frame':
          handleFrame(event.frame, event.now);
          break;
        case 'close':
        case 'error':
          state = 'reconnecting';
          break;
        case 'tick':
          if (state === 'live' && lastFrameAt !== null && event.now - lastFrameAt > staleAfterMs) {
            state = 'stale';
          }
          break;
        default:
          break;
      }
      return state;
    },

    nextBackoffMs() {
      const cap = Math.min(maxBackoffMs, BASE_MS * 2 ** attempt);
      attempt++;
      const floor = cap / 2;
      return Math.round(floor + random() * (cap - floor));
    },

    resumeToken() {
      if (sessionId === null) return null;
      return { sessionId, lastSeq };
    },
  };
}
