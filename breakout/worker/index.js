// Breakout API on Cloudflare Workers. Serves the app (static assets) and keeps every secret server-side.
//   GET    /api/config              what is switched on (+ the public Supabase URL and anon key)
//   POST   /api/channels            { input, nicheId } track a channel: resolve it, score its uploads
//   POST   /api/refresh             { channelId? } re-check now (rate-limited)
//   POST   /api/niches/scan         { nicheId } find outliers from any channel for a niche's search words
//   POST   /api/analyse             { videoId, force? } Gemini: why did this video work?
//   POST   /api/telegram/link       a t.me link that connects the user's Telegram chat
//   POST   /api/telegram/unlink | /api/telegram/test
//   POST   /api/telegram/webhook    called by Telegram (/start <code>, /stop, "Why did it work?" buttons)
//   DELETE /api/account
// Crons: every 15 minutes re-check the channels that are due; hourly scan one niche that is due.
// Both send Telegram alerts for new breakouts.
import { analyseVideo } from '../public/js/analyse.js';
import { nicheQuery, scanNiche } from '../public/js/discover.js';
import { DEFAULT_MODEL } from '../public/js/gemini.js';
import {
  channelToRow, discoveryToRow, pseudoChannel, rowToChannel, rowToNiche, rowToVideo, settingsFromProfile, videoToRow,
} from '../public/js/rows.js';
import { shouldAlert } from '../public/js/score.js';
import { refreshChannel } from '../public/js/tracker.js';
import { YouTubeError, ytClient } from '../public/js/youtube.js';
import { alertMessage, analysisMessage, tg, webhookSecret } from './telegram.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANUAL_REFRESH_MINUTES = 10;
const MANUAL_SCAN_MINUTES = 30;
export const NICHE_CRON = '7 * * * *';
const MAX_ALERTS_PER_CHANNEL = 3;
const LINK_CODE_MINUTES = 60;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const intVar = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const cloudReady = (env) => !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY && env.YOUTUBE_API_KEY);
const telegramReady = (env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME);
const limits = (env) => ({
  maxChannels: intVar(env.MAX_CHANNELS, 30),
  batch: intVar(env.BATCH_SIZE, 6),
  refreshHours: intVar(env.REFRESH_HOURS, 4),
  analysesPerDay: intVar(env.ANALYSES_PER_DAY, 25),
  nicheHours: intVar(env.NICHE_REFRESH_HOURS, 12),
  maxNiches: intVar(env.MAX_NICHES, 8),
});

// ---------------------------------------------------------------------------
// Supabase (service role — the Worker checks ownership itself)
// ---------------------------------------------------------------------------

const serviceHeaders = (env) => {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
};

async function sb(env, path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...serviceHeaders(env), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Database error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer [\w.-]+$/.test(auth)) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id, email: u.email } : null;
}

async function loadProfile(env, userId) {
  const [p] = await sb(env, `profiles?select=*&user_id=eq.${userId}`);
  return p ?? null;
}

async function chatIdFor(env, userId) {
  const [l] = await sb(env, `telegram_links?select=chat_id&user_id=eq.${userId}&chat_id=not.is.null`);
  return l?.chat_id ?? null;
}

// ---------------------------------------------------------------------------
// Refreshing a channel
// ---------------------------------------------------------------------------

/**
 * Re-checks one tracked channel, saves channel + videos, and sends Telegram alerts for new breakouts.
 * `seed`: the first check after adding — existing outliers are marked as already alerted.
 */
