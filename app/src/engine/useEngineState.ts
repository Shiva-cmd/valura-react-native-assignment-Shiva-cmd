import { useSyncExternalStore } from 'react';
import { engine, type EngineState } from './TradingEngine';

export function useEngineState(): EngineState {
  return useSyncExternalStore(engine.store.subscribe, engine.store.get);
}
