import { SPEEDS, classNow, formatBytes, formatClock, startOfWeek, addDays, todayISO } from './logic.js';
import { confirmDialog, historySettled, sheetOpen, toast } from './overlay.js';
import * as player from './player.js';
import * as recorder from './recorder.js';
import {
  openBookmarkSheet, openCourseSheet, openLectureMenu, openOnboarding, openSettings,
} from './sheets.js';
import * as store from './store.js';
import { $, $$, autogrow, debounce, downloadBlob, esc, haptic } from './util.js';
import {
  ICON, courseView, coursesView, dockView, lectureView, libraryList, libraryView, recordView, stampChips, todayView, weekView,
} from './views.js';

const TABS = { today: todayView, courses: coursesView, library: libraryView, week: weekView };

const ui = {
  tab: 'today',
  page: null, // { type: 'course' | 'lecture' | 'record', id }
  query: '',
  filter: 'all',
  weekStart: startOfWeek(todayISO()),
  draft: { courseId: null, title: '', suggested: '' },
};
let depth = 0; // pages stacked on top of the current tab (each owns a history entry)
let pendingTab = null;
let storageFree = null;
let enter = true; // play the entrance animation on navigation, not on every data change
const scrolls = {};
const view = $('#view');

const context = () => ({ state: store.get(), ui, today: todayISO(), now: new Date(), rec: recorder.current(), storageFree });

// ---- navigation (Android back button friendly) --------------------------------

const entry = () => ({ tab: ui.tab, page: ui.page, depth });

async function openPage(page) {
  if (ui.page?.type === page.type && ui.page.id === page.id) return;
  await historySettled();
  scrolls[depth] = scrollY;
  depth++;
  ui.page = page;
  history.pushState(entry(), '');
  enter = true;
  scrollTo(0, 0);
  render();
}

/** Swap the current page for another without growing the back stack (e.g. recorder → saved lecture). */
function replacePage(page) {
  ui.page = page;
  history.replaceState(entry(), '');
  enter = true;
  scrollTo(0, 0);
  render();
}

const app = {
  async back() {
    await historySettled(); // a sheet that just closed may still be going back
    if (depth > 0) history.back();
  },
  home() { setTab('today'); },
  newCourse() { openCourseSheet(app); },
  afterCourseAdded(id) { if (ui.page?.type !== 'record') openPage({ type: 'course', id }); },
};

function setTab(tab) {
  if (depth > 0) {
    pendingTab = tab;
    history.go(-depth);
    return;
  }
  if (ui.tab === tab) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = tab;
  history.replaceState(entry(), '');
  enter = true;
  scrollTo(0, 0);
  render();
}

addEventListener('popstate', (e) => {
  const s = e.state;
  if (!s) return;
  ui.tab = s.tab;
  ui.page = s.page;
  depth = s.depth;
  if (pendingTab && depth === 0) {
    ui.tab = pendingTab;
    pendingTab = null;
    history.replaceState(entry(), '');
    scrolls[0] = 0;
  }
  enter = true;
  render();
  scrollTo(0, scrolls[depth] ?? 0);
});

function openRecorder(courseId) {
  if (!recorder.current()) {
    const st = store.get();
    const suggestion = classNow(st.courses.filter((c) => !c.archived));
    const fromTimetable = courseId === undefined && suggestion && suggestion.state !== 'later' ? suggestion.course : null;
    ui.draft = {
      courseId: courseId !== undefined ? courseId : fromTimetable?.id ?? ui.draft.courseId ?? null,
      title: '',
      suggested: fromTimetable ? fromTimetable.name : '',
    };
    if (ui.draft.courseId && !st.courses.some((c) => c.id === ui.draft.courseId)) ui.draft.courseId = null;
    navigator.storage?.estimate?.().then((e) => { storageFree = e.quota - e.usage; if (ui.page?.type === 'record' && !recorder.current()) render(); }).catch(() => {});
  }
  openPage({ type: 'record' });
}

