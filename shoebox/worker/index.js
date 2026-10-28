// Shoebox API on Cloudflare Workers. Serves the app (static assets) and keeps every secret server-side:
//   GET    /api/config        public settings the app needs (Supabase URL + anon key, what is switched on)
//   POST   /api/scan          store a receipt photo/PDF in R2 and read it with Gemini
//   GET    /api/image/:key    a receipt file (owner only)
//   DELETE /api/image/:key
//   POST   /api/email         send an export to yourself or your accountant with Resend
//   DELETE /api/account       delete every file and the Supabase account (rows cascade)
// A daily cron emails Making Tax Digital deadline reminders.
import { ACCEPTED_TYPES, DEFAULT_MODEL, MAX_UPLOAD_BYTES, extractReceipt } from '../public/js/extract.js';
import { diffDays, fromISO } from '../public/js/dates.js';
import { nextDeadline } from '../public/js/tax.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$/;
const MAX_EMAIL_BYTES = 5 * 1024 * 1024;
const REMIND_DAYS = [14, 3];
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const cloudReady = (env) => !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
const emailReady = (env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM);
// Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey.
const serviceHeaders = (env) => {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
};

/** Today in the UK, as YYYY-MM-DD. */
export const ukToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
const longDate = (iso) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(fromISO(iso));

/** The signed-in Supabase user behind the request's bearer token, or null. */
async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!cloudReady(env) || !/^Bearer [\w.-]+$/.test(auth)) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id, email: u.email, auth } : null;
}

const ownsKey = (user, key) => KEY_RE.test(key) && key.startsWith(`${user.id}/`);

async function scan(request, env, user) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!ACCEPTED_TYPES.includes(type)) return fail(415, 'Send a JPEG, PNG, WebP, HEIC photo or a PDF.');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_UPLOAD_BYTES) return fail(413, 'That file is over 10 MB.');
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) return fail(400, 'The file is empty.');
  if (buffer.byteLength > MAX_UPLOAD_BYTES) return fail(413, 'That file is over 10 MB.');

  const imageKey = `${user.id}/${crypto.randomUUID()}.${EXT[type]}`;
  await env.RECEIPTS.put(imageKey, buffer, { httpMetadata: { contentType: type } });

  if (!env.GEMINI_API_KEY) return json({ imageKey, draft: null, warnings: [], error: 'Receipt reading is not set up yet, so please type the details in.' });
  try {
    const { draft, warnings } = await extractReceipt({
      apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_MODEL, buffer, mimeType: type, today: ukToday(),
    });
    return json({ imageKey, draft, warnings });
  } catch (e) {
    console.error('extract failed', e);
    return json({ imageKey, draft: null, warnings: [], error: `Couldn’t read the receipt, so please type the details in. ${e.message}` });
  }
}

async function image(request, env, user, key) {
  if (!ownsKey(user, key)) return fail(404, 'Not found.');
  if (request.method === 'DELETE') { await env.RECEIPTS.delete(key); return json({ ok: true }); }
  const obj = await env.RECEIPTS.get(key);
  if (!obj) return fail(404, 'Not found.');
  return new Response(obj.body, {
    headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=604800, immutable' },
  });
}

