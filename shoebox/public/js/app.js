import { cloudBackend, loadConfig, localBackend, preferLocal, setPreferLocal } from './backend.js';
import { todayISO } from './dates.js';
import { fileName, recordsCSV, summaryCSV, summaryJSON, vatCSV } from './export.js';
import { toBase64 } from './extract.js';
import { closeSheet, confirmDialog, sheetOpen, toast } from './overlay.js';
import { openAddSheet, openEmailSheet, openOnboarding, openRecordSheet, openSettings, scanFile } from './sheets.js';
import * as store from './store.js';
import { quarters, summarise, taxYear, taxYearLabel, taxYearOf } from './tax.js';
import { $, $$, download, esc } from './util.js';
import { defaultQuarter, loadingView, receiptsList, receiptsView, signInView, taxView } from './views.js';

const VIEWS = { receipts: receiptsView, tax: taxView };
const view = $('#view');
const navTitle = $('#nav-title');

const ui = {
  tab: 'receipts', year: null, quarter: null, span: 'ytd', consolidated: false,
  query: '', filter: 'all', limit: 80, vatDate: todayISO(),
};
let signin = null; // { step, email, busy, error } while the sign-in screen shows
let enter = true;

const app = {
  ui,
  backend: null,
  /** After saving: show the receipts list for the tax year the record belongs to. */
  showDate(date) {
    const y = taxYearOf(date, store.get().settings.quarterBasis);
    if (ui.year !== y) { ui.year = y; ui.quarter = null; }
    render();
  },
  async signOut() {
    await app.backend.signOut();
    store.disconnect();
    startSignIn();
  },
  useCloud() { setPreferLocal(false); location.reload(); },
  async backup() {
    const { records, settings } = store.get();
    const { geminiKey, geminiModel, ...safeSettings } = settings;
    const files = {};
    if (app.backend.mode === 'local') {
      for (const r of records) {
        const blob = r.imageKey && await app.backend.fileBlob(r.imageKey);
        if (blob) files[r.imageKey] = await blobToDataURL(blob);
      }
    }
    const data = { app: 'shoebox', version: 1, exportedAt: new Date().toISOString(), settings: safeSettings, records, files };
    download(`shoebox-backup-${todayISO()}.json`, JSON.stringify(data), 'application/json');
    toast(app.backend.mode === 'cloud' ? 'Backup downloaded (photos stay in your account)' : 'Backup downloaded');
  },
  async restore(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a Shoebox backup.'); return; }
    if (data?.app !== 'shoebox' || !Array.isArray(data.records)) { toast('That file isn’t a Shoebox backup.'); return; }
    const ok = await confirmDialog({ title: `Restore ${data.records.length} records?`, message: 'Records with the same ID are replaced; everything else is kept.', confirmLabel: 'Restore' });
    if (!ok) return;
    try {
      const b = app.backend;
      const files = data.files && typeof data.files === 'object' ? data.files : {};
      if (b.mode === 'local') {
        for (const [key, url] of Object.entries(files)) {
          if (key.startsWith('local/') && typeof url === 'string' && url.startsWith('data:')) await b.putFile(key, await (await fetch(url)).blob());
        }
      }
      const mine = (k) => (b.mode === 'cloud' ? k?.startsWith(`${b.user.id}/`) : k?.startsWith('local/') && (k in files || store.get().records.some((r) => r.imageKey === k)));
      const n = await store.importRecords(data.records.map((r) => ({ ...r, imageKey: mine(r.imageKey) ? r.imageKey : null })));
      if (data.settings) await store.saveSettings({ ...data.settings, onboarded: true });
      closeSheet();
      toast(`Restored ${n} records`);
    } catch (e) { toast(e.message); }
  },
  async wipe() {
    try {
      await app.backend.deleteEverything();
      if (app.backend.mode === 'cloud') { store.disconnect(); startSignIn(); toast('Your account was deleted'); }
      else { await store.connect(app.backend); toast('Everything was deleted'); maybeOnboard(); }
    } catch (e) { toast(e.message); }
  },
};

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const context = () => {
  const state = store.get();
  const today = todayISO();
  const currentYear = taxYearOf(today, state.settings.quarterBasis);
  ui.year ??= currentYear;
  return { state, ui, today, currentYear, backend: app.backend };
};