export async function processChannel(env, row, { settings, chatId = null, seed = false, now = Date.now() }) {
  const yt = ytClient(env.YOUTUBE_API_KEY);
  const out = await refreshChannel(yt, row.yt_channel_id, { now, settings });
  const nowIso = new Date(now).toISOString();
  const [chRow] = await sb(env, `channels?id=eq.${row.id}`, { method: 'PATCH', body: channelToRow(out.channel), prefer: 'return=representation' });
  let videoRows = [];
  if (out.videos.length) {
    videoRows = await sb(env, 'videos?on_conflict=user_id,yt_video_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: out.videos.map((v) => ({
        ...videoToRow(v), user_id: row.user_id, channel_id: row.id, updated_at: nowIso,
        ...(seed ? { alerted_at: v.isOutlier ? nowIso : null } : {}),
      })),
    });
  }
  const channel = rowToChannel(chRow ?? { ...row, ...channelToRow(out.channel) });
  const videos = videoRows.map(rowToVideo);
  const alerted = seed ? 0 : await sendAlerts(env, videos, { chatId, settings, now, channelFor: () => channel });
  return { channel, videos, alerted };
}

/** Telegram alerts for fresh, not-yet-alerted outliers; marks them as alerted. Returns how many were sent. */
async function sendAlerts(env, videos, { chatId, settings, now, channelFor, label }) {
  if (!chatId || !settings.alerts || !telegramReady(env)) return 0;
  const nowIso = new Date(now).toISOString();
  const fresh = videos.filter((v) => shouldAlert(v, now)).sort((a, b) => b.score - a.score).slice(0, MAX_ALERTS_PER_CHANNEL);
  const sent = [];
  for (const v of fresh) if ((await tg(env, 'sendMessage', { chat_id: chatId, ...alertMessage(v, channelFor(v), now, label) })).ok) sent.push(v.id);
  if (sent.length) {
    await sb(env, `videos?id=in.(${sent.join(',')})`, { method: 'PATCH', body: { alerted_at: nowIso } });
    for (const v of videos) if (sent.includes(v.id)) v.alertedAt = nowIso;
  }
  return sent.length;
}

/** Scans one niche for outliers from any channel (skipping channels the user already tracks). */
export async function processNiche(env, niche, { settings, chatId = null, now = Date.now() }) {
  const nowIso = new Date(now).toISOString();
  const tracked = new Set((await sb(env, `channels?select=yt_channel_id&user_id=eq.${niche.user_id}`)).map((c) => c.yt_channel_id));
  const found = (await scanNiche(ytClient(env.YOUTUBE_API_KEY), nicheQuery(niche), { now, settings }))
    .filter((v) => !tracked.has(v.ytChannelId));
  const seed = !niche.scanned_at; // the first scan's finds are not "new", so no alert flood
  let rows = [];
  if (found.length) {
    rows = await sb(env, 'videos?on_conflict=user_id,yt_video_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: found.map((v) => ({
        ...discoveryToRow(v), user_id: niche.user_id, niche_id: niche.id, updated_at: nowIso,
        ...(seed ? { alerted_at: v.isOutlier ? nowIso : null } : {}),
      })),
    });
  }
  await sb(env, `niches?id=eq.${niche.id}`, { method: 'PATCH', body: { scanned_at: nowIso } });
  const videos = rows.map(rowToVideo);
  const alerted = seed ? 0 : await sendAlerts(env, videos, { chatId, settings, now, channelFor: pseudoChannel, label: niche.name });
  return { niche: rowToNiche({ ...niche, scanned_at: nowIso }), videos, alerted };
}

/** Only a user's first MAX_NICHES niches with search words are scanned, to protect the shared quota. */
async function nicheAllowed(env, niche) {
  const list = await sb(env, `niches?select=id&user_id=eq.${niche.user_id}&keywords=neq.&order=created_at.asc&limit=${limits(env).maxNiches}`);
  return list.some((n) => n.id === niche.id);
}

