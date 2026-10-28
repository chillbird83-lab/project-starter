// Date formatting for the interface (English UI; US users get month-first dates).
import { fromISO } from './logic.js';

const locale = /^en-US/i.test(navigator.language || '') ? 'en-US' : 'en-GB';
const f = (opts) => new Intl.DateTimeFormat(locale, opts);
const F = {
  dayMonth: f({ weekday: 'short', day: 'numeric', month: 'short' }),
  dateLong: f({ weekday: 'long', day: 'numeric', month: 'long' }),
  monthYear: f({ month: 'long', year: 'numeric' }),
  weekdayLong: f({ weekday: 'long' }),
  weekdayShort: f({ weekday: 'short' }),
  short: f({ day: 'numeric', month: 'short' }),
  time: f({ hour: '2-digit', minute: '2-digit' }),
};

export const dayMonth = (iso) => F.dayMonth.format(fromISO(iso));
export const dateLong = (iso) => F.dateLong.format(fromISO(iso));
export const monthYear = (yyyyMm) => F.monthYear.format(fromISO(`${yyyyMm}-01`));
export const weekday = (iso) => F.weekdayLong.format(fromISO(iso));
export const weekdayShort = (iso) => F.weekdayShort.format(fromISO(iso));
export const range = (a, b) => F.short.formatRange(fromISO(a), fromISO(b));
export const clockTime = (epochMs) => F.time.format(new Date(epochMs));
/** "10:15" from minutes after midnight. */
export const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
