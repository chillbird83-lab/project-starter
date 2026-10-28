// Microphone recording: pause/resume, bookmarks and notes while recording, a live input level, a screen
// wake lock, and crash safety — audio is written to disk every few seconds, so an interrupted recording
// can be recovered on the next launch (store.recoverSessions).
import { QUALITY, toISO } from './logic.js';
import * as store from './store.js';
import { uid } from './util.js';

const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
const SLICE_MS = 5000;
const LEVELS = 160; // ~16 s of level history for the waveform

export const supported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

let rec = null;
const listeners = new Set();
let savedHandler = () => {};
export const current = () => rec;
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
/** Called after every stop — including ones the recorder makes itself when the microphone is lost. */
export const onSaved = (fn) => { savedHandler = fn; };
const emit = () => listeners.forEach((fn) => fn(rec));

/** Recorded time in ms (paused time is not part of the audio, so it is not counted). */
export const elapsed = (r = rec) => (r ? r.acc + (r.state === 'recording' ? performance.now() - r.segStart : 0) : 0);

const meta = (r) => ({
  id: r.id, courseId: r.courseId, title: r.title, date: r.date, startedAt: r.startedAt, mime: r.mime,
  bookmarks: r.bookmarks, notes: r.notes, durationMs: Math.round(elapsed(r)), size: r.size, updatedAt: Date.now(),
});

/** Turns a getUserMedia / MediaRecorder failure into advice the user can act on. */
export function explain(err) {
  switch (err?.name) {
    case 'NotAllowedError': case 'SecurityError':
      return 'Lectern is not allowed to use the microphone. In Chrome, tap the icon left of the address (or ⋮ → Site settings) and allow Microphone.';
    case 'NotFoundError': case 'OverconstrainedError': return 'No microphone was found on this device.';
    case 'NotReadableError': case 'AbortError': return 'The microphone is busy — close any call or other recording app and try again.';
    default: return `Recording could not start${err?.message ? `: ${err.message}` : '.'}`;
  }
}

export async function start({ courseId, title }) {
  if (rec) return rec;
  const { quality, noiseReduction } = store.get().settings;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: noiseReduction, autoGainControl: true, channelCount: 1 },
  });
  let mr;
  try {
    const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    mr = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: QUALITY[quality].bps });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const now = new Date();
  const r = {
    id: uid(), courseId, title, date: toISO(now), startedAt: now.getTime(), mime: mr.mimeType || 'audio/webm',
    bookmarks: [], notes: '', state: 'recording', acc: 0, segStart: performance.now(),
    size: 0, seq: 0, chunks: [], levels: [], stream, mr, wake: null, audioCtx: null, timer: 0, unlock: null,
  };
  rec = r;
  // Held for as long as this tab records. The browser drops it if the tab dies, which tells
  // store.recoverSessions that the recording was cut off rather than still running elsewhere.
  navigator.locks?.request(store.sessionLock(r.id), () => new Promise((resolve) => { r.unlock = resolve; })).catch(() => {});
  store.saveSession(meta(r));

  mr.ondataavailable = (e) => {
    if (!e.data?.size) return;
    r.chunks.push(e.data);
    r.size += e.data.size;
    store.saveChunk(r.id, r.seq++, e.data);
    store.saveSession(meta(r));
  };
  // A phone call or another app can take the microphone away: keep what we have.
  mr.onerror = () => { if (rec === r) stop({ interrupted: true }); };
  stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (rec === r) stop({ interrupted: true }); });

  mr.start(SLICE_MS);
  startMeter(r);
  lockScreen(r);
  emit();
  return r;
}

export function pause() {
  const r = rec;
  if (r?.state !== 'recording') return;
  r.mr.pause();
  r.acc += performance.now() - r.segStart;
  r.state = 'paused';
  r.mr.requestData();
  emit();
}

export function resume() {
  const r = rec;
  if (r?.state !== 'paused') return;
  r.mr.resume();
  r.segStart = performance.now();
  r.state = 'recording';
  emit();
}

