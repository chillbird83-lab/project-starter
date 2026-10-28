// Screens: Receipts and Tax (Making Tax Digital), plus the sign-in screen.
import { EXPENSE_CATEGORIES, categoryOf } from './categories.js';
import { addDays, diffDays } from './dates.js';
import { dateLong, dateRange, dateShort, heroMoney, money, monthYear, plural, relDays } from './format.js';
import { CONSOLIDATED_LIMIT, amounts, nextDeadline, quarters, quarterStatus, summarise, taxYear, taxYearLabel, vatPeriod } from './tax.js';
import { esc } from './util.js';

const STATUS = {
  upcoming: ['pill-neutral', 'Not started'],
  open: ['pill-neutral', 'In progress'],
  due: ['pill-warn', 'Ready to send'],
  overdue: ['pill-over', 'Overdue'],
  submitted: ['pill-ok', 'Sent'],
};

const icon = (cat) => `<span class="ico" style="--c:${esc(cat.color)}" aria-hidden="true">${esc(cat.emoji)}</span>`;

const yearPicker = (ctx) => `<div class="week-nav">
  <button type="button" class="icon-btn" data-action="year" data-value="-1" aria-label="Previous tax year"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
  <button type="button" class="icon-btn" data-action="year" data-value="1" aria-label="Next tax year" ${ctx.ui.year >= ctx.currentYear ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
</div>`;

