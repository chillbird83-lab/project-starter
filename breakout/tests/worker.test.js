import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { NICHE_CRON, runNicheScan, runScheduled } from '../worker/index.js';
import { webhookSecret } from '../worker/telegram.js';
import { fakeSupabase } from './fake-supabase.js';
import { CH, fakeYouTube } from './fake-youtube.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const TOKENS = { 'Bearer alice.jwt': { id: ALICE, email: 'alice@example.com' }, 'Bearer bob.jwt': { id: BOB, email: 'bob@example.com' } };

const env = (extra = {}) => ({
  SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', YOUTUBE_API_KEY: 'yt',
  GEMINI_API_KEY: 'gem', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_BOT_USERNAME: 'BreakoutBot', ...extra,
});

const ANALYSIS = {
  summary: 'A personal challenge with a clear time frame.', factors: [{ factor: 'Title', insight: 'Challenge + duration' }],
  title_formula: 'I tried [habit] for [N] days', thumbnail_notes: 'Before/after', audience_reaction: 'People share attempts',
  ideas: [{ title: 'I quit sugar for 30 days', angle: 'Same format' }], confidence: 'high',
};

/** Routes global fetch to fake Supabase, YouTube, Telegram and Gemini. */
function world(seed) {
  const sb = fakeSupabase(seed);
  const yt = fakeYouTube();
  const telegram = [];
  let gemini = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://sb.test/auth/v1/user')) {
      const u = TOKENS[init.headers.Authorization];
      return u ? Response.json(u) : new Response('{}', { status: 401 });
    }
    if (url.startsWith('https://sb.test/auth/v1/admin/users/')) return Response.json({});
    if (url.startsWith('https://sb.test/')) return sb.handle(url, init);
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    if (url.includes('generativelanguage.googleapis.com')) { gemini++; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANALYSIS) }] } }] }); }
    return yt.fetchImpl(url, init);
  };
  return { sb, yt, telegram, gemini: () => gemini, restore: () => { globalThis.fetch = original; } };
}