/** Hourly cron: the niche whose last scan is oldest, if it is due. */
export async function runNicheScan(env, now = Date.now()) {
  if (!cloudReady(env)) return { scanned: 0 };
  const cutoff = new Date(now - limits(env).nicheHours * 36e5).toISOString();
  const due = await sb(env, `niches?select=*&keywords=neq.&or=(scanned_at.is.null,scanned_at.lt.${cutoff})&order=scanned_at.asc.nullsfirst&limit=3`);
  for (const niche of due) {
    if (!(await nicheAllowed(env, niche))) {
      await sb(env, `niches?id=eq.${niche.id}`, { method: 'PATCH', body: { scanned_at: new Date(now).toISOString() } });
      continue;
    }
    const [profile] = await sb(env, `profiles?select=*&user_id=eq.${niche.user_id}`);
    const chatId = telegramReady(env) ? await chatIdFor(env, niche.user_id) : null;
    try {
      const r = await processNiche(env, niche, { settings: settingsFromProfile(profile ?? {}), chatId, now });
      return { scanned: 1, found: r.videos.length, alerted: r.alerted };
    } catch (e) {
      console.error('niche scan failed', niche.id, e.message);
      if (!/quota/i.test(e.message)) await sb(env, `niches?id=eq.${niche.id}`, { method: 'PATCH', body: { scanned_at: new Date(now).toISOString() } }).catch(() => {});
      return { scanned: 0, error: e.message };
    }
  }
  return { scanned: 0 };
}

/** Cron: the channels whose last check is oldest, a few at a time to stay inside Worker limits. */
export async function runScheduled(env, now = Date.now()) {
  if (!cloudReady(env)) return { checked: 0 };
  const { batch, refreshHours } = limits(env);
  const cutoff = new Date(now - refreshHours * 36e5).toISOString();
  const due = await sb(env, `channels?select=*&or=(checked_at.is.null,checked_at.lt.${cutoff})&order=checked_at.asc.nullsfirst&limit=${batch}`);
  if (!due.length) return { checked: 0 };
  const users = [...new Set(due.map((c) => c.user_id))].join(',');
  const [profiles, links] = await Promise.all([
    sb(env, `profiles?select=*&user_id=in.(${users})`),
    telegramReady(env) ? sb(env, `telegram_links?select=user_id,chat_id&user_id=in.(${users})&chat_id=not.is.null`) : [],
  ]);
  let checked = 0, alerted = 0;
  for (const row of due) {
    try {
      const r = await processChannel(env, row, {
        settings: settingsFromProfile(profiles.find((p) => p.user_id === row.user_id)),
        chatId: links.find((l) => l.user_id === row.user_id)?.chat_id ?? null,
        now,
      });
      checked++;
      alerted += r.alerted;
    } catch (e) {
      console.error('refresh failed', row.yt_channel_id, e.message);
      if (e instanceof YouTubeError && /quota/i.test(e.message)) break;
      // Push it to the back of the queue so one broken channel can't block the rest.
      await sb(env, `channels?id=eq.${row.id}`, { method: 'PATCH', body: { checked_at: new Date(now).toISOString() } }).catch(() => {});
    }
  }
  return { checked, alerted };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function addChannel(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.input ?? '').trim();
  if (!input) return fail(400, 'Paste a channel link, an @handle or a video link.');
  const nicheId = body.nicheId && UUID_RE.test(body.nicheId) ? body.nicheId : null;
  if (nicheId && !(await sb(env, `niches?select=id&id=eq.${nicheId}&user_id=eq.${user.id}`)).length) return fail(404, 'That niche doesn’t exist.');

  let found;
  try { found = await ytClient(env.YOUTUBE_API_KEY).resolveChannel(input); } catch (e) { return fail(e instanceof YouTubeError ? 422 : 502, e.message); }

  const existing = await sb(env, `channels?select=id,yt_channel_id&user_id=eq.${user.id}`);
  if (existing.some((c) => c.yt_channel_id === found.ytChannelId)) return fail(409, `You already track ${found.title}.`);
  const { maxChannels } = limits(env);
  if (existing.length >= maxChannels) return fail(403, `You can track up to ${maxChannels} channels. Remove one first.`);

  const [row] = await sb(env, 'channels', {
    method: 'POST', prefer: 'return=representation',
    body: { ...channelToRow(found), user_id: user.id, niche_id: nicheId },
  });
  const profile = await loadProfile(env, user.id);
  try {
    return json(await processChannel(env, row, { settings: settingsFromProfile(profile ?? {}), seed: true }));
  } catch (e) {
    return json({ channel: rowToChannel(row), videos: [], alerted: 0, error: e.message });
  }
}

