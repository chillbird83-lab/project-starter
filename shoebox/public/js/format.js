// Display formatting: always pounds and UK dates, because the records are for HMRC.
import { fromISO } from './dates.js';
import { esc } from './util.js';

const full = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const dfmt = (opts) => new Intl.DateTimeFormat('en-GB', opts);
const F = {
  short: dfmt({ day: 'numeric', month: 'short' }),
  long: dfmt({ day: 'numeric', month: 'long', year: 'numeric' }),
  medium: dfmt({ day: 'numeric', month: 'short', year: 'numeric' }),
  weekday: dfmt({ weekday: 'short', day: 'numeric', month: 'short' }),
  month: dfmt({ month: 'long', year: 'numeric' }),
};

/** "£12.50" */
export const money = (pence) => full.format(pence / 100);
/** Hero number with the pence in a smaller span. */
export const heroMoney = (pence) => full.formatToParts(pence / 100)
  .map((p) => (p.type === 'decimal' || p.type === 'fraction' ? `<span class="frac">${esc(p.value)}</span>` : esc(p.value))).join('');

export const dateShort = (iso) => F.short.format(fromISO(iso));
export const dateLong = (iso) => F.long.format(fromISO(iso));
export const dateMedium = (iso) => F.medium.format(fromISO(iso));
export const dateDay = (iso) => F.weekday.format(fromISO(iso));
export const monthYear = (iso) => F.month.format(fromISO(iso));
/** "6 Jul – 5 Oct 2026" */
export const dateRange = (a, b) => F.medium.formatRange(fromISO(a), fromISO(b));

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** "in 3 days", "tomorrow", "today", "2 days ago" */
export function relDays(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
