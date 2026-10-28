// App state for whoever is signed in, kept in sync with the backend.
import { DEFAULT_SETTINGS } from './score.js';

let backend = null;
let state = { ready: false, niches: [], channels: [], videos: [], settings: { ...DEFAULT_SETTINGS }, telegram: { linked: false } };
const listeners = new Set();

export const get = () => state;
export const api = () => backend;
export const subscribe = (fn) => listeners.add(fn);
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };

export async function connect(b) {
  backend = b;
  set({ ready: false });
  const data = await b.load();
  set({ ready: true, ...data, settings: sanitizeSettings(data.settings) });
}

export function disconnect() {
  backend = null;
  set({ ready: false, niches: [], channels: [], videos: [], settings: { ...DEFAULT_SETTINGS }, telegram: { linked: false } });
}

export function sanitizeSettings(s = {}) {
  const n = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    ...DEFAULT_SETTINGS,
    onboarded: !!s.onboarded,
    threshold: n(s.threshold, 1.5, 100, 3),
    minViews: Math.round(n(s.minViews, 0, 1e9, 1000)),
    includeShorts: s.includeShorts !== false,
    alerts: s.alerts !== false,
    ...(backend?.mode === 'local' ? {
      youtubeKey: String(s.youtubeKey ?? '').trim(), geminiKey: String(s.geminiKey ?? '').trim(), geminiModel: String(s.geminiModel ?? '').trim(),
    } : {}),
  };
}

export async function saveSettings(patch) {
  const settings = sanitizeSettings({ ...state.settings, ...patch });
  await backend.saveSettings(settings);
  set({ settings });
  return settings;
}

/** Merges fresh channels/videos from an add or refresh into the state. */
function merge({ channels = [], videos = [] }) {
  const chIds = new Set(channels.map((c) => c.id));
  const vIds = new Set(videos.map((v) => v.id));
  set({
    channels: [...state.channels.filter((c) => !chIds.has(c.id)), ...channels],
    videos: [...state.videos.filter((v) => !vIds.has(v.id)), ...videos],
  });
}

export async function addChannel(input, nicheId) {
  const r = await backend.addChannel(input, nicheId);
  merge({ channels: [r.channel], videos: r.videos });
  return r;
}

export async function refresh(channelId, opts) {
  const r = await backend.refresh(channelId, opts);
  merge(r);
  return r;
}

export async function analyse(videoId, force) {
  const r = await backend.analyse(videoId, force);
  set({ videos: state.videos.map((v) => (v.id === videoId ? { ...v, analysis: r.analysis, analysedAt: r.analysedAt } : v)) });
  return r.analysis;
}

export async function setSaved(videoId, saved) {
  set({ videos: state.videos.map((v) => (v.id === videoId ? { ...v, saved } : v)) });
  try { await backend.setSaved(videoId, saved); } catch (e) {
    set({ videos: state.videos.map((v) => (v.id === videoId ? { ...v, saved: !saved } : v)) });
    throw e;
  }
}

export async function saveNiche(niche) {
  const n = await backend.saveNiche(niche);
  set({ niches: [...state.niches.filter((x) => x.id !== n.id), n] });
  return n;
}

export async function deleteNiche(id) {
  await backend.deleteNiche(id);
  set({
    niches: state.niches.filter((n) => n.id !== id),
    channels: state.channels.map((c) => (c.nicheId === id ? { ...c, nicheId: null } : c)),
    videos: state.videos.filter((v) => v.channelId || v.nicheId !== id),
  });
}

/** Searches YouTube for the niche's outliers and merges what it finds. */
export async function scanNiche(id) {
  const r = await backend.scanNiche(id);
  merge({ videos: r.videos });
  set({ niches: state.niches.map((n) => (n.id === id ? { ...n, ...r.niche } : n)) });
  return r;
}

export async function moveChannel(id, nicheId) {
  await backend.moveChannel(id, nicheId);
  set({ channels: state.channels.map((c) => (c.id === id ? { ...c, nicheId } : c)) });
}

export async function deleteChannel(id) {
  await backend.deleteChannel(id);
  set({ channels: state.channels.filter((c) => c.id !== id), videos: state.videos.filter((v) => v.channelId !== id) });
}

export const setTelegram = (telegram) => set({ telegram });