function render() {
  document.body.classList.toggle('signed-out', !!signin);
  if (signin) {
    view.innerHTML = signInView(signin);
    navTitle.textContent = '';
    return;
  }
  if (!store.get().ready) { view.innerHTML = loadingView(); return; }
  const ctx = context();
  const f = document.activeElement;
  const sel = f && view.contains(f) && f.dataset?.action
    ? `[data-action="${f.dataset.action}"]${f.dataset.value ? `[data-value="${f.dataset.value}"]` : ''}${f.dataset.id ? `[data-id="${f.dataset.id}"]` : ''}`
    : f?.id === 'search' ? '#search' : null;
  const caret = f?.id === 'search' ? f.selectionStart : null;

  view.innerHTML = VIEWS[ui.tab](ctx);
  view.classList.toggle('enter', enter);
  enter = false;
  $$('[data-action="tab"]').forEach((b) => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  navTitle.textContent = $('.large-title', view)?.textContent ?? '';
  if (sel && !sheetOpen()) {
    const n = $(sel, view);
    n?.focus({ preventScroll: true });
    if (caret != null) n?.setSelectionRange(caret, caret);
  }
}

function setTab(tab) {
  if (ui.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = tab;
  enter = true;
  window.scrollTo(0, 0);
  render();
}

// ---- exports ---------------------------------------------------------------

function currentQuarter() {
  const ctx = context();
  const q = quarters(ui.year, ctx.state.settings.quarterBasis)[(ui.quarter ?? defaultQuarter(ctx)) - 1];
  const from = ui.span === 'ytd' ? q.yearStart : q.start;
  return { q, from, summary: summarise(ctx.state.records, from, q.end, ctx.state.settings) };
}

const csvBlob = (text) => new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });

function quarterFiles() {
  const { settings, records } = store.get();
  const { q, summary } = currentQuarter();
  const span = ui.span === 'ytd' ? 'year to date' : 'quarter only';
  const title = `Quarterly update ${q.n}, ${taxYearLabel(q.year)} (${span})`;
  const yr = taxYear(ui.year, settings.quarterBasis);
  return {
    title,
    mtd: [fileName(q.year, `Q${q.n}-mtd`, 'csv'), summaryCSV(summary, { settings, title, consolidated: ui.consolidated })],
    json: [fileName(q.year, `Q${q.n}-hmrc`, 'json'), summaryJSON(summary, { settings, taxYear: q.year, consolidated: ui.consolidated })],
    records: [fileName(ui.year, 'records', 'csv'), recordsCSV(records.filter((r) => r.date >= yr.start && r.date <= yr.end), settings)],
  };
}

const b64 = (text) => toBase64(new TextEncoder().encode(`﻿${text}`).buffer);

