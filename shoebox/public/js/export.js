// CSV / JSON files for HMRC bridging software, an accountant, or a spreadsheet.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryOf } from './categories.js';
import { pounds } from './dates.js';
import { amounts, mtdPeriodSummary, taxYearLabel } from './tax.js';

/** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with an apostrophe. */
export function cell(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCSV = (rows) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

/** Every record, one per line — the digital records HMRC asks you to keep. */
export function recordsCSV(records, settings) {
  const rows = [[
    'Date', 'Type', 'Supplier or customer', 'Description', 'Category', 'HMRC field', 'Gross £', 'VAT £',
    'Business use %', 'Amount for tax £', 'Disallowable £', 'Allowable £', 'VAT reclaimable £', 'Payment', 'Receipt image', 'Record ID',
  ]];
  for (const r of [...records].sort((a, b) => a.date.localeCompare(b.date))) {
    const a = amounts(r, settings);
    const cat = categoryOf(r.category, r.kind);
    const income = r.kind === 'income';
    rows.push([
      r.date, income ? 'Income' : 'Expense', r.merchant, r.description, cat.label, cat.id, pounds(r.gross), pounds(r.vat || 0),
      income ? '' : (r.businessPct ?? 100), pounds(a.amount), pounds(a.disallowable), pounds(a.amount - a.disallowable),
      income ? '' : pounds(a.vatReclaim), r.payment || '', r.imageKey ? 'yes' : 'no', r.id,
    ]);
  }
  return toCSV(rows);
}

/** Quarterly update totals, labelled with HMRC's field names so they can be keyed or mapped across. */
export function summaryCSV(summary, { settings, title, consolidated = false, generated = new Date().toISOString().slice(0, 10) }) {
  const rows = [
    [title], ['Business', settings.businessName || ''], ['Period', `${summary.from} to ${summary.to}`],
    ['Generated', generated], ['Records', summary.count], [],
    ['Section', 'HMRC field', 'Description', 'Amount £', 'Disallowable £', 'Allowable £'],
    ['Income', 'turnover', INCOME_CATEGORIES[0].label, pounds(summary.income.turnover), '', pounds(summary.income.turnover)],
    ['Income', 'other', INCOME_CATEGORIES[1].label, pounds(summary.income.other), '', pounds(summary.income.other)],
  ];
  if (consolidated) {
    rows.push(['Expenses', 'consolidatedExpenses', 'All allowable expenses', pounds(summary.totals.allowable), '', pounds(summary.totals.allowable)]);
  } else {
    for (const c of EXPENSE_CATEGORIES) {
      const e = summary.expenses[c.id];
      rows.push(['Expenses', c.id, c.label, pounds(e.amount), pounds(e.disallowable), pounds(e.amount - e.disallowable)]);
    }
  }
  rows.push(
    [],
    ['Total', '', 'Income', pounds(summary.totals.income)],
    ['Total', '', 'Expenses', pounds(summary.totals.expenses), pounds(summary.totals.disallowable), pounds(summary.totals.allowable)],
    ['Total', '', 'Profit (income − allowable expenses)', pounds(summary.totals.profit)],
  );
  return toCSV(rows);
}

export function vatCSV(summary, { settings, generated = new Date().toISOString().slice(0, 10) }) {
  const v = summary.vat;
  return toCSV([
    ['VAT return'], ['Business', settings.businessName || ''], ['Period', `${summary.from} to ${summary.to}`], ['Generated', generated], [],
    ['Box', 'Description', 'Value'],
    [1, 'VAT due on sales and other outputs', pounds(v.box1)],
    [2, 'VAT due on acquisitions from the EU (Northern Ireland only)', pounds(v.box2)],
    [3, 'Total VAT due (box 1 + box 2)', pounds(v.box3)],
    [4, 'VAT reclaimed on purchases and other inputs', pounds(v.box4)],
    [5, v.refund ? 'Net VAT to reclaim' : 'Net VAT to pay', pounds(v.box5)],
    [6, 'Total value of sales excluding VAT (whole pounds)', v.box6],
    [7, 'Total value of purchases excluding VAT (whole pounds)', v.box7],
    [8, 'Supplies of goods to the EU (Northern Ireland only)', v.box8],
    [9, 'Acquisitions of goods from the EU (Northern Ireland only)', v.box9],
  ]);
}

export function summaryJSON(summary, { settings, taxYear, consolidated = false }) {
  return JSON.stringify({
    source: 'Shoebox',
    business: settings.businessName || undefined,
    taxYear: taxYearLabel(taxYear),
    note: 'Cumulative period summary in the shape of HMRC\'s Self-Employment Business (MTD) API. Amounts in GBP.',
    ...mtdPeriodSummary(summary, { consolidated }),
  }, null, 2);
}

/** "shoebox-2026-27-Q2-mtd.csv" */
export const fileName = (taxYear, part, ext) => `shoebox-${taxYearLabel(taxYear).replace('/', '-')}-${part}.${ext}`;
