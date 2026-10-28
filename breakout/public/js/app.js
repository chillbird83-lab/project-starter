import { cloudBackend, loadConfig, localBackend, preferLocal, setPreferLocal } from './backend.js';
import { closeSheet, confirmDialog, sheetOpen, toast } from './overlay.js';
import {
  askGeminiKey, openAddChannel, openAddMenu, openChannel, openIdea, openNicheEditor, openNiches, openOnboarding, openSettings, openVideo,
} from './sheets.js';
import * as store from './store.js';
import { languageName } from './lang.js';
import { interestQuery } from './similar.js';
import { $, $$, esc, haptic } from './util.js';
import { videoURL } from './youtube.js';
import {
  channelsView, ideasView, loadingView, outlierList, outliersView, reportFor, reportView, signInView, suggestionsFor,
} from './views.js';

const VIEWS = { outliers: outliersView, report: reportView, ideas: ideasView, channels: channelsView };
const LOCAL_REFRESH_HOURS = 3;
/** Niche searches cost ~130 quota units, so they repeat less often than channel checks. */
const LOCAL_NICHE_HOURS = 12;
const MANUAL_NICHE_HOURS = 1;
const view = $('#view');
const navTitle = $('#nav-title');

const FEED_KEY = 'breakout.feed';
const savedFeed = (() => { try { return JSON.parse(localStorage.getItem(FEED_KEY)) || {}; } catch { return {}; } })();
const ui = {
  tab: 'outliers', niche: 'all', period: 30, kind: 'all', limit: 40, refreshing: false,
  stage: 'todo', summarising: false, findingSimilar: false,
  sort: ['score', 'rising', 'views', 'new'].includes(savedFeed.sort) ? savedFeed.sort : 'score',
  size: ['any', '10000', '100000', '1000000'].includes(savedFeed.size) ? savedFeed.size : 'any',
};
/** Sort and channel-size choices are remembered on this device. */
const rememberFeed = () => { try { localStorage.setItem(FEED_KEY, JSON.stringify({ sort: ui.sort, size: ui.size })); } catch { /* private mode */ } };
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
  showTab(tab) { setTab(tab, { top: true }); },
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
  if (ui.refreshing) return;
  if (!channels.length && !dueNiches.length) {
    // Niches were searched recently: still refresh view counts, which is cheap.
    try { await store.refreshStats(); } catch { /* ignore */ }
    if (!quiet) toast('Niches were searched in the last hour. View counts are up to date.');
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
  // Fresh view counts for recent outliers, for "Rising now" (1 quota unit per 50 videos).
  try { await store.refreshStats(); } catch { /* not worth interrupting for */ }
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

function setTab(tab, { top = false } = {}) {
  if (ui.tab === tab) { if (top) render(); window.scrollTo({ top: 0, behavior: top ? 'auto' : 'smooth' }); return; }
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
    case 'show-niche': app.showNiche(id); break;
    case 'stage': ui.stage = value; render(); break;
    case 'new-idea': openIdea(app); break;
    case 'idea': openIdea(app, { id }); break;
    case 'idea-move': moveIdea(id, el.dataset.to); break;
    case 'summarise': summarise(); break;
    case 'save-report-idea': saveReportIdea(el.dataset.key, el); break;
    case 'copy': navigator.clipboard?.writeText(value).then(() => toast('Copied'), () => toast('Couldn’t copy on this device.')); break;
    case 'suggest-open': if (id) openVideo(app, id); else if (el.dataset.video) window.open(videoURL(el.dataset.video), '_blank', 'noopener'); break;
    case 'track-suggested': trackSuggested(el); break;
    case 'dismiss-suggested': dismissSuggested(el.dataset.yt); break;
    case 'find-similar': findSimilar(); break;
    case 'use-local': setPreferLocal(true); location.reload(); break;
    case 'signin-back': signin = { step: 'email', email: signin.email }; render(); break;
    default: break;
  }
});

