import { cloudBackend, loadConfig, localBackend, preferLocal, setPreferLocal } from './backend.js';
import { closeSheet, confirmDialog, sheetOpen, toast } from './overlay.js';
import { openAddChannel, openAddMenu, openChannel, openNicheEditor, openNiches, openOnboarding, openSettings, openVideo } from './sheets.js';
import * as store from './store.js';
import { languageName } from './lang.js';
import { $, $$, esc } from './util.js';
import { channelsView, loadingView, outlierList, outliersView, signInView } from './views.js';

const VIEWS = { outliers: outliersView, channels: channelsView };
const LOCAL_REFRESH_HOURS = 3;
/** Niche searches cost ~122 quota units, so they repeat less often than channel checks. */
const LOCAL_NICHE_HOURS = 12;
const MANUAL_NICHE_HOURS = 1;
const view = $('#view');
const navTitle = $('#nav-title');

const ui = { tab: 'outliers', niche: 'all', period: 30, kind: 'all', limit: 40, refreshing: false };
let signin = null;
let enter = true;

const app = {
  ui,
  backend: null,
  afterAdd(channel) {
    ui.niche = channel.nicheId ?? 'all';
    if (ui.tab !== 'outliers') { ui.tab = 'outliers'; enter = true; }
    render();
  },
  showNiche(id) {
    ui.niche = id;
    ui.limit = 40;
    if (ui.tab !== 'outliers') { ui.tab = 'outliers'; enter = true; }
    window.scrollTo(0, 0);
    render();
  },
  async signOut() {
    await app.backend.signOut();
    store.disconnect();
    startSignIn();
  },
  useCloud() { setPreferLocal(false); location.reload(); },
  async wipe() {
    try {
      await app.backend.deleteEverything();
      if (app.backend.mode === 'cloud') { store.disconnect(); startSignIn(); toast('Your account was deleted'); }
      else { await store.connect(app.backend); toast('Everything was deleted'); maybeOnboard(); }
    } catch (e) { toast(e.message); }
  },
  /** After opening the bot link: poll until Telegram reports the chat as connected. */
  watchTelegram(onLinked) {
    let tries = 0;
    const tick = async () => {
      if (++tries > 40 || !app.backend?.telegramStatus) return;
      try {
        const t = await app.backend.telegramStatus();
        if (t.linked) { store.setTelegram(t); onLinked?.(); toast('Telegram connected'); return; }
      } catch { /* keep trying */ }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  },
};

/** Re-checks tracked channels and re-searches niches that haven't been searched for `nicheHours`. */
async function refreshAll({ quiet = false, staleHours = 0, nicheHours = MANUAL_NICHE_HOURS, channels: withChannels = true } = {}) {
  const { channels, niches } = store.get();
  const cutoff = Date.now() - nicheHours * 36e5;
  const dueNiches = niches.filter((n) => !n.scannedAt || Date.parse(n.scannedAt) < cutoff);
  if (ui.refreshing || (!channels.length && !dueNiches.length)) {
    if (!quiet && !ui.refreshing) toast('Everything was checked in the last hour.');
    return;
  }
  ui.refreshing = true;
  render();
  const done = [], errors = [];
  try {
    if (withChannels && channels.length) {
      const r = await store.refresh(undefined, { staleHours });
      if (r.channels.length) done.push(`${r.channels.length} channel${r.channels.length === 1 ? '' : 's'}`);
      errors.push(...(r.errors || []));
    }
  } catch (e) { errors.push(e.message); }
  for (const n of dueNiches) {
    try { await store.scanNiche(n.id); done.push(n.name); } catch (e) {
      errors.push(`${n.name}: ${e.message}`);
      if (/quota/i.test(e.message)) break;
    }
  }
  try {
    if (!quiet) toast(errors.length ? errors[0] : done.length ? `Checked ${done.join(', ')}` : 'Up to date');
  } finally {
    ui.refreshing = false;
    render();
  }
}

const context = () => ({ state: store.get(), ui, now: Date.now(), backend: app.backend });

function render() {
  document.body.classList.toggle('signed-out', !!signin);
  if (signin) { view.innerHTML = signInView(signin); navTitle.textContent = ''; return; }
  if (!store.get().ready) { view.innerHTML = loadingView(); return; }
  const ctx = context();
  if (ui.niche !== 'all' && ui.niche !== 'saved' && !ctx.state.niches.some((n) => n.id === ui.niche)) ui.niche = 'all';
  const f = document.activeElement;
  const sel = f && view.contains(f) && f.dataset?.action ? `[data-action="${f.dataset.action}"]${f.dataset.value ? `[data-value="${f.dataset.value}"]` : ''}${f.dataset.id ? `[data-id="${f.dataset.id}"]` : ''}` : null;
  view.innerHTML = VIEWS[ui.tab](ctx);
  view.classList.toggle('enter', enter);
  enter = false;
  $$('[data-action="tab"]').forEach((b) => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  navTitle.textContent = $('.large-title', view)?.textContent ?? '';
  if (sel && !sheetOpen()) $(sel, view)?.focus({ preventScroll: true });
}

function setTab(tab) {
  if (ui.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = tab;
  enter = true;
  window.scrollTo(0, 0);
  render();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('.backdrop, .alert-backdrop')) return;
  const { action, value, id } = el.dataset;
  switch (action) {
    case 'tab': setTab(el.dataset.tab); break;
    case 'add': openAddMenu(app); break;
    case 'add-channel': openAddChannel(app, el.dataset.niche ? { nicheId: el.dataset.niche } : undefined); break;
    case 'add-niche': openNicheEditor(app); break;
    case 'edit-niche': openNicheEditor(app, { id }); break;
    case 'remove-niche': removeNiche(id); break;
    case 'settings': openSettings(app); break;
    case 'video': openVideo(app, id); break;
    case 'channel': openChannel(app, id); break;
    case 'niches': openNiches(app); break;
    case 'niche': ui.niche = value; ui.limit = 40; render(); break;
    case 'period': ui.period = Number(value); ui.limit = 40; render(); break;
    case 'kind': ui.kind = value; render(); break;
    case 'more': ui.limit += 40; $('#outlier-list').innerHTML = outlierList(context()); break;
    case 'refresh': refreshAll(); break;
    case 'use-local': setPreferLocal(true); location.reload(); break;
    case 'signin-back': signin = { step: 'email', email: signin.email }; render(); break;
    default: break;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset?.action !== 'language') return;
  const language = e.target.value;
  try {
    await store.saveSettings({ language });
  } catch (err) { toast(err.message); return; }
  if (language === 'any') { toast('Showing all languages'); return; }
  // Search niches again so the next results favour the new language (quota permitting).
  toast(`Showing ${languageName(language)} videos. Searching your niches again…`);
  refreshAll({ quiet: false, nicheHours: 0, channels: false });
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

const nav = $('#nav');
const onScroll = () => {
  const y = window.scrollY;
  nav.classList.toggle('scrolled', y > 6);
  nav.classList.toggle('show-title', y > 44);
};
addEventListener('scroll', onScroll, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !store.get().ready) return;
  render();
  if (app.backend.mode === 'local') maybeLocalRefresh();
});

async function removeNiche(id) {
  const n = store.get().niches.find((x) => x.id === id);
  if (!n || !await confirmDialog({ title: `Remove “${n.name}”?`, message: 'Videos found by this niche are removed. Tracked channels stay.', confirmLabel: 'Remove', destructive: true })) return;
  try {
    await store.deleteNiche(id);
    ui.niche = 'all';
    render();
    toast('Niche removed');
  } catch (e) { toast(e.message); }
}

function startSignIn() { signin = { step: 'email', email: '' }; render(); }

function maybeOnboard() { if (!store.get().settings.onboarded) openOnboarding(app); }

/** This-device mode has no server checking in the background, so check when the app opens. */
function maybeLocalRefresh() {
  const { settings, channels, niches } = store.get();
  if (!settings.youtubeKey) return;
  const stale = (iso, hours) => !iso || Date.parse(iso) < Date.now() - hours * 36e5;
  if (channels.some((c) => stale(c.checkedAt, LOCAL_REFRESH_HOURS)) || niches.some((n) => stale(n.scannedAt, LOCAL_NICHE_HOURS))) {
    refreshAll({ quiet: true, staleHours: LOCAL_REFRESH_HOURS, nicheHours: LOCAL_NICHE_HOURS });
  }
}

async function openData() {
  render();
  try {
    await store.connect(app.backend);
    maybeOnboard();
    if (app.backend.mode === 'local') maybeLocalRefresh();
  } catch (e) {
    if (app.backend.mode === 'cloud' && !app.backend.user) { startSignIn(); return; }
    view.innerHTML = `<div class="empty"><div class="empty-emoji" aria-hidden="true">⚠️</div><h3>Couldn’t load your channels</h3><p>${esc(e.message)}</p><button type="button" class="btn primary" onclick="location.reload()">Try again</button></div>`;
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
  // When a new version takes over, reload once so the screen isn't left running the old code.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !sheetOpen()) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('./sw.js').then((r) => r.update()).catch(() => {});
}
