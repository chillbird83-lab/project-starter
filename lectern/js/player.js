// One shared audio element, so playback keeps going while you move around the app (and with the screen
// off). Remembers where you stopped in each lecture and drives the lock-screen controls (Media Session).
import * as store from './store.js';

const audio = new Audio();
audio.preload = 'auto';
let cur = null; // { id, url, durationMs, start, loaded, ready: Promise }
let lastSave = 0;
const listeners = new Set();

export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn());

export const loadedId = () => cur?.id ?? null;
export const playing = () => !!cur && !audio.paused;
export const time = () => (cur ? (cur.loaded ? Math.round(audio.currentTime * 1000) : cur.start) : 0);
export const duration = () => {
  const d = audio.duration;
  return cur ? (Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : cur.durationMs) : 0;
};

/**
 * Recorder WebM files have no duration in their header, which breaks seeking. Asking for a far-away
 * position makes the browser scan the file once and learn the real length.
 */
function fixDuration() {
  return new Promise((resolve) => {
    const done = () => { audio.removeEventListener('durationchange', check); resolve(); };
    const check = () => { if (Number.isFinite(audio.duration)) { audio.currentTime = 0; done(); } };
    const go = () => {
      if (Number.isFinite(audio.duration)) return resolve();
      audio.addEventListener('durationchange', check);
      audio.currentTime = 1e101;
      setTimeout(done, 4000);
    };
    if (audio.readyState >= 1) go();
    else {
      audio.addEventListener('loadedmetadata', go, { once: true });
      audio.addEventListener('error', () => resolve(), { once: true });
    }
  });
}

/** Loads a lecture's audio (no-op if it is already loaded). Rejects if the audio is missing. */
export async function load(id) {
  if (cur?.id === id) return cur.ready;
  const lec = store.lecture(id);
  const blob = lec?.hasAudio ? await store.getAudio(id) : null;
  if (!blob) throw new Error('Audio not found');
  unload();
  const start = lec.position > 0 && lec.position < lec.durationMs - 5000 ? lec.position : 0;
  const c = { id, url: URL.createObjectURL(blob), durationMs: lec.durationMs, start, loaded: false };
  cur = c;
  audio.src = c.url;
  audio.playbackRate = store.get().settings.speed;
  c.ready = fixDuration().then(() => {
    if (cur !== c) return;
    if (start) audio.currentTime = start / 1000;
    c.loaded = true;
    emit();
  });
  updateSession(lec);
  emit();
  return cur.ready;
}

export function unload() {
  if (!cur) return;
  savePosition(true);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  URL.revokeObjectURL(cur.url);
  cur = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  emit();
}

export async function play(id = cur?.id) {
  if (!id) return;
  await load(id);
  audio.playbackRate = store.get().settings.speed;
  try { await audio.play(); } catch { /* interrupted by a pause or a new load */ }
}

export const pause = () => audio.pause();
export const toggle = (id) => (cur?.id === id && !audio.paused ? pause() : play(id));

export async function seek(ms, id = cur?.id) {
  if (!id) return;
  await load(id);
  audio.currentTime = Math.max(0, Math.min(duration(), ms)) / 1000;
  savePosition(true);
  emit();
}

export const skip = (deltaMs) => cur && seek(time() + deltaMs);

/** Jumps to a moment and plays, starting a few seconds early so you hear the lead-in. */
export async function jump(id, ms, leadMs = 3000) {
  await seek(Math.max(0, ms - leadMs), id);
  await play(id);
}

export function setRate(rate) {
  audio.playbackRate = rate;
  store.updateSettings({ speed: rate });
}

function savePosition(force = false) {
  if (!cur?.loaded) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const lec = store.lecture(cur.id);
  if (!lec) return;
  const t = time();
  store.updateLecture(cur.id, { position: t >= duration() - 1000 ? 0 : t, playedAt: now }, { silent: true });
}

function updateSession(lec) {
  if (!('mediaSession' in navigator)) return;
  const course = store.get().courses.find((c) => c.id === lec.courseId);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: lec.title, artist: course?.name ?? 'Lectern', album: 'Lectern',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* MediaMetadata not supported */ }
}

function updatePositionState() {
  if (!cur || !navigator.mediaSession?.setPositionState) return;
  const d = duration() / 1000;
  if (!(d > 0)) return;
  try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, audio.currentTime), playbackRate: audio.playbackRate }); }
  catch { /* ignore */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => play(), pause, stop: unload,
    seekbackward: (e) => skip(-(e.seekOffset ?? 15) * 1000),
    seekforward: (e) => skip((e.seekOffset ?? 30) * 1000),
    seekto: (e) => seek(e.seekTime * 1000),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

audio.addEventListener('timeupdate', () => { savePosition(); emit(); });
audio.addEventListener('play', () => { updatePositionState(); emit(); });
audio.addEventListener('pause', () => { savePosition(true); emit(); });
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('durationchange', updatePositionState);
audio.addEventListener('ended', () => { savePosition(true); emit(); });
addEventListener('pagehide', () => savePosition(true));
