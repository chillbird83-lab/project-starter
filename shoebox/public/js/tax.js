// Making Tax Digital rules for sole traders: tax years, quarterly update periods, deadlines, VAT
// periods, and how each record counts towards the HMRC totals. Pure functions, fully unit-tested.
import { EXPENSE_IDS, NOT_DEDUCTIBLE, OUTSIDE_VAT } from './categories.js';
import { addDays, endOfMonth } from './dates.js';

export const DEFAULT_SETTINGS = {
  businessName: '',
  vatRegistered: false,
  vatStagger: 1, // VAT quarters ending 1: Mar/Jun/Sep/Dec, 2: Apr/Jul/Oct/Jan, 3: May/Aug/Nov/Feb
  quarterBasis: 'standard', // 'standard' (6 Apr – 5 Jul …) or 'calendar' (1 Apr – 30 Jun …)
  reminders: true,
  accountantEmail: '',
  submitted: {}, // { '2026-Q1': true } — quarters the user marked as sent to HMRC
};

/** Turnover below the VAT registration threshold may report expenses as one consolidated total. */
export const CONSOLIDATED_LIMIT = 90_000_00;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** First calendar year of the tax year `date` falls in: 2026 for anything in 2026/27. */
export function taxYearOf(date, basis = 'standard') {
  const y = Number(date.slice(0, 4));
  return date.slice(5) >= (basis === 'calendar' ? '04-01' : '04-06') ? y : y - 1;
}

export const taxYearLabel = (y) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

export function taxYear(y, basis = 'standard') {
  return basis === 'calendar'
    ? { start: `${y}-04-01`, end: `${y + 1}-03-31` }
    : { start: `${y}-04-06`, end: `${y + 1}-04-05` };
}

/**
 * The four quarterly update periods of tax year `y`. Updates are cumulative: each one reports the
 * year so far (yearStart → end). Deadlines are the same on both bases.
 */
export function quarters(y, basis = 'standard') {
  const day = basis === 'calendar' ? '01' : '06';
  const starts = [`${y}-04-${day}`, `${y}-07-${day}`, `${y}-10-${day}`, `${y + 1}-01-${day}`, `${y + 1}-04-${day}`];
  const deadlines = [`${y}-08-07`, `${y}-11-07`, `${y + 1}-02-07`, `${y + 1}-05-07`];
  return deadlines.map((deadline, i) => ({
    id: `${y}-Q${i + 1}`, n: i + 1, year: y,
    start: starts[i], end: addDays(starts[i + 1], -1), yearStart: starts[0], deadline,
  }));
}

/** 'upcoming' | 'open' | 'due' | 'overdue' | 'submitted' */
export function quarterStatus(q, today, submitted = {}) {
  if (submitted[q.id]) return 'submitted';
  if (today < q.start) return 'upcoming';
  if (today <= q.end) return 'open';
  return today <= q.deadline ? 'due' : 'overdue';
}

/** The next quarterly update that has finished and is waiting to be sent, or null. */
export function nextDeadline(today, basis = 'standard', submitted = {}) {
  const y = taxYearOf(today, basis);
  return [...quarters(y - 1, basis), ...quarters(y, basis)]
    .find((q) => q.end < today && today <= q.deadline && !submitted[q.id]) ?? null;
}

/** The VAT quarter containing `date` for a stagger group (1, 2 or 3). Deadline: 1 month + 7 days. */
export function vatPeriod(date, stagger = 1) {
  const month = Number(date.slice(5, 7));
  const residue = (Number(stagger) + 2) % 3; // stagger 1 ends in months ≡ 0 (mod 3), and so on
  const ahead = (((residue - month) % 3) + 3) % 3;
  const end = endOfMonth(date, ahead);
  const start = addDays(endOfMonth(date, ahead - 3), 1);
  return { start, end, deadline: addDays(endOfMonth(end, 1), 7) };
}

/**
 * How one record counts for tax. Money in pence.
 * - amount: what goes in the HMRC category (net of reclaimable VAT when VAT-registered)
 * - disallowable: the part that is not tax-deductible (private use, client entertaining)
 * - vatReclaim / vatOutput: VAT return boxes 4 / 1; purchasesNet / salesNet: boxes 7 / 6
 */