document.addEventListener('change', async (e) => {
  const action = e.target.dataset?.action;
  if (action === 'sort' || action === 'size') {
    ui[action] = e.target.value;
    ui.limit = 40;
    rememberFeed();
    render();
    return;
  }
  if (action !== 'language') return;
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

async function moveIdea(id, to) {
  const idea = store.get().ideas.find((i) => i.id === id);
  if (!idea) return;
  try {
    await store.saveIdea({ ...idea, status: to });
    haptic(10);
    const label = { making: 'Moved to Making', done: 'Published 🎉', todo: 'Back in To make' }[to];
    toast(label, { actionLabel: 'Undo', onAction: () => store.saveIdea({ ...idea }).catch((e) => toast(e.message)) });
  } catch (e) { toast(e.message); }
}

/** "What do they have in common?": one Gemini call for the whole week. */
async function summarise() {
  if (ui.summarising) return;
  const { backend } = app;
  if (backend.mode === 'local' && !store.get().settings.geminiKey
    && !await askGeminiKey('The weekly summary uses Google’s Gemini AI to say what each niche’s breakouts share.')) return;
  ui.summarising = true;
  render();
  try {
    const s = await store.summariseReport(reportFor(store.get(), Date.now()));
    toast(Object.keys(s.items ?? {}).length ? 'Summary ready' : 'The AI had nothing to add this week.');
  } catch (e) { toast(e.message); } finally { ui.summarising = false; render(); }
}

async function saveReportIdea(key, btn) {
  const s = store.get();
  const item = s.reportSummary?.items?.[key];
  const group = reportFor(s, Date.now()).groups.find((g) => g.key === key);
  if (!item?.idea) return;
  btn.disabled = true;
  try {
    await store.saveIdea({ title: item.idea, angle: item.pattern, status: 'todo', sourceTitle: `Weekly report · ${group?.name ?? ''}` });
    toast('Saved to your Ideas board', { actionLabel: 'View', onAction: () => { ui.stage = 'todo'; app.showTab('ideas'); } });
  } catch (e) { btn.disabled = false; toast(e.message); }
}

async function trackSuggested(btn) {
  const yt = btn.dataset.yt;
  const c = suggestionsFor(store.get()).find((x) => x.ytChannelId === yt);
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const nicheId = store.get().niches.some((n) => n.id === btn.dataset.niche) ? btn.dataset.niche : null;
    const r = await store.addChannel(yt, nicheId);
    toast(`Now tracking ${r.channel.title}`);
  } catch (e) { btn.disabled = false; btn.textContent = 'Track'; toast(e.message.replace(/^You already track/, `${c?.title ?? 'This channel'}: you already track`)); }
}

async function dismissSuggested(yt) {
  const c = suggestionsFor(store.get()).find((x) => x.ytChannelId === yt);
  try {
    await store.dismissChannel(yt);
    toast(`${c?.title ?? 'Channel'} won’t be suggested again`, {
      actionLabel: 'Undo', onAction: () => store.saveSettings({ dismissedChannels: store.get().settings.dismissedChannels.filter((x) => x !== yt) }).catch(() => {}),
    });
  } catch (e) { toast(e.message); }
}

async function findSimilar() {
  const q = interestQuery({ videos: store.get().videos, ideas: store.get().ideas });
  if (!q || ui.findingSimilar) return;
  ui.findingSimilar = true;
  render();
  try {
    const r = await store.findSimilar(q.query);
    // Only channels the search added count: ones already suggested from your feed aren't new.
    const n = suggestionsFor(store.get()).filter((x) => x.source === 'search' && r.channels.some((c) => c.ytChannelId === x.ytChannelId)).length;
    toast(n ? `Found ${n} more small channel${n === 1 ? '' : 's'} like the videos you open` : 'No new small channels this time. Try again after opening a few more outliers.');
  } catch (e) { toast(e.message); } finally { ui.findingSimilar = false; render(); }
}

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
  } else if (store.get().videos.some((v) => v.score >= 1.5 && Date.now() - Date.parse(v.publishedAt) < 14 * 864e5 && stale(v.updatedAt, 1))) {
    store.refreshStats().catch(() => {});
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
