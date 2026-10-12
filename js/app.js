import { addDays, startOfWeek, todayISO } from './calc.js';
import { makeFormatter } from './format.js';
import { sheetOpen, toast } from './overlay.js';
import { openOnboarding, openPlanSheet, openSettings, openTxSheet } from './sheets.js';
import * as store from './store.js';
import { $, $$ } from './util.js';
import { activityList, activityView, insightsView, plansView, weekView } from './views.js';

const VIEWS = { week: weekView, plans: plansView, activity: activityView, insights: insightsView };

const ui = {
  tab: 'week',
  weekStart: startOfWeek(todayISO(), store.get().settings.weekStart),
  expandedDay: todayISO(),
  query: '',
  filter: 'all',
  limit: 60,
  range: 30,
  lastToday: todayISO(),
};

let enter = true; // play the entrance animation on tab / week changes, not on every data change
const view = $('#view');
const navTitle = $('#nav-title');
let fmtCache = { key: '', fmt: null };

const getFmt = (currency) => {
  const key = `${currency}|${navigator.language}`;
  if (fmtCache.key !== key) fmtCache = { key, fmt: makeFormatter(currency) };
  return fmtCache.fmt;
};

const context = () => {
  const state = store.get();
  return { state, ui, fmt: getFmt(state.settings.currency), today: todayISO() };
};

const app = {
  ui,
  /** Jump the week screen to the week containing `date` and open that day. */
  goToDate(date) {
    ui.weekStart = startOfWeek(date, store.get().settings.weekStart);
    ui.expandedDay = date;
    render();
  },
  resetWeek() {
    const today = todayISO();
    ui.weekStart = startOfWeek(today, store.get().settings.weekStart);
    ui.expandedDay = today;
    enter = true;
    render();
  },
};

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
  $$('meta[name="theme-color"]').forEach((m) => {
    const dark = m.dataset.dark === '1';
    m.content = theme === 'auto' ? (dark ? '#000000' : '#f2f2f7') : theme === 'dark' ? '#000000' : '#f2f2f7';
  });
}

function render() {
  const ctx = context();
  applyTheme(ctx.state.settings.theme);

  // Keep the week screen following "today" when the app stays open past midnight.
  if (ctx.today !== ui.lastToday) {
    if (ui.weekStart === startOfWeek(ui.lastToday, ctx.state.settings.weekStart)) {
      ui.weekStart = startOfWeek(ctx.today, ctx.state.settings.weekStart);
      ui.expandedDay = ctx.today;
    }
    ui.lastToday = ctx.today;
  }

  // Remember focus so keyboard users do not lose their place when the screen re-renders.
  const f = document.activeElement;
  const sel = f && view.contains(f) && f.dataset?.action
    ? `[data-action="${f.dataset.action}"]${f.dataset.date ? `[data-date="${f.dataset.date}"]` : ''}${f.dataset.id ? `[data-id="${f.dataset.id}"]` : ''}${f.dataset.value ? `[data-value="${f.dataset.value}"]` : ''}`
    : null;

  view.innerHTML = VIEWS[ui.tab](ctx);
  view.classList.toggle('enter', enter);
  enter = false;
  view.dataset.tab = ui.tab;
  $$('[data-action="tab"]').forEach((b) => {
    const on = b.dataset.tab === ui.tab;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  navTitle.textContent = $('.large-title', view)?.textContent ?? '';
  if (sel && !sheetOpen()) $(sel, view)?.focus({ preventScroll: true });
}

function renderActivityList() {
  const el = $('#activity-list');
  if (el) el.innerHTML = activityList(context());
}

function setTab(tab) {
  if (ui.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = tab;
  enter = true;
  window.scrollTo(0, 0);
  render();
}

// ---- events ----------------------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('.backdrop, .alert-backdrop')) return;
  const { action, date, id, value, tab } = el.dataset;
  switch (action) {
    case 'tab': setTab(tab); break;
    case 'add': openTxSheet(app, { date: date || (ui.tab === 'week' && ui.expandedDay) || todayISO() }); break;
    case 'edit-tx': openTxSheet(app, { id }); break;
    case 'new-plan': openPlanSheet(app); break;
    case 'edit-plan': openPlanSheet(app, { id }); break;
    case 'settings': openSettings(app); break;
    case 'prev-week': enter = true; ui.weekStart = addDays(ui.weekStart, -7); ui.expandedDay = null; render(); break;
    case 'next-week': enter = true; ui.weekStart = addDays(ui.weekStart, 7); ui.expandedDay = null; render(); break;
    case 'this-week': app.resetWeek(); break;
    case 'toggle-day': ui.expandedDay = ui.expandedDay === date ? null : date; render(); break;
    case 'filter': ui.filter = value; ui.limit = 60; render(); break;
    case 'range': ui.range = Number(value); render(); break;
    case 'more': ui.limit += 60; renderActivityList(); break;
    case 'goto-week': ui.weekStart = date; ui.expandedDay = null; setTab('week'); render(); break;
    default: break;
  }
});

// Cards that act as buttons (role="button") should respond to Enter / Space.
document.addEventListener('keydown', (e) => {
  const el = e.target.closest?.('[role="button"][data-action]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') { ui.query = e.target.value; ui.limit = 60; renderActivityList(); }
});

// Frosted nav bar: fades the small title in once the large title scrolls away.
const nav = $('#nav');
const onScroll = () => {
  const y = window.scrollY;
  nav.classList.toggle('scrolled', y > 6);
  nav.classList.toggle('show-title', y > 44);
};
addEventListener('scroll', onScroll, { passive: true });

// Refresh when coming back to the app (new day, or data changed in another tab).
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
addEventListener('storage', (e) => { if (e.key === 'budgie.v1') location.reload(); });

store.subscribe(render);
render();
onScroll();

if (!store.get().onboarded) openOnboarding(app);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (store.hadPersistError()) toast('Changes cannot be saved in this browser mode.');
