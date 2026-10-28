// App state. Courses, lectures and settings live in memory (the views read them synchronously) and are
// written through to IndexedDB in the order they changed. Audio is only read from disk when needed.
import * as db from './db.js';
import { DEFAULT_SETTINGS, extFor, fileNameFor, sanitizeCourse, sanitizeData, sanitizeLecture, sanitizeSettings } from './logic.js';
import { makeZip, readZip } from './zip.js';

let state = { settings: { ...DEFAULT_SETTINGS }, onboarded: false, courses: [], lectures: [] };
const subscribers = new Set();
let errorHandler = (e) => console.error(e);
let queue = Promise.resolve();

export const get = () => state;
export const subscribe = (fn) => (subscribers.add(fn), () => subscribers.delete(fn));
export const onError = (fn) => { errorHandler = fn; };
const notify = () => subscribers.forEach((fn) => fn(state));

/** Runs writes one after another; the returned promise rejects if this write fails. */
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}
/** Fire-and-forget write: failures are reported through the error handler. */
const persist = (fn) => enqueue(fn).catch((e) => errorHandler(e));

export async function init() {
  const r = await db.run(['kv', 'courses', 'lectures'], 'readonly', (s) => ({
    settings: s.kv.get('settings'), onboarded: s.kv.get('onboarded'), courses: s.courses.getAll(), lectures: s.lectures.getAll(),
  }));
  const courses = r.courses.map(sanitizeCourse).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  const ids = new Set(courses.map((c) => c.id));
  state = {
    settings: sanitizeSettings(r.settings),
    onboarded: !!r.onboarded,
    courses,
    lectures: r.lectures.map((l) => sanitizeLecture(l, ids)).filter(Boolean),
  };
  notify();
}

// ---- settings ----------------------------------------------------------------

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  notify();
  const settings = { ...state.settings };
  persist(() => db.run('kv', 'readwrite', (s) => s.kv.put(settings, 'settings')));
}

export function markOnboarded() {
  state.onboarded = true;
  notify();
  persist(() => db.run('kv', 'readwrite', (s) => s.kv.put(true, 'onboarded')));
}

// ---- courses -----------------------------------------------------------------

export function saveCourse(course) {
  const i = state.courses.findIndex((c) => c.id === course.id);
  if (i >= 0) state.courses[i] = course;
  else state.courses.push(course);
  notify();
  persist(() => db.run('courses', 'readwrite', (s) => s.courses.put(course)));
}

/** Deletes a course; its recordings stay and become "No course". */
export function deleteCourse(id) {
  const moved = state.lectures.filter((l) => l.courseId === id);
  moved.forEach((l) => { l.courseId = null; });
  state.courses = state.courses.filter((c) => c.id !== id);
  notify();
  persist(() => db.run(['courses', 'lectures'], 'readwrite', (s) => {
    s.courses.delete(id);
    moved.forEach((l) => s.lectures.put(l));
  }));
}

// ---- lectures ----------------------------------------------------------------

export const lecture = (id) => state.lectures.find((l) => l.id === id);

/** `silent` skips re-rendering — used for notes and the playback position, which the page already shows. */
export function updateLecture(id, patch, { silent = false } = {}) {
  const l = lecture(id);
  if (!l) return;
  Object.assign(l, patch);
  if (!silent) notify();
  persist(() => db.run('lectures', 'readwrite', (s) => s.lectures.put(l)));
}

export function deleteLecture(id) {
  state.lectures = state.lectures.filter((l) => l.id !== id);
  notify();
  persist(() => db.run(['lectures', 'audio'], 'readwrite', (s) => { s.lectures.delete(id); s.audio.delete(id); }));
}

/** Frees space: deletes the audio but keeps notes and bookmarks. */
export function removeAudio(id) {
  updateLecture(id, { hasAudio: false, size: 0, position: 0 });
  persist(() => db.run('audio', 'readwrite', (s) => s.audio.delete(id)));
}

export async function getAudio(id) {
  await queue; // a recording that was just saved must be on disk before it is read back
  return db.run('audio', 'readonly', (s) => s.audio.get(id));
}

// ---- recording sessions --------------------------------------------------------

const sessionKey = (id) => `session:${id}`;
const clearSession = (id) => db.run(['kv', 'chunks'], 'readwrite', (s) => {
  s.kv.delete(sessionKey(id));
  s.chunks.delete(db.sessionRange(id));
});

export const sessionLock = (id) => `lectern-recording-${id}`;
export const saveSession = (meta) => persist(() => db.run('kv', 'readwrite', (s) => s.kv.put(meta, sessionKey(meta.id))));
export const saveChunk = (id, seq, blob) => persist(() => db.run('chunks', 'readwrite', (s) => s.chunks.put(blob, [id, seq])));
export const discardSession = (id) => persist(() => clearSession(id));