// ---- events ----------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('.backdrop, .alert-backdrop')) return;
  const { action, value } = el.dataset;
  switch (action) {
    case 'tab': setTab(el.dataset.tab); break;
    case 'add': openAddSheet(app); break;
    case 'edit': openRecordSheet(app, { id: el.dataset.id }); break;
    case 'settings': openSettings(app); break;
    case 'year': ui.year += Number(value); ui.quarter = null; enter = true; render(); break;
    case 'filter': ui.filter = value; ui.limit = 80; render(); break;
    case 'more': ui.limit += 80; $('#receipts-list').innerHTML = receiptsList(context()); break;
    case 'goto-quarter': ui.year = Number(el.dataset.year); ui.quarter = Number(el.dataset.q); setTab('tax'); break;
    case 'quarter': ui.quarter = Number(value); render(); break;
    case 'span': ui.span = value; render(); break;
    case 'consolidated': ui.consolidated = el.checked; render(); break;
    case 'vat-period': ui.vatDate = value; render(); break;
    case 'export-mtd': { const [n, t] = quarterFiles().mtd; download(n, csvBlob(t)); break; }
    case 'export-json': { const [n, t] = quarterFiles().json; download(n, t, 'application/json'); break; }
    case 'export-records': { const [n, t] = quarterFiles().records; download(n, csvBlob(t)); break; }
    case 'export-vat': {
      const { settings, records } = store.get();
      const s = summarise(records, el.dataset.from, el.dataset.to, settings);
      download(`shoebox-vat-${el.dataset.from}-to-${el.dataset.to}.csv`, csvBlob(vatCSV(s, { settings })));
      break;
    }
    case 'email-export': {
      const f = quarterFiles();
      openEmailSheet(app, { title: f.title, attachments: [f.mtd, f.records].map(([filename, text]) => ({ filename, content: b64(text) })) });
      break;
    }
    case 'toggle-submitted': {
      const { q } = currentQuarter();
      const sub = store.get().settings.submitted;
      store.saveSettings({ submitted: { ...sub, [q.id]: !sub[q.id] } }).catch((err) => toast(err.message));
      break;
    }
    case 'use-local': setPreferLocal(true); location.reload(); break;
    case 'signin-back': signin = { step: 'email', email: signin.email }; render(); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  const el = e.target.closest?.('[role="button"][data-action]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') { ui.query = e.target.value; ui.limit = 80; $('#receipts-list').innerHTML = receiptsList(context()); }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'signin') return;
  e.preventDefault();
  const b = app.backend;
  if (signin.step === 'email') {
    const email = $('#si-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { signin = { ...signin, email, error: 'Enter your email address.' }; render(); return; }
    signin = { step: 'email', email, busy: true }; render();
    try { await b.sendCode(email); signin = { step: 'code', email }; } catch (err) { signin = { step: 'email', email, error: err.message }; }
    render();
  } else {
    const code = $('#si-code').value.replace(/\D/g, '');
    if (code.length < 6) { signin = { ...signin, error: 'Enter the code from the email.' }; render(); return; }
    signin = { ...signin, busy: true, error: '' }; render();
    try {
      await b.verifyCode(signin.email, code);
      signin = null;
      await openData();
    } catch (err) { signin = { step: 'code', email: signin.email, error: err.message }; render(); }
  }
});

for (const id of ['#file-camera', '#file-any']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) scanFile(app, file);
  });
}

const nav = $('#nav');
const onScroll = () => {
  const y = window.scrollY;
  nav.classList.toggle('scrolled', y > 6);
  nav.classList.toggle('show-title', y > 44);
};
addEventListener('scroll', onScroll, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get().ready) render(); });

// ---- start -----------------------------------------------------------------

function startSignIn() {
  signin = { step: 'email', email: '' };
  render();
}

function maybeOnboard() {
  if (!store.get().settings.onboarded) openOnboarding();
}

async function openData() {
  render();
  try {
    await store.connect(app.backend);
    ui.year = null;
    maybeOnboard();
  } catch (e) {
    if (app.backend.mode === 'cloud' && !app.backend.user) { startSignIn(); return; }
    view.innerHTML = `<div class="empty"><div class="empty-emoji" aria-hidden="true">⚠️</div><h3>Couldn’t load your receipts</h3><p>${esc(e.message)}</p><button type="button" class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
}

store.subscribe(() => render());

(async () => {
  render();
  const config = await loadConfig();
  if (config.cloud && !preferLocal()) {
    app.backend = cloudBackend(config, { onSignedOut: () => { store.disconnect(); closeSheet(true); startSignIn(); toast('Please sign in again.'); } });
    if (!app.backend.user) { startSignIn(); return; }
  } else {
    app.backend = localBackend(config);
  }
  await openData();
})();

onScroll();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