export function addBookmark(kind, label, t = elapsed()) {
  if (!rec) return null;
  const b = { id: uid(), t: Math.round(t), kind, label };
  rec.bookmarks.push(b);
  rec.bookmarks.sort((a, c) => a.t - c.t);
  store.saveSession(meta(rec));
  emit();
  return b;
}

export function removeBookmark(id) {
  if (!rec) return;
  rec.bookmarks = rec.bookmarks.filter((b) => b.id !== id);
  store.saveSession(meta(rec));
  emit();
}

/** Title / course / notes edits while recording. Saved with the next chunk, or right away when `flush`. */
export function setDetails(patch, { flush = false } = {}) {
  if (!rec) return;
  Object.assign(rec, patch);
  if (flush) store.saveSession(meta(rec));
}

/**
 * Stops and saves, then reports to the onSaved handler: { lecture } on success, { lecture: null } if nothing
 * was recorded, or { error } — with the audio as `error.blob`, so it can still be downloaded — if saving
 * failed (phone storage full). `interrupted` is set when the recorder stopped by itself.
 */
export async function stop({ interrupted = false } = {}) {
  const r = rec;
  if (!r || r.state === 'saving') return null;
  if (r.state === 'recording') r.acc += performance.now() - r.segStart;
  r.state = 'saving';
  emit();
  await new Promise((resolve) => {
    if (r.mr.state === 'inactive') return resolve();
    r.mr.addEventListener('stop', resolve, { once: true });
    r.mr.stop();
  });
  release(r);
  const blob = new Blob(r.chunks, { type: r.mime });
  rec = null;
  if (!blob.size) {
    store.discardSession(r.id);
    emit();
    savedHandler({ lecture: null, interrupted });
    return null;
  }
  const lecture = {
    id: r.id, courseId: r.courseId, title: r.title.trim() || 'Recording', date: r.date, startedAt: r.startedAt,
    durationMs: Math.round(r.acc), size: blob.size, mime: r.mime, hasAudio: true,
    bookmarks: r.bookmarks, notes: r.notes, reviewed: false, starred: false, position: 0, playedAt: 0,
  };
  try {
    await store.finishSession(lecture, blob);
  } catch (e) {
    emit();
    savedHandler({ error: Object.assign(new Error('The recording could not be saved — your phone may be out of space.'), { blob, lecture, cause: e }), interrupted });
    return null;
  }
  emit();
  savedHandler({ lecture, interrupted });
  return lecture;
}

// ---- level meter & wake lock -------------------------------------------------

function startMeter(r) {
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(r.stream).connect(analyser);
    ctx.resume?.();
    const buf = new Float32Array(analyser.fftSize);
    r.audioCtx = ctx;
    r.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
      const level = r.state === 'recording' ? Math.min(1, Math.max(0, (db + 60) / 50)) : 0;
      r.levels.push(level);
      if (r.levels.length > LEVELS) r.levels.shift();
    }, 100);
  } catch { /* the level meter is a nicety; recording works without it */ }
}

/** True when the last ~8 s were almost silent — the phone may be too far from the speaker. */
export function tooQuiet(r = rec) {
  if (!r || r.state !== 'recording' || r.levels.length < 80) return false;
  const recent = r.levels.slice(-80);
  return recent.reduce((s, v) => s + v, 0) / recent.length < 0.06;
}

async function lockScreen(r) {
  try {
    r.wake = await navigator.wakeLock?.request('screen');
  } catch { r.wake = null; }
}

// Android releases the wake lock when the app is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (rec && !document.hidden && rec.state !== 'saving' && (!rec.wake || rec.wake.released)) lockScreen(rec);
});

export const screenLocked = () => !!rec?.wake && !rec.wake.released;

function release(r) {
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  r.audioCtx?.close().catch(() => {});
  r.wake?.release().catch(() => {});
  r.wake = null;
  r.unlock?.();
}

addEventListener('beforeunload', (e) => {
  if (rec) { e.preventDefault(); e.returnValue = ''; }
});
