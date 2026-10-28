// Screen renderers. Each takes a context { state, ui, today, now, rec } and returns an HTML string.
import {
  BOOKMARK_KINDS, DAYS, byNewest, bytesPerHour, classNow, courseStats, formatBytes, formatClock, formatLength,
  groupByMonth, inProgress, nextClass, nextTitle, parseStamps, searchLectures, startOfWeek, addDays, weekPlan,
} from './logic.js';
import * as fmt from './format.js';
import * as player from './player.js';
import { elapsed, supported } from './recorder.js';
import { esc } from './util.js';

export const NO_COURSE = { id: null, name: 'No course', emoji: '🎙️', color: '#8e8e93', slots: [] };
export const courseOf = (state, id) => state.courses.find((c) => c.id === id) ?? NO_COURSE;

const svg = (body, size = 22, sw = 2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  play: (s = 30) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" fill="currentColor"/></svg>`,
  pause: (s = 30) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor"/></svg>`,
  back: (n) => `${svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 3.8v4.6h4.6"/>', 30, 1.8)}<b>${n}</b>`,
  fwd: (n) => `${svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.8v4.6h-4.6"/>', 30, 1.8)}<b>${n}</b>`,
  bookmark: svg('<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/><path d="M12 7.5v5M9.5 10h5"/>', 24, 1.8),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', 18, 1.8),
  chev: '<svg class="chev" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/>', 17, 2.2),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18, 2.4),
};

const ico = (c, cls = '') => `<span class="ico ${cls}" style="--c:${esc(c.color)}" aria-hidden="true">${esc(c.emoji)}</span>`;
const pill = (kind, text) => `<span class="pill pill-${kind}">${esc(text)}</span>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;

function emptyState(emoji, title, text, action = '') {
  return `<div class="empty"><div class="empty-emoji" aria-hidden="true">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

function lectureRow(ctx, l, { showCourse = true, snippet = '', at } = {}) {
  const c = courseOf(ctx.state, l.courseId);
  const sub = [showCourse && c.id ? c.name : '', fmt.dayMonth(l.date), formatClock(l.durationMs)].filter(Boolean).join(' · ');
  const n = l.bookmarks.length;
  const progress = inProgress(l) ? l.position / l.durationMs : 0;
  return `<button type="button" class="row lec" data-action="open-lecture" data-id="${esc(l.id)}"${at !== undefined ? ` data-at="${at}"` : ''}>
    ${ico(c)}
    <span class="grow"><span class="title">${esc(l.title)}</span><span class="sub">${esc(sub)}</span>${snippet ? `<span class="sub snippet">${esc(snippet)}</span>` : ''}
      ${progress ? `<span class="meter slim" aria-label="${Math.round(progress * 100)}% listened"><i class="fill" style="width:${(progress * 100).toFixed(1)}%"></i></span>` : ''}</span>
    <span class="badges">${l.starred ? '<span class="star" title="Starred">★</span>' : ''}${n ? `<span class="bm-count" title="${plural(n, 'bookmark')}">🔖${n}</span>` : ''}${l.reviewed ? '' : '<span class="dot" title="Not reviewed yet"></span>'}${l.hasAudio ? '' : '<span class="muted small">no audio</span>'}</span>
  </button>`;
}

