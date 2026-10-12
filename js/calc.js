// Pure budget logic. No DOM, no storage — everything here is unit-tested.
// Money is always an integer number of minor units (cents). Dates are local 'YYYY-MM-DD' strings.

const pad = (n) => String(n).padStart(2, '0');

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayISO = () => toISO(new Date());

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

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso, n) {
  const d = fromISO(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
}

/** First day of the week containing `iso`. weekStart: 0 = Sunday … 6 = Saturday. */
export function startOfWeek(iso, weekStart = 1) {
  const dow = fromISO(iso).getDay();
  return addDays(iso, -((dow - weekStart + 7) % 7));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Parses user input like "12", "12.5", "12,50", "1 234,56", "1,234.56". Returns cents or NaN.
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

const sumBy = (txs, pred) => txs.reduce((a, t) => (pred(t) ? a + t.amount : a), 0);

/** Weekly budget in force for the week starting `weekStart`. */
export function weeklyBudgetFor(state, weekStart) {
  const list = [...(state.weeklyBudgets || [])].sort((a, b) => a.from.localeCompare(b.from));
  if (!list.length) return 0;
  let amount = list[0].amount; // weeks before the first entry use the earliest budget
  for (const b of list) if (b.from <= weekStart) amount = b.amount;
  return amount;
}

/** Everything the "This week" screen needs. */
export function weekSummary(state, weekStart, today = todayISO()) {
  const budget = weeklyBudgetFor(state, weekStart);
  const weekEnd = addDays(weekStart, 6);
  const txs = state.transactions;
  const isCurrent = today >= weekStart && today <= weekEnd;
  const isPast = today > weekEnd;
  const todayIdx = isCurrent ? diffDays(weekStart, today) : isPast ? 7 : -1;

  const days = [];
  let running = budget;
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const spent = sumBy(txs, (t) => t.type === 'expense' && t.date === date);
    const income = sumBy(txs, (t) => t.type === 'income' && t.date === date);
    running -= spent;
    days.push({
      date,
      spent,
      income,
      remaining: running,
      isToday: date === today,
      isFuture: date > today,
      isPast: date < today,
    });
  }

  const spent = days.reduce((a, d) => a + d.spent, 0);
  const income = days.reduce((a, d) => a + d.income, 0);
  const remaining = budget - spent;
  const daysLeft = isPast ? 0 : isCurrent ? 7 - todayIdx : 7;
  const spentBeforeToday = days.slice(0, Math.max(todayIdx, 0)).reduce((a, d) => a + d.spent, 0);
  const todaySpent = isCurrent ? days[todayIdx].spent : 0;
  // What you can spend per remaining day (today included) if you spread what is left evenly.
  const safePerDay = daysLeft > 0 ? Math.floor((budget - spentBeforeToday) / daysLeft) : 0;
  const leftToday = isCurrent ? safePerDay - todaySpent : 0;

  const usedPct = budget > 0 ? spent / budget : spent > 0 ? 1 : 0;
  const timePct = isPast ? 1 : isCurrent ? (todayIdx + 1) / 7 : 0;
  let status = 'ok';
  if (remaining < 0) status = 'over';
  else if (!isPast && (usedPct >= 0.9 || (isCurrent && usedPct > timePct + 0.15))) status = 'warn';

  return {
    weekStart, weekEnd, budget, spent, income, remaining, days,
    isCurrent, isPast, isFuture: !isCurrent && !isPast,
    daysLeft, safePerDay, todaySpent, leftToday,
    usedPct, status,
    dailyAverage: budget / 7,
  };
}

/** Last `n` weeks (oldest first) ending with the week containing `today`, trimmed to when the user started. */
export function weekHistory(state, n, today = todayISO()) {
  const ws = state.settings.weekStart;
  const first = [
    ...state.transactions.map((t) => t.date),
    ...(state.weeklyBudgets || []).map((b) => b.from),
  ].sort()[0];
  const out = [];
  let w = startOfWeek(today, ws);
  for (let i = 0; i < n; i++) {
    if (first && addDays(w, 6) < first) break;
    out.unshift(weekSummary(state, w, today));
    w = addDays(w, -7);
  }
  return out;
}

const matchesPlan = (plan, t) =>
  t.type === 'expense' && (!plan.categoryIds || plan.categoryIds.length === 0 || plan.categoryIds.includes(t.categoryId));

/** Everything a long-term plan card needs. `end` is exclusive. */
export function planSummary(state, plan, today = todayISO()) {
  const end = addMonths(plan.start, plan.months);
  const lastDay = addDays(end, -1);
  const totalDays = Math.max(1, diffDays(plan.start, end));
  const elapsed = clamp(diffDays(plan.start, today) + 1, 0, totalDays);
  const daysLeft = totalDays - elapsed;
  const inPlan = (t) => matchesPlan(plan, t) && t.date >= plan.start && t.date < end;
  const spent = sumBy(state.transactions, inPlan);
  const remaining = plan.amount - spent;
  const expected = Math.round((plan.amount * elapsed) / totalDays);
  const upcoming = today < plan.start;
  const ended = today >= end;
  const projected = elapsed >= 7 ? Math.round((spent / elapsed) * totalDays) : null;
  const perDayLeft = daysLeft > 0 ? Math.max(0, Math.floor(remaining / daysLeft)) : 0;

  let status = 'ontrack';
  if (upcoming) status = 'upcoming';
  else if (spent > plan.amount) status = 'over';
  else if (ended) status = 'done';
  else if (projected !== null && projected > plan.amount) status = 'pace';

  const perMonth = plan.amount / plan.months;
  const months = [];
  for (let i = 0; i < plan.months; i++) {
    const s = addMonths(plan.start, i);
    const e = addMonths(plan.start, i + 1);
    const mSpent = sumBy(state.transactions, (t) => matchesPlan(plan, t) && t.date >= s && t.date < e);
    months.push({
      start: s, end: e, spent: mSpent, budget: Math.round(perMonth),
      state: today >= e ? 'past' : today >= s ? 'current' : 'future',
    });
  }

  return {
    plan, end, lastDay, totalDays, elapsed, daysLeft, spent, remaining, expected,
    projected, perDayLeft, status, upcoming, ended, months,
    usedPct: plan.amount > 0 ? spent / plan.amount : 0,
    timePct: elapsed / totalDays,
  };
}

/** Expense totals per category for transactions in [from, to] (inclusive), biggest first. */
export function categoryBreakdown(transactions, from, to) {
  const totals = new Map();
  let all = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < from || t.date > to) continue;
    totals.set(t.categoryId, (totals.get(t.categoryId) || 0) + t.amount);
    all += t.amount;
  }
  return [...totals.entries()]
    .map(([categoryId, total]) => ({ categoryId, total, pct: all ? total / all : 0 }))
    .sort((a, b) => b.total - a.total);
}

/** Splits [from, to] into buckets of `size` days (oldest first) with expense/income totals. */
export function bucketTotals(transactions, from, to, size = 1) {
  const buckets = [];
  for (let s = from; s <= to; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    buckets.push({ start: s, end: e > to ? to : e, spent: 0, income: 0 });
  }
  for (const t of transactions) {
    if (t.date < from || t.date > to) continue;
    const b = buckets[Math.floor(diffDays(from, t.date) / size)];
    if (t.type === 'expense') b.spent += t.amount;
    else b.income += t.amount;
  }
  return buckets;
}

export function rangeTotals(transactions, from, to) {
  let spent = 0, income = 0, count = 0;
  for (const t of transactions) {
    if (t.date < from || t.date > to) continue;
    count++;
    if (t.type === 'expense') spent += t.amount;
    else income += t.amount;
  }
  return { spent, income, net: income - spent, count };
}
