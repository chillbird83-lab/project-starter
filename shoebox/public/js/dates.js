// Date and money helpers. Dates are local 'YYYY-MM-DD' strings; money is an integer number of pence.

const pad = (n) => String(n).padStart(2, '0');

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayISO = () => toISO(new Date());

export const isISODate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = fromISO(s);
  return toISO(d) === s;
};

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Whole days from a to b (b - a). DST-safe. */
export function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
}

/** Last day of the month `n` months after the month containing `iso`. */
export function endOfMonth(iso, n = 0) {
  const d = fromISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + n + 1, 0));
}

/**
 * Parses user input like "12", "12.5", "12,50", "£1,234.56". Returns pence or NaN.
 * A lone separator followed by exactly three digits ("1,234") is read as a thousands separator.
 */
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : NaN;
  const s = String(input ?? '').replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return NaN;
  const seps = s.match(/[.,]/g) || [];
  let normalized = s;
  if (seps.length) {
    const sep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const intPart = s.slice(0, sep).replace(/[.,]/g, '');
    const frac = s.slice(sep + 1);
    const mixed = s.includes('.') && s.includes(',');
    const repeated = seps.length > 1 && !mixed;
    const thousands = !mixed && (repeated || (frac.length === 3 && intPart !== '' && intPart !== '0'));
    normalized = thousands ? s.replace(/[.,]/g, '') : `${intPart || '0'}.${frac}`;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Pence → "12.50" (for CSV files and form inputs). */
export const pounds = (pence) => (pence / 100).toFixed(2);
/** Pence → "12" or "12.50" for form inputs. */
export const penceToInput = (p) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));
