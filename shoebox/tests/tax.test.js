import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, endOfMonth, isISODate } from '../public/js/dates.js';
import {
  amounts, mtdPeriodSummary, nextDeadline, quarters, quarterStatus, summarise, taxYearLabel, taxYearOf, vatPeriod,
} from '../public/js/tax.js';
import { cell, recordsCSV, summaryCSV, vatCSV } from '../public/js/export.js';

const exp = (date, gross, extra = {}) => ({ id: `${date}-${gross}`, kind: 'expense', date, gross, vat: 0, category: 'adminCosts', businessPct: 100, merchant: 'Shop', description: '', ...extra });
const inc = (date, gross, extra = {}) => ({ id: `i-${date}-${gross}`, kind: 'income', date, gross, vat: 0, category: 'turnover', merchant: 'Client', description: '', ...extra });

test('dates and amounts', () => {
  assert.equal(parseAmount('£1,234.56'), 123456);
  assert.equal(parseAmount('12,50'), 1250);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
  assert.equal(endOfMonth('2026-11-15', -3), '2026-08-31');
  assert.ok(isISODate('2026-02-28'));
  assert.ok(!isISODate('2026-02-30'));
});

test('tax year boundaries', () => {
  assert.equal(taxYearOf('2026-04-05'), 2025);
  assert.equal(taxYearOf('2026-04-06'), 2026);
  assert.equal(taxYearOf('2027-01-15'), 2026);
  assert.equal(taxYearOf('2026-04-02', 'calendar'), 2026);
  assert.equal(taxYearOf('2026-03-31', 'calendar'), 2025);
  assert.equal(taxYearLabel(2026), '2026/27');
  assert.equal(taxYearLabel(2099), '2099/00');
});

test('quarterly update periods and deadlines', () => {
  const q = quarters(2026);
  assert.deepEqual(q.map((x) => [x.start, x.end, x.deadline]), [
    ['2026-04-06', '2026-07-05', '2026-08-07'],
    ['2026-07-06', '2026-10-05', '2026-11-07'],
    ['2026-10-06', '2027-01-05', '2027-02-07'],
    ['2027-01-06', '2027-04-05', '2027-05-07'],
  ]);
  assert.ok(q.every((x) => x.yearStart === '2026-04-06'));
  const c = quarters(2026, 'calendar');
  assert.deepEqual(c.map((x) => [x.start, x.end]), [
    ['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-12-31'], ['2027-01-01', '2027-03-31'],
  ]);
  assert.equal(quarterStatus(q[1], '2026-10-28'), 'due');
  assert.equal(quarterStatus(q[1], '2026-11-08'), 'overdue');
  assert.equal(quarterStatus(q[1], '2026-11-08', { '2026-Q2': true }), 'submitted');
  assert.equal(quarterStatus(q[2], '2026-10-28'), 'open');
  assert.equal(quarterStatus(q[3], '2026-10-28'), 'upcoming');
});

test('next deadline looks back into the previous tax year', () => {
  assert.equal(nextDeadline('2026-10-28').id, '2026-Q2');
  assert.equal(nextDeadline('2027-04-20').id, '2026-Q4'); // Q4 of 2026/27 is due 7 May 2027
  assert.equal(nextDeadline('2026-10-28', 'standard', { '2026-Q2': true }), null);
  assert.equal(nextDeadline('2026-09-01'), null); // Q1 was due 7 Aug, Q2 not finished yet
});

test('VAT periods for each stagger', () => {
  assert.deepEqual(vatPeriod('2026-10-28', 1), { start: '2026-10-01', end: '2026-12-31', deadline: '2027-02-07' });
  assert.deepEqual(vatPeriod('2026-10-28', 2), { start: '2026-08-01', end: '2026-10-31', deadline: '2026-12-07' });
  assert.deepEqual(vatPeriod('2026-10-28', 3), { start: '2026-09-01', end: '2026-11-30', deadline: '2027-01-07' });
  assert.deepEqual(vatPeriod('2027-01-15', 2), { start: '2026-11-01', end: '2027-01-31', deadline: '2027-03-07' });
  assert.deepEqual(vatPeriod('2026-03-31', 1), { start: '2026-01-01', end: '2026-03-31', deadline: '2026-05-07' });
});

test('record amounts: VAT, private use, entertaining', () => {
  const vatReg = { vatRegistered: true };
  // £120 incl. £20 VAT, fully business
  assert.deepEqual(amounts(exp('2026-05-01', 12000, { vat: 2000 }), vatReg), { amount: 10000, disallowable: 0, vatReclaim: 2000, purchasesNet: 10000 });
  // Not VAT registered: the whole £120 is the cost
  assert.deepEqual(amounts(exp('2026-05-01', 12000, { vat: 2000 }), {}), { amount: 12000, disallowable: 0, vatReclaim: 0, purchasesNet: 10000 });
  // Phone bill 60% business, VAT registered: reclaim 60% of VAT; private 40% of the gross is disallowable
  const phone = amounts(exp('2026-05-01', 6000, { vat: 1000, businessPct: 60 }), vatReg);
  assert.deepEqual(phone, { amount: 5400, disallowable: 2400, vatReclaim: 600, purchasesNet: 3000 });
  assert.equal(phone.amount - phone.disallowable, Math.round((6000 - 1000) * 0.6)); // allowable = business share net of VAT
  // Client lunch: never deductible, no VAT reclaim
  assert.deepEqual(amounts(exp('2026-05-01', 4800, { vat: 800, category: 'businessEntertainmentCosts' }), vatReg), { amount: 4800, disallowable: 4800, vatReclaim: 0, purchasesNet: 4000 });
  // VAT bigger than the gross is clamped
  assert.equal(amounts(exp('2026-05-01', 1000, { vat: 5000 }), vatReg).amount, 0);
  // Income
  assert.deepEqual(amounts(inc('2026-05-01', 60000, { vat: 10000 }), vatReg), { amount: 50000, disallowable: 0, vatOutput: 10000, salesNet: 50000 });
  assert.deepEqual(amounts(inc('2026-05-01', 60000), {}), { amount: 60000, disallowable: 0, vatOutput: 0, salesNet: 60000 });
});

