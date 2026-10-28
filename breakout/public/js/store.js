// App state for whoever is signed in, kept in sync with the backend.
import { LANGUAGES, defaultLanguage } from './lang.js';
import { DEFAULT_SETTINGS } from './score.js';
import { cleanDismissed } from './similar.js';

let backend = null;
const EMPTY = { niches: [], channels: [], videos: [], ideas: [], similar: null, reportSummary: null, settings: { ...DEFAULT_SETTINGS }, telegram: { linked: false } };
let state = { ready: false, ...EMPTY };
const listeners = new Set();

export const get = () => state;
export const api = () => backend;
export const subscribe = (fn) => listeners.add(fn);
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };

export async function connect(b) {
  backend = b;
  set({ ready: false });
  const data = await b.load();
  set({ ready: true, ...EMPTY, ...data, ideas: data.ideas ?? [], settings: sanitizeSettings(data.settings) });
  // Settings from before the language filter: save the default so niche searches use it too.
  if (data.settings.onboarded && !data.settings.language) await saveSettings({}).catch(() => {});
}

export function disconnect() {
  backend = null;
  set({ ready: false, ...EMPTY });
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
    language: LANGUAGES.some(([c]) => c === s.language) ? s.language : defaultLanguage(),
    hideMixed: s.hideMixed !== false,
    hideLanguages: [...new Set((Array.isArray(s.hideLanguages) ? s.hideLanguages : []).filter((c) => c !== 'any' && LANGUAGES.some(([x]) => x === c)))],
    weeklyReport: s.weeklyReport !== false,
    dismissedChannels: cleanDismissed(s.dismissedChannels),
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

/** Fresh view counts for recent candidates (this-device mode; the Worker does it on its own in cloud mode). */
export async function refreshStats() {
  const r = await backend.refreshStats();
  if (r.videos.length) merge(r);
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
    videos: state.videos.map((v) => (v.nicheIds?.includes(id) ? { ...v, nicheIds: v.nicheIds.filter((n) => n !== id) } : v))
      .filter((v) => v.channelId || v.nicheIds?.length),
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

/** Counts an open, for "Similar channels". Not worth bothering anyone about if it fails. */
export async function markOpened(videoId) {
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) return;
  const opens = (v.opens || 0) + 1, openedAt = new Date().toISOString();
  state = { ...state, videos: state.videos.map((x) => (x.id === videoId ? { ...x, opens, openedAt } : x)) }; // no re-render
  await backend.markOpened(videoId, opens, openedAt).catch(() => {});
}

export async function saveIdea(idea) {
  const i = await backend.saveIdea(idea);
  set({ ideas: [i, ...state.ideas.filter((x) => x.id !== i.id)] });
  return i;
}

export async function deleteIdea(id) {
  await backend.deleteIdea(id);
  set({ ideas: state.ideas.filter((i) => i.id !== id) });
}

export async function summariseReport(report) {
  const reportSummary = await backend.summariseReport(report);
  set({ reportSummary });
  return reportSummary;
}

export async function findSimilar(query) {
  const similar = await backend.findSimilar(query);
  set({ similar });
  return similar;
}

export const dismissChannel = (ytChannelId) => saveSettings({ dismissedChannels: [...state.settings.dismissedChannels, ytChannelId] });
