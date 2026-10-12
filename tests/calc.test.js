import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, diffDays, startOfWeek, parseAmount, weekSummary, weekHistory,
  planSummary, categoryBreakdown, bucketTotals, rangeTotals, weeklyBudgetFor,
} from '../js/calc.js';

const tx = (date, amount, extra = {}) => ({ id: `${date}-${amount}`, type: 'expense', categoryId: 'food', note: '', date, amount, ...extra });
const mk = (transactions = [], extra = {}) => ({
  settings: { weekStart: 1 },
  weeklyBudgets: [{ from: '2026-10-12', amount: 50000 }],
  transactions,
  plans: [],
  ...extra,
});

test('date helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-10-25', '2026-10-26'), 1); // across DST end in Europe
  assert.equal(diffDays('2026-03-28', '2026-03-30'), 2); // across DST start in Europe
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(startOfWeek('2026-10-12', 1), '2026-10-12'); // Monday
  assert.equal(startOfWeek('2026-10-18', 1), '2026-10-12'); // Sunday belongs to the Monday week
  assert.equal(startOfWeek('2026-10-18', 0), '2026-10-18'); // Sunday-first weeks
  assert.equal(startOfWeek('2026-10-17', 6), '2026-10-17'); // Saturday-first
});

test('parseAmount', () => {
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('12,50'), 1250);
  assert.equal(parseAmount('€ 12,5'), 1250);
  assert.equal(parseAmount('1 234,56'), 123456);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('1,234'), 123400);
  assert.equal(parseAmount('1.234.567'), 123456700);
  assert.equal(parseAmount('0,125'), 13);
  assert.equal(parseAmount('.5'), 50);
  assert.equal(parseAmount('0.1') + parseAmount('0.2'), 30);
  assert.equal(parseAmount('19.99'), 1999);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal(parseAmount('-5'), 500); // minus sign is ignored; the app has separate expense/income types
  assert.equal(parseAmount(12.34), 1234);
});

test('week: daily running balance matches "budget minus what I spend"', () => {
  const s = mk([tx('2026-10-12', 3000), tx('2026-10-12', 1250), tx('2026-10-13', 5000), tx('2026-10-13', 999, { type: 'income' })]);
  const w = weekSummary(s, '2026-10-12', '2026-10-14');
  assert.equal(w.budget, 50000);
  assert.deepEqual(w.days.map((d) => d.remaining), [45750, 40750, 40750, 40750, 40750, 40750, 40750]);
  assert.equal(w.spent, 9250);
  assert.equal(w.remaining, 40750);
  assert.equal(w.income, 999);
  assert.equal(w.isCurrent, true);
  assert.equal(w.daysLeft, 5); // Wed..Sun
  // (500 - 92.50 + 0 spent today) / 5 days — spent before today = 92.50
  assert.equal(w.safePerDay, Math.floor((50000 - 9250) / 5));
  assert.equal(w.leftToday, w.safePerDay);
  assert.equal(w.status, 'ok');
});

test('week: spending today reduces what is left today but not tomorrow-shares retroactively', () => {
  const s = mk([tx('2026-10-12', 10000), tx('2026-10-14', 4000)]);
  const w = weekSummary(s, '2026-10-12', '2026-10-14');
  assert.equal(w.safePerDay, Math.floor(40000 / 5));
  assert.equal(w.leftToday, 8000 - 4000);
  assert.equal(w.todaySpent, 4000);
});

test('week: statuses', () => {
  assert.equal(weekSummary(mk([tx('2026-10-12', 51000)]), '2026-10-12', '2026-10-13').status, 'over');
  assert.equal(weekSummary(mk([tx('2026-10-12', 46000)]), '2026-10-12', '2026-10-17').status, 'warn');
  assert.equal(weekSummary(mk([tx('2026-10-12', 30000)]), '2026-10-12', '2026-10-13').status, 'warn'); // 60% used after 2/7 days
  assert.equal(weekSummary(mk([tx('2026-10-12', 20000)]), '2026-10-12', '2026-10-15').status, 'ok');
  const past = weekSummary(mk([tx('2026-10-12', 49000)]), '2026-10-12', '2026-10-25');
  assert.equal(past.status, 'ok');
  assert.equal(past.isPast, true);
  assert.equal(past.daysLeft, 0);
  assert.equal(past.safePerDay, 0);
});

test('week: future and empty weeks', () => {
  const f = weekSummary(mk(), '2026-10-19', '2026-10-14');
  assert.equal(f.isFuture, true);
  assert.equal(f.daysLeft, 7);
  assert.equal(f.safePerDay, Math.floor(50000 / 7));
  assert.equal(f.remaining, 50000);
  const zero = weekSummary({ ...mk(), weeklyBudgets: [] }, '2026-10-12', '2026-10-12');
  assert.equal(zero.budget, 0);
  assert.equal(zero.usedPct, 0);
});