// ---- rendering ------------------------------------------------------------------

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
  $$('meta[name="theme-color"]').forEach((m) => {
    const dark = theme === 'dark' || (theme === 'auto' && m.dataset.dark === '1');
    m.content = dark ? '#000000' : '#f2f2f7';
  });
}

const NAV_RIGHT = {
  settings: `<button type="button" class="icon-btn nav-btn" data-action="settings" aria-label="Settings"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>`,
  more: '<button type="button" class="icon-btn nav-btn" data-action="lecture-menu" aria-label="More actions"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="19" cy="12" r="1.9" fill="currentColor"/></svg></button>',
  edit: '<button type="button" class="link nav-link" data-action="edit-course">Edit</button>',
};

function render() {
  const ctx = context();
  applyTheme(ctx.state.settings.theme);
  const { page } = ui;

  // Keep focus and caret across re-renders (e.g. typing notes while a bookmark is added).
  const f = document.activeElement;
  const keep = f && view.contains(f) && f.id ? { id: f.id, start: f.selectionStart, end: f.selectionEnd } : null;

  view.innerHTML = page?.type === 'lecture' ? lectureView(ctx, page.id)
    : page?.type === 'course' ? courseView(ctx, page.id)
    : page?.type === 'record' ? recordView(ctx)
    : TABS[ui.tab](ctx);
  view.classList.toggle('enter', enter);
  enter = false;
  view.dataset.page = page?.type ?? ui.tab;

  $('#nav-back').hidden = !page;
  $('#nav-title').textContent = $('.large-title', view)?.textContent ?? '';
  const right = page?.type === 'lecture' && ctx.state.lectures.some((l) => l.id === page.id) ? 'more'
    : page?.type === 'course' && page.id && ctx.state.courses.some((c) => c.id === page.id) ? 'edit'
    : page ? '' : 'settings';
  const navRight = $('#nav-right');
  if (navRight.dataset.kind !== right) { navRight.innerHTML = NAV_RIGHT[right] ?? ''; navRight.dataset.kind = right; }

  const activeTab = page?.type === 'record' ? 'record' : ui.tab;
  $$('[data-action="tab"]', $('.tabbar')).forEach((b) => {
    const on = b.dataset.tab === activeTab && !page;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.classList.toggle('on-record', page?.type === 'record');
  document.body.classList.toggle('is-recording', !!ctx.rec);
  renderDock(ctx);

  $$('textarea.notes', view).forEach(autogrow);
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el && !sheetOpen()) {
      el.focus({ preventScroll: true });
      try { if (keep.start !== null && keep.start !== undefined) el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
    }
  }
  if (page?.type === 'record' && ctx.rec) startWave();
}

let dockKey = '';
function renderDock(ctx = context()) {
  const html = dockView(ctx);
  const dock = $('#dock');
  const key = html.replace(/<span class="tnum" data-live="time">.*?<\/span>|<span data-p="cur">.*?<\/span>/g, '');
  if (key !== dockKey) { dock.innerHTML = html; dockKey = key; }
  document.body.classList.toggle('has-dock', !!html);
}

// ---- live parts: recording clock, waveform, player position -------------------------

setInterval(() => {
  const rec = recorder.current();
  if (!rec) return;
  const t = formatClock(recorder.elapsed());
  $$('[data-live="time"]').forEach((el) => { if (el.textContent !== t) el.textContent = t; });
  const meta = $('[data-live="meta"]');
  if (meta) {
    const bits = [formatBytes(rec.size)];
    if (rec.state === 'recording') bits.push(recorder.screenLocked() ? 'Screen stays on' : 'Keep the screen on');
    const text = `${bits.join(' · ')}${recorder.tooQuiet() ? ' · Very quiet — move closer?' : ''}`;
    if (meta.textContent !== text) meta.textContent = text;
    meta.classList.toggle('warn', recorder.tooQuiet());
  }
  const dimTime = $('#dim-time');
  if (dimTime && !$('#dim').hidden) dimTime.textContent = t;
}, 250);

let waving = false;
function startWave() {
  if (waving) return;
  waving = true;
  const draw = () => {
    const canvas = $('#wave');
    const rec = recorder.current();
    if (!canvas || !rec || document.hidden || !$('#dim').hidden) { waving = false; return; }
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const color = getComputedStyle(canvas).color;
    const bar = 3, gap = 2, n = Math.floor(w / (bar + gap));
    const levels = rec.levels.slice(-n);
    g.fillStyle = color;
    levels.forEach((v, i) => {
      const bh = Math.max(3, v * h * 0.95);
      const x = w - (levels.length - i) * (bar + gap);
      g.globalAlpha = 0.35 + 0.65 * (i / levels.length);
      g.beginPath();
      g.roundRect?.(x, (h - bh) / 2, bar, bh, 1.5) ?? g.rect(x, (h - bh) / 2, bar, bh);
      g.fill();
    });
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

let dragging = false;
let lastPlaying = null;
function updatePlayer() {
  const id = player.loadedId();
  const onPage = ui.page?.type === 'lecture' && ui.page.id === id;
  const t = player.time(), d = player.duration(), playing = player.playing();
  if (onPage) {
    const range = $('#p-range');
    if (range && !dragging) {
      if (Number(range.max) !== d && d) range.max = d;
      range.value = t;
      range.setAttribute('aria-valuetext', formatClock(t));
      range.parentElement.style.setProperty('--p', `${d ? (t / d * 100).toFixed(2) : 0}%`);
    }
    if (!dragging) {
      const cur = $('[data-p="cur"]', view), left = $('[data-p="left"]', view);
      if (cur) cur.textContent = formatClock(t);
      if (left) left.textContent = `−${formatClock(Math.max(0, d - t))}`;
    }
  }
  if (playing !== lastPlaying) {
    lastPlaying = playing;
    $$('[data-p="play"]').forEach((b) => {
      const big = b.classList.contains('ctl-play');
      b.innerHTML = playing ? ICON.pause(big ? 30 : 24) : ICON.play(big ? 30 : 24);
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
  }
  renderDock();
  $$('#dock [data-p="cur"]').forEach((el) => { el.textContent = formatClock(t); });
}
player.onChange(updatePlayer);

// ---- dim mode: black screen while recording (saves battery on OLED phones) -----------

function dim(on) {
  $('#dim').hidden = !on;
  document.body.classList.toggle('no-scroll', on);
  if (!on && ui.page?.type === 'record') startWave();
}
$('#dim').addEventListener('click', () => dim(false));

// ---- recording lifecycle ------------------------------------------------------------

recorder.onChange(() => render());
recorder.onSaved(async ({ lecture, error, interrupted }) => {
  dim(false);
  if (error) {
    const ok = await confirmDialog({ title: 'Could not save the recording', message: `${error.message} Download the audio so it is not lost?`, confirmLabel: 'Download' });
    if (ok) downloadBlob(`${error.lecture.title} - ${error.lecture.date}.webm`, error.blob);
    return;
  }
  if (!lecture) { toast('Nothing was recorded'); return; }
  haptic(20);
  if (ui.page?.type === 'record') replacePage({ type: 'lecture', id: lecture.id });
  if (interrupted) confirmDialog({ title: 'Recording stopped', message: `The microphone was taken by another app or a call. The ${formatClock(lecture.durationMs)} recorded so far is saved.`, cancelLabel: null });
  else toast(`Saved · ${formatClock(lecture.durationMs)}`);
});

async function startRecording() {
  const title = $('#rec-title')?.value.trim() || $('#rec-title')?.placeholder || 'Recording';
  player.pause();
  try {
    await recorder.start({ courseId: ui.draft.courseId, title });
    haptic(25);
  } catch (err) {
    confirmDialog({ title: 'Cannot record', message: recorder.explain(err), cancelLabel: null });
  }
}

async function stopRecording() {
  const rec = recorder.current();
  if (!rec) return;
  const ok = await confirmDialog({ title: 'Stop and save?', message: `${rec.title} · ${formatClock(recorder.elapsed())}`, confirmLabel: 'Stop & save' });
  if (ok) await recorder.stop();
}

// ---- events -------------------------------------------------------------------------

const lectureId = () => (ui.page?.type === 'lecture' ? ui.page.id : null);

/** Inserts "[12:34] " at the caret of a notes field and saves it. */
function insertStamp(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const id = lectureId();
  const ms = targetId === 'rec-notes' ? recorder.elapsed() : player.loadedId() === id ? player.time() : store.lecture(id)?.position ?? 0;
  const stamp = `[${formatClock(ms)}] `;
  const at = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, at);
  const insert = (before && !before.endsWith('\n') ? '\n' : '') + stamp;
  el.setRangeText(insert, at, el.selectionEnd ?? at, 'end');
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('.backdrop, .alert-backdrop') || el.disabled) return;
  const { action, id, value, tab, kind } = el.dataset;
  const st = store.get();
  switch (action) {
    case 'tab': setTab(tab); break;
    case 'back': app.back(); break;
    case 'settings': openSettings(app); break;
    case 'new-course': openCourseSheet(app); break;
    case 'edit-course': openCourseSheet(app, { id: id ?? ui.page?.id }); break;
    case 'open-course': openPage({ type: 'course', id: id || null }); break;
    case 'open-lecture': {
      await openPage({ type: 'lecture', id });
      if (el.dataset.at) player.seek(Math.max(0, Number(el.dataset.at) - 3000), id).catch(() => {});
      break;
    }
    case 'record': openRecorder(id === undefined ? undefined : id || null); break;
    case 'show-review': ui.filter = 'review'; ui.query = ''; setTab('library'); break;
    case 'filter': ui.filter = value; render(); break;
    case 'prev-week': ui.weekStart = addDays(ui.weekStart, -7); enter = true; render(); break;
    case 'next-week': ui.weekStart = addDays(ui.weekStart, 7); enter = true; render(); break;
    case 'this-week': ui.weekStart = startOfWeek(todayISO()); enter = true; render(); break;

    // recorder
    case 'draft-course': {
      ui.draft.courseId = id || null;
      ui.draft.title = $('#rec-title')?.value ?? '';
      haptic();
      render();
      break;
    }
    case 'rec-start': startRecording(); break;
    case 'rec-pause': if (recorder.current()?.state === 'paused') recorder.resume(); else recorder.pause(); haptic(15); break;
    case 'rec-stop': stopRecording(); break;
    case 'rec-dim': dim(true); break;
    case 'rec-mark': {
      haptic(15);
      if (kind === 'note') { openBookmarkSheet({ live: true, t: recorder.elapsed(), kind }); break; }
      const b = recorder.addBookmark(kind, '');
      if (b) toast(`${el.textContent.trim()} · ${formatClock(b.t)}`, { ms: 1800 });
      break;
    }
    case 'rec-unmark': recorder.removeBookmark(id); break;
    case 'stamp': insertStamp(el.dataset.target); break;

    // player & lecture
    case 'p-toggle': player.toggle(id).catch(() => toast('The audio could not be played')); break;
    case 'p-skip': {
      const lid = lectureId();
      if (player.loadedId() === lid) player.skip(Number(value));
      else player.seek(store.lecture(lid).position + Number(value), lid).catch(() => toast('The audio could not be played'));
      break;
    }
    case 'p-rate': {
      const next = SPEEDS[(SPEEDS.indexOf(st.settings.speed) + 1) % SPEEDS.length];
      player.setRate(next);
      el.textContent = `${next}×`;
      break;
    }
    case 'p-jump': player.jump(lectureId(), Number(value)).catch(() => toast('The audio could not be played')); break;
    case 'p-mark': {
      const lid = lectureId();
      const t = player.loadedId() === lid ? player.time() : store.lecture(lid).position;
      openBookmarkSheet({ lectureId: lid, t, kind: 'important' });
      break;
    }
    case 'p-close': player.unload(); break;
    case 'edit-bm': openBookmarkSheet({ lectureId: lectureId(), bookmarkId: id }); break;
    case 'toggle-reviewed': { const l = store.lecture(lectureId()); store.updateLecture(l.id, { reviewed: !l.reviewed }); haptic(); break; }
    case 'toggle-star': { const l = store.lecture(lectureId()); store.updateLecture(l.id, { starred: !l.starred }); haptic(); break; }
    case 'lecture-menu': openLectureMenu(app, lectureId()); break;
    default: break;
  }
});

// Cards that act as buttons (role="button") should respond to Enter / Space.
document.addEventListener('keydown', (e) => {
  const el = e.target.closest?.('[role="button"][data-action]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); }
});

const saveNotes = debounce((id, notes) => {
  store.updateLecture(id, { notes }, { silent: true });
  const s = $('#notes-status');
  if (s) s.textContent = 'Saved';
}, 600);
const saveRecDetails = debounce(() => recorder.setDetails({}, { flush: true }), 1500);

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'search') { ui.query = t.value; $('#library-list').innerHTML = libraryList(context()); }
  if (t.id === 'rec-title') {
    if (recorder.current()) { recorder.setDetails({ title: t.value }); saveRecDetails(); }
    else ui.draft.title = t.value;
  }
  if (t.id === 'rec-notes') { recorder.setDetails({ notes: t.value }); saveRecDetails(); }
  if (t.id === 'notes') {
    const id = lectureId();
    const l = store.lecture(id);
    if (l) l.notes = t.value; // keep the in-memory copy current so a re-render never shows older text
    const s = $('#notes-status');
    if (s) s.textContent = 'Saving…';
    saveNotes(id, t.value);
    const stamps = $('#note-stamps');
    if (stamps && store.lecture(id)?.hasAudio) stamps.innerHTML = stampChips(t.value);
  }
  if (t.id === 'p-range') {
    dragging = true;
    const d = Number(t.max), v = Number(t.value);
    $('[data-p="cur"]', view).textContent = formatClock(v);
    $('[data-p="left"]', view).textContent = `−${formatClock(Math.max(0, d - v))}`;
    t.parentElement.style.setProperty('--p', `${d ? (v / d * 100).toFixed(2) : 0}%`);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'p-range') {
    dragging = false;
    player.seek(Number(e.target.value), lectureId()).catch(() => toast('The audio could not be played'));
  }
});

