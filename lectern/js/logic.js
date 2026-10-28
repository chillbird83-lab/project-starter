// Pure organiser logic — no DOM, no storage — so it can be unit-tested in Node (tests/lectern.test.js).

export const pad2 = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const fromISO = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayISO = () => toISO(new Date());
export const addDays = (iso, n) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
};
/** First day of the week containing `iso` (weekStart: 0 = Sunday, 1 = Monday). */
export const startOfWeek = (iso, weekStart = 1) => addDays(iso, -((fromISO(iso).getDay() - weekStart + 7) % 7));
export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---- constants ---------------------------------------------------------------

export const BOOKMARK_KINDS = {
  important: { label: 'Important', emoji: '⭐', color: '#ff9500' },
  exam: { label: 'Exam', emoji: '🎯', color: '#ff3b30' },
  question: { label: 'Question', emoji: '❓', color: '#af52de' },
  note: { label: 'Note', emoji: '📌', color: '#007aff' },
};

/** Opus bitrates. Speech stays clear at 32 kbps — about 14 MB per hour. */
export const QUALITY = {
  saver: { label: 'Saver', bps: 16000 },
  standard: { label: 'Standard', bps: 32000 },
  high: { label: 'High', bps: 64000 },
};
export const bytesPerHour = (quality) => (QUALITY[quality] ?? QUALITY.standard).bps / 8 * 3600;

export const COURSE_EMOJIS = ['📘', '📗', '📙', '📕', '📓', '📔', '📒', '🧪', '📐', '💻'];
export const COURSE_COLORS = ['#007aff', '#34c759', '#ff9500', '#ff2d55', '#af52de', '#5856d6', '#30b0c7', '#ffcc00', '#a2845e', '#ff3b30'];
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_SETTINGS = { theme: 'auto', quality: 'standard', noiseReduction: true, speed: 1 };

// ---- formatting --------------------------------------------------------------

/** Player-style clock: "4:05", "12:05", "1:02:03". */
export function formatClock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** Human length: "1 h 24 min", "45 min", "<1 min". */
export function formatLength(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 1) return ms > 0 ? '<1 min' : '0 min';
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** "09:15" → 555 (minutes after midnight), or null when invalid. */
export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/** Timestamps typed into notes, like [12:30] or [1:02:03] → milliseconds, in order of appearance. */
export function parseStamps(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g)) {
    const [, h, min, s] = m;
    if (+s > 59 || (h !== undefined && +min > 59)) continue;
    const ms = ((+(h ?? 0) * 60 + +min) * 60 + +s) * 1000;
    if (!out.includes(ms)) out.push(ms);
  }
  return out;
}

// ---- timetable ---------------------------------------------------------------

const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();

/** Class slots on an ISO date, sorted by start: [{ course, slot, start, end }] (minutes after midnight). */
export function classesOn(courses, iso) {
  const day = fromISO(iso).getDay();
  return courses
    .filter((c) => !c.archived)
    .flatMap((course) => (course.slots ?? []).filter((s) => s.day === day).map((slot) => ({ course, slot, start: parseTime(slot.start), end: parseTime(slot.end) })))
    .filter((x) => x.start !== null && x.end !== null)
    .sort((a, b) => a.start - b.start || a.course.name.localeCompare(b.course.name));
}

/**
 * The class to suggest right now: one in progress ('now'), one starting within `early` minutes ('soon'),
 * else the next one later today ('later'). Null when nothing is left today.
 */
export function classNow(courses, now = new Date(), early = 15) {
  const t = minutesOf(now);
  const today = classesOn(courses, toISO(now));
  const live = today.find((c) => t >= c.start && t < c.end) ?? today.find((c) => t >= c.start - early && t < c.start);
  if (live) return { ...live, state: t < live.start ? 'soon' : 'now', minutesTo: Math.max(0, live.start - t) };
  const next = today.find((c) => c.start > t);
  return next ? { ...next, state: 'later', minutesTo: next.start - t } : null;
}

/** The next time this course meets, from `now` on (within a week): { date, slot, start, end } or null. */
export function nextClass(course, now = new Date()) {
  const today = toISO(now), t = minutesOf(now);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    const hit = classesOn([course], date).find((c) => i > 0 || c.end > t);
    if (hit) return { date, slot: hit.slot, start: hit.start, end: hit.end };
  }
  return null;
}

/** Seven days from `weekStart`, each with its classes and whether each one has a recording that day. */
export function weekPlan(state, weekStart, today = todayISO()) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    const classes = classesOn(state.courses, date).map((c) => ({
      ...c, recorded: state.lectures.some((l) => l.courseId === c.course.id && l.date === date),
    }));
    return { date, isToday: date === today, isPast: date < today, classes };
  });
}

// ---- lectures ----------------------------------------------------------------

export const byNewest = (a, b) => b.startedAt - a.startedAt;

/** Suggested title for the next recording of a course: "Lecture 4". */
export function nextTitle(lectures, courseId) {
  const own = lectures.filter((l) => l.courseId === courseId);
  const highest = Math.max(0, ...own.map((l) => +(/^Lecture (\d+)$/.exec(l.title)?.[1] ?? 0)));
  return `Lecture ${Math.max(own.length, highest) + 1}`;
}

export function courseStats(lectures, courseId) {
  const own = lectures.filter((l) => l.courseId === courseId);
  return {
    count: own.length,
    totalMs: own.reduce((s, l) => s + l.durationMs, 0),
    toReview: own.filter((l) => !l.reviewed).length,
    bookmarks: own.reduce((s, l) => s + l.bookmarks.length, 0),
  };
}

/** Started listening but not finished. */
export const inProgress = (l) => l.hasAudio && l.position > 0 && l.position < l.durationMs - 10_000;