/** Sends an export to the user's own address or the accountant address saved in their profile. */
async function email(request, env, user) {
  if (!emailReady(env)) return fail(503, 'Email is not set up on this server.');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_EMAIL_BYTES) return fail(413, 'The export is too large to email.');
  let body;
  try { body = await request.json(); } catch { return fail(400, 'Invalid request.'); }
  const to = String(body?.to || '').trim().toLowerCase();
  const profile = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=accountant_email,business_name&user_id=eq.${user.id}`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: user.auth },
  }).then((r) => (r.ok ? r.json() : [])).then((rows) => rows[0] || {});
  const allowed = [user.email, profile.accountant_email].filter(Boolean).map((e) => e.trim().toLowerCase());
  if (!EMAIL_RE.test(to) || !allowed.includes(to)) return fail(403, 'Exports can only go to your own email or the accountant email in Settings.');

  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)
    .filter((a) => typeof a?.filename === 'string' && typeof a?.content === 'string')
    .map((a) => ({ filename: a.filename.replace(/[^\w.() -]/g, '_').slice(0, 80), content: a.content }));
  const from = profile.business_name ? `${profile.business_name} via Shoebox` : user.email;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      reply_to: user.email,
      subject: String(body.subject || 'Shoebox export').slice(0, 150),
      text: `${String(body.text || '').slice(0, 4000)}\n\nSent by ${from}.`,
      attachments,
    }),
  });
  if (!res.ok) { console.error('resend', res.status, await res.text()); return fail(502, 'The email could not be sent. Please try again.'); }
  return json({ ok: true });
}

async function deleteAccount(env, user) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return fail(503, 'Account deletion is not set up on this server.');
  let cursor;
  do {
    const page = await env.RECEIPTS.list({ prefix: `${user.id}/`, cursor });
    if (page.objects.length) await env.RECEIPTS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: serviceHeaders(env) });
  if (!res.ok) return fail(502, 'Your files were deleted but the account could not be. Please try again.');
  return json({ ok: true });
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/api/config' && method === 'GET') {
    return json({
      cloud: cloudReady(env), supabaseUrl: env.SUPABASE_URL || '', supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
      ai: !!env.GEMINI_API_KEY, email: emailReady(env), reminders: emailReady(env) && !!env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  const user = await getUser(request, env);
  if (!user) return fail(401, 'Please sign in again.');
  if (pathname === '/api/scan' && method === 'POST') return scan(request, env, user);
  if (pathname.startsWith('/api/image/') && (method === 'GET' || method === 'DELETE')) {
    return image(request, env, user, decodeURIComponent(pathname.slice('/api/image/'.length)));
  }
  if (pathname === '/api/email' && method === 'POST') return email(request, env, user);
  if (pathname === '/api/account' && method === 'DELETE') return deleteAccount(env, user);
  return fail(404, 'Not found.');
}

/** Emails everyone with reminders on, 14 and 3 days before their next quarterly update is due. */
export async function sendReminders(env, now = new Date()) {
  if (!cloudReady(env) || !emailReady(env) || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const today = ukToday(now);
  const messages = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=email,business_name,quarter_basis,submitted&reminders=eq.true&email=not.is.null&order=user_id`, {
      headers: { ...serviceHeaders(env), Range: `${offset}-${offset + 999}` },
    });
    if (!res.ok) { console.error('profiles', res.status); break; }
    const rows = await res.json();
    for (const p of rows) {
      if (!EMAIL_RE.test(p.email || '')) continue;
      const q = nextDeadline(today, p.quarter_basis === 'calendar' ? 'calendar' : 'standard', p.submitted || {});
      const days = q && diffDays(today, q.deadline);
      if (!q || !REMIND_DAYS.includes(days)) continue;
      messages.push({
        from: env.EMAIL_FROM,
        to: [p.email],
        subject: `Your Making Tax Digital update is due in ${days} days`,
        text: [
          `Hi${p.business_name ? ` ${p.business_name}` : ''},`,
          '',
          `Your quarterly update for ${longDate(q.yearStart)} to ${longDate(q.end)} is due by ${longDate(q.deadline)}.`,
          'Check that every receipt is in, then export the totals for your MTD software or accountant.',
          env.APP_URL ? `\nOpen Shoebox: ${env.APP_URL}` : '',
          '\nYou get this because reminders are on. Turn them off in Shoebox → Settings.',
        ].join('\n'),
      });
    }
    if (rows.length < 1000) break;
  }
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
    if (!res.ok) console.error('resend batch', res.status, await res.text());
  }
  return messages.length;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    try {
      return await route(request, env, url);
    } catch (e) {
      console.error(e);
      return fail(500, 'Something went wrong. Please try again.');
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env, new Date(event.scheduledTime)));
  },
};
