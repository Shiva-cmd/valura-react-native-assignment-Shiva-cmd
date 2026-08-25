// Minimal external store for the low-frequency state (connection status,
// resume token, health-ish counters). Deliberately not Redux/Zustand - it's
// a dozen lines and one dependency less to justify in the README.
//
// High-frequency data (price ticks, candle series) does NOT go through this:
// it lives in Reanimated shared values so the chart never re-renders React
// on every tick. This store is for things that change a few times a second
// at most.

export type Listener = () => void;

export class Store<T> {
  private state: T;
  private readonly listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set = (patch: Partial<T>): void => {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
