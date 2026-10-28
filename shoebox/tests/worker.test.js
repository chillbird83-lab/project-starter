import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sendReminders, ukToday } from '../worker/index.js';

const UID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

function bucket() {
  const files = new Map();
  return {
    files,
    async put(key, body, opts) { files.set(key, { body: new Uint8Array(body), type: opts?.httpMetadata?.contentType }); },
    async get(key) { const f = files.get(key); return f ? { body: f.body, httpMetadata: { contentType: f.type } } : null; },
    async delete(keys) { for (const k of [].concat(keys)) files.delete(k); },
    async list({ prefix }) { return { objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
  };
}

const baseEnv = () => ({
  SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  GEMINI_API_KEY: 'gem', GEMINI_MODEL: 'flash-x', RESEND_API_KEY: 're', EMAIL_FROM: 'Shoebox <hi@shoebox.test>',
  APP_URL: 'https://app.test', RECEIPTS: bucket(),
});

/** Replaces global fetch with a router; records every call. */
function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, handler] of routes) if (String(url).includes(pattern)) return handler(String(url), init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const authOK = ['/auth/v1/user', (u, init) => (init.headers.Authorization === 'Bearer good.token'
  ? Response.json({ id: UID, email: 'jo@example.com' }) : new Response('{}', { status: 401 }))];
const gemini = ['generativelanguage.googleapis.com', () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ is_receipt: true, merchant: 'Shell', date: '2026-10-01', currency: 'GBP', total: 60, vat: 10, vat_number: 'GB1', category: 'carVanTravelExpenses', description: 'Fuel', payment_method: 'card' }) }] } }] })];

const req = (path, { method = 'GET', token = 'good.token', body, type } = {}) =>
  new Request(`https://app.test${path}`, { method, body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(type ? { 'Content-Type': type } : {}) } });

