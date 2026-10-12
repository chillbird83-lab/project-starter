// Sheets (modal forms): transaction, plan, settings, onboarding.
import { parseAmount, startOfWeek, todayISO, weekSummary } from './calc.js';
import { CURRENCIES, guessCurrency, makeFormatter } from './format.js';
import { closeSheet, confirmDialog, openSheet, toast } from './overlay.js';
import * as store from './store.js';
import { $, $$, autosize, download, esc, haptic, uid } from './util.js';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtOf = () => makeFormatter(store.get().settings.currency);
const centsToInput = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

const header = (title, { cancel = 'Cancel', submit = 'Save' } = {}) =>
  `<div class="sheet-head"><button type="button" class="link" data-close>${cancel}</button><h2>${esc(title)}</h2>${submit ? `<button type="submit" class="link strong">${esc(submit)}</button>` : '<span></span>'}</div>`;

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/** app: { ui, goToDate(date) } — used to jump to the right week after saving. */
export function openTxSheet(app, { id, date, type = 'expense' } = {}) {
  const st = store.get();
  const editing = id ? st.transactions.find((t) => t.id === id) : null;
  const fmt = fmtOf();
  const form = { type: editing?.type ?? type, categoryId: editing?.categoryId ?? null };
  const cats = (t) => st.categories.filter((c) => c.type === t);
  if (!form.categoryId) form.categoryId = cats(form.type)[0]?.id;

  const chips = () => cats(form.type).map((c) =>
    `<button type="button" class="chip ${c.id === form.categoryId ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}" aria-pressed="${c.id === form.categoryId}"><span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.name)}</button>`).join('');

  const el = openSheet(`<form id="tx-form" novalidate>
    ${header(editing ? 'Edit' : 'New transaction')}
    <div class="seg" role="tablist" aria-label="Type">
      <button type="button" role="tab" data-type="expense">Expense</button>
      <button type="button" role="tab" data-type="income">Income</button>
    </div>
    <label class="amount-field"><span class="sr-only">Amount</span>
      <span class="cur" aria-hidden="true">${esc(fmt.symbol)}</span>
      <input id="tx-amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${editing ? centsToInput(editing.amount) : ''}" autofocus>
    </label>
    <p class="impact" id="tx-impact" aria-live="polite"></p>
    <h3 class="mini-title">Category</h3>
    <div class="chips" id="tx-cats">${chips()}</div>
    <div class="card list inset">
      <label class="row field"><span class="title">Note</span><input id="tx-note" maxlength="80" placeholder="Optional" value="${esc(editing?.note ?? '')}" enterkeyhint="done"></label>
      <label class="row field"><span class="title">Date</span><input id="tx-date" type="date" value="${esc(editing?.date ?? date ?? todayISO())}" required></label>
    </div>
    <p class="form-error" id="tx-error" role="alert" hidden></p>
    ${editing ? '<button type="button" class="btn danger-text" data-del>Delete transaction</button>' : ''}
  </form>`, { label: editing ? 'Edit transaction' : 'New transaction' });

  const amountEl = $('#tx-amount', el), dateEl = $('#tx-date', el), impactEl = $('#tx-impact', el), errEl = $('#tx-error', el);

  autosize(amountEl);

  const syncType = () => {
    $$('[data-type]', el).forEach((b) => {
      const on = b.dataset.type === form.type;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    if (!cats(form.type).some((c) => c.id === form.categoryId)) form.categoryId = cats(form.type)[0]?.id;
    $('#tx-cats', el).innerHTML = chips();
    el.classList.toggle('is-income', form.type === 'income');
    updateImpact();
  };

  // Live preview: what this entry does to the week it falls in.
  const updateImpact = () => {
    const cents = parseAmount(amountEl.value);
    const d = dateEl.value;
    if (form.type !== 'expense' || !d || !(cents > 0)) { impactEl.textContent = ''; impactEl.className = 'impact'; return; }
    const s = store.get();
    const ws = startOfWeek(d, s.settings.weekStart);
    const others = s.transactions.filter((t) => t.id !== editing?.id);
    const before = weekSummary({ ...s, transactions: others }, ws);
    if (!before.budget) { impactEl.textContent = ''; return; }
    const after = weekSummary({ ...s, transactions: [...others, { type: 'expense', amount: cents, date: d, categoryId: form.categoryId, id: 'x', note: '' }] }, ws);
    const f = fmtOf();
    impactEl.className = `impact ${after.remaining < 0 ? 'neg' : ''}`;
    impactEl.textContent = after.remaining < 0
      ? `That puts this week ${f.money(-after.remaining)} over budget.`
      : `Week budget: ${f.money(before.remaining)} left → ${f.money(after.remaining)} left`;
  };

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-type]');
    if (t) { form.type = t.dataset.type; syncType(); haptic(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { form.categoryId = c.dataset.cat; $('#tx-cats', el).innerHTML = chips(); updateImpact(); haptic(); return; }
    if (e.target.closest('[data-del]')) {
      const removed = store.deleteTransaction(editing.id);
      closeSheet();
      toast('Transaction deleted', { actionLabel: 'Undo', onAction: () => store.saveTransaction(removed) });
    }
  });
  amountEl.addEventListener('input', updateImpact);
  dateEl.addEventListener('change', updateImpact);

  $('#tx-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseAmount(amountEl.value);
    const fail = (msg, node) => { errEl.textContent = msg; errEl.hidden = false; node.focus(); node.classList.add('shake'); setTimeout(() => node.classList.remove('shake'), 400); };
    if (!(amount > 0)) return fail('Enter an amount greater than zero.', amountEl);
    if (amount > 99_999_999_99) return fail('That amount is too large.', amountEl);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEl.value)) return fail('Pick a date.', dateEl);
    store.saveTransaction({
      id: editing?.id ?? uid(), type: form.type, amount, categoryId: form.categoryId,
      note: $('#tx-note', el).value.trim(), date: dateEl.value,
    });
    haptic(12);
    closeSheet();
    app.goToDate(dateEl.value);
    toast(editing ? 'Saved' : form.type === 'income' ? 'Income added' : 'Expense added');
  });

  syncType();
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function openPlanSheet(app, { id } = {}) {
  const st = store.get();
  const editing = id ? st.plans.find((p) => p.id === id) : null;
  const fmt = fmtOf();
  const selected = new Set(editing?.categoryIds ?? []);
  const expenseCats = st.categories.filter((c) => c.type === 'expense');
  const startLocal = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  let months = editing?.months ?? 3;

  const chips = () => expenseCats.map((c) =>
    `<button type="button" class="chip ${selected.has(c.id) ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}" aria-pressed="${selected.has(c.id)}"><span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.name)}</button>`).join('');

  const el = openSheet(`<form id="plan-form" novalidate>
    ${header(editing ? 'Edit plan' : 'New plan')}
    <label class="amount-field"><span class="sr-only">Total budget</span>
      <span class="cur" aria-hidden="true">${esc(fmt.symbol)}</span>
      <input id="plan-amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${editing ? centsToInput(editing.amount) : ''}" autofocus>
    </label>
    <p class="impact" id="plan-per-month" aria-live="polite"></p>
    <div class="card list inset">
      <label class="row field"><span class="title">Name</span><input id="plan-name" maxlength="40" placeholder="e.g. Winter, Holiday" value="${esc(editing?.name ?? '')}"></label>
      <label class="row field"><span class="title">Icon</span><input id="plan-emoji" maxlength="4" class="emoji-input" value="${esc(editing?.emoji ?? '🎯')}" aria-label="Emoji icon"></label>
      <label class="row field"><span class="title">Starts</span><input id="plan-start" type="date" value="${esc(editing?.start ?? startLocal)}"></label>
      <div class="row field"><span class="title">Length</span>
        <span class="stepper"><button type="button" data-step="-1" aria-label="Fewer months">−</button><output id="plan-months" aria-live="polite">${months} mo</output><button type="button" data-step="1" aria-label="More months">＋</button></span></div>
    </div>
    <h3 class="mini-title">Counts spending in</h3>
    <div class="chips" id="plan-cats">${chips()}</div>
    <p class="hint" id="plan-cats-hint"></p>
    <p class="form-error" id="plan-error" role="alert" hidden></p>
    ${editing ? '<button type="button" class="btn danger-text" data-del>Delete plan</button>' : ''}
  </form>`, { label: editing ? 'Edit plan' : 'New plan' });

  const amountEl = $('#plan-amount', el), startEl = $('#plan-start', el), errEl = $('#plan-error', el);
  autosize(amountEl);
  const refresh = () => {
    $('#plan-months', el).textContent = `${months} mo`;
    const cents = parseAmount(amountEl.value);
    $('#plan-per-month', el).textContent = cents > 0 ? `${fmtOf().money(Math.round(cents / months))} per month` : 'Total budget for the whole plan';
    $('#plan-cats-hint', el).textContent = selected.size ? '' : 'All expense categories count toward this plan.';
    $('#plan-cats', el).innerHTML = chips();
  };

  el.addEventListener('click', async (e) => {
    const step = e.target.closest('[data-step]');
    if (step) { months = Math.min(36, Math.max(1, months + Number(step.dataset.step))); refresh(); haptic(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { selected.has(c.dataset.cat) ? selected.delete(c.dataset.cat) : selected.add(c.dataset.cat); refresh(); return; }
    if (e.target.closest('[data-del]')) {
      if (await confirmDialog({ title: `Delete “${editing.name}”?`, message: 'Your transactions are not affected.', confirmLabel: 'Delete', destructive: true })) {
        store.deletePlan(editing.id);
        closeSheet();
        toast('Plan deleted');
      }
    }
  });
  amountEl.addEventListener('input', refresh);

  $('#plan-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseAmount(amountEl.value);
    const fail = (msg, node) => { errEl.textContent = msg; errEl.hidden = false; node.focus(); node.classList.add('shake'); setTimeout(() => node.classList.remove('shake'), 400); };
    if (!(amount > 0)) return fail('Enter the total budget for this plan.', amountEl);
    if (!startEl.value) return fail('Pick a start date.', startEl);
    store.savePlan({
      id: editing?.id ?? uid(),
      name: $('#plan-name', el).value.trim() || 'My plan',
      emoji: $('#plan-emoji', el).value.trim() || '🎯',
      amount, start: startEl.value, months, categoryIds: [...selected],
    });
    haptic(12);
    closeSheet();
    toast(editing ? 'Plan saved' : 'Plan created');
  });

  refresh();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function openSettings(app) {
  let el;
  const render = () => {
    const st = store.get();
    const s = st.settings;
    const fmt = fmtOf();
    const wk = startOfWeek(todayISO(), s.weekStart);
    const budget = weekSummary(st, wk).budget;
    const catRows = (type) => st.categories.filter((c) => c.type === type).map((c) =>
      `<div class="row"><span class="ico" style="--c:${esc(c.color)}" aria-hidden="true">${esc(c.emoji)}</span><span class="grow title">${esc(c.name)}</span>
        ${store.PROTECTED_CATEGORIES.includes(c.id) ? '<span class="muted small">Default</span>' : `<button type="button" class="link destructive" data-del-cat="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">Delete</button>`}</div>`).join('');
    return `<div class="settings">
      <div class="sheet-head"><span></span><h2>Settings</h2><button type="button" class="link strong" data-close>Done</button></div>

      <h3 class="group-label">Weekly budget</h3>
      <div class="card list inset">
        <label class="row field"><span class="title">Amount per week</span><input id="set-budget" inputmode="decimal" autocomplete="off" placeholder="0" value="${budget ? centsToInput(budget) : ''}" class="right"></label>
        <label class="row field"><span class="title">Week starts on</span>
          <select id="set-weekstart" class="right">${DOW.map((d, i) => `<option value="${i}" ${i === s.weekStart ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="row field"><span class="title">Currency</span>
          <select id="set-currency" class="right">${CURRENCIES.map(([c, n]) => `<option value="${c}" ${c === s.currency ? 'selected' : ''}>${c} · ${esc(n)}</option>`).join('')}</select></label>
      </div>
      <p class="hint">A new weekly amount applies from the current week; earlier weeks keep what they had.</p>

      <h3 class="group-label">Appearance</h3>
      <div class="seg" role="tablist" aria-label="Appearance">
        ${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button type="button" role="tab" data-theme="${v}" class="${s.theme === v ? 'on' : ''}" aria-selected="${s.theme === v}">${l}</button>`).join('')}
      </div>

      <h3 class="group-label">Expense categories</h3>
      <div class="card list inset">${catRows('expense')}</div>
      <h3 class="group-label">Income categories</h3>
      <div class="card list inset">${catRows('income')}</div>
      <form id="add-cat" class="card list inset add-cat">
        <div class="row field"><input id="cat-emoji" class="emoji-input" maxlength="4" value="🏷️" aria-label="Emoji"><input id="cat-name" maxlength="24" placeholder="New category name" aria-label="Category name" class="grow">
          <select id="cat-type" aria-label="Type"><option value="expense">Expense</option><option value="income">Income</option></select>
          <button class="link strong" type="submit">Add</button></div>
      </form>

      <h3 class="group-label">Your data</h3>
      <div class="card list inset">
        <button type="button" class="row" data-act="export-json"><span class="grow title blue">Export backup (JSON)</span></button>
        <button type="button" class="row" data-act="export-csv"><span class="grow title blue">Export transactions (CSV)</span></button>
        <button type="button" class="row" data-act="import"><span class="grow title blue">Import backup…</span></button>
        <button type="button" class="row" data-act="sample"><span class="grow title blue">Load sample data</span></button>
        <button type="button" class="row" data-act="erase"><span class="grow title red">Erase all data</span></button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p class="hint">Everything stays on this device. Export a backup now and then — clearing browser data removes it.</p>
      ${store.hadPersistError() ? '<p class="form-error">Could not save to this browser (private mode or storage full). Your changes will be lost when you close the page — export a backup.</p>' : ''}
      <p class="about">Budgie 1.0 · ${esc(fmt.currency)}</p>
    </div>`;
  };

  const mount = () => {
    const scroll = el?.scrollTop ?? 0;
    const body = $('.sheet-body', el ?? document);
    if (body) { body.innerHTML = render(); el.scrollTop = scroll; }
  };

  // Re-render only when the sheet's own content changes (never from a field's blur/change event).
  el = openSheet(render(), { label: 'Settings', focus: false });

  el.addEventListener('change', async (e) => {
    const t = e.target;
    const s = store.get().settings;
    if (t.id === 'set-budget') {
      const cents = parseAmount(t.value);
      if (!Number.isNaN(cents)) store.setWeeklyBudget(cents, startOfWeek(todayISO(), s.weekStart));
      else toast('Enter a valid amount');
    } else if (t.id === 'set-weekstart') {
      // Budgets are keyed by week start, so re-anchor them to the new first day of the week.
      const next = Number(t.value);
      const st = store.get();
      const current = weekSummary(st, startOfWeek(todayISO(), s.weekStart)).budget;
      store.updateSettings({ weekStart: next });
      if (current) store.setWeeklyBudget(current, startOfWeek(todayISO(), next));
      app.resetWeek();
    } else if (t.id === 'set-currency') {
      store.updateSettings({ currency: t.value });
    } else if (t.id === 'import-file') {
      const file = t.files[0];
      t.value = '';
      if (!file) return;
      try {
        const next = store.sanitize(JSON.parse(await file.text()));
        if (!next) throw new Error('bad');
        if (await confirmDialog({ title: 'Replace all data?', message: `This backup has ${next.transactions.length} transactions and ${next.plans.length} plans. Your current data will be replaced.`, confirmLabel: 'Replace', destructive: true })) {
          store.replaceState({ ...next, onboarded: true });
          app.resetWeek();
          mount();
          toast('Backup restored');
        }
      } catch { toast('That file is not a Budgie backup'); }
    }
  });

  el.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-cat') return;
    e.preventDefault();
    const name = $('#cat-name', el).value.trim();
    if (!name) { $('#cat-name', el).focus(); return; }
    const palette = store.CATEGORY_COLORS;
    store.addCategory({ name, emoji: $('#cat-emoji', el).value.trim() || '🏷️', type: $('#cat-type', el).value, color: palette[store.get().categories.length % palette.length] });
    mount();
    haptic();
  });

  el.addEventListener('click', async (e) => {
    const theme = e.target.closest('[data-theme]');
    if (theme) { store.updateSettings({ theme: theme.dataset.theme }); mount(); return; }
    const del = e.target.closest('[data-del-cat]');
    if (del) {
      const cat = store.get().categories.find((c) => c.id === del.dataset.delCat);
      const used = store.get().transactions.filter((t) => t.categoryId === cat.id).length;
      if (await confirmDialog({ title: `Delete “${cat.name}”?`, message: used ? `${used} transaction${used === 1 ? '' : 's'} will move to “${cat.type === 'income' ? 'Other income' : 'Other'}”.` : '', confirmLabel: 'Delete', destructive: true })) { store.deleteCategory(cat.id); mount(); }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const st = store.get();
    const stamp = todayISO();
    if (act === 'export-json') { download(`budgie-backup-${stamp}.json`, JSON.stringify(st, null, 2), 'application/json'); toast('Backup downloaded'); }
    if (act === 'export-csv') {
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const name = (id) => st.categories.find((c) => c.id === id)?.name ?? 'Other';
      // Prefix cells that start with =,+,-,@ so spreadsheets do not run them as formulas.
      const safe = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
      const rows = [...st.transactions].sort((a, b) => a.date.localeCompare(b.date))
        .map((t) => [t.date, t.type, (t.amount / 100).toFixed(2), q(safe(name(t.categoryId))), q(safe(t.note))].join(','));
      download(`budgie-transactions-${stamp}.csv`, ['date,type,amount,category,note', ...rows].join('\n'), 'text/csv');
      toast('CSV downloaded');
    }
    if (act === 'import') $('#import-file', el).click();
    if (act === 'sample') {
      if (!st.transactions.length || await confirmDialog({ title: 'Load sample data?', message: 'This replaces your current data with a demo.', confirmLabel: 'Load', destructive: true })) {
        store.replaceState(store.sampleData({ ...store.freshState(), settings: st.settings }));
        app.resetWeek();
        closeSheet();
        toast('Sample data loaded');
      }
    }
    if (act === 'erase' && await confirmDialog({ title: 'Erase everything?', message: 'All transactions, plans and settings will be deleted. This cannot be undone.', confirmLabel: 'Erase', destructive: true })) {
      store.replaceState({ ...store.freshState(), onboarded: true });
      app.resetWeek();
      closeSheet();
      toast('All data erased');
    }
  });
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export function openOnboarding(app) {
  const currency = guessCurrency();
  const fmt = makeFormatter(currency);
  const el = openSheet(`<form id="welcome" novalidate class="welcome">
    <div class="welcome-art" aria-hidden="true">🐦</div>
    <h2 class="welcome-title">Welcome to Budgie</h2>
    <p class="welcome-text">Set a weekly budget, log what you spend and always know what is left — today, this week and over the next months.</p>
    <label class="amount-field"><span class="sr-only">Weekly budget</span><span class="cur" id="w-cur" aria-hidden="true">${esc(fmt.symbol)}</span>
      <input id="w-amount" inputmode="decimal" autocomplete="off" placeholder="Weekly budget" autofocus></label>
    <div class="card list inset">
      <label class="row field"><span class="title">Currency</span><select id="w-currency" class="right">${CURRENCIES.map(([c, n]) => `<option value="${c}" ${c === currency ? 'selected' : ''}>${c} · ${esc(n)}</option>`).join('')}</select></label>
      <label class="row field"><span class="title">Week starts on</span><select id="w-week" class="right">${DOW.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    </div>
    <p class="form-error" id="w-error" role="alert" hidden></p>
    <button type="submit" class="btn primary">Get started</button>
    <button type="button" class="btn secondary" data-sample>Explore with sample data</button>
  </form>`, { label: 'Welcome' });

  // Onboarding must be completed (or skipped with sample data) — dismissing it just reopens next launch.
  $('#w-currency', el).addEventListener('change', (e) => { $('#w-cur', el).textContent = makeFormatter(e.target.value).symbol; });
  $('[data-sample]', el).addEventListener('click', () => {
    const base = store.freshState();
    base.settings.currency = $('#w-currency', el).value;
    base.settings.weekStart = Number($('#w-week', el).value);
    store.replaceState(store.sampleData(base));
    app.resetWeek();
    closeSheet();
  });
  $('#welcome', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const cents = parseAmount($('#w-amount', el).value);
    if (!(cents > 0)) {
      const err = $('#w-error', el);
      err.textContent = 'Enter how much you can spend each week.';
      err.hidden = false;
      $('#w-amount', el).focus();
      return;
    }
    const weekStart = Number($('#w-week', el).value);
    store.updateSettings({ currency: $('#w-currency', el).value, weekStart });
    store.setWeeklyBudget(cents, startOfWeek(todayISO(), weekStart));
    store.markOnboarded();
    app.resetWeek();
    closeSheet();
  });
}
