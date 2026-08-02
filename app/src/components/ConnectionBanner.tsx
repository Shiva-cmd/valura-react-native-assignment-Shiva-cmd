// Three honest states (B3): LIVE, RECONNECTING, STALE. A trading UI that
// keeps showing a confident price after the feed died is worse than one
// that shows nothing - so this is deliberately the least subtle thing on
// the screen when it isn't green.

import { View, Text, StyleSheet } from 'react-native';
import { useEngineState } from '../engine/useEngineState';

const LABEL: Record<string, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  reconnecting: 'RECONNECTING',
  stale: 'STALE',
};

const COLOR: Record<string, string> = {
  connecting: '#8E8E93',
  live: '#12C48B',
  reconnecting: '#FFB020',
  stale: '#FF5B5B',
};

export function ConnectionBanner() {
  const { connState, lastError } = useEngineState();
  const color = COLOR[connState] ?? '#8E8E93';

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{LABEL[connState] ?? connState.toUpperCase()}</Text>
      {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginEnd: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  error: {
    marginStart: 10,
    fontSize: 11,
    color: '#FF5B5B',
  },
});