function slotRow(ctx, x, date) {
  const { course } = x;
  const nowMin = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  const over = date < ctx.today || (date === ctx.today && nowMin >= x.end);
  const live = date === ctx.today && nowMin >= x.start && nowMin < x.end;
  const status = x.recorded ? pill('ok', 'Recorded') : live ? pill('live', 'Now') : over ? pill('neutral', 'Not recorded') : '';
  const sub = [course.room, course.lecturer].filter(Boolean).join(' · ');
  return `<button type="button" class="row slot ${over && !x.recorded ? 'is-over' : ''}" data-action="open-course" data-id="${esc(course.id)}">
    <span class="slot-time"><b>${fmt.hm(x.start)}</b><small>${fmt.hm(x.end)}</small></span>
    <span class="slot-bar" style="--c:${esc(course.color)}" aria-hidden="true"></span>
    <span class="grow"><span class="title">${esc(course.emoji)} ${esc(course.name)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
    ${status}
  </button>`;
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function classCard(ctx) {
  const { state, now } = ctx;
  const active = state.courses.filter((c) => !c.archived);
  if (!active.length) {
    return `<article class="card hero-card">
      <span class="eyebrow">Get organised</span>
      <h2 class="hero-title">Add your courses</h2>
      <p class="muted">Add each course with its weekly times. When you tap record, Lectern picks the class you are in and names the recording for you.</p>
      <div class="hero-actions"><button type="button" class="btn primary" data-action="new-course">Add a course</button>
      <button type="button" class="btn secondary" data-action="record">Just record</button></div>
    </article>`;
  }
  const c = classNow(active, now);
  if (!c) {
    return `<article class="card hero-card">
      <span class="eyebrow">Today</span>
      <h2 class="hero-title">No more classes today</h2>
      <p class="muted">Recordings you make now go to the course you pick.</p>
      <div class="hero-actions"><button type="button" class="btn rec" data-action="record"><span class="rec-ico"></span>Record</button></div>
    </article>`;
  }
  const eyebrow = c.state === 'now' ? 'Happening now' : c.state === 'soon' ? `Starts in ${c.minutesTo} min` : `Next class · in ${formatLength(c.minutesTo * 60000)}`;
  const where = [`${fmt.hm(c.start)}–${fmt.hm(c.end)}`, c.course.room, c.course.lecturer].filter(Boolean).join(' · ');
  return `<article class="card hero-card class-now" style="--c:${esc(c.course.color)}">
    <span class="eyebrow ${c.state !== 'later' ? 'live' : ''}">${esc(eyebrow)}</span>
    <div class="class-line">${ico(c.course, 'big')}<div class="grow"><h2 class="hero-title">${esc(c.course.name)}</h2><p class="muted">${esc(where)}</p></div></div>
    <div class="hero-actions"><button type="button" class="btn rec" data-action="record" data-id="${esc(c.course.id)}"><span class="rec-ico"></span>Record ${esc(c.course.name)}</button></div>
  </article>`;
}

function recordingCard(ctx) {
  const { rec, state } = ctx;
  const c = courseOf(state, rec.courseId);
  return `<article class="card hero-card is-recording" role="button" tabindex="0" data-action="record">
    <span class="eyebrow live">${rec.state === 'paused' ? 'Paused' : 'Recording'}</span>
    <div class="class-line">${ico(c, 'big')}<div class="grow"><h2 class="hero-title">${esc(rec.title)}</h2><p class="muted">${esc(c.name)} · <span data-live="time">${formatClock(elapsed(rec))}</span></p></div>${ICON.chev}</div>
  </article>`;
}

export function todayView(ctx) {
  const { state, today } = ctx;
  const head = `<header class="screen-head"><div><h1 class="large-title">Today</h1><p class="subtitle">${esc(fmt.dateLong(today))}</p></div></header>`;
  const parts = [head, ctx.rec ? recordingCard(ctx) : classCard(ctx)];

  const classes = weekPlan(state, today, today)[0].classes;
  if (classes.length) {
    parts.push(`<h2 class="section-title">Classes today</h2><section class="card list">${classes.map((x) => slotRow(ctx, x, today)).join('')}</section>`);
  }
  const listening = state.lectures.filter(inProgress).sort((a, b) => b.playedAt - a.playedAt).slice(0, 3);
  if (listening.length) {
    parts.push(`<h2 class="section-title">Continue listening</h2><section class="card list">${listening.map((l) => lectureRow(ctx, l)).join('')}</section>`);
  }
  const review = state.lectures.filter((l) => !l.reviewed).sort(byNewest);
  if (review.length) {
    parts.push(`<div class="section-row"><h2 class="section-title">To review</h2>${review.length > 5 ? `<button type="button" class="link" data-action="show-review">See all ${review.length}</button>` : ''}</div>
      <p class="section-note">Mark a recording as reviewed once you have gone through it.</p>
      <section class="card list">${review.slice(0, 5).map((l) => lectureRow(ctx, l)).join('')}</section>`);
  } else if (state.lectures.length) {
    parts.push(`<p class="footnote">✅ You are all caught up — every recording is reviewed.</p>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

function nextLabel(ctx, course) {
  const n = nextClass(course, ctx.now);
  if (!n) return course.slots.length ? '' : 'No weekly times yet';
  const day = n.date === ctx.today ? 'Today' : n.date === addDays(ctx.today, 1) ? 'Tomorrow' : fmt.weekday(n.date);
  return `Next: ${day} ${fmt.hm(n.start)}`;
}

function courseCard(ctx, c) {
  const s = courseStats(ctx.state.lectures, c.id);
  const facts = [plural(s.count, 'recording'), s.totalMs ? formatLength(s.totalMs) : '', s.toReview ? `${s.toReview} to review` : ''].filter(Boolean).join(' · ');
  const next = nextLabel(ctx, c);
  return `<article class="card course-card" role="button" tabindex="0" data-action="open-course" data-id="${esc(c.id)}" style="--c:${esc(c.color)}">
    ${ico(c, 'big')}
    <div class="grow"><h3>${esc(c.name)}</h3>${c.lecturer ? `<p class="muted small">${esc(c.lecturer)}</p>` : ''}
      <p class="course-facts">${esc(facts)}</p>${next ? `<p class="course-next ${c.slots.length ? '' : 'muted'}">${esc(next)}</p>` : ''}</div>
    ${ICON.chev}
  </article>`;
}

export function coursesView(ctx) {
  const { state } = ctx;
  const head = `<header class="screen-head"><div><h1 class="large-title">Courses</h1><p class="subtitle">${state.courses.length ? 'Your recordings, by course' : 'Organise recordings by course'}</p></div>
    <button type="button" class="chip-btn solid" data-action="new-course">＋ New</button></header>`;
  const active = state.courses.filter((c) => !c.archived), archived = state.courses.filter((c) => c.archived);
  const loose = state.lectures.filter((l) => !l.courseId);
  if (!state.courses.length && !loose.length) {
    return `${head}${emptyState('📚', 'Add your courses', 'Give each course a colour and its weekly times. Lectern then files every recording under the right course and builds your week.',
      '<button type="button" class="btn primary" data-action="new-course">Add your first course</button>')}`;
  }
  return `${head}
    ${active.map((c) => courseCard(ctx, c)).join('')}
    ${loose.length ? `<article class="card course-card" role="button" tabindex="0" data-action="open-course" data-id="" style="--c:#8e8e93">${ico(NO_COURSE, 'big')}<div class="grow"><h3>No course</h3><p class="course-facts">${plural(loose.length, 'recording')}</p></div>${ICON.chev}</article>` : ''}
    ${archived.length ? `<h2 class="section-title">Archived</h2><p class="section-note">Hidden from Today and Week. Recordings stay in the Library.</p>${archived.map((c) => courseCard(ctx, c)).join('')}` : ''}`;
}

export function courseView(ctx, id) {
  const { state } = ctx;
  const c = id ? state.courses.find((x) => x.id === id) : NO_COURSE;
  if (!c) return emptyState('🤷', 'Course not found', 'It may have been deleted.');
  const lectures = state.lectures.filter((l) => l.courseId === (id || null)).sort(byNewest);
  const s = courseStats(state.lectures, id || null);
  const sub = [c.lecturer, c.room].filter(Boolean).join(' · ');
  const slots = [...c.slots].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || a.start.localeCompare(b.start));
  return `<header class="course-hero" style="--c:${esc(c.color)}">
      ${ico(c, 'huge')}
      <h1 class="large-title">${esc(c.name)}</h1>
      ${sub ? `<p class="subtitle">${esc(sub)}</p>` : ''}
      ${c.archived ? `<p class="hero-pill">${pill('neutral', 'Archived')}</p>` : ''}
    </header>
    <dl class="card stats">
      <div><dt>Recordings</dt><dd>${s.count}</dd></div>
      <div><dt>Total</dt><dd>${s.totalMs ? esc(formatLength(s.totalMs)) : '—'}</dd></div>
      <div><dt>To review</dt><dd>${s.toReview}</dd></div>
    </dl>
    <button type="button" class="btn rec" data-action="record" data-id="${esc(id ?? '')}"><span class="rec-ico"></span>Record${id ? ` ${esc(c.name)}` : ''}</button>
    ${id ? `<h2 class="section-title">Weekly times</h2>
    ${slots.length ? `<section class="card list">${slots.map((sl) => `<div class="row"><span class="grow title">${DAYS[sl.day]}</span><span class="muted">${esc(sl.start)}–${esc(sl.end)}</span></div>`).join('')}</section>`
      : `<p class="section-note">No times yet. <button type="button" class="link inline" data-action="edit-course" data-id="${esc(id)}">Add them</button> so Lectern can pick this course when you record.</p>`}` : ''}
    <h2 class="section-title">Recordings</h2>
    ${lectures.length ? `<section class="card list">${lectures.map((l) => lectureRow(ctx, l, { showCourse: false })).join('')}</section>`
      : '<p class="section-note">Nothing recorded yet.</p>'}`;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function libraryList(ctx) {
  const { state, ui } = ctx;
  const results = searchLectures(state, ui.query, ui.filter);
  if (!state.lectures.length) {
    return emptyState('🎙️', 'No recordings yet', 'Tap the red button to record your first lecture. You can add bookmarks and notes while it records.');
  }
  if (!results.length) {
    return `<p class="footnote">${ui.query ? `Nothing matches “${esc(ui.query)}”.` : ui.filter === 'review' ? 'Nothing left to review. 🎉' : 'No starred recordings yet — star the important ones.'}</p>`;
  }
  return groupByMonth(results, (r) => r.lecture.date).map((g) => `<div class="group">
    <h3 class="group-title"><span>${esc(fmt.monthYear(g.month))}</span><span>${g.items.length}</span></h3>
    <section class="card list">${g.items.map((r) => lectureRow(ctx, r.lecture, { snippet: r.snippet, at: r.at })).join('')}</section>
  </div>`).join('');
}

export function libraryView(ctx) {
  const { state, ui } = ctx;
  const total = state.lectures.reduce((s, l) => s + l.durationMs, 0);
  const filters = [['all', 'All'], ['review', 'To review'], ['starred', 'Starred']];
  return `<header class="screen-head"><div><h1 class="large-title">Library</h1><p class="subtitle">${plural(state.lectures.length, 'recording')}${total ? ` · ${esc(formatLength(total))}` : ''}</p></div></header>
    <label class="search">${ICON.search}<span class="sr-only">Search recordings</span>
      <input id="search" type="search" placeholder="Search titles, notes, bookmarks" value="${esc(ui.query)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="seg" role="group" aria-label="Filter">${filters.map(([v, t]) => `<button type="button" class="${ui.filter === v ? 'on' : ''}" aria-pressed="${ui.filter === v}" data-action="filter" data-value="${v}">${t}</button>`).join('')}</div>
    <div id="library-list">${libraryList(ctx)}</div>`;
}

// ---------------------------------------------------------------------------
// Week (timetable)
// ---------------------------------------------------------------------------

export function weekView(ctx) {
  const { state, ui, today } = ctx;
  const current = startOfWeek(today);
  const title = ui.weekStart === current ? 'This Week' : ui.weekStart === addDays(current, 7) ? 'Next Week' : ui.weekStart === addDays(current, -7) ? 'Last Week' : 'Week';
  const nav = `<div class="week-nav" role="group" aria-label="Choose week">
    <button type="button" class="icon-btn" data-action="prev-week" aria-label="Previous week"><svg viewBox="0 0 10 16" width="10" height="16"><path d="M8 1L2 8l6 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    ${ui.weekStart !== current ? '<button type="button" class="chip-btn" data-action="this-week">Today</button>' : ''}
    <button type="button" class="icon-btn" data-action="next-week" aria-label="Next week"><svg viewBox="0 0 10 16" width="10" height="16"><path d="M2 1l6 7-6 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>`;
  const head = `<header class="screen-head"><div><h1 class="large-title">${title}</h1><p class="subtitle">${esc(fmt.range(ui.weekStart, addDays(ui.weekStart, 6)))}</p></div>${nav}</header>`;
  if (!state.courses.some((c) => !c.archived && c.slots.length)) {
    return `${head}${emptyState('🗓️', 'Build your timetable', 'Add weekly times to your courses and your week appears here — with a tick for every class you recorded.',
      `<button type="button" class="btn primary" data-action="${state.courses.length ? 'tab' : 'new-course'}" data-tab="courses">${state.courses.length ? 'Go to courses' : 'Add a course'}</button>`)}`;
  }
  const days = weekPlan(state, ui.weekStart, today);
  const done = days.flatMap((d) => d.classes).filter((x) => x.recorded).length;
  const all = days.flatMap((d) => d.classes).length;
  return `${head}
    <p class="week-summary">${done} of ${plural(all, 'class')} recorded</p>
    ${days.filter((d) => d.classes.length || d.isToday).map((d) => `<div class="group ${d.isToday ? 'is-today' : ''}">
      <h3 class="group-title"><span>${d.isToday ? 'Today · ' : ''}${esc(fmt.dateLong(d.date))}</span></h3>
      ${d.classes.length ? `<section class="card list">${d.classes.map((x) => slotRow(ctx, x, d.date)).join('')}</section>` : '<p class="section-note">No classes.</p>'}
    </div>`).join('')}
    <p class="footnote">Times come from each course — tap a class to see its recordings.</p>`;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export function recordView(ctx) {
  const { state, ui, rec } = ctx;
  if (!supported()) {
    return emptyState('🚫', 'Recording is not available here', 'This browser cannot record audio. Open Lectern in Chrome on your Android phone.');
  }
  if (!rec) {
    const draft = ui.draft;
    const chips = [...state.courses.filter((c) => !c.archived), NO_COURSE].map((c) => {
      const on = (c.id ?? null) === draft.courseId;
      return `<button type="button" class="chip ${on ? 'on' : ''}" data-action="draft-course" data-id="${esc(c.id ?? '')}" style="--c:${esc(c.color)}" aria-pressed="${on}"><span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.name)}</button>`;
    }).join('');
    const hours = ctx.storageFree ? Math.floor(ctx.storageFree / bytesPerHour(state.settings.quality)) : null;
    return `<header class="screen-head"><div><h1 class="large-title">New recording</h1><p class="subtitle">${draft.suggested ? `${esc(draft.suggested)} · from your timetable` : 'Pick a course and tap record'}</p></div></header>
      <h3 class="mini-title">Course</h3>
      <div class="chips">${chips}</div>
      <div class="card list inset"><label class="row field"><span class="title">Title</span><input id="rec-title" maxlength="80" value="${esc(draft.title)}" placeholder="${esc(nextTitle(state.lectures, draft.courseId))}" enterkeyhint="done"></label></div>
      <div class="rec-stage">
        <button type="button" class="rec-btn" data-action="rec-start" aria-label="Start recording"><i></i></button>
        <p class="rec-hint">Tap to start recording</p>
      </div>
      <ul class="tips">
        <li>The screen stays on while recording — keep Lectern open. Tap <b>Dim</b> to save battery.</li>
        <li>Put the phone face up, as close to the lecturer as you can.</li>
        ${hours !== null ? `<li>Space for about <b>${hours > 999 ? '999+' : hours} hours</b> at ${esc(state.settings.quality)} quality.</li>` : ''}
      </ul>`;
  }

  const c = courseOf(state, rec.courseId);
  const marks = [...rec.bookmarks].reverse();
  return `<div class="rec-live state-${rec.state}">
    <div class="rec-course" style="--c:${esc(c.color)}">${ico(c)}<div class="grow"><span class="sub">${esc(c.name)}</span>
      <input id="rec-title" class="rec-title-input" maxlength="80" value="${esc(rec.title)}" aria-label="Title" enterkeyhint="done"></div></div>
    <div class="rec-status"><span class="rec-dot" aria-hidden="true"></span><span>${rec.state === 'saving' ? 'Saving…' : rec.state === 'paused' ? 'Paused' : 'Recording'}</span></div>
    <div class="rec-time" data-live="time" role="timer" aria-live="off">${formatClock(elapsed(rec))}</div>
    <canvas id="wave" class="wave" aria-hidden="true"></canvas>
    <p class="rec-meta" data-live="meta">${esc(formatBytes(rec.size))}</p>
    <div class="rec-controls">
      <button type="button" class="ctl" data-action="rec-dim" ${rec.state === 'saving' ? 'disabled' : ''}><span aria-hidden="true">🌙</span>Dim</button>
      <button type="button" class="ctl-big" data-action="rec-pause" ${rec.state === 'saving' ? 'disabled' : ''} aria-label="${rec.state === 'paused' ? 'Resume' : 'Pause'}">${rec.state === 'paused' ? '<span class="rec-ico"></span>' : ICON.pause(34)}</button>
      <button type="button" class="ctl stop" data-action="rec-stop" ${rec.state === 'saving' ? 'disabled' : ''}><span class="stop-ico" aria-hidden="true"></span>Stop</button>
    </div>
    <h3 class="mini-title">Bookmark this moment</h3>
    <div class="bm-grid">${Object.entries(BOOKMARK_KINDS).map(([k, b]) => `<button type="button" class="bm-btn" data-action="rec-mark" data-kind="${k}" style="--c:${b.color}" ${rec.state === 'saving' ? 'disabled' : ''}><span aria-hidden="true">${b.emoji}</span>${esc(b.label)}${k === 'note' ? '…' : ''}</button>`).join('')}</div>
    ${marks.length ? `<section class="card list rec-marks">${marks.map((b) => `<div class="row bm-row"><span class="bm-ico" style="--c:${BOOKMARK_KINDS[b.kind].color}" aria-hidden="true">${BOOKMARK_KINDS[b.kind].emoji}</span><span class="grow title">${esc(b.label || BOOKMARK_KINDS[b.kind].label)}</span><span class="muted tnum">${formatClock(b.t)}</span><button type="button" class="icon-btn subtle" data-action="rec-unmark" data-id="${esc(b.id)}" aria-label="Remove bookmark">${ICON.close}</button></div>`).join('')}</section>` : ''}
    <h3 class="mini-title">Notes</h3>
    <div class="card notes-card"><textarea id="rec-notes" class="notes" placeholder="Type notes while you listen…  Tap ⏱ to add the current time." aria-label="Notes">${esc(rec.notes)}</textarea>
      <div class="notes-tools"><button type="button" class="chip-btn" data-action="stamp" data-target="rec-notes">⏱ Insert time</button></div></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export function stampChips(text) {
  const stamps = parseStamps(text);
  return stamps.length ? `<span class="muted small">Jump to</span>${stamps.slice(0, 30).map((t) => `<button type="button" class="chip-btn" data-action="p-jump" data-value="${t}">${formatClock(t)}</button>`).join('')}` : '';
}

export function lectureView(ctx, id) {
  const { state } = ctx;
  const l = state.lectures.find((x) => x.id === id);
  if (!l) return emptyState('🤷', 'Recording not found', 'It may have been deleted.');
  const c = courseOf(state, l.courseId);
  const loaded = player.loadedId() === id;
  const t = loaded ? player.time() : l.position;
  const d = loaded ? player.duration() : l.durationMs;
  const playing = loaded && player.playing();
  const speed = state.settings.speed;

  const playerCard = l.hasAudio ? `<section class="card player" aria-label="Player">
      <div class="scrub" style="--p:${d ? (t / d * 100).toFixed(2) : 0}%">
        <input type="range" id="p-range" min="0" max="${d}" step="1000" value="${t}" aria-label="Position" aria-valuetext="${formatClock(t)}">
        <div class="ticks" aria-hidden="true">${l.bookmarks.map((b) => `<i style="left:${d ? Math.min(100, b.t / d * 100).toFixed(2) : 0}%;--c:${BOOKMARK_KINDS[b.kind].color}"></i>`).join('')}</div>
      </div>
      <div class="times"><span data-p="cur">${formatClock(t)}</span><span data-p="left">−${formatClock(Math.max(0, d - t))}</span></div>
      <div class="controls">
        <button type="button" class="ctl-sm" data-action="p-rate" aria-label="Playback speed">${speed}×</button>
        <button type="button" class="ctl-skip" data-action="p-skip" data-value="-15000" aria-label="Back 15 seconds">${ICON.back(15)}</button>
        <button type="button" class="ctl-play" data-action="p-toggle" data-id="${esc(id)}" aria-label="${playing ? 'Pause' : 'Play'}" data-p="play">${playing ? ICON.pause() : ICON.play()}</button>
        <button type="button" class="ctl-skip" data-action="p-skip" data-value="30000" aria-label="Forward 30 seconds">${ICON.fwd(30)}</button>
        <button type="button" class="ctl-sm" data-action="p-mark" aria-label="Add bookmark here">${ICON.bookmark}</button>
      </div>
    </section>` : `<section class="card"><p class="muted">🔇 The audio of this recording was removed to free up space. Its notes and bookmarks are kept.</p></section>`;

  const bms = l.bookmarks.length
    ? `<section class="card list">${l.bookmarks.map((b) => {
      const k = BOOKMARK_KINDS[b.kind];
      return `<div class="row bm-row"><button type="button" class="bm-main" data-action="p-jump" data-value="${b.t}" ${l.hasAudio ? '' : 'disabled'}>
        <span class="bm-ico" style="--c:${k.color}" aria-hidden="true">${k.emoji}</span><span class="grow"><span class="title">${esc(b.label || k.label)}</span></span><span class="tnum bm-time">${formatClock(b.t)}</span></button>
        <button type="button" class="icon-btn subtle" data-action="edit-bm" data-id="${esc(b.id)}" aria-label="Edit bookmark">${ICON.pencil}</button></div>`;
    }).join('')}</section>`
    : `<p class="section-note">${l.hasAudio ? 'Tap 🔖 in the player to mark a moment you want to find again.' : 'No bookmarks.'}</p>`;

  return `<header class="lec-head">
      <button type="button" class="course-chip" data-action="open-course" data-id="${esc(c.id ?? '')}" style="--c:${esc(c.color)}"><span aria-hidden="true">${esc(c.emoji)}</span>${esc(c.name)}</button>
      <h1 class="large-title lec-title">${esc(l.title)}</h1>
      <p class="subtitle">${esc(fmt.dateLong(l.date))} · ${esc(fmt.clockTime(l.startedAt))} · ${esc(formatLength(l.durationMs))}${l.size ? ` · ${esc(formatBytes(l.size))}` : ''}</p>
    </header>
    ${playerCard}
    <div class="toggles">
      <button type="button" class="toggle ${l.reviewed ? 'on ok' : ''}" data-action="toggle-reviewed" aria-pressed="${l.reviewed}">${l.reviewed ? '✓ Reviewed' : '○ Mark reviewed'}</button>
      <button type="button" class="toggle ${l.starred ? 'on star' : ''}" data-action="toggle-star" aria-pressed="${l.starred}">${l.starred ? '★ Starred' : '☆ Star'}</button>
    </div>
    <div class="section-row"><h2 class="section-title">Bookmarks</h2>${l.bookmarks.length ? `<span class="muted">${l.bookmarks.length}</span>` : ''}</div>
    ${bms}
    <h2 class="section-title">Notes</h2>
    <div class="card notes-card">
      <textarea id="notes" class="notes" placeholder="Summary, key points, questions for the tutorial…  Type [12:30] or tap ⏱ to link a moment." aria-label="Notes">${esc(l.notes)}</textarea>
      <div class="notes-tools">${l.hasAudio ? '<button type="button" class="chip-btn" data-action="stamp" data-target="notes">⏱ Insert time</button>' : ''}<span class="notes-status muted small" id="notes-status"></span></div>
      <div class="stamps" id="note-stamps">${l.hasAudio ? stampChips(l.notes) : ''}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Dock: recording banner / mini player above the tab bar
// ---------------------------------------------------------------------------

export function dockView(ctx) {
  const { rec, state, ui } = ctx;
  if (rec && ui.page?.type !== 'record') {
    return `<button type="button" class="dock-bar is-rec" data-action="record"><span class="rec-dot" aria-hidden="true"></span>
      <span class="grow"><span class="title">${rec.state === 'paused' ? 'Paused' : 'Recording'} · ${esc(rec.title)}</span></span><span class="tnum" data-live="time">${formatClock(elapsed(rec))}</span></button>`;
  }
  const id = player.loadedId();
  const l = id && state.lectures.find((x) => x.id === id);
  if (!l || (ui.page?.type === 'lecture' && ui.page.id === id) || ui.page?.type === 'record') return '';
  const c = courseOf(state, l.courseId);
  const playing = player.playing();
  return `<div class="dock-bar">
    <button type="button" class="dock-open" data-action="open-lecture" data-id="${esc(id)}">${ico(c)}<span class="grow"><span class="title">${esc(l.title)}</span><span class="sub">${esc(c.name)} · <span data-p="cur">${formatClock(player.time())}</span></span></span></button>
    <button type="button" class="icon-btn plain" data-action="p-toggle" data-id="${esc(id)}" data-p="play" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICON.pause(24) : ICON.play(24)}</button>
    <button type="button" class="icon-btn plain" data-action="p-close" aria-label="Close player">${ICON.close}</button>
  </div>`;
}