const call = (path, { method = 'POST', token = 'alice.jwt', body, headers = {} } = {}, e = env(), ctx = { waitUntil: () => {} }) =>
  worker.fetch(new Request(`https://app.test${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), e, ctx);

test('config says what is on without leaking secrets', async () => {
  const body = await (await call('/api/config', { method: 'GET', token: null })).json();
  assert.equal(body.cloud, true);
  assert.equal(body.telegram, true);
  assert.equal(body.botUsername, 'BreakoutBot');
  assert.ok(!/service|"yt"|gem|123:abc/.test(JSON.stringify(body)));
  assert.equal((await (await call('/api/config', { method: 'GET' }, {}, env({ YOUTUBE_API_KEY: '' }))).json()).cloud, false);
});

test('adding a channel scores it and treats old outliers as already seen', async () => {
  const w = world();
  try {
    assert.equal((await call('/api/channels', { token: 'nope.jwt', body: { input: '@morningmaker' } })).status, 401);
    const res = await call('/api/channels', { body: { input: '@morningmaker' } });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.channel.title, 'Morning Maker');
    assert.equal(out.channel.baselineLong, 12750);
    const b = out.videos.find((v) => v.ytVideoId === 'breakout001');
    assert.equal(b.isOutlier, true);
    assert.ok(b.alertedAt, 'seeded as alerted');
    assert.equal(w.telegram.length, 0);
    assert.ok(w.sb.db.videos.every((v) => v.user_id === ALICE));
    assert.equal((await call('/api/channels', { body: { input: CH } })).status, 409);
    assert.equal((await call('/api/channels', { body: { input: '@nobody' } })).status, 422);
    const capped = await call('/api/channels', { token: 'bob.jwt', body: { input: CH } }, env({ MAX_CHANNELS: '1' }));
    assert.equal(capped.status, 200); // Bob has none yet
    const over = await call('/api/channels', { token: 'bob.jwt', body: { input: '@morningmaker' } }, env({ MAX_CHANNELS: '1' }));
    assert.equal(over.status, 409); // same channel → duplicate wins over the cap message
  } finally { w.restore(); }
});

test('cron checks due channels and alerts each breakout once', async () => {
  const w = world({
    channels: [{ id: 'c1', user_id: ALICE, yt_channel_id: CH, title: 'Morning Maker', checked_at: null }],
    profiles: [{ user_id: ALICE, threshold: 3, min_views: 1000, include_shorts: true, alerts: true }],
    telegram_links: [{ user_id: ALICE, chat_id: 777 }],
  });
  try {
    const r = await runScheduled(env(), Date.parse('2026-10-28T12:00:00Z'));
    assert.deepEqual(r, { checked: 1, alerted: 1 });
    const alert = w.telegram.find((t) => t.method === 'sendMessage');
    assert.equal(alert.body.chat_id, 777);
    assert.match(alert.body.text, /14× typical views<\/b> · Morning Maker/);
    assert.match(alert.body.text, /60K views in 3 days \(usually ~12.8K\)/);
    assert.match(alert.body.reply_markup.inline_keyboard[0][0].callback_data, /^an:/);
    assert.ok(w.sb.db.videos.find((v) => v.yt_video_id === 'breakout001').alerted_at);

    w.sb.db.channels[0].checked_at = null;
    assert.deepEqual(await runScheduled(env(), Date.parse('2026-10-28T16:00:00Z')), { checked: 1, alerted: 0 });

    // Not due yet → nothing happens; alerts off → no message
    assert.deepEqual(await runScheduled(env(), Date.parse('2026-10-28T17:00:00Z')), { checked: 0 });
  } finally { w.restore(); }
});

test('manual refresh is rate-limited', async () => {
  const w = world({ channels: [{ id: 'c1', user_id: ALICE, yt_channel_id: CH, title: 'Morning Maker', checked_at: null }] });
  try {
    const first = await call('/api/refresh', { body: {} });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).channels.length, 1);
    assert.equal((await call('/api/refresh', { body: {} })).status, 429);
  } finally { w.restore(); }
});

test('analysis is owner-only, cached and limited', async () => {
  const w = world();
  try {
    const added = await (await call('/api/channels', { body: { input: CH } })).json();
    const vid = added.videos.find((v) => v.ytVideoId === 'breakout001').id;
    assert.equal((await call('/api/analyse', { token: 'bob.jwt', body: { videoId: vid } })).status, 404);
    const a = await (await call('/api/analyse', { body: { videoId: vid } })).json();
    assert.equal(a.analysis.titleFormula, 'I tried [habit] for [N] days');
    assert.equal(w.gemini(), 1);
    await call('/api/analyse', { body: { videoId: vid } });
    assert.equal(w.gemini(), 1, 'second call served from the database');
    const other = added.videos.find((v) => v.ytVideoId === 'normal00001').id;
    assert.equal((await call('/api/analyse', { body: { videoId: other } }, env({ ANALYSES_PER_DAY: '1' }))).status, 429);
  } finally { w.restore(); }
});

test('Telegram: linking, secret check and the "Why did it work?" button', async () => {
  const w = world();
  try {
    const secret = await webhookSecret(env());
    const hook = (update, s = secret, ctx) => call('/api/telegram/webhook', { token: null, body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': s } }, env(), ctx);
    assert.equal((await hook({ message: { text: '/start x', chat: { id: 1 } } }, 'wrong')).status, 403);

    const { url } = await (await call('/api/telegram/link', { body: {} })).json();
    const code = url.split('start=')[1];
    assert.match(url, /^https:\/\/t\.me\/BreakoutBot\?start=[0-9a-f]{32}$/);
    await hook({ message: { text: `/start ${code}`, chat: { id: 555 } } });
    assert.equal(w.sb.db.telegram_links[0].chat_id, 555);
    assert.equal(w.sb.db.telegram_links[0].link_code, null);
    assert.match(w.telegram.at(-1).body.text, /Connected to Breakout/);
    await hook({ message: { text: `/start ${code}`, chat: { id: 999 } } }); // code is single-use
    assert.equal(w.sb.db.telegram_links[0].chat_id, 555);

    const added = await (await call('/api/channels', { body: { input: CH } })).json();
    const vid = added.videos.find((v) => v.ytVideoId === 'breakout001').id;
    const tasks = [];
    const ctx = { waitUntil: (p) => tasks.push(p) };
    await hook({ callback_query: { id: 'cb1', data: `an:${vid}`, from: { id: 999 }, message: { chat: { id: 999 }, message_id: 4 } } }, secret, ctx);
    await Promise.all(tasks);
    assert.equal(w.gemini(), 0, 'a stranger’s chat cannot trigger analysis');
    await hook({ callback_query: { id: 'cb2', data: `an:${vid}`, from: { id: 555 }, message: { chat: { id: 555 }, message_id: 5 } } }, secret, ctx);
    await Promise.all(tasks);
    const msg = w.telegram.at(-1);
    assert.equal(msg.body.chat_id, 555);
    assert.match(msg.body.text, /Why “I tried the 5am routine for 30 days” worked/);
    assert.match(msg.body.text, /1\. <b>I quit sugar for 30 days<\/b>/);

    await hook({ message: { text: '/stop', chat: { id: 555 } } });
    assert.equal(w.sb.db.profiles.length, 0); // no profile row yet → nothing to pause, but no crash
  } finally { w.restore(); }
});

const NICHE = '33333333-3333-4333-8333-333333333333';

test('niche scan: finds outliers from any channel, skips tracked channels, rate-limited', async () => {
  const w = world({ niches: [{ id: NICHE, user_id: ALICE, name: 'Cooking', keywords: 'budget cooking, meal prep', scanned_at: null, created_at: '2026-01-01' }] });
  try {
    assert.equal((await call('/api/niches/scan', { token: 'bob.jwt', body: { nicheId: NICHE } })).status, 404);
    const res = await call('/api/niches/scan', { body: { nicheId: NICHE } });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    const q = w.yt.calls.find((u) => u.pathname.endsWith('/search')).searchParams.get('q');
    assert.equal(q, 'budget cooking | meal prep');
    assert.deepEqual(out.videos.map((v) => v.ytVideoId).sort(), ['breakout001', 'tinyhit0001']);
    const tiny = w.sb.db.videos.find((v) => v.yt_video_id === 'tinyhit0001');
    assert.deepEqual(tiny.niche_ids, [NICHE]);
    assert.equal(tiny.channel_id, undefined);
    assert.equal(tiny.channel_title, 'Tiny Kitchen');
    assert.ok(tiny.alerted_at, 'first scan seeds alerts');
    assert.ok(w.sb.db.niches[0].scanned_at);
    assert.equal((await call('/api/niches/scan', { body: { nicheId: NICHE } })).status, 429);

    // Track Morning Maker → its videos are left to channel tracking on the next scan
    await call('/api/channels', { body: { input: '@morningmaker' } });
    w.sb.db.niches[0].scanned_at = '2000-01-01T00:00:00Z';
    const again = await (await call('/api/niches/scan', { body: { nicheId: NICHE } })).json();
    assert.deepEqual(again.videos.map((v) => v.ytVideoId), ['tinyhit0001']);
  } finally { w.restore(); }
});

test('a niche without search words searches its name; the niche limit applies', async () => {
  const w = world({ niches: [
    { id: NICHE, user_id: ALICE, name: 'history', keywords: '', created_at: '2026-01-01' },
    { id: '44444444-4444-4444-8444-444444444444', user_id: ALICE, name: 'ww2', keywords: '', created_at: '2026-01-02' },
  ] });
  try {
    const e = env({ MAX_NICHES: '1' });
    assert.equal((await call('/api/niches/scan', { body: { nicheId: NICHE } }, e)).status, 200);
    assert.equal(w.yt.calls.find((u) => u.pathname.endsWith('/search')).searchParams.get('q'), 'history');
    assert.equal((await call('/api/niches/scan', { body: { nicheId: '44444444-4444-4444-8444-444444444444' } }, e)).status, 403);
    assert.equal((await call('/api/niches/scan', { body: { nicheId: '44444444-4444-4444-8444-444444444444' } })).status, 200);
  } finally { w.restore(); }
});

test('hourly cron scans a due niche and alerts new finds; analysis works for discovered videos', async () => {
  const w = world({
    niches: [{ id: NICHE, user_id: ALICE, name: 'Cooking', keywords: 'budget cooking', scanned_at: '2026-10-27T00:00:00Z', created_at: '2026-01-01' }],
    profiles: [{ user_id: ALICE, threshold: 3, min_views: 1000, include_shorts: true, alerts: true }],
    telegram_links: [{ user_id: ALICE, chat_id: 777 }],
  });
  try {
    const now = Date.parse('2026-10-28T12:07:00Z');
    const tasks = [];
    await worker.scheduled({ cron: NICHE_CRON, scheduledTime: now }, env(), { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    const alerts = w.telegram.filter((t) => t.method === 'sendMessage');
    assert.equal(alerts.length, 2);
    assert.ok(alerts.some((a) => /Tiny Kitchen · in “Cooking”/.test(a.body.text)));
    assert.deepEqual(await runNicheScan(env(), now + 36e5), { scanned: 0 }); // not due again for 12 hours

    const tiny = w.sb.db.videos.find((v) => v.yt_video_id === 'tinyhit0001');
    const a = await (await call('/api/analyse', { body: { videoId: tiny.id } })).json();
    assert.equal(a.analysis.titleFormula, 'I tried [habit] for [N] days');
    assert.ok(w.yt.calls.some((u) => u.searchParams.get('playlistId') === `UU${'9876543210987654321098'}`), 'fetched the channel for comparison');
  } finally { w.restore(); }
});

test('the 15-minute cron still runs channel checks', async () => {
  const w = world({ channels: [{ id: 'c1', user_id: ALICE, yt_channel_id: CH, title: 'Morning Maker', checked_at: null }] });
  try {
    const tasks = [];
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse('2026-10-28T12:00:00Z') }, env(), { waitUntil: (p) => tasks.push(p) });
    await Promise.all(tasks);
    assert.ok(w.sb.db.channels[0].checked_at);
  } finally { w.restore(); }
});

test('a video found by two overlapping niches belongs to both', async () => {
  const B = '66666666-6666-4666-8666-666666666666';
  const w = world({ niches: [
    { id: NICHE, user_id: ALICE, name: 'history', keywords: 'history', created_at: '2026-01-01' },
    { id: B, user_id: ALICE, name: 'ww2', keywords: 'ww2', created_at: '2026-01-02' },
  ] });
  try {
    await call('/api/niches/scan', { body: { nicheId: NICHE } });
    await call('/api/niches/scan', { body: { nicheId: B } });
    assert.deepEqual(w.sb.db.videos.find((v) => v.yt_video_id === 'tinyhit0001').niche_ids, [NICHE, B]);
  } finally { w.restore(); }
});

test('the Worker searches niches in the language saved in the profile', async () => {
  const w = world({
    niches: [{ id: NICHE, user_id: ALICE, name: 'ww2', keywords: 'ww2', created_at: '2026-01-01' }],
    profiles: [{ user_id: ALICE, threshold: 3, min_views: 1000, include_shorts: true, alerts: true, language: 'es' }],
  });
  try {
    await call('/api/niches/scan', { body: { nicheId: NICHE } });
    assert.equal(w.yt.calls.find((u) => u.pathname.endsWith('/search')).searchParams.get('relevanceLanguage'), 'es');
  } finally { w.restore(); }
});

test('alerts skip videos in other languages', async () => {
  const w = world({
    niches: [{ id: NICHE, user_id: ALICE, name: 'cooking', keywords: 'cooking', scanned_at: '2026-10-27T00:00:00Z', created_at: '2026-01-01' }],
    profiles: [{ user_id: ALICE, threshold: 3, min_views: 1000, include_shorts: true, alerts: true, language: 'es', hide_mixed: true, hide_languages: [] }],
    telegram_links: [{ user_id: ALICE, chat_id: 777 }],
  });
  try {
    await runNicheScan(env(), Date.parse('2026-10-28T12:07:00Z'));
    const alerts = w.telegram.filter((t) => t.method === 'sendMessage').map((t) => t.body.text);
    // "I tried the 5am routine for 30 days" is English → no alert; the short title it can't place still alerts
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Feed 4 people/);
  } finally { w.restore(); }
});
