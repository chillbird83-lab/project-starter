// Sheets: add, review/edit a record (with the AI scan), settings, first-run setup, email export.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryOf } from './categories.js';
import { isISODate, parseAmount, penceToInput, todayISO } from './dates.js';
import { WARNING_TEXT } from './extract.js';
import { money } from './format.js';
import { prepareFile } from './image.js';
import { closeSheet, confirmDialog, openSheet, sheetElement, toast } from './overlay.js';
import * as store from './store.js';
import { amounts } from './tax.js';
import { $, $$, autosize, esc, haptic } from './util.js';

const PAYMENTS = [['', 'Not set'], ['card', 'Card'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['other', 'Other']];
const SHARES = [100, 90, 80, 75, 60, 50, 40, 25, 20, 10];

const header = (title, { cancel = 'Cancel', submit = 'Save' } = {}) =>
  `<div class="sheet-head"><button type="button" class="link" data-close>${cancel}</button><h2>${esc(title)}</h2>${submit ? `<button type="submit" class="link strong">${esc(submit)}</button>` : '<span></span>'}</div>`;

const switchRow = (id, title, sub, on) =>
  `<label class="row field toggle"><span class="grow"><span class="title">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span><input type="checkbox" class="switch" id="${id}" ${on ? 'checked' : ''}></label>`;

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export function openAddSheet(app) {
  const el = openSheet(`${header('Add', { submit: '' })}
    <div class="options">
      <button type="button" class="option primary" data-pick="camera"><span aria-hidden="true">📷</span><b>Take a photo</b><small>AI reads it for you</small></button>
      <button type="button" class="option" data-pick="file"><span aria-hidden="true">🖼️</span><b>Upload photo or PDF</b><small>Emailed receipts and invoices</small></button>
      <button type="button" class="option" data-pick="manual"><span aria-hidden="true">⌨️</span><b>Type in an expense</b><small>No receipt to hand</small></button>
      <button type="button" class="option" data-pick="income"><span aria-hidden="true">💷</span><b>Add income</b><small>Sales and fees you’ve been paid</small></button>
    </div>
    ${app.backend.mode === 'local' && !store.get().settings.geminiKey ? '<p class="hint center">To read receipts automatically, add a free Gemini key in Settings.</p>' : ''}`, { label: 'Add' });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const pick = b.dataset.pick;
    if (pick === 'camera') $('#file-camera').click();
    else if (pick === 'file') $('#file-any').click();
    else openRecordSheet(app, { draft: { kind: pick === 'income' ? 'income' : 'expense' } });
  });
}

/** Photo or PDF picked: shrink it, open the review sheet straight away, fill it in when the AI answers. */
export async function scanFile(app, file) {
  let prepared;
  try { prepared = await prepareFile(file); } catch (e) { closeSheet(true); toast(e.message); return; }
  const preview = { url: URL.createObjectURL(prepared.blob), type: prepared.type };
  const ctl = openRecordSheet(app, { scanning: true, preview });
  let res;
  try {
    res = await app.backend.scan(prepared.blob, prepared.type, store.get().settings);
  } catch (e) {
    res = { imageKey: null, draft: null, warnings: [], error: e.message };
  }
  if (ctl.closed()) { store.purgeFile(res.imageKey); return; }
  ctl.fill(res);
}

// ---------------------------------------------------------------------------
// Record (review / edit)
// ---------------------------------------------------------------------------

