import { Platform } from 'react-native';

/**
 * Default backend URL. Android emulators can't reach the host machine via
 * `localhost` (that resolves to the emulator itself) - `10.0.2.2` is the
 * documented alias for the host loopback. iOS simulator and web share the
 * host's network namespace, so `localhost` works there.
 */
export function defaultServerHost(): string {
  if (Platform.OS === 'android') return '10.0.2.2';
  return 'localhost';
}

export const DEFAULT_PORT = 8080;
export const SYMBOL = 'BTCUSDT';
export const DEPTH = 50;
export const STALE_AFTER_MS = 2000;
export const MAX_BACKOFF_MS = 30000;