/** The quarter to show by default: the one waiting to be sent, else the one in progress. */
export function defaultQuarter(ctx) {
  const { settings } = ctx.state;
  const qs = quarters(ctx.ui.year, settings.quarterBasis);
  const pending = nextDeadline(ctx.today, settings.quarterBasis, settings.submitted);
  if (pending?.year === ctx.ui.year) return pending.n;
  return (qs.find((q) => ctx.today >= q.start && ctx.today <= q.end) ?? qs[ctx.today < qs[0].start ? 0 : 3]).n;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function deadlineCard(ctx) {
  const { settings } = ctx.state;
  const q = nextDeadline(ctx.today, settings.quarterBasis, settings.submitted);
  if (!q) {
    const current = [...quarters(ctx.currentYear - 1, settings.quarterBasis), ...quarters(ctx.currentYear, settings.quarterBasis)]
      .find((x) => ctx.today >= x.start && ctx.today <= x.end);
    if (!current) return '';
    return `<button type="button" class="card row deadline" data-action="goto-quarter" data-year="${current.year}" data-q="${current.n}">
      <span class="ico" style="--c:#007aff" aria-hidden="true">🗓️</span>
      <span class="grow"><span class="title">Quarter ${current.n} ends ${dateShort(current.end)}</span><span class="sub">Next update due ${dateLong(current.deadline)}</span></span>
      <span class="chev" aria-hidden="true">›</span></button>`;
  }
  const days = diffDays(ctx.today, q.deadline);
  return `<button type="button" class="card row deadline ${days <= 7 ? 'urgent' : ''}" data-action="goto-quarter" data-year="${q.year}" data-q="${q.n}">
    <span class="ico" style="--c:${days <= 7 ? '#ff3b30' : '#ff9500'}" aria-hidden="true">⏰</span>
    <span class="grow"><span class="title">Quarterly update ${q.n} due ${relDays(days)}</span><span class="sub">${esc(taxYearLabel(q.year))} · send by ${dateLong(q.deadline)}</span></span>
    <span class="chev" aria-hidden="true">›</span></button>`;
}

function summaryCard(ctx) {
  const { settings, records } = ctx.state;
  const yr = taxYear(ctx.ui.year, settings.quarterBasis);
  const to = ctx.ui.year === ctx.currentYear ? ctx.today : yr.end;
  const s = summarise(records, yr.start, to, settings);
  return `<section class="card summary" aria-label="Tax year so far">
    <span class="eyebrow">${ctx.ui.year === ctx.currentYear ? 'Tax year so far' : `Tax year ${esc(taxYearLabel(ctx.ui.year))}`}</span>
    <div class="big-num">${heroMoney(s.totals.allowable)}</div>
    <p class="muted small">allowable expenses from ${plural(s.count, 'record')}</p>
    <dl class="stats">
      <div><dt>Income</dt><dd>${money(s.totals.income)}</dd></div>
      <div><dt>Profit</dt><dd>${money(s.totals.profit)}</dd></div>
      <div><dt>${settings.vatRegistered ? 'VAT back' : 'Not allowed'}</dt><dd>${money(settings.vatRegistered ? s.vat.box4 : s.totals.disallowable)}</dd></div>
    </dl>
  </section>`;
}

const recordRow = (r, ctx) => {
  const cat = categoryOf(r.category, r.kind);
  const a = amounts(r, ctx.state.settings);
  const income = r.kind === 'income';
  const notes = [cat.label, dateShort(r.date)];
  if (!income && r.businessPct < 100) notes.push(`${r.businessPct}% business`);
  return `<button type="button" class="row" data-action="edit" data-id="${esc(r.id)}">
    ${icon(cat)}
    <span class="grow"><span class="title">${esc(r.merchant || r.description || cat.label)}${r.imageKey ? ' <span class="clip" aria-label="has receipt">📎</span>' : ''}</span><span class="sub">${esc(notes.join(' · '))}</span></span>
    <span class="amt ${income ? 'pos' : ''}">${income ? '+' : ''}${money(r.gross)}${r.vat ? `<small>VAT ${money(r.vat)}</small>` : a.disallowable && !income ? `<small>${money(a.amount - a.disallowable)} allowable</small>` : ''}</span>
  </button>`;
};

export function receiptsList(ctx) {
  const { records, settings } = ctx.state;
  const yr = taxYear(ctx.ui.year, settings.quarterBasis);
  const q = ctx.ui.query.trim().toLowerCase();
  const list = records.filter((r) => r.date >= yr.start && r.date <= yr.end
    && (ctx.ui.filter === 'all' || r.kind === ctx.ui.filter)
    && (!q || `${r.merchant} ${r.description} ${categoryOf(r.category, r.kind).label} ${(r.gross / 100).toFixed(2)}`.toLowerCase().includes(q)));
  if (!list.length) {
    return q || ctx.ui.filter !== 'all'
      ? '<p class="footnote">Nothing matches.</p>'
      : `<div class="empty"><div class="empty-emoji" aria-hidden="true">🧾</div><h3>No receipts in ${esc(taxYearLabel(ctx.ui.year))}</h3>
         <p>Snap a receipt and Shoebox reads the amount, VAT and category for you.</p>
         <button type="button" class="btn primary" data-action="add">Add a receipt</button></div>`;
  }
  const groups = new Map();
  for (const r of list.slice(0, ctx.ui.limit)) {
    const key = r.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].map(([month, rs]) => {
    const spent = rs.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.gross, 0);
    return `<section class="group"><h3 class="group-title"><span>${esc(monthYear(`${month}-01`))}</span><span>${spent ? money(spent) : ''}</span></h3>
      <div class="card list">${rs.map((r) => recordRow(r, ctx)).join('')}</div></section>`;
  }).join('') + (list.length > ctx.ui.limit ? '<button type="button" class="btn secondary" data-action="more">Show more</button>' : '');
}

