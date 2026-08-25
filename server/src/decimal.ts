// Exact decimal arithmetic on decimal strings, backed by BigInt.
//
// Mirrors core/decimal.mjs (the client core's copy of the same guarantee).
// Duplicated rather than imported so the client core stays a dependency-free
// plain-JS module with no build step, while the server keeps full static
// typing. Both sides are exercised independently by their own verifier, so
// the two copies cannot silently drift without a check noticing.
//
// See A4 in ASSIGNMENT.md and DECISIONS.md for the guarantee this provides:
// every price/quantity computation (comparison, sum, VWAP, OHLC) is exact
// until the final rounding step, which is always explicit and half-away-
// from-zero.

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

interface Parsed {
  unscaled: bigint;
  scale: number;
}

function parse(str: string): Parsed {
  const m = DECIMAL_RE.exec(str.trim());
  if (!m) throw new TypeError(`not a decimal string: ${str}`);
  const sign = m[1];
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  const unscaled = BigInt((sign === '-' ? '-' : '') + intPart + fracPart);
  return { unscaled, scale: fracPart.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function widen(d: Parsed, scale: number): bigint {
  return d.scale === scale ? d.unscaled : d.unscaled * pow10(scale - d.scale);
}

function format(unscaled: bigint, scale: number): string {
  const neg = unscaled < 0n;
  let digits = (neg ? -unscaled : unscaled).toString();
  if (scale === 0) return (neg ? '-' : '') + digits;
  while (digits.length <= scale) digits = '0' + digits;
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return (neg ? '-' : '') + intPart + '.' + fracPart;
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  const ua = widen(da, scale);
  const ub = widen(db, scale);
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

export function isZero(str: string): boolean {
  return parse(str).unscaled === 0n;
}

export function isNegative(str: string): boolean {
  return parse(str).unscaled < 0n;
}

export function add(a: string, b: string): string {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  return format(widen(da, scale) + widen(db, scale), scale);
}

export function sub(a: string, b: string): string {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  return format(widen(da, scale) - widen(db, scale), scale);
}

export function mul(a: string, b: string): string {
  const da = parse(a);
  const db = parse(b);
  return format(da.unscaled * db.unscaled, da.scale + db.scale);
}

/** Round a decimal string to `dp` places, half away from zero. */
export function roundTo(str: string, dp: number): string {
  const d = parse(str);
  if (d.scale <= dp) return format(widen(d, dp), dp);
  const factor = pow10(d.scale - dp);
  const neg = d.unscaled < 0n;
  const abs = neg ? -d.unscaled : d.unscaled;
  const q = abs / factor;
  const r = abs % factor;
  const roundedAbs = r * 2n >= factor ? q + 1n : q;
  return format(neg ? -roundedAbs : roundedAbs, dp);
}

/** a / b, rounded half away from zero to `dp` places, with guard digits. */
export function divRound(aStr: string, bStr: string, dp: number, guard = 12): string {
  const da = parse(aStr);
  const db = parse(bStr);
  if (db.unscaled === 0n) throw new RangeError('division by zero');
  const wantScale = dp + guard;
  const numerator = da.unscaled * pow10(db.scale + wantScale);
  const denominator = db.unscaled * pow10(da.scale);
  const guarded = numerator / denominator;
  return roundTo(format(guarded, wantScale), dp);
}

export function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && DECIMAL_RE.test(v.trim());
}
