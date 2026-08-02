// Hand rolled. No charting library: this builds its own Skia path from the
// close series every frame the data changes, and tracks the scrub gesture
// entirely on the UI thread - the gesture worklet writes straight into
// Reanimated shared values that the header reads, with no JS round trip per
// frame. That round trip is what the brief calls out as the thing that
// visibly lags.

import { View, StyleSheet } from 'react-native';
import { Canvas, Path, Skia, LinearGradient, vec, Circle } from '@shopify/react-native-skia';
import { useDerivedValue, useFrameCallback, useSharedValue, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { engine } from '../engine/TradingEngine';

// Worklets can only capture plain data and SharedValues, not arbitrary class
// instances - closing over `engine` itself (a TradingEngine instance) inside
// a worklet throws "[Worklets] Cannot copy value of type `TradingEngine`."
// Pulling the individual shared values out here means every worklet below
// captures only those, never the engine object.
const { closes, scrubIndex, scrubActive, lastTickAt } = engine;

// Real numbers for METRICS.md, not estimates: tick-to-paint is a genuine
// cross-thread timestamp diff (JS-thread message receipt vs. the UI-thread
// frame that actually reflects it), and scrub frame time is Reanimated's own
// per-frame delta while the gesture is active. Pull these from `adb logcat`.
function logTickToPaint(ms: number): void {
  console.log(`[metrics] tick-to-paint: ${ms}ms`);
}
function logScrubFrame(ms: number): void {
  console.log(`[metrics] scrub-frame-time: ${ms.toFixed(1)}ms`);
}

const HEIGHT = 220;
const PAD = 14;
const UP_COLOR = '#12C48B';
const DOWN_COLOR = '#FF5B5B';

function stats(data: number[]) {
  'worklet';
  let min = data[0] ?? 0;
  let max = data[0] ?? 0;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max: max === min ? min + 1 : max };
}

interface Props {
  readonly width: number;
}

export function Chart({ width }: Props) {
  const lastPaintedTick = useSharedValue(0);

  useFrameCallback((frameInfo) => {
    if (lastTickAt.value > 0 && lastTickAt.value !== lastPaintedTick.value) {
      const latency = Date.now() - lastTickAt.value;
      lastPaintedTick.value = lastTickAt.value;
      if (latency >= 0 && latency < 5000) runOnJS(logTickToPaint)(latency);
    }
    if (scrubActive.value && frameInfo.timeSincePreviousFrame != null) {
      runOnJS(logScrubFrame)(frameInfo.timeSincePreviousFrame);
    }
  });

  const isUp = useDerivedValue(() => {
    const data = closes.value;
    if (data.length < 2) return true;
    return (data.at(-1) ?? 0) >= (data[0] ?? 0);
  });

  const linePath = useDerivedValue(() => {
    const data = closes.value;
    const path = Skia.Path.Make();
    if (data.length < 2) return path;
    const { min, max } = stats(data);
    const stepX = (width - PAD * 2) / (data.length - 1);
    const scaleY = (HEIGHT - PAD * 2) / (max - min);
    for (let i = 0; i < data.length; i++) {
      const x = PAD + i * stepX;
      const y = HEIGHT - PAD - ((data[i] ?? min) - min) * scaleY;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    return path;
  });

  const fillPath = useDerivedValue(() => {
    const path = linePath.value.copy();
    path.lineTo(width - PAD, HEIGHT - PAD);
    path.lineTo(PAD, HEIGHT - PAD);
    path.close();
    return path;
  });

  const markerPoint = useDerivedValue(() => {
    const data = closes.value;
    const idx = scrubIndex.value;
    if (!scrubActive.value || idx < 0 || idx >= data.length || data.length < 2) {
      return { x: -100, y: -100, visible: false };
    }
    const { min, max } = stats(data);
    const stepX = (width - PAD * 2) / (data.length - 1);
    const scaleY = (HEIGHT - PAD * 2) / (max - min);
    const x = PAD + idx * stepX;
    const y = HEIGHT - PAD - ((data[idx] ?? min) - min) * scaleY;
    return { x, y, visible: true };
  });

  const markerCx = useDerivedValue(() => markerPoint.value.x);
  const markerCy = useDerivedValue(() => markerPoint.value.y);
  const markerRadius = useDerivedValue(() => (markerPoint.value.visible ? 5 : 0));

  const scrubLine = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const p = markerPoint.value;
    if (!p.visible) return path;
    path.moveTo(p.x, PAD);
    path.lineTo(p.x, HEIGHT - PAD);
    return path;
  });

  const lineColor = useDerivedValue(() => (isUp.value ? UP_COLOR : DOWN_COLOR));
  const gradientColors = useDerivedValue(() =>
    isUp.value ? ['rgba(18,196,139,0.35)', 'rgba(18,196,139,0)'] : ['rgba(255,91,91,0.35)', 'rgba(255,91,91,0)'],
  );

  function updateScrubFromX(x: number): void {
    'worklet';
    const data = closes.value;
    if (data.length === 0) return;
    const stepX = (width - PAD * 2) / (data.length - 1 || 1);
    let idx = Math.round((x - PAD) / stepX);
    idx = Math.max(0, Math.min(data.length - 1, idx));
    scrubIndex.value = idx;
  }

  const pan = Gesture.Pan()
    .onBegin((e) => {
      scrubActive.value = true;
      updateScrubFromX(e.x);
    })
    .onUpdate((e) => {
      updateScrubFromX(e.x);
    })
    .onFinalize(() => {
      scrubActive.value = false;
    });

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.container, { width, height: HEIGHT }]}>
        <Canvas style={{ width, height: HEIGHT }}>
          <Path path={fillPath} style="fill">
            <LinearGradient start={vec(0, 0)} end={vec(0, HEIGHT)} colors={gradientColors} />
          </Path>
          <Path path={linePath} style="stroke" strokeWidth={2.5} color={lineColor} strokeCap="round" strokeJoin="round" />
          <Path path={scrubLine} style="stroke" strokeWidth={1} color="rgba(255,255,255,0.35)" />
          <Circle cx={markerCx} cy={markerCy} r={markerRadius} color={lineColor} />
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
  },
});
