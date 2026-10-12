// Screen renderers. Each takes a context { state, ui, fmt, today } and returns an HTML string.
import {
  addDays, bucketTotals, categoryBreakdown, planSummary, rangeTotals, startOfWeek, weekHistory, weekSummary,
} from './calc.js';
import { donut, ring } from './charts.js';
import { esc } from './util.js';

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const pct = (n) => `${Math.round(clamp01(n) * 1000) / 10}%`;

export const catOf = (state, id) =>
  state.categories.find((c) => c.id === id) ?? { id, name: 'Other', emoji: '📦', color: '#8e8e93', type: 'expense' };

const icon = (cat, cls = '') => `<span class="ico ${cls}" style="--c:${esc(cat.color)}" aria-hidden="true">${esc(cat.emoji)}</span>`;

const pill = (kind, text) => `<span class="pill pill-${kind}">${esc(text)}</span>`;

function txRow(ctx, t, { showDate = false } = {}) {
  const { state, fmt } = ctx;
  const cat = catOf(state, t.categoryId);
  const sub = [t.note, showDate ? fmt.dayMonth(t.date) : ''].filter(Boolean).join(' · ');
  const amount = t.type === 'income' ? `+${fmt.money(t.amount)}` : `−${fmt.money(t.amount)}`;
  return `<button type="button" class="row tx" data-action="edit-tx" data-id="${esc(t.id)}">
    ${icon(cat)}
    <span class="grow"><span class="title">${esc(cat.name)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
    <span class="amt ${t.type === 'income' ? 'pos' : ''}">${amount}</span>
  </button>`;
}

