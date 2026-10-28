// App state: the records and settings of whoever is signed in, kept in sync with the backend.
import { EXPENSE_IDS, INCOME_IDS } from './categories.js';
import { isISODate } from './dates.js';
import { DEFAULT_SETTINGS } from './tax.js';
import { uid } from './util.js';

let backend = null;
let state = { ready: false, records: [], settings: { ...DEFAULT_SETTINGS } };
const listeners = new Set();

export const get = () => state;
export const api = () => backend;
export const subscribe = (fn) => listeners.add(fn);
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };

const sortRecords = (list) => list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

export async function connect(b) {
  backend = b;
  set({ ready: false, records: [] });
  const { records, settings } = await b.load();
  set({ ready: true, records: sortRecords(records.map(sanitizeRecord).filter(Boolean)), settings: sanitizeSettings(settings) });
}

export function disconnect() {
  backend = null;
  set({ ready: false, records: [], settings: { ...DEFAULT_SETTINGS } });
}

/** Accepts a record from a form, the AI or a backup file and returns a safe one, or null. */
export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || !isISODate(r.date)) return null;
  const kind = r.kind === 'income' ? 'income' : 'expense';
  const gross = Number.isInteger(r.gross) && r.gross >= 0 && r.gross <= 999_999_999 ? r.gross : null;
  if (gross === null) return null;
  const ids = kind === 'income' ? INCOME_IDS : EXPENSE_IDS;
  const pct = Number(r.businessPct);
  return {
    id: typeof r.id === 'string' && /^[0-9a-f-]{36}$/i.test(r.id) ? r.id : uid(),
    kind,
    date: r.date,
    merchant: String(r.merchant ?? '').slice(0, 80),
    description: String(r.description ?? '').slice(0, 120),
    category: ids.includes(r.category) ? r.category : (kind === 'income' ? 'turnover' : 'otherExpenses'),
    gross,
    vat: Number.isInteger(r.vat) ? Math.min(Math.max(0, r.vat), gross) : 0,
    businessPct: kind === 'income' ? 100 : (Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : 100),
    payment: ['card', 'cash', 'bank_transfer', 'other'].includes(r.payment) ? r.payment : '',
    vatNumber: String(r.vatNumber ?? '').slice(0, 20),
    imageKey: typeof r.imageKey === 'string' && r.imageKey ? r.imageKey : null,
    createdAt: r.createdAt || new Date().toISOString(),
    updatedAt: r.updatedAt || null,
  };
}

export function sanitizeSettings(s = {}) {
  const email = (v) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim() : '');
  return {
    ...DEFAULT_SETTINGS,
    onboarded: !!s.onboarded,
    businessName: String(s.businessName ?? '').slice(0, 80),
    vatRegistered: !!s.vatRegistered,
    vatStagger: [1, 2, 3].includes(Number(s.vatStagger)) ? Number(s.vatStagger) : 1,
    quarterBasis: s.quarterBasis === 'calendar' ? 'calendar' : 'standard',
    reminders: s.reminders !== false,
    accountantEmail: email(s.accountantEmail),
    submitted: s.submitted && typeof s.submitted === 'object' ? Object.fromEntries(Object.entries(s.submitted).filter(([k, v]) => /^\d{4}-Q[1-4]$/.test(k) && v === true)) : {},
    ...(backend?.mode === 'local' ? { geminiKey: String(s.geminiKey ?? '').trim(), geminiModel: String(s.geminiModel ?? '').trim() } : {}),
  };
}

export async function saveRecord(input) {
  const rec = sanitizeRecord({ ...input, updatedAt: new Date().toISOString() });
  if (!rec) throw new Error('That record is not valid.');
  const [saved] = await backend.saveRecords([rec]);
  const clean = sanitizeRecord(saved) ?? rec;
  set({ records: sortRecords([...state.records.filter((r) => r.id !== clean.id), clean]) });
  return clean;
}

export async function importRecords(list) {
  const clean = list.map(sanitizeRecord).filter(Boolean);
  for (let i = 0; i < clean.length; i += 500) await backend.saveRecords(clean.slice(i, i + 500));
  const ids = new Set(clean.map((r) => r.id));
  set({ records: sortRecords([...state.records.filter((r) => !ids.has(r.id)), ...clean]) });
  return clean.length;
}

/** Removes the record; its file is kept until `purgeFile` so the deletion can be undone. */
export async function deleteRecord(id) {
  const rec = state.records.find((r) => r.id === id);
  await backend.deleteRecord(id);
  set({ records: state.records.filter((r) => r.id !== id) });
  return rec;
}

export async function purgeFile(key) {
  if (key && !state.records.some((r) => r.imageKey === key)) await backend.deleteFile(key).catch(() => {});
}

export async function saveSettings(patch) {
  const settings = sanitizeSettings({ ...state.settings, ...patch });
  await backend.saveSettings(settings);
  set({ settings });
  return settings;
}