export function openRecordSheet(app, { id, draft = {}, scanning = false, preview = null } = {}) {
  const editing = id ? store.get().records.find((r) => r.id === id) : null;
  const settings = store.get().settings;
  const form = {
    kind: editing?.kind ?? draft.kind ?? 'expense',
    category: editing?.category ?? draft.category ?? null,
    imageKey: editing?.imageKey ?? null,
    saved: false,
    closed: false,
  };
  const cats = () => (form.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES);
  if (!cats().some((c) => c.id === form.category)) form.category = form.kind === 'income' ? 'turnover' : 'otherExpenses';
  const v = editing ?? draft;

  const chips = () => cats().map((c) =>
    `<button type="button" class="chip ${c.id === form.category ? 'on' : ''}" data-cat="${c.id}" style="--c:${c.color}" aria-pressed="${c.id === form.category}" title="${esc(c.hint)}"><span aria-hidden="true">${c.emoji}</span>${esc(c.label)}</button>`).join('');
  const shareOptions = (cur) => [...new Set([...SHARES, cur])].sort((a, b) => b - a)
    .map((p) => `<option value="${p}" ${p === cur ? 'selected' : ''}>${p === 100 ? 'All business (100%)' : `${p}% business`}</option>`).join('');

  const title = editing ? 'Edit' : scanning ? 'Check receipt' : form.kind === 'income' ? 'New income' : 'New expense';
  const el = openSheet(`<form id="rec-form" novalidate>
    ${header(title)}
    <div class="receipt-top" id="rec-file" ${preview || form.imageKey ? '' : 'hidden'}></div>
    <div class="scan-status" id="rec-status" role="status" aria-live="polite" ${scanning ? '' : 'hidden'}><span class="spinner" aria-hidden="true"></span> Reading your receipt…</div>
    <ul class="warnings" id="rec-warnings" hidden></ul>
    <div class="seg" role="group" aria-label="Type" ${editing || scanning ? 'hidden' : ''}>
      <button type="button" data-kind="expense">Expense</button><button type="button" data-kind="income">Income</button>
    </div>
    <fieldset id="rec-fields" ${scanning ? 'disabled' : ''}>
      <label class="amount-field"><span class="sr-only">Total paid including VAT</span><span class="cur" aria-hidden="true">£</span>
        <input id="rec-gross" inputmode="decimal" autocomplete="off" placeholder="0" value="${v.gross ? penceToInput(v.gross) : ''}" ${scanning ? '' : 'autofocus'}></label>
      <p class="impact" id="rec-impact" aria-live="polite"></p>
      <h3 class="mini-title">Category</h3>
      <div class="chips" id="rec-cats">${chips()}</div>
      <p class="hint" id="rec-cat-hint"></p>
      <div class="card list inset">
        <label class="row field"><span class="title" id="rec-who-label">${form.kind === 'income' ? 'Customer' : 'Supplier'}</span><input id="rec-merchant" maxlength="80" placeholder="${form.kind === 'income' ? 'Who paid you' : 'Shop or company'}" value="${esc(v.merchant ?? '')}" autocomplete="off"></label>
        <label class="row field"><span class="title">Date</span><input id="rec-date" type="date" value="${esc(v.date ?? todayISO())}" required></label>
        <label class="row field"><span class="title">What for</span><input id="rec-desc" maxlength="120" placeholder="Optional" value="${esc(v.description ?? '')}"></label>
        <div class="row field"><label class="title" for="rec-vat">VAT</label>
          <button type="button" class="chip-btn mini" id="rec-vat20" title="Work out 20% VAT from the total">20%</button>
          <input id="rec-vat" inputmode="decimal" placeholder="0.00" value="${v.vat ? penceToInput(v.vat) : ''}" autocomplete="off"></div>
        <label class="row field expense-only" id="rec-vatno-row"><span class="title">VAT number</span><input id="rec-vatno" maxlength="20" placeholder="On the receipt" value="${esc(v.vatNumber ?? '')}" autocomplete="off"></label>
        <label class="row field expense-only"><span class="title">Business use</span><select id="rec-share">${shareOptions(v.businessPct ?? 100)}</select></label>
        <label class="row field"><span class="title">Paid by</span><select id="rec-pay">${PAYMENTS.map(([k, l]) => `<option value="${k}" ${k === (v.payment ?? '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
    </fieldset>
    <p class="form-error" id="rec-error" role="alert" hidden></p>
    ${editing ? '<button type="button" class="btn danger-text" data-del>Delete</button>' : ''}
  </form>`, {
    label: title,
    focus: !scanning,
    onClose: () => {
      form.closed = true;
      if (preview) URL.revokeObjectURL(preview.url);
      if (!form.saved && !editing && form.imageKey) store.purgeFile(form.imageKey);
    },
  });

  const $f = (s) => $(s, el);
  const grossEl = $f('#rec-gross'), vatEl = $f('#rec-vat'), dateEl = $f('#rec-date'), shareEl = $f('#rec-share'), errEl = $f('#rec-error');
  autosize(grossEl);

  const showFile = (url, type) => {
    const box = $f('#rec-file');
    box.hidden = false;
    box.innerHTML = type === 'application/pdf'
      ? `<button type="button" class="thumb pdf" data-open-file aria-label="Open PDF"><span aria-hidden="true">📄</span>PDF receipt</button>`
      : `<button type="button" class="thumb" data-open-file aria-label="View receipt photo"><img src="${esc(url)}" alt="Receipt photo"></button>`;
    box.dataset.url = url;
    box.dataset.type = type;
  };
  if (preview) showFile(preview.url, preview.type);
  else if (form.imageKey) {
    $f('#rec-file').innerHTML = '<div class="thumb loading"><span class="spinner" aria-hidden="true"></span></div>';
    app.backend.fileURL(form.imageKey)
      .then((url) => showFile(url, /\.pdf$/.test(form.imageKey) ? 'application/pdf' : 'image/jpeg'))
      .catch(() => { $f('#rec-file').innerHTML = '<p class="hint center">The receipt file couldn’t be loaded.</p>'; });
  }

  const record = () => ({
    ...(editing ?? {}),
    id: editing?.id,
    kind: form.kind,
    category: form.category,
    gross: parseAmount(grossEl.value),
    vat: vatEl.value.trim() ? parseAmount(vatEl.value) : 0,
    merchant: $f('#rec-merchant').value.trim(),
    description: $f('#rec-desc').value.trim(),
    date: dateEl.value,
    businessPct: form.kind === 'income' ? 100 : Number(shareEl.value),
    payment: $f('#rec-pay').value,
    vatNumber: form.kind === 'income' ? '' : $f('#rec-vatno').value.trim(),
    imageKey: form.imageKey,
  });

  const updateImpact = () => {
    const r = record();
    const imp = $f('#rec-impact');
    $f('#rec-cat-hint').textContent = categoryOf(form.category, form.kind).hint;
    if (!(r.gross > 0)) { imp.textContent = ''; return; }
    const s = store.get().settings;
    const a = amounts({ ...r, vat: Number.isFinite(r.vat) ? r.vat : 0 }, s);
    if (r.kind === 'income') {
      imp.textContent = s.vatRegistered && r.vat ? `${money(a.amount)} income · ${money(a.vatOutput)} VAT to pay` : `${money(a.amount)} income`;
      return;
    }
    const allowable = a.amount - a.disallowable;
    imp.textContent = form.category === 'businessEntertainmentCosts'
      ? 'Client entertaining is recorded but isn’t tax-deductible.'
      : `${money(allowable)} allowable${s.vatRegistered ? ` · ${money(a.vatReclaim)} VAT back` : ''}`;
  };

  const syncKind = () => {
    $$('[data-kind]', el).forEach((b) => { const on = b.dataset.kind === form.kind; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    if (!cats().some((c) => c.id === form.category)) form.category = form.kind === 'income' ? 'turnover' : 'otherExpenses';
    $f('#rec-cats').innerHTML = chips();
    $$('.expense-only', el).forEach((n) => { n.hidden = form.kind === 'income'; });
    $f('#rec-who-label').textContent = form.kind === 'income' ? 'Customer' : 'Supplier';
    el.classList.toggle('is-income', form.kind === 'income');
    updateImpact();
  };

  el.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { form.kind = k.dataset.kind; syncKind(); haptic(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { form.category = c.dataset.cat; $f('#rec-cats').innerHTML = chips(); updateImpact(); haptic(); return; }
    if (e.target.closest('#rec-vat20')) {
      const g = parseAmount(grossEl.value);
      if (g > 0) { vatEl.value = penceToInput(Math.round(g / 6)); updateImpact(); }
      return;
    }
    if (e.target.closest('[data-open-file]')) { openFile($f('#rec-file').dataset.url, $f('#rec-file').dataset.type); return; }
    if (e.target.closest('[data-del]')) {
      try {
        const removed = await store.deleteRecord(editing.id);
        closeSheet();
        let undone = false;
        toast('Deleted', {
          actionLabel: 'Undo',
          onAction: () => { undone = true; store.saveRecord(removed).catch((err) => toast(err.message)); },
        });
        setTimeout(() => { if (!undone) store.purgeFile(removed.imageKey); }, 6000);
      } catch (err) { toast(err.message); }
    }
  });
  [grossEl, vatEl].forEach((n) => n.addEventListener('input', updateImpact));
  shareEl.addEventListener('change', updateImpact);

  $f('#rec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($f('#rec-fields').disabled) return;
    const r = record();
    const fail = (msg, node) => { errEl.textContent = msg; errEl.hidden = false; node.focus(); node.classList.add('shake'); setTimeout(() => node.classList.remove('shake'), 400); };
    if (!(r.gross > 0)) return fail('Enter the total paid.', grossEl);
    if (r.gross > 999_999_999) return fail('That amount is too large.', grossEl);
    if (!Number.isFinite(r.vat) || r.vat < 0) return fail('Enter the VAT as an amount, e.g. 4.50.', vatEl);
    if (r.vat > r.gross) return fail('VAT can’t be more than the total.', vatEl);
    if (!isISODate(r.date)) return fail('Pick a date.', dateEl);
    const btn = $('button[type="submit"]', el);
    btn.disabled = true;
    try {
      await store.saveRecord(r);
      form.saved = true;
      haptic(12);
      closeSheet();
      app.showDate(r.date);
      toast(editing ? 'Saved' : r.kind === 'income' ? 'Income added' : 'Receipt saved');
    } catch (err) {
      btn.disabled = false;
      fail(err.message, grossEl);
    }
  });

  syncKind();

  return {
    closed: () => form.closed,
    /** Called with the scan result: { imageKey, draft, warnings, error }. */
    fill({ imageKey, draft: d, warnings = [], error }) {
      form.imageKey = imageKey || null;
      $f('#rec-status').hidden = true;
      $f('#rec-fields').disabled = false;
      const notes = [...(error ? [error] : []), ...warnings.map((w) => WARNING_TEXT[w]).filter(Boolean)];
      if (!imageKey) notes.push('The photo couldn’t be saved, so this record won’t have it attached.');
      const list = $f('#rec-warnings');
      list.hidden = !notes.length;
      list.innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
      if (d) {
        form.kind = d.kind || 'expense';
        form.category = d.category;
        if (d.gross) grossEl.value = penceToInput(d.gross);
        vatEl.value = d.vat ? penceToInput(d.vat) : '';
        $f('#rec-merchant').value = d.merchant || '';
        $f('#rec-desc').value = d.description || '';
        $f('#rec-vatno').value = d.vatNumber || '';
        if (isISODate(d.date)) dateEl.value = d.date;
        if (d.payment) $f('#rec-pay').value = d.payment;
        grossEl.dispatchEvent(new Event('input'));
      }
      syncKind();
      if (sheetElement() === el) (d?.gross ? $('button[type="submit"]', el) : grossEl).focus({ preventScroll: true });
    },
  };
}

/** Full-screen photo viewer; PDFs open in the browser's viewer. */
function openFile(url, type) {
  if (!url) return;
  if (type === 'application/pdf') { window.open(url, '_blank', 'noopener'); return; }
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Receipt photo');
  box.innerHTML = `<img src="${esc(url)}" alt="Receipt photo"><button type="button" class="lightbox-close" aria-label="Close">✕</button>`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  $('.lightbox-close', box).focus();
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

const staggerSelect = (cur) => `<select id="set-stagger">${[[1, 'Mar, Jun, Sep, Dec'], [2, 'Apr, Jul, Oct, Jan'], [3, 'May, Aug, Nov, Feb']]
  .map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const basisSelect = (cur) => `<select id="set-basis"><option value="standard" ${cur === 'standard' ? 'selected' : ''}>6 Apr – 5 Jul … (standard)</option><option value="calendar" ${cur === 'calendar' ? 'selected' : ''}>1 Apr – 30 Jun … (calendar)</option></select>`;

export function openOnboarding() {
  const s = store.get().settings;
  const el = openSheet(`<form id="ob-form" class="welcome" novalidate>
    <div class="welcome-art" aria-hidden="true">🧾</div>
    <h2 class="welcome-title">Set up Shoebox</h2>
    <p class="welcome-text">Three questions so your totals match what HMRC expects. You can change them later in Settings.</p>
    <div class="card list inset">
      <label class="row field"><span class="title">Business name</span><input id="set-name" maxlength="80" placeholder="Optional" value="${esc(s.businessName)}" autocomplete="organization"></label>
      ${switchRow('set-vat', 'VAT registered', 'Records costs without the VAT you claim back', s.vatRegistered)}
      <label class="row field" id="ob-stagger" ${s.vatRegistered ? '' : 'hidden'}><span class="title">VAT quarters end</span>${staggerSelect(s.vatStagger)}</label>
      <label class="row field"><span class="title">MTD quarters</span>${basisSelect(s.quarterBasis)}</label>
    </div>
    <p class="hint">Not sure about quarters? Keep “standard”. Calendar quarters are only used if you chose them in your MTD software.</p>
    <button type="submit" class="btn primary">Start</button>
  </form>`, { label: 'Set up Shoebox' });
  $('#set-vat', el).addEventListener('change', (e) => { $('#ob-stagger', el).hidden = !e.target.checked; });
  $('#ob-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await store.saveSettings({
        onboarded: true, businessName: $('#set-name', el).value.trim(), vatRegistered: $('#set-vat', el).checked,
        vatStagger: Number($('#set-stagger', el).value), quarterBasis: $('#set-basis', el).value,
      });
      closeSheet();
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function openSettings(app) {
  const s = store.get().settings;
  const b = app.backend;
  const cloud = b.mode === 'cloud';
  const el = openSheet(`${header('Settings', { cancel: 'Done', submit: '' })}
    <h3 class="group-label">Account</h3>
    <div class="card list inset">
      ${cloud
        ? `<div class="row"><span class="grow"><span class="title">Signed in</span><span class="sub">${esc(b.user?.email ?? '')}</span></span><button type="button" class="link" data-act="sign-out">Sign out</button></div>`
        : `<div class="row"><span class="grow"><span class="title">This device only</span><span class="sub">Receipts are stored in this browser. Back them up below.</span></span>${b.config.cloud ? '<button type="button" class="link" data-act="use-cloud">Sign in</button>' : ''}</div>`}
    </div>

    <h3 class="group-label">Business</h3>
    <div class="card list inset">
      <label class="row field"><span class="title">Business name</span><input id="set-name" maxlength="80" placeholder="Optional" value="${esc(s.businessName)}" autocomplete="organization"></label>
      ${switchRow('set-vat', 'VAT registered', 'Costs are recorded without reclaimable VAT', s.vatRegistered)}
      <label class="row field" id="set-stagger-row" ${s.vatRegistered ? '' : 'hidden'}><span class="title">VAT quarters end</span>${staggerSelect(s.vatStagger)}</label>
      <label class="row field"><span class="title">MTD quarters</span>${basisSelect(s.quarterBasis)}</label>
    </div>

    <h3 class="group-label">Accountant &amp; reminders</h3>
    <div class="card list inset">
      <label class="row field"><span class="title">Accountant email</span><input id="set-acc" type="email" inputmode="email" placeholder="Optional" value="${esc(s.accountantEmail)}" autocomplete="off"></label>
      ${cloud && b.config.reminders ? switchRow('set-remind', 'Deadline reminders', 'Email 14 and 3 days before an update is due', s.reminders) : ''}
    </div>
    ${cloud ? '' : `<p class="hint">Emailing exports and reminders need an account.</p>`}

    ${cloud ? '' : `<h3 class="group-label">Receipt reading</h3>
    <div class="card list inset">
      <label class="row field"><span class="title">Gemini API key</span><input id="set-key" type="password" placeholder="Paste key" value="${esc(s.geminiKey || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="row field"><span class="title">Model</span><input id="set-model" placeholder="gemini-flash-latest" value="${esc(s.geminiModel || '')}" autocomplete="off" spellcheck="false"></label>
    </div>
    <p class="hint">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Photos go straight from this phone to Google. On Gemini’s free tier Google may use them to improve its products, so use a paid key for client or sensitive documents.</p>`}

    <h3 class="group-label">Data</h3>
    <div class="card list inset">
      <button type="button" class="row" data-act="backup"><span class="grow title blue">Download a backup</span></button>
      <button type="button" class="row" data-act="restore"><span class="grow title blue">Restore from a backup…</span></button>
      <button type="button" class="row" data-act="wipe"><span class="grow title red">${cloud ? 'Delete my account and data' : 'Delete everything on this device'}</span></button>
    </div>
    <input type="file" id="set-restore" accept="application/json,.json" hidden>
    <p class="hint">HMRC asks you to keep business records for at least 5 years after the 31 January filing deadline.</p>
    <p class="about">Shoebox · receipts &amp; Making Tax Digital for sole traders<br>Not tax advice. Check anything unusual with an accountant.</p>`, { label: 'Settings', focus: false });

  const save = (patch) => store.saveSettings(patch).catch((err) => toast(err.message));
  const on = (sel, ev, fn) => $(sel, el)?.addEventListener(ev, fn);
  on('#set-name', 'change', (e) => save({ businessName: e.target.value.trim() }));
  on('#set-vat', 'change', (e) => { $('#set-stagger-row', el).hidden = !e.target.checked; save({ vatRegistered: e.target.checked }); });
  on('#set-stagger', 'change', (e) => save({ vatStagger: Number(e.target.value) }));
  on('#set-basis', 'change', (e) => { app.ui.quarter = null; save({ quarterBasis: e.target.value }); });
  on('#set-acc', 'change', (e) => {
    const v = e.target.value.trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast('That email address doesn’t look right.'); return; }
    save({ accountantEmail: v });
  });
  on('#set-remind', 'change', (e) => save({ reminders: e.target.checked }));
  on('#set-key', 'change', (e) => save({ geminiKey: e.target.value.trim() }));
  on('#set-model', 'change', (e) => save({ geminiModel: e.target.value.trim() }));
  on('#set-restore', 'change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await app.restore(file);
  });

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'sign-out') { closeSheet(true); await app.signOut(); }
    if (act === 'use-cloud') { closeSheet(true); app.useCloud(); }
    if (act === 'backup') await app.backup();
    if (act === 'restore') $('#set-restore', el).click();
    if (act === 'wipe') {
      const ok = await confirmDialog({
        title: cloud ? 'Delete your account?' : 'Delete everything?',
        message: 'All receipts, photos and settings will be removed for good. Download a backup first if you need your records.',
        confirmLabel: 'Delete', destructive: true,
      });
      if (ok) { closeSheet(true); await app.wipe(); }
    }
  });
}

