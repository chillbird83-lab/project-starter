// Two interchangeable backends with the same methods:
//  - cloud: Supabase (email-code sign-in, Postgres with row-level security) + the Worker API, which holds
//           the YouTube, Gemini and Telegram keys and checks channels on a schedule.
//  - local: everything in this browser (IndexedDB), using the user's own YouTube and Gemini keys.
//           Channels are checked when the app is open; no Telegram alerts.
import { analyseVideo } from './analyse.js';
import * as db from './db.js';
import { nicheQuery, scanNiche } from './discover.js';
import { rowToChannel, rowToNiche, rowToVideo } from './rows.js';
import { DEFAULT_SETTINGS } from './score.js';
import { refreshChannel } from './tracker.js';
import { ytClient } from './youtube.js';
import { uid } from './util.js';

const SESSION_KEY = 'breakout.session';
const MODE_KEY = 'breakout.mode';

const readJSON = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const writeJSON = (key, v) => { try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };

export const preferLocal = () => { try { return localStorage.getItem(MODE_KEY) === 'local'; } catch { return false; } };
export const setPreferLocal = (on) => { try { if (on) localStorage.setItem(MODE_KEY, 'local'); else localStorage.removeItem(MODE_KEY); } catch { /* ignore */ } };

async function errorText(res, fallback) {
  try {
    const b = await res.json();
    return b.error_description || b.msg || b.message || b.error || fallback;
  } catch { return fallback; }
}

/** What the server has switched on. Without the Worker (plain static hosting) this is all false. */
export async function loadConfig() {
  try {
    const res = await fetch('api/config', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('Content-Type') || '').includes('json')) throw new Error('no api');
    return await res.json();
  } catch {
    return { cloud: false, ai: false, telegram: false };
  }
}

const profileToSettings = (p) => ({
  ...DEFAULT_SETTINGS, onboarded: true, threshold: Number(p.threshold) || 3, minViews: Number(p.min_views ?? 1000),
  includeShorts: p.include_shorts !== false, alerts: p.alerts !== false, language: p.language || null,
});

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

