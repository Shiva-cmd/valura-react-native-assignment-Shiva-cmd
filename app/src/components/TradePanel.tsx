// Robinhood-inspired trade panel. The one functional requirement (B6): as
// the user types a quantity, show the estimated fill price and slippage
// from estimateFill() against the live book - recomputed whenever the
// quantity changes or the book itself moves, so 0.01 BTC and 40 BTC visibly
// differ and the estimate tracks the book rather than a snapshot of it.
//
// No order submission. The estimate is the point.

import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { estimateFill } from '../../../core/index.mjs';
import { engine } from '../engine/TradingEngine';
import { useEngineState } from '../engine/useEngineState';

type Side = 'buy' | 'sell';

export function TradePanel() {
  const { connState, bookVersion } = useEngineState();
  const [side, setSide] = useState<Side>('buy');
  const [quantity, setQuantity] = useState('0.01000000');

  const disabled = connState !== 'live';

  // bookVersion isn't read in the body; it's a dependency purely to force
  // recomputation whenever the live book mutates, since estimateFill reads
  // mutable state off `engine.book` rather than a value React can diff.
  const estimate = useMemo(() => {
    if (!/^\d*(\.\d*)?$/.test(quantity) || quantity === '' || quantity === '.') return null;
    try {
      return estimateFill(engine.book, side, quantity);
    } catch {
      return null;
    }
  }, [side, quantity, bookVersion]);

  return (
    <View style={styles.container}>
      <View style={styles.sideRow}>
        <Pressable
          disabled={disabled}
          onPress={() => setSide('buy')}
          style={[styles.sideButton, side === 'buy' && styles.buyActive, disabled && styles.disabled]}
        >
          <Text style={styles.sideLabel}>Buy</Text>
        </Pressable>
        <Pressable
          disabled={disabled}
          onPress={() => setSide('sell')}
          style={[styles.sideButton, side === 'sell' && styles.sellActive, disabled && styles.disabled]}
        >
          <Text style={styles.sideLabel}>Sell</Text>
        </Pressable>
      </View>

      <View style={styles.qtyRow}>
        <Text style={styles.qtyLabel}>Quantity (BTC)</Text>
        <TextInput
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="decimal-pad"
          editable={!disabled}
          style={[styles.qtyInput, disabled && styles.disabledText]}
          placeholderTextColor="#5A5A5C"
        />
      </View>

      {estimate ? (
        <View style={styles.estimateBox}>
          <Row label="Est. avg price" value={`$${estimate.avgPrice}`} />
          <Row label="Slippage" value={`${estimate.slippageBps} bps`} />
          <Row label="Fillable" value={`${estimate.filledQuantity} BTC`} />
          {estimate.insufficientDepth ? (
            <Text style={styles.warning}>Order exceeds visible depth - shown estimate covers only what is available.</Text>
          ) : null}
        </View>
      ) : (
        <Text style={styles.placeholder}>Enter a quantity to see the estimated fill.</Text>
      )}
    </View>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  sideRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sideButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#1C1C1E',
  },
  buyActive: {
    backgroundColor: '#0F3D2E',
  },
  sellActive: {
    backgroundColor: '#4A1414',
  },
  disabled: {
    opacity: 0.4,
  },
  sideLabel: {
    color: 'white',
    fontWeight: '700',
    fontSize: 15,
  },
  qtyRow: {
    gap: 6,
  },
  qtyLabel: {
    color: '#8E8E93',
    fontSize: 12,
  },
  qtyInput: {
    backgroundColor: '#1C1C1E',
    color: 'white',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  disabledText: {
    color: '#5A5A5C',
  },
  estimateBox: {
    backgroundColor: '#151517',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: '#8E8E93',
    fontSize: 13,
  },
  rowValue: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  warning: {
    color: '#FFB020',
    fontSize: 11,
    marginTop: 4,
  },
  placeholder: {
    color: '#5A5A5C',
    fontSize: 12,
  },
});
