// Exact decimal arithmetic on decimal strings, backed by BigInt.
//
// Every price and quantity in this system is a decimal string, on the wire and
// in memory. Routing any of them through Number loses precision the fixtures
// are specifically designed to catch (see CLIENT_CONTRACT.md, "Numbers").
// Everything here works on the digits directly and never parses a price with
// parseFloat/Number.

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

function parse(str) {
  const m = DECIMAL_RE.exec(String(str).trim());
  if (!m) throw new TypeError(`not a decimal string: ${str}`);
  const [, sign, intPart, fracPart = ''] = m;
  const unscaled = BigInt((sign === '-' ? '-' : '') + intPart + fracPart);
  return { unscaled, scale: fracPart.length };
}

function pow10(n) {
  return 10n ** BigInt(n);
}

/** Rescale unscaled to a wider scale. Only ever called to grow scale, never shrink. */
function widen(d, scale) {
  return d.scale === scale ? d.unscaled : d.unscaled * pow10(scale - d.scale);
}

function format(unscaled, scale) {
  const neg = unscaled < 0n;
  let digits = (neg ? -unscaled : unscaled).toString();
  if (scale === 0) return (neg ? '-' : '') + digits;
  while (digits.length <= scale) digits = '0' + digits;
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  return (neg ? '-' : '') + intPart + '.' + fracPart;
}

/** -1, 0 or 1. Numeric comparison, never lexicographic. */
export function compare(a, b) {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  const ua = widen(da, scale);
  const ub = widen(db, scale);
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

export function isZero(str) {
  return parse(str).unscaled === 0n;
}

export function max(a, b) {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a, b) {
  return compare(a, b) <= 0 ? a : b;
}

export function add(a, b) {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  return format(widen(da, scale) + widen(db, scale), scale);
}

export function sub(a, b) {
  const da = parse(a);
  const db = parse(b);
  const scale = Math.max(da.scale, db.scale);
  return format(widen(da, scale) - widen(db, scale), scale);
}

export function mul(a, b) {
  const da = parse(a);
  const db = parse(b);
  return format(da.unscaled * db.unscaled, da.scale + db.scale);
}

/** Round a decimal string to `dp` places, half away from zero. */
export function roundTo(str, dp) {
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

/**
 * a / b, rounded half away from zero to `dp` decimal places.
 *
 * A quotient of two decimals is not generally a terminating decimal (1/3
 * is not), so "exact" division is not a coherent goal. What we guarantee
 * instead: the result is correctly rounded to `dp` places, computed with
 * `guard` extra digits of precision so the rounding decision at `dp` is
 * correct to well beyond any realistic price/quantity magnitude.
 */
export function divRound(aStr, bStr, dp, guard = 12) {
  const da = parse(aStr);
  const db = parse(bStr);
  if (db.unscaled === 0n) throw new RangeError('division by zero');
  const wantScale = dp + guard;
  const numerator = da.unscaled * pow10(db.scale + wantScale);
  const denominator = db.unscaled * pow10(da.scale);
  const guarded = numerator / denominator;
  return roundTo(format(guarded, wantScale), dp);
}

export function isNegative(str) {
  return parse(str).unscaled < 0n;
}

/** Structural validity only, per PROTOCOL.md's decimal string rule. */
export function isDecimalString(v) {
  return typeof v === 'string' && DECIMAL_RE.test(v.trim());
}
