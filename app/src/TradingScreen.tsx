// App lifecycle (B4): backgrounding and foregrounding must not replay
// buffered frames into the renderer and must not show a stale price as live.
// The engine's hardReset() throws away the current socket (nothing buffered
// survives) and reconnects with a fresh subscribe, so the very first thing
// a foregrounded app can show is a real snapshot, never a stale LIVE label.

import { useEffect, useRef } from 'react';
import { View, StyleSheet, useWindowDimensions, AppState, type AppStateStatus, StatusBar, Platform } from 'react-native';
import { engine } from './engine/TradingEngine';
import { ConnectionBanner } from './components/ConnectionBanner';
import { PriceHeader } from './components/PriceHeader';
import { Chart } from './components/Chart';
import { IntervalSwitcher } from './components/IntervalSwitcher';
import { TradePanel } from './components/TradePanel';
import { RtlToggle } from './components/RtlToggle';
import { markBackgrounded, markForegrounded, startJsFrameMonitor } from './metrics/instrumentation';

export function TradingScreen() {
  const { width } = useWindowDimensions();
  const contentWidth = width - 32;
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    engine.start();
    const stopFrameMonitor = startJsFrameMonitor();

    const sub = AppState.addEventListener('change', (next) => {
      const wasBackground = appState.current.match(/inactive|background/);
      appState.current = next;
      if (next === 'background') {
        markBackgrounded();
      }
      if (wasBackground && next === 'active') {
        markForegrounded();
        engine.hardReset();
      }
    });

    return () => {
      sub.remove();
      stopFrameMonitor();
      engine.stop();
    };
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <ConnectionBanner />
        <RtlToggle />
      </View>
      <PriceHeader width={contentWidth} />
      <View style={styles.chartWrap}>
        <Chart width={contentWidth} />
      </View>
      <IntervalSwitcher />
      <TradePanel />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    paddingTop: (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 47) + 8,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingEnd: 16,
  },
  chartWrap: {
    paddingHorizontal: 16,
    marginTop: 4,
  },
});