test('weekly budget history applies from the week it was set', () => {
  const s = mk([], { weeklyBudgets: [{ from: '2026-09-28', amount: 30000 }, { from: '2026-10-12', amount: 50000 }] });
  assert.equal(weeklyBudgetFor(s, '2026-09-21'), 30000);
  assert.equal(weeklyBudgetFor(s, '2026-10-05'), 30000);
  assert.equal(weeklyBudgetFor(s, '2026-10-12'), 50000);
  assert.equal(weeklyBudgetFor(s, '2026-11-02'), 50000);
});

test('week history stops at the first week of use', () => {
  const s = mk([tx('2026-09-30', 1000)]);
  const h = weekHistory(s, 8, '2026-10-14');
  assert.deepEqual(h.map((w) => w.weekStart), ['2026-09-28', '2026-10-05', '2026-10-12']);
});

test('plan: pace, projection and monthly buckets', () => {
  const plan = { id: 'p', name: 'Q4', amount: 300000, start: '2026-10-01', months: 3 };
  const s = mk([tx('2026-10-05', 40000), tx('2026-10-20', 10000), tx('2026-09-30', 99999), tx('2026-12-31', 5000)]);
  const p = planSummary(s, plan, '2026-10-20');
  assert.equal(p.end, '2027-01-01');
  assert.equal(p.totalDays, 92);
  assert.equal(p.elapsed, 20);
  assert.equal(p.daysLeft, 72);
  assert.equal(p.spent, 55000); // Sep 30 excluded, Dec 31 included
  assert.equal(p.remaining, 245000);
  assert.deepEqual(p.months.map((m) => m.spent), [50000, 0, 5000]);
  assert.deepEqual(p.months.map((m) => m.state), ['current', 'future', 'future']);
  assert.equal(p.months[0].budget, 100000);
  assert.equal(p.projected, Math.round((55000 / 20) * 92));
  assert.equal(p.status, 'ontrack');
  assert.equal(p.perDayLeft, Math.floor(p.remaining / 72));
});

test('plan: statuses', () => {
  const plan = { id: 'p', name: 'Trip', amount: 100000, start: '2026-10-01', months: 2 };
  assert.equal(planSummary(mk(), plan, '2026-09-20').status, 'upcoming');
  assert.equal(planSummary(mk([tx('2026-10-02', 60000)]), plan, '2026-10-15').status, 'pace');
  assert.equal(planSummary(mk([tx('2026-10-02', 100001)]), plan, '2026-10-15').status, 'over');
  assert.equal(planSummary(mk([tx('2026-10-02', 90000)]), plan, '2027-01-05').status, 'done');
  assert.equal(planSummary(mk([tx('2026-10-02', 1000)]), plan, '2026-10-03').status, 'ontrack'); // too early to project
});

test('plan: category filter', () => {
  const plan = { id: 'p', name: 'Travel', amount: 100000, start: '2026-10-01', months: 1, categoryIds: ['travel'] };
  const s = mk([tx('2026-10-02', 5000, { categoryId: 'travel' }), tx('2026-10-02', 7000, { categoryId: 'food' }), tx('2026-10-03', 9000, { categoryId: 'travel', type: 'income' })]);
  assert.equal(planSummary(s, plan, '2026-10-10').spent, 5000);
});

test('breakdown, buckets and totals', () => {
  const s = [tx('2026-10-12', 3000, { categoryId: 'a' }), tx('2026-10-13', 1000, { categoryId: 'b' }), tx('2026-10-13', 1000, { categoryId: 'a' }), tx('2026-10-13', 777, { type: 'income' }), tx('2026-11-01', 9, { categoryId: 'a' })];
  const b = categoryBreakdown(s, '2026-10-12', '2026-10-18');
  assert.deepEqual(b.map((x) => [x.categoryId, x.total]), [['a', 4000], ['b', 1000]]);
  assert.equal(Math.round(b[0].pct * 100), 80);
  const days = bucketTotals(s, '2026-10-12', '2026-10-18', 1);
  assert.equal(days.length, 7);
  assert.equal(days[1].spent, 2000);
  assert.equal(days[1].income, 777);
  const weeks = bucketTotals(s, '2026-10-12', '2026-10-25', 7);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].spent, 5000);
  assert.deepEqual(rangeTotals(s, '2026-10-12', '2026-10-18'), { spent: 5000, income: 777, net: -4223, count: 4 });
});