export function cloudBackend(config, { onSignedOut } = {}) {
  const base = config.supabaseUrl.replace(/\/+$/, '');
  const anon = config.supabaseAnonKey;
  let session = readJSON(SESSION_KEY);
  let refreshing = null;

  const saveSession = (s) => {
    session = s ? { ...s, expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in || 3600) } : null;
    writeJSON(SESSION_KEY, session);
  };

  async function auth(path, body, token) {
    const res = await fetch(`${base}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(await errorText(res, 'Sign-in failed. Please try again.'));
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async function token() {
    if (!session) throw Object.assign(new Error('Please sign in.'), { signedOut: true });
    if (session.expires_at * 1000 - 60_000 > Date.now()) return session.access_token;
    refreshing ??= auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(saveSession)
      .catch((e) => { if (navigator.onLine !== false) { saveSession(null); onSignedOut?.(); } throw e; })
      .finally(() => { refreshing = null; });
    await refreshing;
    return session.access_token;
  }

  async function call(url, init = {}) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await token()}` } });
    } catch (e) {
      if (e.signedOut) throw e;
      throw new Error('You’re offline. Check your connection and try again.');
    }
    if (res.status === 401) { saveSession(null); onSignedOut?.(); throw new Error('Please sign in again.'); }
    if (!res.ok) throw new Error(await errorText(res, `Request failed (${res.status}).`));
    return res;
  }

  const rest = async (path, { method = 'GET', body, prefer } = {}) => {
    const res = await call(`${base}/rest/v1/${path}`, {
      method,
      headers: { apikey: anon, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text(); // empty with Prefer: return=minimal
    return text ? JSON.parse(text) : null;
  };
  const api = (path, body, method = 'POST') =>
    call(`api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

  const VIDEO_COLS = 'id,channel_id,niche_ids,source,lang,yt_video_id,yt_channel_id,channel_title,channel_subs,baseline,baseline_kind,title,thumb,published_at,duration_s,is_short,views,likes,comments,score,is_outlier,alerted_at,analysis,analysed_at,saved,tags,description,updated_at';

  return {
    mode: 'cloud',
    config,
    get user() { return session?.user ? { id: session.user.id, email: session.user.email } : null; },
    sendCode: (email) => auth('otp', { email, create_user: true }),
    async verifyCode(email, code) { saveSession(await auth('verify', { type: 'email', email, token: code })); },
    async signOut() {
      const t = session?.access_token;
      saveSession(null);
      if (t) await auth('logout', {}, t).catch(() => {});
    },

    async load() {
      const [niches, channels, videos, profiles, links] = await Promise.all([
        rest('niches?select=id,name,keywords,scanned_at,created_at&order=created_at.asc'),
        rest('channels?select=*&order=created_at.asc'),
        rest(`videos?select=${VIDEO_COLS}&order=published_at.desc&limit=5000`),
        rest(`profiles?select=*&user_id=eq.${this.user.id}`),
        rest('telegram_links?select=chat_id,linked_at'),
      ]);
      return {
        niches: niches.map(rowToNiche),
        channels: channels.map(rowToChannel),
        videos: videos.map(rowToVideo),
        settings: profiles[0] ? profileToSettings(profiles[0]) : { ...DEFAULT_SETTINGS, onboarded: false },
        telegram: { linked: !!links[0]?.chat_id },
      };
    },
    async saveSettings(s) {
      await rest('profiles', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { user_id: this.user.id, email: this.user.email, threshold: s.threshold, min_views: s.minViews, include_shorts: s.includeShorts, alerts: s.alerts, language: s.language },
      });
    },
    async saveNiche({ id, name, keywords = '' }) {
      const [row] = id
        ? await rest(`niches?id=eq.${id}`, { method: 'PATCH', body: { name, keywords }, prefer: 'return=representation' })
        : await rest('niches', { method: 'POST', body: { user_id: this.user.id, name, keywords }, prefer: 'return=representation' });
      return rowToNiche(row);
    },
    scanNiche: (nicheId) => api('niches/scan', { nicheId }),
    deleteNiche: (id) => rest(`niches?id=eq.${id}`, { method: 'DELETE' }),
    moveChannel: (id, nicheId) => rest(`channels?id=eq.${id}`, { method: 'PATCH', body: { niche_id: nicheId } }),
    deleteChannel: (id) => rest(`channels?id=eq.${id}`, { method: 'DELETE' }),
    setSaved: (id, saved) => rest(`videos?id=eq.${id}`, { method: 'PATCH', body: { saved } }),

    addChannel: (input, nicheId) => api('channels', { input, nicheId }),
    refresh: (channelId) => api('refresh', { channelId }),
    analyse: (videoId, force = false) => api('analyse', { videoId, force }),
    telegramLink: () => api('telegram/link', {}).then((r) => r.url),
    telegramUnlink: () => api('telegram/unlink', {}),
    telegramTest: () => api('telegram/test', {}),
    async telegramStatus() { const [l] = await rest('telegram_links?select=chat_id'); return { linked: !!l?.chat_id }; },
    async deleteEverything() { await api('account', null, 'DELETE'); await this.signOut(); },
  };
}

// ---------------------------------------------------------------------------
// Local (this device only)
// ---------------------------------------------------------------------------

/** Niches a stored video belongs to. Earlier versions kept a single `nicheId`; now a video can be in several. */
const nichesOf = (v) => (Array.isArray(v?.nicheIds) ? v.nicheIds : v?.nicheId ? [v.nicheId] : []);

export function localBackend(config) {
  let settings = { ...DEFAULT_SETTINGS };
  const yt = () => {
    if (!settings.youtubeKey) throw new Error('Add your YouTube API key in Settings first.');
    return ytClient(settings.youtubeKey);
  };

  /** Saves a refresh result, keeping each video's analysis, saved flag and local id. */
  async function store(channelRow, out, { seed = false } = {}) {
    // Match across all videos, so one a niche scan found becomes part of the channel (keeping its analysis).
    const byYt = new Map((await db.getAll('videos')).map((v) => [v.ytVideoId, v]));
    const now = new Date().toISOString();
    const channel = { ...channelRow, ...out.channel };
    const videos = out.videos.map((v) => {
      const old = byYt.get(v.ytVideoId);
      return {
        ...v, id: old?.id ?? uid(), channelId: channel.id, nicheIds: nichesOf(old), analysis: old?.analysis ?? null, analysedAt: old?.analysedAt ?? null,
        saved: old?.saved ?? false, alertedAt: old?.alertedAt ?? (seed && v.isOutlier ? now : null), updatedAt: now,
      };
    });
    await db.put('channels', channel);
    await db.putMany('videos', videos);
    return { channel, videos };
  }

  return {
    mode: 'local',
    config,
    user: null,
    async load() {
      const [niches, channels, videos, saved] = await Promise.all([db.getAll('niches'), db.getAll('channels'), db.getAll('videos'), db.get('kv', 'settings')]);
      settings = { ...DEFAULT_SETTINGS, onboarded: false, youtubeKey: '', geminiKey: '', geminiModel: '', ...saved };
      const upgraded = videos.map((v) => ({ ...v, nicheIds: nichesOf(v) }));
      return { niches, channels, videos: upgraded, settings, telegram: { linked: false } };
    },
    async saveSettings(s) { settings = { ...s }; await db.put('kv', settings, 'settings'); },
    async saveNiche({ id, name, keywords = '' }) {
      const old = id ? await db.get('niches', id) : null;
      const n = { id: id ?? uid(), name, keywords, scannedAt: old?.scannedAt ?? null };
      await db.put('niches', n);
      return n;
    },
    async deleteNiche(id) {
      await db.del('niches', id);
      for (const c of (await db.getAll('channels')).filter((c) => c.nicheId === id)) await db.put('channels', { ...c, nicheId: null });
      for (const v of (await db.getAll('videos')).filter((v) => nichesOf(v).includes(id))) {
        const nicheIds = nichesOf(v).filter((n) => n !== id);
        if (!nicheIds.length && !v.channelId) await db.del('videos', v.id); else await db.put('videos', { ...v, nicheIds });
      }
    },
    /** Finds outliers from any channel for the niche's search words (about 122 of your quota units). */
    async scanNiche(nicheId) {
      const niche = await db.get('niches', nicheId);
      if (!niche) throw new Error('Unknown niche.');
      const query = nicheQuery(niche);
      if (!query) throw new Error('This niche has no name to search for.');
      const [channels, existing] = await Promise.all([db.getAll('channels'), db.getAll('videos')]);
      const tracked = new Set(channels.map((c) => c.ytChannelId));
      const byYt = new Map(existing.map((v) => [v.ytVideoId, v]));
      const now = new Date().toISOString();
      const found = (await scanNiche(yt(), query, { settings })).filter((v) => !tracked.has(v.ytChannelId));
      const videos = found.map((v) => {
        const old = byYt.get(v.ytVideoId);
        return {
          ...v, id: old?.id ?? uid(), channelId: null, nicheIds: [...new Set([...nichesOf(old), nicheId])], analysis: old?.analysis ?? null, analysedAt: old?.analysedAt ?? null,
          saved: old?.saved ?? false, alertedAt: old?.alertedAt ?? null, updatedAt: now,
        };
      });
      await db.putMany('videos', videos);
      const updated = { ...niche, scannedAt: now };
      await db.put('niches', updated);
      return { niche: updated, videos };
    },
    async moveChannel(id, nicheId) { const c = (await db.getAll('channels')).find((x) => x.id === id); if (c) await db.put('channels', { ...c, nicheId }); },
    async deleteChannel(id) {
      await db.del('channels', id);
      for (const v of (await db.getAll('videos')).filter((v) => v.channelId === id)) await db.del('videos', v.id);
    },
    async setSaved(id, saved) { const v = await db.get('videos', id); if (v) await db.put('videos', { ...v, saved }); },

    async addChannel(input, nicheId) {
      const client = yt();
      const found = await client.resolveChannel(input);
      const channels = await db.getAll('channels');
      if (channels.some((c) => c.ytChannelId === found.ytChannelId)) throw new Error(`You already track ${found.title}.`);
      const row = { ...found, id: uid(), nicheId: nicheId ?? null, createdAt: new Date().toISOString() };
      return store(row, await refreshChannel(client, found.ytChannelId, { settings }), { seed: true });
    },
    /** Re-checks one channel, all of them, or (with staleHours) only those not checked for that long. */
    async refresh(channelId, { staleHours = 0 } = {}) {
      const client = yt();
      const cutoff = Date.now() - staleHours * 36e5;
      const rows = (await db.getAll('channels')).filter((c) => (!channelId || c.id === channelId)
        && (!staleHours || !c.checkedAt || Date.parse(c.checkedAt) < cutoff));
      const channels = [], videos = [], errors = [];
      for (const row of rows) {
        try {
          const r = await store(row, await refreshChannel(client, row.ytChannelId, { settings }));
          channels.push(r.channel);
          videos.push(...r.videos);
        } catch (e) {
          errors.push(`${row.title}: ${e.message}`);
          if (/quota/i.test(e.message)) break;
        }
      }
      return { channels, videos, errors };
    },
    async analyse(videoId, force = false) {
      const v = await db.get('videos', videoId);
      if (!v) throw new Error('Unknown video.');
      if (v.analysis && !force) return { analysis: v.analysis, analysedAt: v.analysedAt };
      if (!settings.geminiKey) throw new Error('Add your Gemini API key in Settings to get the analysis.');
      let channel = (await db.getAll('channels')).find((c) => c.id === v.channelId);
      let others;
      if (channel) {
        others = (await db.getAll('videos')).filter((o) => o.channelId === v.channelId && o.id !== v.id)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 15);
      } else {
        // Found by a niche scan: fetch that channel's recent uploads for the comparison (3 units).
        const ctx = await refreshChannel(yt(), v.ytChannelId, { settings });
        channel = ctx.channel;
        others = ctx.videos.filter((o) => o.ytVideoId !== v.ytVideoId).slice(0, 15);
      }
      const analysis = await analyseVideo({ yt: yt(), apiKey: settings.geminiKey, model: settings.geminiModel || undefined, video: v, channel, others });
      const analysedAt = new Date().toISOString();
      await db.put('videos', { ...v, analysis, analysedAt });
      return { analysis, analysedAt };
    },
    async deleteEverything() { await Promise.all(['niches', 'channels', 'videos', 'kv'].map((s) => db.clear(s))); },
  };
}