// ---------------------------------------------------------------------------
// Email an export
// ---------------------------------------------------------------------------

export function openEmailSheet(app, { title, attachments }) {
  const s = store.get().settings;
  const me = app.backend.user?.email ?? '';
  const options = [s.accountantEmail, me].filter(Boolean);
  const el = openSheet(`<form id="em-form" novalidate>
    ${header('Email export', { submit: 'Send' })}
    <div class="card list inset">
      <label class="row field"><span class="title">To</span><select id="em-to">${options.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
      <label class="row field"><span class="title">Subject</span><input id="em-subject" maxlength="150" value="${esc(title)}"></label>
    </div>
    <label class="card note"><span class="sr-only">Message</span><textarea id="em-text" rows="4" maxlength="2000" placeholder="Message (optional)">Hi, here are my figures for ${esc(title.toLowerCase())}.</textarea></label>
    <p class="hint">Attached: ${attachments.map((a) => esc(a.filename)).join(', ')}.${s.accountantEmail ? '' : ' Add your accountant’s email in Settings to send it to them.'}</p>
    <p class="form-error" id="em-error" role="alert" hidden></p>
  </form>`, { label: 'Email export' });
  $('#em-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', el);
    btn.disabled = true;
    try {
      await app.backend.email({ to: $('#em-to', el).value, subject: $('#em-subject', el).value, text: $('#em-text', el).value, attachments });
      closeSheet();
      toast('Email sent');
    } catch (err) {
      btn.disabled = false;
      const errEl = $('#em-error', el);
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}