async function refresh(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const profile = await loadProfile(env, user.id);
  const now = Date.now();
  if (profile?.last_refresh_at && now - Date.parse(profile.last_refresh_at) < MANUAL_REFRESH_MINUTES * 6e4) {
    return fail(429, `Channels were checked a few minutes ago. Try again in ${MANUAL_REFRESH_MINUTES} minutes.`);
  }
  await sb(env, 'profiles?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: user.id, last_refresh_at: new Date(now).toISOString() } });
  const filter = body.channelId && UUID_RE.test(body.channelId) ? `&id=eq.${body.channelId}` : '';
  const rows = await sb(env, `channels?select=*&user_id=eq.${user.id}${filter}&order=checked_at.asc.nullsfirst&limit=${limits(env).batch}`);
  const settings = settingsFromProfile(profile ?? {});
  const chatId = telegramReady(env) ? await chatIdFor(env, user.id) : null;
  const results = [];
  const errors = [];
  for (const row of rows) {
    try { results.push(await processChannel(env, row, { settings, chatId, now })); } catch (e) {
      errors.push(`${row.title}: ${e.message}`);
      if (e instanceof YouTubeError && /quota/i.test(e.message)) break;
    }
  }
  return json({ channels: results.map((r) => r.channel), videos: results.flatMap((r) => r.videos), errors });
}

async function scanNicheNow(request, env, user) {
  const body = await request.json().catch(() => ({}));
  if (!UUID_RE.test(body.nicheId || '')) return fail(400, 'Unknown niche.');
  const [niche] = await sb(env, `niches?select=*&id=eq.${body.nicheId}&user_id=eq.${user.id}`);
  if (!niche) return fail(404, 'Unknown niche.');
  if (!nicheQuery({ keywords: niche.keywords })) return fail(400, 'Add search words to this niche first.');
  if (niche.scanned_at && Date.now() - Date.parse(niche.scanned_at) < MANUAL_SCAN_MINUTES * 6e4) {
    return fail(429, `${niche.name} was scanned a few minutes ago. Niche scans use a lot of YouTube quota, so try again in ${MANUAL_SCAN_MINUTES} minutes.`);
  }
  if (!(await nicheAllowed(env, niche))) return fail(403, `Only your first ${limits(env).maxNiches} niches with search words are scanned.`);
  const profile = await loadProfile(env, user.id);
  const chatId = telegramReady(env) ? await chatIdFor(env, user.id) : null;
  try {
    return json(await processNiche(env, niche, { settings: settingsFromProfile(profile ?? {}), chatId }));
  } catch (e) {
    return fail(e instanceof YouTubeError ? 503 : 502, e.message);
  }
}

async function loadForAnalysis(env, videoId) {
  const [v] = await sb(env, `videos?select=*&id=eq.${videoId}`);
  if (!v) return null;
  if (!v.channel_id) {
    // Found by a niche scan: fetch that channel's recent uploads for the comparison (3 quota units).
    const ctx = await refreshChannel(ytClient(env.YOUTUBE_API_KEY), v.yt_channel_id);
    return { row: v, video: rowToVideo(v), channel: ctx.channel, others: ctx.videos.filter((o) => o.ytVideoId !== v.yt_video_id).slice(0, 15) };
  }
  const [[c], others] = await Promise.all([
    sb(env, `channels?select=*&id=eq.${v.channel_id}`),
    sb(env, `videos?select=title,views,score,yt_video_id&channel_id=eq.${v.channel_id}&id=neq.${videoId}&order=published_at.desc&limit=15`),
  ]);
  return { row: v, video: rowToVideo(v), channel: rowToChannel(c), others: others.map(rowToVideo) };
}

async function runAnalysis(env, loaded) {
  const yt = ytClient(env.YOUTUBE_API_KEY);
  const analysis = await analyseVideo({
    yt, apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_MODEL,
    video: loaded.video, channel: loaded.channel, others: loaded.others,
  });
  const analysedAt = new Date().toISOString();
  await sb(env, `videos?id=eq.${loaded.row.id}`, { method: 'PATCH', body: { analysis, analysed_at: analysedAt } });
  return { analysis, analysedAt };
}

async function analysesToday(env, userId) {
  const since = new Date(Date.now() - 864e5).toISOString();
  return (await sb(env, `videos?select=id&user_id=eq.${userId}&analysed_at=gte.${since}`)).length;
}

async function analyse(request, env, user) {
  if (!env.GEMINI_API_KEY) return fail(503, 'AI analysis isn’t set up on this server yet.');
  const body = await request.json().catch(() => ({}));
  if (!UUID_RE.test(body.videoId || '')) return fail(400, 'Unknown video.');
  const loaded = await loadForAnalysis(env, body.videoId);
  if (!loaded || loaded.row.user_id !== user.id) return fail(404, 'Unknown video.');
  if (loaded.video.analysis && !body.force) return json({ analysis: loaded.video.analysis, analysedAt: loaded.video.analysedAt });
  if (await analysesToday(env, user.id) >= limits(env).analysesPerDay) return fail(429, `That’s ${limits(env).analysesPerDay} analyses today, the daily limit. Try again tomorrow.`);
  try { return json(await runAnalysis(env, loaded)); } catch (e) { return fail(502, e.message); }
}

async function telegramLink(env, user) {
  const code = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await sb(env, 'telegram_links?on_conflict=user_id', {
    method: 'POST', prefer: 'resolution=merge-duplicates',
    body: { user_id: user.id, link_code: code, link_created_at: new Date().toISOString() },
  });
  return json({ url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}` });
}

/** Telegram → us. Always answers 200 quickly; slow work (analysis) continues in waitUntil. */
async function telegramWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) return fail(403, 'Forbidden');
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  if (msg?.text && msg.chat?.id) {
    const chatId = msg.chat.id;
    const [cmd, arg = ''] = msg.text.trim().split(/\s+/);
    if (cmd === '/start' && /^[0-9a-f]{32}$/.test(arg)) {
      const since = new Date(Date.now() - LINK_CODE_MINUTES * 6e4).toISOString();
      const [link] = await sb(env, `telegram_links?select=user_id&link_code=eq.${arg}&link_created_at=gte.${since}`);
      if (link) {
        await sb(env, `telegram_links?user_id=eq.${link.user_id}`, { method: 'PATCH', body: { chat_id: chatId, link_code: null, linked_at: new Date().toISOString() } });
        await tg(env, 'sendMessage', { chat_id: chatId, text: '✅ Connected to Breakout. You’ll get a message here whenever a channel you track has a breakout video.\n\nSend /stop to pause alerts.' });
      } else {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'That link has expired. In Breakout open Settings → Connect Telegram to get a new one.' });
      }
    } else if (cmd === '/stop') {
      const [link] = await sb(env, `telegram_links?select=user_id&chat_id=eq.${chatId}`);
      if (link) await sb(env, `profiles?user_id=eq.${link.user_id}`, { method: 'PATCH', body: { alerts: false } });
      await tg(env, 'sendMessage', { chat_id: chatId, text: link ? 'Alerts paused. Turn them back on in Breakout → Settings.' : 'This chat isn’t connected to Breakout.' });
    } else {
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Hi! To get breakout alerts here, open Breakout → Settings → Connect Telegram.' });
    }
    return json({ ok: true });
  }
  const cb = update.callback_query;
  if (cb?.data?.startsWith('an:')) {
    const chatId = cb.message?.chat?.id ?? cb.from?.id;
    const videoId = cb.data.slice(3);
    ctx.waitUntil((async () => {
      const loaded = UUID_RE.test(videoId) ? await loadForAnalysis(env, videoId) : null;
      const owner = loaded && await chatIdFor(env, loaded.row.user_id);
      if (!loaded || String(owner) !== String(chatId)) { await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Video not found.' }); return; }
      if (!env.GEMINI_API_KEY) { await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'AI analysis isn’t set up yet.' }); return; }
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: loaded.video.analysis ? 'Here it is.' : 'Analysing… this takes a few seconds.' });
      try {
        let analysis = loaded.video.analysis;
        if (!analysis) {
          if (await analysesToday(env, loaded.row.user_id) >= limits(env).analysesPerDay) throw new Error('Daily analysis limit reached. Try again tomorrow.');
          ({ analysis } = await runAnalysis(env, loaded));
        }
        await tg(env, 'sendMessage', { chat_id: chatId, ...analysisMessage(loaded.video, analysis), reply_to_message_id: cb.message?.message_id });
      } catch (e) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: `Couldn’t analyse it: ${e.message}` });
      }
    })());
  }
  return json({ ok: true });
}

async function route(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/api/config' && method === 'GET') {
    return json({
      cloud: cloudReady(env), supabaseUrl: env.SUPABASE_URL || '', supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
      ai: !!env.GEMINI_API_KEY, telegram: telegramReady(env), botUsername: env.TELEGRAM_BOT_USERNAME || '',
      maxChannels: limits(env).maxChannels, refreshHours: limits(env).refreshHours,
      maxNiches: limits(env).maxNiches, nicheHours: limits(env).nicheHours,
    });
  }
  if (!cloudReady(env)) return fail(503, 'The server isn’t set up yet.');
  if (pathname === '/api/telegram/webhook' && method === 'POST') return telegramReady(env) ? telegramWebhook(request, env, ctx) : fail(503, 'Telegram isn’t set up.');
  const user = await getUser(request, env);
  if (!user) return fail(401, 'Please sign in again.');
  if (method === 'POST' && pathname === '/api/channels') return addChannel(request, env, user);
  if (method === 'POST' && pathname === '/api/refresh') return refresh(request, env, user);
  if (method === 'POST' && pathname === '/api/analyse') return analyse(request, env, user);
  if (method === 'POST' && pathname === '/api/niches/scan') return scanNicheNow(request, env, user);
  if (pathname.startsWith('/api/telegram/') && !telegramReady(env)) return fail(503, 'Telegram isn’t set up on this server.');
  if (method === 'POST' && pathname === '/api/telegram/link') return telegramLink(env, user);
  if (method === 'POST' && pathname === '/api/telegram/unlink') {
    await sb(env, `telegram_links?user_id=eq.${user.id}`, { method: 'PATCH', body: { chat_id: null, linked_at: null } });
    return json({ ok: true });
  }
  if (method === 'POST' && pathname === '/api/telegram/test') {
    const chatId = await chatIdFor(env, user.id);
    if (!chatId) return fail(404, 'Connect Telegram first.');
    const r = await tg(env, 'sendMessage', { chat_id: chatId, text: '👋 Test from Breakout. Alerts will look like this when a tracked channel breaks out.' });
    return r.ok ? json({ ok: true }) : fail(502, 'Telegram didn’t accept the message. Did you block the bot?');
  }
  if (method === 'DELETE' && pathname === '/api/account') {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: serviceHeaders(env) });
    return res.ok ? json({ ok: true }) : fail(502, 'The account could not be deleted. Please try again.');
  }
  return fail(404, 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      console.error(e);
      return fail(500, 'Something went wrong. Please try again.');
    }
  },
  async scheduled(event, env, ctx) {
    const job = event.cron === NICHE_CRON ? runNicheScan : runScheduled;
    ctx.waitUntil(job(env, event.scheduledTime).then((r) => console.log('cron', event.cron, JSON.stringify(r))));
  },
};