test('summarise groups by HMRC field within the period', () => {
  const records = [
    exp('2026-04-05', 99999), // previous tax year — outside
    exp('2026-04-10', 2400, { vat: 400, category: 'carVanTravelExpenses' }),
    exp('2026-05-10', 1200, { category: 'adminCosts', businessPct: 50 }),
    exp('2026-06-01', 3600, { vat: 600, category: 'businessEntertainmentCosts' }),
    exp('2026-06-02', 50000, { category: 'wagesAndStaffCosts' }),
    exp('2026-06-03', 500, { category: 'nonsense' }),
    inc('2026-06-15', 240000, { vat: 40000 }),
    inc('2026-06-20', 10000, { category: 'other' }),
    inc('2026-07-06', 777), // next quarter — outside
  ];
  const s = summarise(records, '2026-04-06', '2026-07-05', { vatRegistered: true });
  assert.equal(s.count, 7);
  assert.equal(s.expenses.carVanTravelExpenses.amount, 2000);
  assert.deepEqual(s.expenses.adminCosts, { amount: 1200, disallowable: 600, count: 1 });
  assert.equal(s.expenses.businessEntertainmentCosts.disallowable, 3600);
  assert.equal(s.expenses.otherExpenses.amount, 500); // unknown category falls back to "other"
  assert.deepEqual(s.income, { turnover: 200000, other: 10000 });
  assert.equal(s.totals.expenses, 2000 + 1200 + 3600 + 50000 + 500);
  assert.equal(s.totals.allowable, 2000 + 600 + 0 + 50000 + 500);
  assert.equal(s.totals.profit, 210000 - 53100);
  // VAT: output 400.00, reclaim 4.00 (travel only), box 7 excludes wages
  assert.equal(s.vat.box1, 40000);
  assert.equal(s.vat.box4, 400);
  assert.equal(s.vat.box5, 39600);
  assert.equal(s.vat.refund, false);
  assert.equal(s.vat.box6, 2100);
  assert.equal(s.vat.box7, Math.floor((2000 + 600 + 3000 + 500) / 100));
});

test('MTD period summary JSON shape', () => {
  const s = summarise([exp('2026-04-10', 2400, { vat: 400, category: 'carVanTravelExpenses' }), exp('2026-04-11', 1000, { businessPct: 70 }), inc('2026-04-12', 100050)], '2026-04-06', '2026-07-05', {});
  assert.deepEqual(mtdPeriodSummary(s), {
    periodDates: { periodStartDate: '2026-04-06', periodEndDate: '2026-07-05' },
    periodIncome: { turnover: 1000.5, other: 0 },
    periodExpenses: { carVanTravelExpenses: 24, adminCosts: 10 },
    periodDisallowableExpenses: { adminCostsDisallowable: 3 },
  });
  assert.deepEqual(mtdPeriodSummary(s, { consolidated: true }).periodExpenses, { consolidatedExpenses: 31 });
});

test('CSV exports escape text and resist formula injection', () => {
  assert.equal(cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell(-5), '-5');
  const settings = { vatRegistered: false, businessName: 'Jo, Plumbing' };
  const records = [exp('2026-05-02', 1999, { merchant: '@Screwfix', description: 'Pipe "15mm"', imageKey: 'k' }), inc('2026-05-01', 50000)];
  const csv = recordsCSV(records, settings).split('\r\n');
  assert.match(csv[0], /^Date,Type,/);
  assert.match(csv[1], /^2026-05-01,Income,Client/);
  assert.match(csv[2], /^2026-05-02,Expense,'@Screwfix,"Pipe ""15mm""",Office, phone & software|^2026-05-02,Expense,'@Screwfix,"Pipe ""15mm""","Office, phone & software"/);
  assert.ok(csv[2].includes(',19.99,0.00,100,19.99,0.00,19.99,0.00,,yes,'));
  const s = summarise(records, '2026-04-06', '2026-07-05', settings);
  const sum = summaryCSV(s, { settings, title: 'Q1', generated: '2026-07-10' });
  assert.ok(sum.includes('Business,"Jo, Plumbing"'));
  assert.ok(sum.includes('Expenses,adminCosts,"Office, phone & software",19.99,0.00,19.99'));
  assert.ok(sum.includes('Total,,Profit (income − allowable expenses),480.01'));
  assert.ok(summaryCSV(s, { settings, title: 'Q1', consolidated: true }).includes('consolidatedExpenses,All allowable expenses,19.99'));
  assert.ok(vatCSV(s, { settings }).includes('5,Net VAT to pay,0.00'));
});
