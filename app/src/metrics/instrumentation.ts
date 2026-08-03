// Real instrumentation, not estimates (C1/METRICS.md). Everything here logs
// through console so numbers can be pulled straight from `adb logcat` /
// Metro's log stream during a manual run - there is no separate profiling
// harness to trust or distrust.

export interface Milestones {
  connectStartedAt: number | null;
  firstLiveAt: number | null;
  foregroundedAt: number | null;
  liveAfterForegroundAt: number | null;
}

export const milestones: Milestones = {
  connectStartedAt: null,
  firstLiveAt: null,
  foregroundedAt: null,
  liveAfterForegroundAt: null,
};

export function markConnectStart(): void {
  milestones.connectStartedAt = Date.now();
}

export function markFirstLive(): void {
  if (milestones.connectStartedAt !== null && milestones.firstLiveAt === null) {
    milestones.firstLiveAt = Date.now();
    const ms = milestones.firstLiveAt - milestones.connectStartedAt;
    console.log(`[metrics] reconnect-to-first-live-tick: ${ms}ms`);
  }
}

export function markBackgrounded(): void {
  milestones.liveAfterForegroundAt = null;
}

// Called when the app actually returns to the foreground, not when it goes
// to the background - markBackgrounded() used to store its timestamp in
// `foregroundedAt` instead, so the metric below measured "time since
// backgrounding" (including however long the app sat backgrounded) rather
// than the actual resync time after resuming.
export function markForegrounded(): void {
  milestones.foregroundedAt = Date.now();
}

export function markLiveAfterForeground(): void {
  if (milestones.foregroundedAt !== null && milestones.liveAfterForegroundAt === null) {
    milestones.liveAfterForegroundAt = Date.now();
    const ms = milestones.liveAfterForegroundAt - milestones.foregroundedAt;
    console.log(`[metrics] foreground-resync-to-live: ${ms}ms`);
  }
}

/**
 * JS-thread frame monitor. Runs its own rAF loop and logs when a frame took
 * meaningfully longer than the 16.7ms budget - a direct measurement of JS
 * thread contention from parsing/dispatching the message stream, independent
 * of whatever the UI thread (Skia/Reanimated) is doing.
 */
export function startJsFrameMonitor(windowMs = 60000): () => void {
  let last = Date.now();
  let dropped = 0;
  let frames = 0;
  let windowStart = Date.now();
  let raf: ReturnType<typeof requestAnimationFrame> | null = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const delta = now - last;
    last = now;
    frames++;
    if (delta > 32) dropped++; // more than ~2 frames' worth of budget

    if (now - windowStart >= windowMs) {
      console.log(`[metrics] dropped JS frames in ${windowMs}ms window: ${dropped} (of ${frames} ticks)`);
      dropped = 0;
      frames = 0;
      windowStart = now; // was never reset, so this fired every frame after the first window
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    if (raf !== null) cancelAnimationFrame(raf);
  };
}
