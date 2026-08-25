import { useRef, useSyncExternalStore } from 'react';
import { engine, type EngineState } from './TradingEngine';

/**
 * Full-state subscription. Every consumer re-renders on every store.set()
 * call, including unrelated fields (e.g. bookVersion bumping ~10x/sec from
 * live book deltas). Kept for cases that genuinely need the whole shape;
 * prefer useEngineSelector for anything that only reads one or two fields -
 * see the bug this caused: ConnectionBanner, IntervalSwitcher, and the
 * Buy/Sell buttons were all re-rendering continuously because they shared
 * this hook with TradePanel, which legitimately needs bookVersion.
 */
export function useEngineState(): EngineState {
  return useSyncExternalStore(engine.store.subscribe, engine.store.get);
}

/**
 * Subscribe to a derived slice of engine state, re-rendering only when that
 * slice's value actually changes (by `equalityFn`, default reference/
 * primitive equality). This is what keeps a 10Hz book update from
 * re-rendering the connection banner or the interval switcher.
 */
export function useEngineSelector<T>(
  selector: (state: EngineState) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const read = () => selector(engine.store.get());
  const cached = useRef(read());

  const subscribe = (onStoreChange: () => void) =>
    engine.store.subscribe(() => {
      const next = read();
      if (!equalityFn(cached.current, next)) {
        cached.current = next;
        onStoreChange();
      }
    });

  return useSyncExternalStore(subscribe, () => cached.current);
}
