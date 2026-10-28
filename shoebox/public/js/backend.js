// Two interchangeable backends with the same methods:
//  - cloud: Supabase (email-code sign-in + Postgres with row-level security) and the Worker API
//           (Gemini, R2 photos, Resend email). No SDK — plain fetch against Supabase's REST endpoints.
//  - local: everything in this browser's IndexedDB; receipts are read with the user's own Gemini key.
import * as db from './db.js';
import { extractReceipt } from './extract.js';
import { DEFAULT_SETTINGS } from './tax.js';
import { uid } from './util.js';

const SESSION_KEY = 'shoebox.session';
const MODE_KEY = 'shoebox.mode';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };

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
    return { cloud: false, ai: false, email: false, reminders: false };
  }
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

const toRow = (r, userId) => ({
  id: r.id, user_id: userId, kind: r.kind, date: r.date, merchant: r.merchant || '', description: r.description || '',
  category: r.category, gross_pence: r.gross, vat_pence: r.vat || 0, business_pct: r.businessPct ?? 100,
  payment: r.payment || '', vat_number: r.vatNumber || '', image_key: r.imageKey || null,
});
const fromRow = (row) => ({
  id: row.id, kind: row.kind, date: row.date, merchant: row.merchant, description: row.description, category: row.category,
  gross: row.gross_pence, vat: row.vat_pence, businessPct: row.business_pct, payment: row.payment, vatNumber: row.vat_number,
  imageKey: row.image_key, createdAt: row.created_at, updatedAt: row.updated_at,
});
const toProfile = (s, user) => ({
  user_id: user.id, email: user.email, business_name: s.businessName, vat_registered: s.vatRegistered, vat_stagger: s.vatStagger,
  quarter_basis: s.quarterBasis, reminders: s.reminders, accountant_email: s.accountantEmail, submitted: s.submitted,
});
const fromProfile = (p) => ({
  ...DEFAULT_SETTINGS, onboarded: true, businessName: p.business_name, vatRegistered: p.vat_registered, vatStagger: p.vat_stagger,
  quarterBasis: p.quarter_basis, reminders: p.reminders, accountantEmail: p.accountant_email, submitted: p.submitted || {},
});

export function cloudBackend(config, { onSignedOut } = {}) {
  const base = config.supabaseUrl.replace(/\/+$/, '');
  const anon = config.supabaseAnonKey;
  let session = readJSON(SESSION_KEY);
  let refreshing = null;
  const images = new Map();

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

  const rest = async (path, { method = 'GET', body, prefer, range } = {}) => {
    const res = await call(`${base}/rest/v1/${path}`, {
      method,
      headers: { apikey: anon, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}), ...(range ? { Range: range } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text(); // empty with Prefer: return=minimal
    return text ? JSON.parse(text) : null;
  };

  const api = (path, init) => call(`api/${path}`, init).then((r) => r.json());

  return {
    mode: 'cloud',
    config,
    get user() { return session?.user ? { id: session.user.id, email: session.user.email } : null; },

    sendCode: (email) => auth('otp', { email, create_user: true }),
    async verifyCode(email, code) { saveSession(await auth('verify', { type: 'email', email, token: code })); },
    async signOut() {
      const t = session?.access_token;
      saveSession(null);
      images.forEach((u) => URL.revokeObjectURL(u));
      images.clear();
      if (t) await auth('logout', {}, t).catch(() => {});
    },

    async load() {
      const records = [];
      for (let from = 0; ; from += 1000) {
        const rows = await rest('receipts?select=*&order=date.desc,created_at.desc', { range: `${from}-${from + 999}` });
        records.push(...rows.map(fromRow));
        if (rows.length < 1000) break;
      }
      const [profile] = await rest(`profiles?select=*&user_id=eq.${this.user.id}`);
      return { records, settings: profile ? fromProfile(profile) : { ...DEFAULT_SETTINGS, onboarded: false } };
    },
    async saveRecords(list) {
      const rows = await rest('receipts', { method: 'POST', body: list.map((r) => toRow(r, this.user.id)), prefer: 'resolution=merge-duplicates,return=representation' });
      return rows.map(fromRow);
    },
    deleteRecord: (id) => rest(`receipts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async saveSettings(s) {
      await rest('profiles', { method: 'POST', body: toProfile(s, this.user), prefer: 'resolution=merge-duplicates,return=minimal' });
    },

    async scan(blob, type) {
      return api('scan', { method: 'POST', headers: { 'Content-Type': type }, body: blob });
    },
    async fileURL(key) {
      if (!images.has(key)) images.set(key, URL.createObjectURL(await (await call(`api/image/${encodeURIComponent(key)}`)).blob()));
      return images.get(key);
    },
    async deleteFile(key) {
      if (images.has(key)) { URL.revokeObjectURL(images.get(key)); images.delete(key); }
      await call(`api/image/${encodeURIComponent(key)}`, { method: 'DELETE' });
    },
    email: (msg) => api('email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }),
    async deleteEverything() {
      await api('account', { method: 'DELETE' });
      await this.signOut();
    },
  };
}

// ---------------------------------------------------------------------------
// Local (this device only)
// ---------------------------------------------------------------------------

export function localBackend(config) {
  const images = new Map();
  return {
    mode: 'local',
    config,
    user: null,
    async load() {
      const [records, settings] = await Promise.all([db.getAll('records'), db.get('kv', 'settings')]);
      return { records, settings: { ...DEFAULT_SETTINGS, onboarded: false, geminiKey: '', geminiModel: '', ...settings } };
    },
    async saveRecords(list) { await db.putMany('records', list); return list; },
    deleteRecord: (id) => db.del('records', id),
    saveSettings: (s) => db.put('kv', s, 'settings'),

    /** Stores the file and, when the user added their own Gemini key, reads it straight from the browser. */
    async scan(blob, type, settings) {
      const imageKey = `local/${uid()}.${EXT[type] || 'bin'}`;
      await db.put('files', blob, imageKey);
      if (!settings.geminiKey) {
        return { imageKey, draft: null, warnings: [], error: 'Add a free Gemini key in Settings to read receipts automatically. For now, type the details in.' };
      }
      try {
        const out = await extractReceipt({ apiKey: settings.geminiKey, model: settings.geminiModel || undefined, buffer: await blob.arrayBuffer(), mimeType: type });
        return { imageKey, ...out };
      } catch (e) {
        return { imageKey, draft: null, warnings: [], error: navigator.onLine === false ? 'You’re offline, so please type the details in.' : `Couldn’t read the receipt. ${e.message}` };
      }
    },
    async fileURL(key) {
      if (!images.has(key)) {
        const blob = await db.get('files', key);
        if (!blob) throw new Error('This receipt file is missing.');
        images.set(key, URL.createObjectURL(blob));
      }
      return images.get(key);
    },
    async deleteFile(key) {
      if (images.has(key)) { URL.revokeObjectURL(images.get(key)); images.delete(key); }
      await db.del('files', key);
    },
    fileBlob: (key) => db.get('files', key),
    putFile: (key, blob) => db.put('files', blob, key),
    async deleteEverything() { await Promise.all([db.clear('records'), db.clear('files'), db.clear('kv')]); },
  };
}
