import { fromISO } from './calc.js';
import { esc } from './util.js';

export const CURRENCIES = [
  ['EUR', 'Euro'], ['USD', 'US Dollar'], ['GBP', 'British Pound'], ['CHF', 'Swiss Franc'],
  ['PLN', 'Polish Złoty'], ['CZK', 'Czech Koruna'], ['UAH', 'Ukrainian Hryvnia'], ['SEK', 'Swedish Krona'],
  ['NOK', 'Norwegian Krone'], ['DKK', 'Danish Krone'], ['HUF', 'Hungarian Forint'], ['RON', 'Romanian Leu'],
  ['TRY', 'Turkish Lira'], ['CAD', 'Canadian Dollar'], ['AUD', 'Australian Dollar'], ['NZD', 'New Zealand Dollar'],
  ['JPY', 'Japanese Yen'], ['INR', 'Indian Rupee'], ['BRL', 'Brazilian Real'], ['MXN', 'Mexican Peso'],
  ['AED', 'UAE Dirham'], ['ZAR', 'South African Rand'],
];

/** Guess a sensible starting currency from the browser locale. */
export function guessCurrency(locale = navigator.language || 'en') {
  const region = (locale.split('-')[1] || '').toUpperCase();
  const map = { US: 'USD', GB: 'GBP', CH: 'CHF', PL: 'PLN', CZ: 'CZK', UA: 'UAH', SE: 'SEK', NO: 'NOK', DK: 'DKK', HU: 'HUF', RO: 'RON', TR: 'TRY', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', IN: 'INR', BR: 'BRL', MX: 'MXN', AE: 'AED', ZA: 'ZAR' };
  const lang = locale.split('-')[0];
  return map[region] || ({ pl: 'PLN', cs: 'CZK', uk: 'UAH', sv: 'SEK', nb: 'NOK', da: 'DKK', hu: 'HUF', ro: 'RON', tr: 'TRY', ja: 'JPY' }[lang]) || 'EUR';
}

export function makeFormatter(currency, locale = navigator.language || 'en') {
  const build = (opts) => {
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency, ...opts }); }
    catch { return new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR', ...opts }); }
  };
  const full = build({});
  const whole = build({ maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const dateLocale = /^en-US/i.test(locale) ? 'en-US' : 'en-GB';
  const dfmt = (opts) => new Intl.DateTimeFormat(dateLocale, opts);
  const f = {
    wd: dfmt({ weekday: 'short' }), wdLong: dfmt({ weekday: 'long' }),
    md: dfmt({ day: 'numeric', month: 'short' }), mdLong: dfmt({ weekday: 'long', day: 'numeric', month: 'long' }),
    month: dfmt({ month: 'short' }), monthLong: dfmt({ month: 'long' }), my: dfmt({ month: 'short', year: 'numeric' }),
    day: dfmt({ day: 'numeric' }),
  };
  const d = (iso, key) => f[key].format(fromISO(iso));

  return {
    currency,
    /** "€12.50", or "€12" when `round` is set. */
    money: (cents, { round = false } = {}) => (round ? whole : full).format(cents / 100),
    /** Whole units when the amount is a whole number, cents otherwise: "€12" / "€12.50". */
    moneyAuto: (cents) => (cents % 100 === 0 ? whole : full).format(cents / 100),
    /** Signed: "+€5.00" / "−€5.00". */
    signed: (cents) => `${cents < 0 ? '−' : '+'}${full.format(Math.abs(cents) / 100)}`,
    /** HTML with the fraction in a smaller span — used for big hero numbers. */
    hero: (cents) =>
      full.formatToParts(cents / 100)
        .map((p) => (p.type === 'decimal' || p.type === 'fraction' ? `<span class="frac">${esc(p.value)}</span>` : esc(p.value)))
        .join(''),
    symbol: full.formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency,
    weekday: (iso) => d(iso, 'wd'),
    weekdayLong: (iso) => d(iso, 'wdLong'),
    dayNum: (iso) => d(iso, 'day'),
    dayMonth: (iso) => d(iso, 'md'),
    dateLong: (iso) => d(iso, 'mdLong'),
    monthShort: (iso) => d(iso, 'month'),
    monthLong: (iso) => d(iso, 'monthLong'),
    monthYear: (iso) => d(iso, 'my'),
    range: (a, b) => f.md.formatRange(fromISO(a), fromISO(b)),
  };
}