test('config reports what is switched on, without secrets', async () => {
  const res = await worker.fetch(req('/api/config', { token: null }), baseEnv());
  const body = await res.json();
  assert.deepEqual(body, { cloud: true, supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', ai: true, email: true, reminders: true });
  assert.ok(!JSON.stringify(body).includes('service') && !JSON.stringify(body).includes('gem'));
  const empty = await (await worker.fetch(req('/api/config'), { RECEIPTS: bucket() })).json();
  assert.equal(empty.cloud, false);
});

test('static files go to the assets binding', async () => {
  const env = { ...baseEnv(), ASSETS: { fetch: async () => new Response('<html>') } };
  assert.equal(await (await worker.fetch(req('/index.html'), env)).text(), '<html>');
});

test('API needs a valid Supabase session', async () => {
  const m = mockFetch([authOK]);
  try {
    assert.equal((await worker.fetch(req('/api/scan', { method: 'POST', token: null }), baseEnv())).status, 401);
    assert.equal((await worker.fetch(req('/api/scan', { method: 'POST', token: 'bad.token' }), baseEnv())).status, 401);
  } finally { m.restore(); }
});

test('scan stores the file under the user and returns a draft', async () => {
  const env = baseEnv();
  const m = mockFetch([authOK, gemini]);
  try {
    const res = await worker.fetch(req('/api/scan', { method: 'POST', body: new Uint8Array([1, 2, 3]), type: 'image/jpeg' }), env);
    const out = await res.json();
    assert.equal(res.status, 200);
    assert.match(out.imageKey, new RegExp(`^${UID}/[0-9a-f-]{36}\\.jpg$`));
    assert.deepEqual([...env.RECEIPTS.files.get(out.imageKey).body], [1, 2, 3]);
    assert.equal(out.draft.gross, 6000);
    assert.equal(out.draft.vat, 1000);
    assert.equal(out.draft.category, 'carVanTravelExpenses');
    const g = m.calls.find((c) => c.url.includes('generativelanguage'));
    assert.match(g.url, /models\/flash-x:generateContent/);
    assert.equal(g.init.headers['x-goog-api-key'], 'gem');

    assert.equal((await worker.fetch(req('/api/scan', { method: 'POST', body: 'x', type: 'text/html' }), env)).status, 415);
  } finally { m.restore(); }
});

test('scan still saves the photo when Gemini fails', async () => {
  const env = baseEnv();
  const m = mockFetch([authOK, ['generativelanguage', () => new Response('{}', { status: 429 })]]);
  try {
    const out = await (await worker.fetch(req('/api/scan', { method: 'POST', body: new Uint8Array([9]), type: 'application/pdf' }), env)).json();
    assert.match(out.imageKey, /\.pdf$/);
    assert.equal(out.draft, null);
    assert.match(out.error, /quota/);
  } finally { m.restore(); }
});

test('images are only served to their owner', async () => {
  const env = baseEnv();
  const mine = `${UID}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
  const theirs = `${OTHER}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
  await env.RECEIPTS.put(mine, new Uint8Array([7]), { httpMetadata: { contentType: 'image/png' } });
  await env.RECEIPTS.put(theirs, new Uint8Array([8]), { httpMetadata: { contentType: 'image/png' } });
  const m = mockFetch([authOK]);
  try {
    const ok = await worker.fetch(req(`/api/image/${mine}`), env);
    assert.equal(ok.headers.get('Content-Type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [7]);
    assert.equal((await worker.fetch(req(`/api/image/${theirs}`), env)).status, 404);
    assert.equal((await worker.fetch(req(`/api/image/${encodeURIComponent(`${UID}/../${theirs}`)}`), env)).status, 404);
    assert.equal((await worker.fetch(req(`/api/image/${theirs}`, { method: 'DELETE' }), env)).status, 404);
    assert.ok(env.RECEIPTS.files.has(theirs));
    await worker.fetch(req(`/api/image/${mine}`, { method: 'DELETE' }), env);
    assert.ok(!env.RECEIPTS.files.has(mine));
  } finally { m.restore(); }
});

test('email only goes to the user or their accountant', async () => {
  const env = baseEnv();
  const m = mockFetch([authOK,
    ['/rest/v1/profiles', () => Response.json([{ accountant_email: 'Acc@Firm.co.uk', business_name: 'Jo Plumbing' }])],
    ['api.resend.com/emails', () => Response.json({ id: 'e1' })]]);
  const send = (to) => worker.fetch(req('/api/email', { method: 'POST', type: 'application/json', body: JSON.stringify({ to, subject: 'Q2', text: 'Hi', attachments: [{ filename: 'q2/../x.csv', content: 'YQ==' }] }) }), env);
  try {
    assert.equal((await send('stranger@example.com')).status, 403);
    assert.equal((await send('acc@firm.co.uk')).status, 200);
    assert.equal((await send('jo@example.com')).status, 200);
    const sent = JSON.parse(m.calls.find((c) => c.url.endsWith('api.resend.com/emails')).init.body);
    assert.deepEqual(sent.to, ['acc@firm.co.uk']);
    assert.equal(sent.reply_to, 'jo@example.com');
    assert.equal(sent.attachments[0].filename, 'q2_.._x.csv');
    assert.match(sent.text, /Sent by Jo Plumbing via Shoebox/);
  } finally { m.restore(); }
});

test('delete account removes files and the Supabase user', async () => {
  const env = baseEnv();
  await env.RECEIPTS.put(`${UID}/a.jpg`, new Uint8Array([1]));
  await env.RECEIPTS.put(`${OTHER}/b.jpg`, new Uint8Array([1]));
  const m = mockFetch([authOK, ['/auth/v1/admin/users/', () => Response.json({})]]);
  try {
    assert.equal((await worker.fetch(req('/api/account', { method: 'DELETE' }), env)).status, 200);
    assert.deepEqual([...env.RECEIPTS.files.keys()], [`${OTHER}/b.jpg`]);
    const del = m.calls.find((c) => c.url.includes('/admin/users/'));
    assert.equal(del.url, `https://sb.test/auth/v1/admin/users/${UID}`);
    assert.equal(del.init.headers.Authorization, 'Bearer service');
  } finally { m.restore(); }
});

test('reminders go out 14 and 3 days before the deadline', async () => {
  const profiles = [
    { email: 'a@x.com', business_name: 'A', quarter_basis: 'standard', submitted: {} },
    { email: 'b@x.com', business_name: '', quarter_basis: 'standard', submitted: { '2026-Q2': true } },
    { email: 'not-an-email', quarter_basis: 'standard', submitted: {} },
  ];
  const m = mockFetch([['/rest/v1/profiles', (u, init) => {
    assert.equal(init.headers.Authorization, 'Bearer service');
    assert.match(u, /reminders=eq\.true/);
    return Response.json(profiles);
  }], ['api.resend.com/emails/batch', () => Response.json({ data: [] })]]);
  try {
    // 7 Nov 2026 deadline: 24 Oct is 14 days before (UK time), 25 Oct is not
    assert.equal(ukToday(new Date('2026-10-24T08:17:00Z')), '2026-10-24');
    assert.equal(await sendReminders(baseEnv(), new Date('2026-10-24T08:17:00Z')), 1);
    const batch = JSON.parse(m.calls.find((c) => c.url.includes('batch')).init.body);
    assert.deepEqual(batch[0].to, ['a@x.com']);
    assert.match(batch[0].subject, /due in 14 days/);
    assert.match(batch[0].text, /6 April 2026 to 5 October 2026 is due by 7 November 2026/);
    assert.match(batch[0].text, /https:\/\/app\.test/);
    assert.equal(await sendReminders(baseEnv(), new Date('2026-10-25T08:17:00Z')), 0);
    assert.equal(await sendReminders(baseEnv(), new Date('2026-11-04T08:17:00Z')), 1);
    assert.equal(await sendReminders({ ...baseEnv(), RESEND_API_KEY: '' }, new Date('2026-11-04T08:17:00Z')), 0);
  } finally { m.restore(); }
});

test('new-style Supabase secret keys are sent only as apikey', async () => {
  const m = mockFetch([['/rest/v1/profiles', (u, init) => {
    assert.equal(init.headers.apikey, 'sb_secret_abc');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json([]);
  }]]);
  try { assert.equal(await sendReminders({ ...baseEnv(), SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc' }), 0); } finally { m.restore(); }
});