function emptyState(emoji, title, text, action = '') {
  return `<div class="empty"><div class="empty-emoji" aria-hidden="true">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

// ---------------------------------------------------------------------------
// This week
// ---------------------------------------------------------------------------

function weekTitle(ctx, w) {
  const current = startOfWeek(ctx.today, ctx.state.settings.weekStart);
  if (w.weekStart === current) return 'This Week';
  if (w.weekStart === addDays(current, -7)) return 'Last Week';
  if (w.weekStart === addDays(current, 7)) return 'Next Week';
  return ctx.fmt.range(w.weekStart, w.weekEnd);
}

function weekStatus(ctx, w) {
  const { fmt } = ctx;
  if (w.isFuture) return pill('neutral', 'Upcoming');
  if (w.isPast) return w.remaining >= 0 ? pill('ok', `Saved ${fmt.money(w.remaining)}`) : pill('over', `Over by ${fmt.money(-w.remaining)}`);
  if (w.status === 'over') return pill('over', `Over by ${fmt.money(-w.remaining)}`);
  if (w.status === 'warn') return pill('warn', 'Spending fast');
  return pill('ok', 'On track');
}

function dayRow(ctx, w, d) {
  const { state, ui, fmt } = ctx;
  const open = ui.expandedDay === d.date;
  const avg = w.dailyAverage || 1;
  const ratio = d.spent / avg;
  const level = ratio > 1.5 ? 'high' : ratio > 1 ? 'mid' : 'low';
  const txs = state.transactions.filter((t) => t.date === d.date).reverse();
  const cls = ['day', d.isToday && 'is-today', d.isFuture && 'is-future', open && 'open'].filter(Boolean).join(' ');
  const left = d.remaining;
  return `<div class="${cls}">
    <button type="button" class="day-row" data-action="toggle-day" data-date="${d.date}" aria-expanded="${open}">
      <span class="day-name"><b>${fmt.weekday(d.date)}</b><small>${fmt.dayMonth(d.date)}</small></span>
      <span class="day-bar" aria-hidden="true"><i class="lvl-${level}" style="width:${pct(ratio / 2)}"></i></span>
      <span class="day-spent">${d.spent ? `−${fmt.moneyAuto(d.spent)}` : d.isFuture ? '' : '—'}</span>
      <span class="day-left ${left < 0 ? 'neg' : ''}">${d.isFuture && !d.spent ? '' : fmt.moneyAuto(left)}</span>
      <svg class="chev" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    ${open ? `<div class="day-detail">
      ${txs.length ? txs.map((t) => txRow(ctx, t)).join('') : `<p class="muted pad">${d.isFuture ? 'Nothing planned yet.' : 'No spending recorded.'}</p>`}
      <button type="button" class="row add-row" data-action="add" data-date="${d.date}"><span class="ico add-ico" aria-hidden="true">＋</span><span class="grow title">Add to ${esc(d.isToday ? 'today' : fmt.weekdayLong(d.date))}</span></button>
    </div>` : ''}
  </div>`;
}

export function weekView(ctx) {
  const { state, ui, fmt, today } = ctx;
  const w = weekSummary(state, ui.weekStart, today);
  const title = weekTitle(ctx, w);
  const nav = `<div class="week-nav" role="group" aria-label="Choose week">
    <button type="button" class="icon-btn" data-action="prev-week" aria-label="Previous week"><svg viewBox="0 0 10 16" width="10" height="16"><path d="M8 1L2 8l6 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    ${!w.isCurrent ? `<button type="button" class="chip-btn" data-action="this-week">Today</button>` : ''}
    <button type="button" class="icon-btn" data-action="next-week" aria-label="Next week"><svg viewBox="0 0 10 16" width="10" height="16"><path d="M2 1l6 7-6 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>`;
  const head = `<header class="screen-head"><div><h1 class="large-title">${esc(title)}</h1><p class="subtitle">${esc(fmt.range(w.weekStart, w.weekEnd))}${w.isCurrent ? ` · ${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} left` : ''}</p></div>${nav}</header>`;

  if (!w.budget) {
    return `${head}${emptyState('🎯', 'Set a weekly budget', 'Pick an amount you can spend each week. Budgie subtracts every purchase and tells you what is left.',
      '<button type="button" class="btn primary" data-action="settings">Set weekly budget</button>')}`;
  }

  const fraction = w.budget ? w.remaining / w.budget : 0;
  const label = w.remaining >= 0 ? 'left this week' : 'over budget';
  const ringLabel = `${fmt.money(Math.abs(w.remaining))} ${label} of ${fmt.money(w.budget)}`;

  const hero = `<article class="card hero status-${w.status}">
    <div class="ring-wrap">
      ${ring({ fraction, status: w.status, label: ringLabel })}
      <div class="ring-center">
        <span class="eyebrow">${w.remaining >= 0 ? 'Left' : 'Over by'}</span>
        <span class="hero-num">${fmt.hero(Math.abs(w.remaining))}</span>
        <span class="hero-sub">of ${fmt.moneyAuto(w.budget)} budget</span>
      </div>
    </div>
    <div class="hero-pill">${weekStatus(ctx, w)}</div>
    <dl class="stats">
      <div><dt>Spent</dt><dd>${fmt.moneyAuto(w.spent)}</dd></div>
      <div><dt>${w.isPast ? 'Daily avg' : 'Per day left'}</dt><dd>${fmt.moneyAuto(w.isPast ? Math.round(w.spent / 7) : Math.max(0, w.safePerDay))}</dd></div>
      <div><dt>${w.income ? 'Income' : 'Days left'}</dt><dd>${w.income ? fmt.moneyAuto(w.income) : w.daysLeft}</dd></div>
    </dl>
  </article>`;

  let today_card = '';
  if (w.isCurrent) {
    const left = w.leftToday;
    const share = w.safePerDay > 0 ? w.todaySpent / w.safePerDay : w.todaySpent > 0 ? 1 : 0;
    today_card = `<article class="card today-card">
      <div class="today-top">
        <div><span class="eyebrow">Safe to spend today</span>
          <div class="today-num ${left < 0 ? 'neg' : ''}">${fmt.money(left)}</div></div>
        <button type="button" class="btn primary small" data-action="add" data-date="${today}">＋ Add</button>
      </div>
      <div class="meter slim"><i class="fill ${share > 1 ? 'over' : share > 0.8 ? 'warn' : ''}" style="width:${pct(share)}"></i></div>
      <p class="meter-caption">${w.todaySpent ? `You spent ${fmt.money(w.todaySpent)} of ${fmt.money(Math.max(0, w.safePerDay))} today.` : `Spread evenly, that is ${fmt.money(Math.max(0, w.safePerDay))} a day for the rest of the week.`}</p>
    </article>`;
  }

  return `${head}${hero}${today_card}
    <h2 class="section-title">Day by day</h2>
    <p class="section-note">Each day subtracts what you spent from your budget — the right-hand number is what remains.</p>
    <section class="card list days" aria-label="Daily ledger">${w.days.map((d) => dayRow(ctx, w, d)).join('')}</section>`;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const PLAN_STATUS = {
  ontrack: ['ok', 'On track'], pace: ['warn', 'Spending fast'], over: ['over', 'Over budget'],
  done: ['ok', 'Completed'], upcoming: ['neutral', 'Upcoming'],
};

function planCard(ctx, plan) {
  const { fmt, state, today } = ctx;
  const p = planSummary(state, plan, today);
  const [kind, text] = PLAN_STATUS[p.status];
  const cats = (plan.categoryIds || []).map((id) => catOf(state, id).name);
  const scale = Math.max(1, ...p.months.map((m) => Math.max(m.spent, m.budget)));
  const meterClass = p.status === 'over' ? 'over' : p.status === 'pace' ? 'warn' : '';
  const footer = p.ended ? `Ended ${fmt.dayMonth(p.lastDay)}`
    : p.upcoming ? `Starts ${fmt.dayMonth(plan.start)}`
    : `${fmt.money(p.perDayLeft, { round: true })}/day available · ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;

  return `<article class="card plan" role="button" tabindex="0" data-action="edit-plan" data-id="${esc(plan.id)}" aria-label="Edit plan ${esc(plan.name)}">
    <header class="plan-head">
      <span class="ico big" style="--c:#007aff" aria-hidden="true">${esc(plan.emoji)}</span>
      <div class="grow"><h3>${esc(plan.name)}</h3>
        <p class="muted">${esc(fmt.range(plan.start, p.lastDay))} · ${plan.months} month${plan.months === 1 ? '' : 's'}${cats.length ? ` · ${esc(cats.join(', '))}` : ''}</p>
        <div class="plan-pill">${pill(kind, text)}</div></div>
    </header>
    <div class="plan-main">
      <div><span class="eyebrow">${p.remaining >= 0 ? 'Remaining' : 'Over by'}</span>
        <div class="plan-num ${p.remaining < 0 ? 'neg' : ''}">${fmt.moneyAuto(Math.abs(p.remaining))}</div></div>
      <div class="plan-of">of ${fmt.moneyAuto(plan.amount)}<br><span class="muted">${fmt.moneyAuto(Math.round(plan.amount / plan.months))} / month</span></div>
    </div>
    <div class="meter" role="img" aria-label="${pct(p.usedPct)} of the plan budget spent, ${pct(p.timePct)} of the time passed">
      <i class="fill ${meterClass}" style="width:${pct(p.usedPct)}"></i>
      ${!p.upcoming && !p.ended ? `<b class="marker" style="left:${pct(p.timePct)}" title="Where you should be today"></b>` : ''}
    </div>
    <div class="meter-legend"><span>Spent ${fmt.moneyAuto(p.spent)}</span><span>${p.upcoming ? '' : `Pace ${fmt.moneyAuto(p.expected)}`}</span></div>
    <div class="months" aria-label="Spending per month">
      ${p.months.map((m) => `<div class="mcol ${m.state} ${m.spent > m.budget ? 'over' : ''}">
        <span class="mval">${m.state === 'future' ? '' : fmt.moneyAuto(m.spent)}</span>
        <div class="mbar"><i style="height:${pct(m.spent / scale)}"></i><u style="bottom:${pct(m.budget / scale)}"></u></div>
        <span class="mlabel">${fmt.monthShort(m.start)}</span>
      </div>`).join('')}
    </div>
    <footer class="plan-foot"><span>${esc(footer)}</span>${p.projected !== null && !p.ended ? `<span class="${p.projected > plan.amount ? 'neg' : ''}">Projected ${fmt.moneyAuto(p.projected)}</span>` : ''}</footer>
  </article>`;
}

export function plansView(ctx) {
  const { state } = ctx;
  const head = `<header class="screen-head"><div><h1 class="large-title">Plans</h1><p class="subtitle">Budgets for several months</p></div>
    <button type="button" class="chip-btn solid" data-action="new-plan">＋ New plan</button></header>`;
  if (!state.plans.length) {
    return `${head}${emptyState('🗓️', 'Plan the bigger picture', 'Set aside an amount for the next few months — a holiday, a season, a savings push — and watch your pace, monthly breakdown and projection.',
      '<button type="button" class="btn primary" data-action="new-plan">Create your first plan</button>')}`;
  }
  const plans = [...state.plans].sort((a, b) => b.start.localeCompare(a.start));
  return `${head}${plans.map((p) => planCard(ctx, p)).join('')}
    <p class="footnote">Plans count every expense inside their dates, on top of your weekly budget. Limit a plan to certain categories when you edit it.</p>`;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function filteredTransactions(ctx) {
  const { state, ui } = ctx;
  const q = ui.query.trim().toLowerCase();
  return state.transactions
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => ui.filter === 'all' || t.type === ui.filter)
    .filter(({ t }) => !q || t.note.toLowerCase().includes(q) || catOf(state, t.categoryId).name.toLowerCase().includes(q))
    .sort((a, b) => b.t.date.localeCompare(a.t.date) || b.i - a.i)
    .map(({ t }) => t);
}

function dayLabel(ctx, iso) {
  if (iso === ctx.today) return 'Today';
  if (iso === addDays(ctx.today, -1)) return 'Yesterday';
  return ctx.fmt.dateLong(iso);
}

export function activityList(ctx) {
  const { ui, fmt } = ctx;
  const all = filteredTransactions(ctx);
  if (!all.length) {
    return ctx.state.transactions.length
      ? emptyState('🔍', 'No matches', 'Try a different search or filter.')
      : emptyState('🧾', 'No transactions yet', 'Add your first expense and it will show up here.', '<button type="button" class="btn primary" data-action="add">Add expense</button>');
  }
  const shown = all.slice(0, ui.limit);
  const groups = [];
  for (const t of shown) {
    const g = groups.at(-1);
    if (g && g.date === t.date) g.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }
  return groups.map((g) => {
    const spent = g.items.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
    return `<section class="group"><h2 class="group-title"><span>${esc(dayLabel(ctx, g.date))}</span>${spent ? `<span>−${fmt.moneyAuto(spent)}</span>` : ''}</h2>
      <div class="card list">${g.items.map((t) => txRow(ctx, t)).join('')}</div></section>`;
  }).join('') + (all.length > shown.length ? `<button type="button" class="btn secondary" data-action="more">Show more (${all.length - shown.length})</button>` : '');
}

export function activityView(ctx) {
  const { ui } = ctx;
  const seg = (v, label) => `<button type="button" role="tab" aria-selected="${ui.filter === v}" data-action="filter" data-value="${v}" class="${ui.filter === v ? 'on' : ''}">${label}</button>`;
  return `<header class="screen-head"><div><h1 class="large-title">Activity</h1><p class="subtitle">${ctx.state.transactions.length} transaction${ctx.state.transactions.length === 1 ? '' : 's'}</p></div></header>
    <div class="search"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M13 13l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="search" id="search" placeholder="Search notes and categories" value="${esc(ui.query)}" autocomplete="off" enterkeyhint="search" aria-label="Search transactions"></div>
    <div class="seg" role="tablist" aria-label="Filter">${seg('all', 'All')}${seg('expense', 'Expenses')}${seg('income', 'Income')}</div>
    <div id="activity-list">${activityList(ctx)}</div>`;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const RANGES = [[7, '7D'], [30, '30D'], [90, '90D'], [365, '1Y']];

export function insightsView(ctx) {
  const { state, ui, fmt, today } = ctx;
  const n = ui.range;
  const from = addDays(today, -(n - 1));
  const prevFrom = addDays(from, -n);
  const prevTo = addDays(from, -1);
  const cur = rangeTotals(state.transactions, from, today);
  const prev = rangeTotals(state.transactions, prevFrom, prevTo);
  const delta = prev.spent > 0 ? (cur.spent - prev.spent) / prev.spent : null;

  const seg = RANGES.map(([v, l]) => `<button type="button" role="tab" aria-selected="${n === v}" data-action="range" data-value="${v}" class="${n === v ? 'on' : ''}">${l}</button>`).join('');
  const head = `<header class="screen-head"><div><h1 class="large-title">Insights</h1><p class="subtitle">${esc(fmt.range(from, today))}</p></div></header>
    <div class="seg" role="tablist" aria-label="Time range">${seg}</div>`;

  if (!cur.count && !state.transactions.length) {
    return `${head}${emptyState('📊', 'Nothing to analyse yet', 'Once you add some spending, trends and category breakdowns appear here.')}`;
  }

  const summary = `<article class="card summary">
    <span class="eyebrow">Spent</span>
    <div class="big-num">${fmt.hero(cur.spent)}</div>
    ${delta === null ? '' : `<p class="delta ${delta > 0 ? 'neg' : 'pos'}">${delta > 0 ? '▲' : '▼'} ${Math.round(Math.abs(delta) * 100)}% vs previous ${n} days</p>`}
    <dl class="stats">
      <div><dt>Per day</dt><dd>${fmt.moneyAuto(Math.round(cur.spent / n))}</dd></div>
      <div><dt>Income</dt><dd>${fmt.moneyAuto(cur.income)}</dd></div>
      <div><dt>Net</dt><dd class="${cur.net < 0 ? 'neg' : 'pos'}">${cur.net < 0 ? '−' : ''}${fmt.moneyAuto(Math.abs(cur.net))}</dd></div>
    </dl></article>`;

  const size = n <= 30 ? 1 : n <= 90 ? 7 : 30;
  const buckets = bucketTotals(state.transactions, from, today, size);
  const max = Math.max(1, ...buckets.map((b) => b.spent));
  const labelEvery = Math.ceil(buckets.length / 7);
  const bars = `<article class="card"><h2 class="card-title">Spending over time</h2>
    <div class="bars" role="img" aria-label="Bar chart of spending over time">
      ${buckets.map((b, i) => `<div class="bcol" title="${esc(size === 1 ? fmt.dayMonth(b.start) : fmt.range(b.start, b.end))}: ${esc(fmt.money(b.spent))}">
        <div class="bbar"><i class="${b.spent === max ? 'peak' : ''}" style="height:${pct(b.spent / max)}"></i></div>
        <span class="blabel">${i % labelEvery === 0 ? esc(size === 1 && n === 7 ? fmt.weekday(b.start).slice(0, 2) : size === 30 ? fmt.monthShort(b.start) : fmt.dayNum(b.start)) : ''}</span>
      </div>`).join('')}
    </div></article>`;

  const cats = categoryBreakdown(state.transactions, from, today);
  const top = cats.slice(0, 6);
  const rest = cats.slice(6).reduce((a, c) => a + c.total, 0);
  const slices = top.map((c) => ({ value: c.total, color: catOf(state, c.categoryId).color }));
  if (rest) slices.push({ value: rest, color: '#8e8e93' });
  const catCard = `<article class="card"><h2 class="card-title">Where it went</h2>
    ${cats.length ? `<div class="donut-wrap">${donut(slices, { label: 'Spending by category' })}
      <div class="donut-center"><span class="eyebrow">Total</span><b>${fmt.moneyAuto(cur.spent)}</b></div></div>
    <div class="list flat">${cats.map((c) => {
      const cat = catOf(state, c.categoryId);
      return `<div class="row cat">${icon(cat)}<span class="grow"><span class="title">${esc(cat.name)}</span>
        <span class="meter slim"><i class="fill" style="width:${pct(c.pct)};background:${esc(cat.color)}"></i></span></span>
        <span class="amt">${fmt.moneyAuto(c.total)}<small>${Math.round(c.pct * 100)}%</small></span></div>`;
    }).join('')}</div>` : '<p class="muted pad">No expenses in this period.</p>'}</article>`;

  const hist = weekHistory(state, 8, today);
  let streak = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const w = hist[i];
    if (w.isCurrent) continue;
    if (w.budget && w.remaining >= 0) streak++;
    else break;
  }
  const weeks = hist.length > 1 || (hist[0] && hist[0].budget)
    ? `<article class="card"><h2 class="card-title">Weekly results</h2>
      ${streak >= 2 ? `<p class="streak">🔥 ${streak} weeks in a row within budget</p>` : ''}
      <div class="list flat">${[...hist].reverse().map((w) => {
        const used = w.budget ? w.spent / w.budget : 0;
        return `<button type="button" class="row week-row" data-action="goto-week" data-date="${w.weekStart}">
          <span class="grow"><span class="title">${esc(fmt.range(w.weekStart, w.weekEnd))}${w.isCurrent ? ' <small class="muted">· now</small>' : ''}</span>
            <span class="meter slim"><i class="fill ${w.remaining < 0 ? 'over' : used > 0.9 ? 'warn' : ''}" style="width:${pct(used)}"></i></span></span>
          <span class="amt ${w.remaining < 0 ? 'neg' : ''}">${fmt.moneyAuto(w.spent)}<small>of ${fmt.moneyAuto(w.budget)}</small></span></button>`;
      }).join('')}</div></article>`
    : '';

  const biggest = state.transactions
    .filter((t) => t.type === 'expense' && t.date >= from && t.date <= today)
    .sort((a, b) => b.amount - a.amount).slice(0, 3);
  const bigCard = biggest.length
    ? `<article class="card"><h2 class="card-title">Biggest expenses</h2><div class="list flat">${biggest.map((t) => txRow(ctx, t, { showDate: true })).join('')}</div></article>`
    : '';

  return `${head}${summary}${bars}${catCard}${weeks}${bigCard}`;
}
