// Drawn with Skia rather than RN <Text> for one reason: while scrubbing, the
// price shown here has to track the gesture at UI-thread speed. Driving it
// through React state would mean a JS round trip every frame of the drag,
// which is exactly the lag the brief calls out.

import { View, StyleSheet, Platform } from 'react-native';
import { Canvas, Text as SkiaText, matchFont } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';
import { engine } from '../engine/TradingEngine';

// See Chart.tsx: worklets can only capture plain data/SharedValues, not the
// TradingEngine instance itself, so pull the shared values out at module
// scope rather than referencing `engine.xxx` inside a worklet body.
const { closes, scrubIndex, scrubActive, livePrice } = engine;

const HEIGHT = 76;
const UP_COLOR = '#12C48B';
const DOWN_COLOR = '#FF5B5B';

const priceFont = matchFont({
  fontFamily: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif', default: 'sans-serif' }),
  fontSize: 34,
  fontWeight: '700',
});
const changeFont = matchFont({
  fontFamily: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif', default: 'sans-serif' }),
  fontSize: 15,
  fontWeight: '600',
});

function currentIndex() {
  'worklet';
  const data = closes.value;
  if (scrubActive.value && scrubIndex.value >= 0 && scrubIndex.value < data.length) {
    return scrubIndex.value;
  }
  return data.length - 1;
}

interface Props {
  readonly width: number;
}

export function PriceHeader({ width }: Props) {
  const priceText = useDerivedValue(() => {
    const data = closes.value;
    const idx = currentIndex();
    const price = idx >= 0 ? data[idx] : livePrice.value;
    return price !== undefined ? `$${price.toFixed(2)}` : '--';
  });

  const changeText = useDerivedValue(() => {
    const data = closes.value;
    const idx = currentIndex();
    if (data.length < 2 || idx < 0) return '';
    const base = data[0] ?? 0;
    const cur = data[idx] ?? base;
    if (base === 0) return '';
    const pct = ((cur - base) / base) * 100;
    const sign = pct >= 0 ? '+' : '';
    const scrubSuffix = scrubActive.value ? ' (scrub)' : '';
    return `${sign}${pct.toFixed(2)}%${scrubSuffix}`;
  });

  const isUp = useDerivedValue(() => {
    const data = closes.value;
    const idx = currentIndex();
    if (data.length < 2 || idx < 0) return true;
    return (data[idx] ?? 0) >= (data[0] ?? 0);
  });

  const changeColor = useDerivedValue(() => (isUp.value ? UP_COLOR : DOWN_COLOR));

  return (
    <View style={[styles.container, { width, height: HEIGHT }]}>
      <Canvas style={{ width, height: HEIGHT }}>
        <SkiaText x={2} y={38} text={priceText} font={priceFont} color="white" />
        <SkiaText x={2} y={62} text={changeText} font={changeFont} color={changeColor} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
  },
});
