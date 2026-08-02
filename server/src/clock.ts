// Injected clock. Nothing on the path to output may call Date.now() directly
// (PROTOCOL.md, replay mode): two replays of the same tape must produce byte
// identical output, so the server's notion of "now" has to come from the
// tape's logical time, not the wall clock.

export interface Clock {
  now(): number;
}

/** Logical time driven entirely by consumed events. Used in replay mode. */
export class ManualClock implements Clock {
  private current = 0;

  now(): number {
    return this.current;
  }

  set(t: number): void {
    if (t > this.current) this.current = t;
  }
}

/** Real wall clock. Used only when actually talking to Binance. */
export class WallClock implements Clock {
  now(): number {
    return Date.now();
  }
}
