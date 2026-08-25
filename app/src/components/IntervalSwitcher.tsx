// Wires a control to createAggregator's interval switch (B5, optional).
// Switching just changes which aggregator's series the chart reads next -
// no re-fetch, no stall, because each interval's aggregator has been running
// the whole time.

import { View, Text, Pressable, StyleSheet } from 'react-native';
import { engine, type Interval } from '../engine/TradingEngine';
import { useEngineSelector } from '../engine/useEngineState';

const OPTIONS: { label: string; value: Interval }[] = [
  { label: '1s', value: 1000 },
  { label: '5s', value: 5000 },
  { label: '1m', value: 60000 },
];

export function IntervalSwitcher() {
  const interval = useEngineSelector((s) => s.interval);

  return (
    <View style={styles.row}>
      {OPTIONS.map((opt) => {
        const active = opt.value === interval;
        return (
          <Pressable
            key={opt.value}
            onPress={() => engine.setInterval(opt.value)}
            style={[styles.pill, active && styles.pillActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 8,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#1C1C1E',
  },
  pillActive: {
    backgroundColor: '#2C2C2E',
  },
  label: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  labelActive: {
    color: 'white',
  },
});