function excerpt(text, at, len, radius = 36) {
  const from = Math.max(0, at - radius), to = Math.min(text.length, at + len + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/**
 * Filters and searches lectures. Every word of the query must appear somewhere in the title, course name,
 * notes or bookmark labels. Returns [{ lecture, snippet, at }] newest first — `at` is a bookmark time to jump to.
 */
export function searchLectures(state, query = '', filter = 'all') {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const courseName = (id) => state.courses.find((c) => c.id === id)?.name ?? '';
  return state.lectures
    .filter((l) => filter === 'all' || (filter === 'review' && !l.reviewed) || (filter === 'starred' && l.starred))
    .map((l) => {
      if (!terms.length) return { lecture: l, snippet: '' };
      const hay = [l.title, courseName(l.courseId), l.notes, ...l.bookmarks.map((b) => b.label)].join('\n').toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return null;
      const head = `${l.title}\n${courseName(l.courseId)}`.toLowerCase();
      const rest = terms.filter((t) => !head.includes(t));
      if (!rest.length) return { lecture: l, snippet: '' };
      const b = l.bookmarks.find((x) => rest.some((t) => x.label.toLowerCase().includes(t)));
      if (b) return { lecture: l, snippet: `${formatClock(b.t)} · ${b.label}`, at: b.t };
      const notes = l.notes.toLowerCase();
      const t = rest.find((x) => notes.includes(x));
      return { lecture: l, snippet: t ? excerpt(l.notes, notes.indexOf(t), t.length) : '' };
    })
    .filter(Boolean)
    .sort((a, b) => byNewest(a.lecture, b.lecture));
}

/** Groups items by "YYYY-MM" of `dateOf(item)`, keeping their order: [{ month, items }]. */
export function groupByMonth(items, dateOf) {
  const groups = [];
  for (const item of items) {
    const month = dateOf(item).slice(0, 7);
    if (groups.at(-1)?.month !== month) groups.push({ month, items: [] });
    groups.at(-1).items.push(item);
  }
  return groups;
}

// ---- validation (storage & backup import) ------------------------------------

const str = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const num = (v, fallback = 0) => (Number.isFinite(v) && v >= 0 ? v : fallback);

export function sanitizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
    quality: s.quality in QUALITY ? s.quality : DEFAULT_SETTINGS.quality,
    noiseReduction: typeof s.noiseReduction === 'boolean' ? s.noiseReduction : DEFAULT_SETTINGS.noiseReduction,
    speed: SPEEDS.includes(s.speed) ? s.speed : DEFAULT_SETTINGS.speed,
  };
}

export function sanitizeSlot(s) {
  if (!s || !Number.isInteger(s.day) || s.day < 0 || s.day > 6) return null;
  const a = parseTime(s.start), b = parseTime(s.end);
  if (a === null || b === null || b <= a) return null;
  return { day: s.day, start: s.start.padStart(5, '0'), end: s.end.padStart(5, '0') };
}

export function sanitizeCourse(c) {
  if (!c || typeof c !== 'object' || !c.id || typeof c.name !== 'string' || !c.name.trim()) return null;
  return {
    id: String(c.id),
    name: c.name.trim().slice(0, 50),
    emoji: str(c.emoji, 8, '📘') || '📘',
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : COURSE_COLORS[0],
    lecturer: str(c.lecturer, 60),
    room: str(c.room, 40),
    slots: (Array.isArray(c.slots) ? c.slots : []).map(sanitizeSlot).filter(Boolean).slice(0, 14),
    archived: !!c.archived,
    createdAt: num(c.createdAt, Date.now()),
  };
}

export function sanitizeLecture(l, courseIds) {
  if (!l || typeof l !== 'object' || !l.id || !isISODate(l.date)) return null;
  return {
    id: String(l.id),
    courseId: courseIds.has(l.courseId) ? l.courseId : null,
    title: str(l.title, 80).trim() || 'Recording',
    date: l.date,
    startedAt: num(l.startedAt, fromISO(l.date).getTime()),
    durationMs: num(l.durationMs),
    size: num(l.size),
    mime: str(l.mime, 60, 'audio/webm') || 'audio/webm',
    hasAudio: !!l.hasAudio,
    bookmarks: (Array.isArray(l.bookmarks) ? l.bookmarks : [])
      .filter((b) => b && Number.isFinite(b.t) && b.t >= 0)
      .map((b) => ({ id: String(b.id ?? `${b.t}`), t: Math.round(b.t), kind: b.kind in BOOKMARK_KINDS ? b.kind : 'note', label: str(b.label, 80) }))
      .sort((a, b) => a.t - b.t),
    notes: str(l.notes, 50_000),
    reviewed: !!l.reviewed,
    starred: !!l.starred,
    position: num(l.position),
    playedAt: num(l.playedAt),
  };
}

/** Accepts parsed backup data and returns { courses, lectures, settings }, or null if it is not Lectern data. */
export function sanitizeData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.courses) || !Array.isArray(raw.lectures)) return null;
  const courses = raw.courses.map(sanitizeCourse).filter(Boolean);
  const ids = new Set(courses.map((c) => c.id));
  return {
    courses,
    lectures: raw.lectures.map((l) => sanitizeLecture(l, ids)).filter(Boolean),
    settings: sanitizeSettings(raw.settings),
  };
}

/** File extension for a recorder MIME type. */
export const extFor = (mime = '') => (/mp4|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');

/** A safe, readable file name: "Calculus - Lecture 4 - 2026-10-28.webm". */
export function fileNameFor(lecture, courseName = '') {
  const base = [courseName, lecture.title, lecture.date].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base.slice(0, 120)}.${extFor(lecture.mime)}`;
}