// Leaving a notes field: save straight away.
document.addEventListener('focusout', (e) => {
  if (e.target.id === 'notes' && lectureId()) saveNotes.flush(lectureId(), e.target.value);
  if (e.target.id === 'rec-notes' || e.target.id === 'rec-title') saveRecDetails.flush();
});

// Frosted nav bar: fades the small title in once the large title scrolls away.
const nav = $('#nav');
const onScroll = () => {
  nav.classList.toggle('scrolled', scrollY > 6);
  nav.classList.toggle('show-title', scrollY > 44);
};
addEventListener('scroll', onScroll, { passive: true });

// Keep "Happening now" fresh, but never re-render under someone's typing.
const quietRender = () => { if (!document.hidden && !sheetOpen() && !view.contains(document.activeElement)) render(); };
document.addEventListener('visibilitychange', quietRender);
setInterval(quietRender, 60_000);

// ---- start -----------------------------------------------------------------------------

store.subscribe(() => render());
store.onError((err) => {
  console.error(err);
  toast(err?.name === 'QuotaExceededError' ? 'Your phone is out of space — free some up or remove old audio.' : 'Could not save a change.');
});

history.replaceState(entry(), '');
view.innerHTML = '<p class="footnote">Loading…</p>';
try {
  await store.init();
  render();
  onScroll();
  if (!store.get().onboarded) openOnboarding(app);
  else if (location.hash === '#record') openRecorder(); // home-screen shortcut
  const n = await store.recoverSessions();
  if (n) toast(`Recovered ${n} unfinished recording${n === 1 ? '' : 's'}`, { ms: 6000 });
} catch (err) {
  console.error(err);
  view.innerHTML = `<div class="empty"><div class="empty-emoji" aria-hidden="true">⚠️</div><h3>Lectern cannot open its storage</h3><p>${esc(err?.message || 'Storage is unavailable in this browser mode.')} Private/incognito tabs cannot keep recordings.</p></div>`;
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