export function amounts(r, { vatRegistered = false } = {}) {
  const gross = Math.max(0, r.gross || 0);
  const vat = clamp(r.vat || 0, 0, gross);
  if (r.kind === 'income') {
    return { amount: vatRegistered ? gross - vat : gross, disallowable: 0, vatOutput: vatRegistered ? vat : 0, salesNet: gross - vat };
  }
  const share = clamp(r.businessPct ?? 100, 0, 100) / 100;
  const purchasesNet = Math.round((gross - vat) * share);
  if (NOT_DEDUCTIBLE.has(r.category)) return { amount: gross, disallowable: gross, vatReclaim: 0, purchasesNet };
  const vatReclaim = vatRegistered ? Math.round(vat * share) : 0;
  const amount = gross - vatReclaim;
  return { amount, disallowable: Math.min(amount, Math.round(gross * (1 - share))), vatReclaim, purchasesNet };
}

/** Totals for records dated from..to (inclusive), grouped the way HMRC asks for them. */
export function summarise(records, from, to, settings = DEFAULT_SETTINGS) {
  const expenses = Object.fromEntries(EXPENSE_IDS.map((id) => [id, { amount: 0, disallowable: 0, count: 0 }]));
  const income = { turnover: 0, other: 0 };
  const vat = { output: 0, reclaim: 0, salesNet: 0, purchasesNet: 0 };
  let count = 0;
  for (const r of records) {
    if (r.date < from || r.date > to) continue;
    count++;
    const a = amounts(r, settings);
    if (r.kind === 'income') {
      income[r.category === 'other' ? 'other' : 'turnover'] += a.amount;
      vat.output += a.vatOutput;
      vat.salesNet += a.salesNet;
    } else {
      const e = expenses[r.category] ?? expenses.otherExpenses;
      e.amount += a.amount;
      e.disallowable += a.disallowable;
      e.count++;
      vat.reclaim += a.vatReclaim;
      if (!OUTSIDE_VAT.has(r.category)) vat.purchasesNet += a.purchasesNet;
    }
  }
  const totalIncome = income.turnover + income.other;
  const totalExpenses = Object.values(expenses).reduce((s, e) => s + e.amount, 0);
  const disallowable = Object.values(expenses).reduce((s, e) => s + e.disallowable, 0);
  const allowable = totalExpenses - disallowable;
  return {
    from, to, count, income, expenses,
    totals: { income: totalIncome, expenses: totalExpenses, disallowable, allowable, profit: totalIncome - allowable },
    vat: vatBoxes(vat),
  };
}

/** VAT return boxes. 1–5 in pence; 6–9 in whole pounds, as HMRC asks. */
export function vatBoxes({ output, reclaim, salesNet, purchasesNet }) {
  const box3 = output;
  return {
    box1: output, box2: 0, box3, box4: reclaim, box5: Math.abs(box3 - reclaim), refund: reclaim > box3,
    box6: Math.floor(salesNet / 100), box7: Math.floor(purchasesNet / 100), box8: 0, box9: 0,
  };
}

const gbp = (pence) => Math.round(pence) / 100;

/**
 * The totals in the shape of HMRC's Self-Employment Business API period summary
 * (periodIncome / periodExpenses / periodDisallowableExpenses), amounts in pounds.
 * `consolidated` sends one expenses total instead of categories (turnover under £90,000).
 */
export function mtdPeriodSummary(summary, { consolidated = false } = {}) {
  const out = {
    periodDates: { periodStartDate: summary.from, periodEndDate: summary.to },
    periodIncome: { turnover: gbp(summary.income.turnover), other: gbp(summary.income.other) },
  };
  if (consolidated) {
    out.periodExpenses = { consolidatedExpenses: gbp(summary.totals.allowable) };
    return out;
  }
  const expenses = {}, disallowable = {};
  for (const [id, e] of Object.entries(summary.expenses)) {
    if (e.amount) expenses[id] = gbp(e.amount);
    if (e.disallowable) disallowable[`${id}Disallowable`] = gbp(e.disallowable);
  }
  out.periodExpenses = expenses;
  if (Object.keys(disallowable).length) out.periodDisallowableExpenses = disallowable;
  return out;
}