/** Stores a finished recording as a lecture, then clears its in-progress chunks. Rejects if it could not be saved. */
export async function finishSession(lec, blob) {
  await enqueue(() => db.run(['lectures', 'audio'], 'readwrite', (s) => {
    s.audio.put(blob, lec.id);
    s.lectures.put(lec);
  }));
  state.lectures.push(lec);
  notify();
  persist(() => clearSession(lec.id));
  persistStorage();
}

/**
 * Turns recordings that were cut off (app closed, phone restarted, browser crashed) into lectures from
 * the chunks saved so far. A recording still running in another tab holds its Web Lock and is skipped
 * (without Web Locks, anything saved in the last 20 s counts as still running).
 */
export async function recoverSessions() {
  const keys = await db.run('kv', 'readonly', (s) => s.kv.getAllKeys());
  const ids = new Set(state.courses.map((c) => c.id));
  const held = navigator.locks ? new Set((await navigator.locks.query()).held.map((l) => l.name)) : null;
  let recovered = 0;
  for (const key of keys.filter((k) => typeof k === 'string' && k.startsWith('session:'))) {
    const id = key.slice(8);
    const meta = await db.run('kv', 'readonly', (s) => s.kv.get(key));
    if (held ? held.has(sessionLock(id)) : meta?.updatedAt > Date.now() - 20_000) continue;
    if (!meta || lecture(id)) { await clearSession(id); continue; }
    const chunks = await db.run('chunks', 'readonly', (s) => s.chunks.getAll(db.sessionRange(id)));
    if (!chunks.length) { await clearSession(id); continue; }
    const blob = new Blob(await Promise.all(chunks.map((c) => c.arrayBuffer())), { type: meta.mime });
    const lec = sanitizeLecture({ ...meta, hasAudio: true, size: blob.size }, ids);
    if (!lec) { await clearSession(id); continue; }
    await finishSession(lec, blob);
    recovered++;
  }
  return recovered;
}

/** Asks the browser not to clear Lectern's storage when the phone runs low on space. */
export async function persistStorage() {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; }
  catch { return false; }
}

// ---- backup ------------------------------------------------------------------

/** A ZIP with lectern.json (courses, lectures, notes, bookmarks) and every recording as a playable file. */
export async function exportBackup(onProgress) {
  const audio = {}, files = [], used = new Set();
  for (const l of state.lectures.filter((x) => x.hasAudio)) {
    const blob = await getAudio(l.id);
    if (!blob) continue;
    let name = `audio/${fileNameFor(l, state.courses.find((c) => c.id === l.courseId)?.name)}`;
    for (let n = 2; used.has(name); n++) name = name.replace(/( \(\d+\))?(\.\w+)$/, ` (${n})$2`);
    used.add(name);
    audio[l.id] = name;
    files.push({ name, data: blob, date: new Date(l.startedAt) });
  }
  const data = { app: 'lectern', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, courses: state.courses, lectures: state.lectures, audio };
  return makeZip([{ name: 'lectern.json', data: JSON.stringify(data, null, 2) }, ...files], { onProgress });
}

/** Merges a backup into this phone: anything already here is kept, everything new is added. */
export async function importBackup(file) {
  const entries = await readZip(file);
  const json = entries.get('lectern.json');
  if (!json) throw new Error('This file is not a Lectern backup.');
  const raw = JSON.parse(await json.text());
  const data = sanitizeData(raw);
  if (!data) throw new Error('This file is not a Lectern backup.');
  const haveCourse = new Set(state.courses.map((c) => c.id));
  const courses = data.courses.filter((c) => !haveCourse.has(c.id));
  const lectures = data.lectures.filter((l) => !lecture(l.id));
  await enqueue(() => db.run('courses', 'readwrite', (s) => courses.forEach((c) => s.courses.put(c))));
  state.courses.push(...courses);
  for (const l of lectures) {
    const src = entries.get(raw.audio?.[l.id] ?? `audio/${l.id}.${extFor(l.mime)}`);
    l.hasAudio = !!src;
    l.size = src?.size ?? 0;
    const blob = src && new Blob([await src.arrayBuffer()], { type: l.mime });
    await enqueue(() => db.run(['lectures', 'audio'], 'readwrite', (s) => {
      if (blob) s.audio.put(blob, l.id);
      s.lectures.put(l);
    }));
    state.lectures.push(l);
  }
  notify();
  return { courses: courses.length, lectures: lectures.length };
}

export async function eraseAll() {
  await enqueue(() => db.run(['kv', 'courses', 'lectures', 'audio', 'chunks'], 'readwrite', (s) => {
    Object.values(s).forEach((store) => store.clear());
    s.kv.put(true, 'onboarded');
  }));
  state = { settings: { ...DEFAULT_SETTINGS }, onboarded: true, courses: [], lectures: [] };
  notify();
}