export function receiptsView(ctx) {
  return `<div class="screen-head"><div><h1 class="large-title">Receipts</h1><p class="subtitle">Tax year ${esc(taxYearLabel(ctx.ui.year))}</p></div>${yearPicker(ctx)}</div>
    ${ctx.ui.year === ctx.currentYear ? deadlineCard(ctx) : ''}
    ${summaryCard(ctx)}
    <div class="search"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
      <input id="search" type="search" placeholder="Search" aria-label="Search receipts" value="${esc(ctx.ui.query)}" autocomplete="off"></div>
    <div class="seg" role="group" aria-label="Show">
      ${[['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([v, l]) => `<button type="button" data-action="filter" data-value="${v}" class="${ctx.ui.filter === v ? 'on' : ''}" aria-pressed="${ctx.ui.filter === v}">${l}</button>`).join('')}
    </div>
    <div id="receipts-list">${receiptsList(ctx)}</div>`;
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

const line = (label, value, { sub = '', strong = false, cls = '' } = {}) =>
  `<div class="row kv ${cls}"><span class="grow"><span class="${strong ? 'title strong' : 'title'}">${label}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span><span class="amt">${value}</span></div>`;

function quarterCard(ctx, q) {
  const { settings, records } = ctx.state;
  const status = quarterStatus(q, ctx.today, settings.submitted);
  const ytd = ctx.ui.span === 'ytd';
  const from = ytd ? q.yearStart : q.start;
  const s = summarise(records, from, q.end, settings);
  const consolidated = ctx.ui.consolidated;
  const [pillCls, pillText] = STATUS[status];
  const days = diffDays(ctx.today, q.deadline);
  const expenseRows = consolidated
    ? line('All allowable expenses', money(s.totals.allowable), { sub: 'consolidatedExpenses' })
    : EXPENSE_CATEGORIES.filter((c) => s.expenses[c.id].amount).map((c) => {
      const e = s.expenses[c.id];
      return line(`${esc(c.emoji)} ${esc(c.label)}`, money(e.amount), { sub: `${plural(e.count, 'record')}${e.disallowable ? ` · ${money(e.disallowable)} not allowable` : ''}` });
    }).join('') || '<p class="pad muted">No expenses in this period.</p>';

  return `<section class="card quarter" aria-label="Quarterly update ${q.n}">
    <div class="q-head">
      <div><span class="eyebrow">Quarterly update ${q.n}</span><h2 class="card-title">${esc(dateRange(q.start, q.end))}</h2></div>
      <span class="pill ${pillCls}">${pillText}</span>
    </div>
    <p class="muted small q-due">${status === 'submitted' ? `Marked as sent. It was due ${dateLong(q.deadline)}.`
      : `Send by ${dateLong(q.deadline)}${days >= 0 && status !== 'upcoming' ? ` (${relDays(days)})` : ''}.`}
      Updates are cumulative: this one covers ${esc(dateRange(q.yearStart, q.end))}.</p>
    <div class="seg" role="group" aria-label="Period">
      <button type="button" data-action="span" data-value="ytd" class="${ytd ? 'on' : ''}" aria-pressed="${ytd}">Year to date</button>
      <button type="button" data-action="span" data-value="q" class="${ytd ? '' : 'on'}" aria-pressed="${!ytd}">This quarter only</button>
    </div>
    <h3 class="mini-title">Income</h3>
    <div class="list flat">${line('💷 Sales &amp; fees', money(s.income.turnover), { sub: 'turnover' })}${line('💰 Other business income', money(s.income.other), { sub: 'other' })}</div>
    <h3 class="mini-title">Expenses</h3>
    <div class="list flat">${expenseRows}</div>
    <div class="list flat totals">
      ${line('Total expenses', money(s.totals.expenses), { strong: true, sub: s.totals.disallowable ? `${money(s.totals.disallowable)} not allowable` : '' })}
      ${line('Profit', money(s.totals.profit), { strong: true, sub: 'Income minus allowable expenses' })}
    </div>
    <label class="row toggle"><span class="grow"><span class="title">One expenses total</span><span class="sub">Allowed if your turnover is under ${money(CONSOLIDATED_LIMIT).replace('.00', '')} a year</span></span>
      <input type="checkbox" class="switch" data-action="consolidated" ${consolidated ? 'checked' : ''}></label>
    <div class="actions">
      <button type="button" class="btn primary" data-action="export-mtd">Export for MTD software (CSV)</button>
      <div class="btn-row">
        <button type="button" class="btn secondary" data-action="export-json">HMRC JSON</button>
        <button type="button" class="btn secondary" data-action="export-records">All records</button>
      </div>
      ${ctx.backend.mode === 'cloud' && ctx.backend.config.email ? '<button type="button" class="btn secondary" data-action="email-export">Email to accountant</button>' : ''}
      <button type="button" class="btn ${status === 'submitted' ? 'secondary' : 'tinted'}" data-action="toggle-submitted">${status === 'submitted' ? 'Mark as not sent' : 'I’ve sent this update'}</button>
    </div>
  </section>`;
}

function vatCard(ctx) {
  const { settings, records } = ctx.state;
  const p = vatPeriod(ctx.ui.vatDate, settings.vatStagger);
  const s = summarise(records, p.start, p.end, settings);
  const v = s.vat;
  const days = diffDays(ctx.today, p.deadline);
  return `<section class="card" aria-label="VAT return">
    <div class="q-head">
      <div><span class="eyebrow">VAT return</span><h2 class="card-title">${esc(dateRange(p.start, p.end))}</h2></div>
      <div class="week-nav">
        <button type="button" class="icon-btn" data-action="vat-period" data-value="${addDays(p.start, -1)}" aria-label="Previous VAT period">‹</button>
        <button type="button" class="icon-btn" data-action="vat-period" data-value="${addDays(p.end, 1)}" aria-label="Next VAT period" ${p.end >= ctx.today ? 'disabled' : ''}>›</button>
      </div>
    </div>
    <p class="muted small q-due">Due ${dateLong(p.deadline)}${days >= 0 && p.end < ctx.today ? ` (${relDays(days)})` : ''}. Submit it with your MTD for VAT software.</p>
    <div class="list flat">
      ${line('Box 1 · VAT on sales', money(v.box1))}
      ${line('Box 4 · VAT reclaimed on purchases', money(v.box4))}
      ${line(`Box 5 · ${v.refund ? 'VAT to reclaim' : 'VAT to pay'}`, money(v.box5), { strong: true })}
      ${line('Box 6 · Sales excluding VAT', `£${v.box6.toLocaleString('en-GB')}`)}
      ${line('Box 7 · Purchases excluding VAT', `£${v.box7.toLocaleString('en-GB')}`)}
    </div>
    <p class="hint">Boxes 2, 8 and 9 (EU goods, Northern Ireland) are 0. Flat Rate Scheme users work VAT out differently.</p>
    <button type="button" class="btn secondary" data-action="export-vat" data-from="${p.start}" data-to="${p.end}">Export VAT figures (CSV)</button>
  </section>`;
}

export function taxView(ctx) {
  const { settings } = ctx.state;
  const qs = quarters(ctx.ui.year, settings.quarterBasis);
  const q = qs[(ctx.ui.quarter ?? defaultQuarter(ctx)) - 1];
  return `<div class="screen-head"><div><h1 class="large-title">Tax</h1><p class="subtitle">Making Tax Digital · ${esc(taxYearLabel(ctx.ui.year))}</p></div>${yearPicker(ctx)}</div>
    <div class="seg quarters" role="group" aria-label="Quarter">
      ${qs.map((x) => {
        const st = quarterStatus(x, ctx.today, settings.submitted);
        return `<button type="button" data-action="quarter" data-value="${x.n}" class="${x.n === q.n ? 'on' : ''}" aria-pressed="${x.n === q.n}">Q${x.n}<i class="dot ${st}" aria-label="${STATUS[st][1]}"></i></button>`;
      }).join('')}
    </div>
    ${quarterCard(ctx, q)}
    ${settings.vatRegistered ? vatCard(ctx) : ''}
    <p class="footnote">Shoebox prepares your figures and keeps your digital records. Send the quarterly update with HMRC-recognised MTD software (bridging software accepts the CSV) or through your accountant. This isn’t tax advice.</p>`;
}

// ---------------------------------------------------------------------------
// Sign in (cloud mode)
// ---------------------------------------------------------------------------

export function signInView({ step = 'email', email = '', busy = false, error = '' }) {
  return `<div class="welcome-screen">
    <img src="icons/icon.svg" alt="" width="84" height="84" class="welcome-logo">
    <h1 class="welcome-title">Shoebox</h1>
    <p class="welcome-text">Snap receipts, let AI read the amount, VAT and category, and export your Making Tax Digital totals.</p>
    <form id="signin" class="card signin" novalidate>
      ${step === 'email'
        ? `<label class="field-block"><span class="eyebrow">Email</span><input id="si-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(email)}" required autofocus></label>
           <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Email me a sign-in code'}</button>`
        : `<p class="small muted">We sent a code to <b>${esc(email)}</b>. It can take a minute to arrive.</p>
           <label class="field-block"><span class="eyebrow">Code</span><input id="si-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" required autofocus></label>
           <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Sign in'}</button>
           <button type="button" class="btn secondary" data-action="signin-back">Use a different email</button>`}
      <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
    </form>
    <button type="button" class="link" data-action="use-local">Use without an account (this device only)</button>
  </div>`;
}

export const loadingView = (text = 'Loading…') => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
