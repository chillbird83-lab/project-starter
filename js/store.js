import { addDays, startOfWeek, todayISO, toISO } from './calc.js';
import { uid } from './util.js';

const KEY = 'budgie.v1';

export const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', emoji: '🛒', color: '#34c759', type: 'expense' },
  { id: 'eating-out', name: 'Eating out', emoji: '🍽️', color: '#ff9500', type: 'expense' },
  { id: 'coffee', name: 'Coffee', emoji: '☕', color: '#a2845e', type: 'expense' },
  { id: 'transport', name: 'Transport', emoji: '🚌', color: '#007aff', type: 'expense' },
  { id: 'home', name: 'Home', emoji: '🏠', color: '#5856d6', type: 'expense' },
  { id: 'bills', name: 'Bills', emoji: '💡', color: '#ffcc00', type: 'expense' },
  { id: 'health', name: 'Health', emoji: '💊', color: '#ff2d55', type: 'expense' },
  { id: 'shopping', name: 'Shopping', emoji: '🛍️', color: '#af52de', type: 'expense' },
  { id: 'fun', name: 'Fun', emoji: '🎬', color: '#30b0c7', type: 'expense' },
  { id: 'travel', name: 'Travel', emoji: '✈️', color: '#64d2ff', type: 'expense' },
  { id: 'other', name: 'Other', emoji: '📦', color: '#8e8e93', type: 'expense' },
  { id: 'salary', name: 'Salary', emoji: '💼', color: '#34c759', type: 'income' },
  { id: 'gift', name: 'Gift', emoji: '🎁', color: '#ff9500', type: 'income' },
  { id: 'other-income', name: 'Other income', emoji: '💰', color: '#30b0c7', type: 'income' },
];
export const PROTECTED_CATEGORIES = ['other', 'other-income'];
export const CATEGORY_COLORS = ['#34c759', '#ff9500', '#007aff', '#5856d6', '#ff2d55', '#af52de', '#30b0c7', '#ffcc00', '#a2845e', '#64d2ff'];

export function freshState() {
  return {
    version: 1,
    onboarded: false,
    settings: { currency: 'EUR', weekStart: 1, theme: 'auto' },
    weeklyBudgets: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    transactions: [],
    plans: [],
  };
}

/** Accepts anything parsed from storage / an import file and returns a safe state, or null. */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.transactions)) return null;
  const base = freshState();
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const cats = Array.isArray(raw.categories) && raw.categories.length
    ? raw.categories.filter((c) => c && c.id && c.name).map((c) => ({
        id: String(c.id), name: String(c.name).slice(0, 30), emoji: String(c.emoji || '📦').slice(0, 8),
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#8e8e93', type: c.type === 'income' ? 'income' : 'expense',
      }))
    : base.categories;
  for (const p of PROTECTED_CATEGORIES) if (!cats.some((c) => c.id === p)) cats.push(base.categories.find((c) => c.id === p));
  const catIds = new Set(cats.map((c) => c.id));
  const fallback = (type) => (type === 'income' ? 'other-income' : 'other');
  return {
    version: 1,
    onboarded: !!raw.onboarded,
    settings: {
      currency: typeof raw.settings?.currency === 'string' ? raw.settings.currency : base.settings.currency,
      weekStart: Number.isInteger(raw.settings?.weekStart) && raw.settings.weekStart >= 0 && raw.settings.weekStart <= 6 ? raw.settings.weekStart : 1,
      theme: ['auto', 'light', 'dark'].includes(raw.settings?.theme) ? raw.settings.theme : 'auto',
    },
    weeklyBudgets: (raw.weeklyBudgets || []).filter((b) => isDate(b?.from) && Number.isInteger(b.amount) && b.amount >= 0)
      .map((b) => ({ from: b.from, amount: b.amount })),
    categories: cats,
    transactions: raw.transactions
      .filter((t) => t && isDate(t.date) && Number.isInteger(t.amount) && t.amount > 0 && (t.type === 'expense' || t.type === 'income'))
      .map((t) => ({
        id: String(t.id || uid()), type: t.type, amount: t.amount, date: t.date,
        categoryId: catIds.has(t.categoryId) ? t.categoryId : fallback(t.type),
        note: String(t.note || '').slice(0, 80),
      })),
    plans: (raw.plans || []).filter((p) => p && isDate(p.start) && Number.isInteger(p.amount) && p.amount > 0 && Number.isInteger(p.months) && p.months >= 1 && p.months <= 60)
      .map((p) => ({
        id: String(p.id || uid()), name: String(p.name || 'Plan').slice(0, 40), emoji: String(p.emoji || '🎯').slice(0, 8),
        amount: p.amount, start: p.start, months: p.months,
        categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds.filter((id) => catIds.has(id)) : [],
      })),
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return sanitize(raw) ?? freshState();
  } catch {
    return freshState();
  }
}

let state = load();
let persistError = false;
const subscribers = new Set();

export const get = () => state;
export const subscribe = (fn) => (subscribers.add(fn), () => subscribers.delete(fn));
export const hadPersistError = () => persistError;

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    persistError = false;
  } catch {
    persistError = true; // private mode / quota — the app keeps working in memory
  }
}

/** Run a mutation, persist, and notify the UI. */
export function commit(mutator) {
  mutator(state);
  save();
  subscribers.forEach((fn) => fn(state));
}

export function replaceState(next) {
  commit(() => { state = next; });
}

// ---- mutations -------------------------------------------------------------

/** Sets the weekly budget from `weekStart` onwards (earlier weeks keep their own amount). */
export function setWeeklyBudget(cents, weekStart) {
  commit((s) => {
    s.weeklyBudgets = s.weeklyBudgets.filter((b) => b.from < weekStart);
    s.weeklyBudgets.push({ from: weekStart, amount: cents });
  });
}

export function saveTransaction(tx) {
  commit((s) => {
    const i = s.transactions.findIndex((t) => t.id === tx.id);
    if (i >= 0) s.transactions[i] = tx;
    else s.transactions.push(tx);
  });
}

export function deleteTransaction(id) {
  let removed;
  commit((s) => {
    const i = s.transactions.findIndex((t) => t.id === id);
    if (i >= 0) [removed] = s.transactions.splice(i, 1);
  });
  return removed;
}

export function savePlan(plan) {
  commit((s) => {
    const i = s.plans.findIndex((p) => p.id === plan.id);
    if (i >= 0) s.plans[i] = plan;
    else s.plans.push(plan);
  });
}

export function deletePlan(id) {
  commit((s) => { s.plans = s.plans.filter((p) => p.id !== id); });
}

export function addCategory({ name, emoji, type, color }) {
  const cat = { id: uid(), name, emoji: emoji || '📦', color, type };
  commit((s) => s.categories.push(cat));
  return cat;
}

export function deleteCategory(id) {
  if (PROTECTED_CATEGORIES.includes(id)) return;
  commit((s) => {
    const cat = s.categories.find((c) => c.id === id);
    if (!cat) return;
    const fallback = cat.type === 'income' ? 'other-income' : 'other';
    s.transactions.forEach((t) => { if (t.categoryId === id) t.categoryId = fallback; });
    s.plans.forEach((p) => { p.categoryIds = (p.categoryIds || []).filter((c) => c !== id); });
    s.categories = s.categories.filter((c) => c.id !== id);
  });
}

export function updateSettings(patch) {
  commit((s) => Object.assign(s.settings, patch));
}

export function markOnboarded() {
  commit((s) => { s.onboarded = true; });
}

// ---- sample data -----------------------------------------------------------

/** Deterministic demo data: ~4 weeks of spending, a weekly budget and one long-term plan. */
export function sampleData(base = freshState()) {
  const today = todayISO();
  const weekStart = startOfWeek(today, base.settings.weekStart);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const menu = [
    ['groceries', ['Supermarket', 'Farmers market', 'Bakery'], 900, 3800],
    ['eating-out', ['Lunch', 'Dinner with friends', 'Takeaway'], 800, 3200],
    ['coffee', ['Flat white', 'Latte'], 250, 520],
    ['transport', ['Metro ticket', 'Taxi', 'Fuel'], 280, 2400],
    ['fun', ['Cinema', 'Concert', 'Book'], 1200, 4500],
    ['shopping', ['T-shirt', 'Headphones'], 1500, 6000],
    ['health', ['Pharmacy'], 600, 2200],
  ];
  const txs = [];
  const first = addDays(weekStart, -21);
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const count = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const [categoryId, notes, lo, hi] = pick(menu);
      txs.push({ id: uid(), type: 'expense', categoryId, note: pick(notes), date: d, amount: Math.round((lo + rnd() * (hi - lo)) / 10) * 10 });
    }
  }
  txs.push({ id: uid(), type: 'income', categoryId: 'salary', note: 'Monthly salary', date: addDays(weekStart, -9), amount: 240000 });
  txs.push({ id: uid(), type: 'expense', categoryId: 'bills', note: 'Electricity', date: addDays(weekStart, -4), amount: 6400 });
  const planStart = toISO(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  return {
    ...base,
    onboarded: true,
    weeklyBudgets: [{ from: addDays(weekStart, -21), amount: 30000 }],
    transactions: txs,
    plans: [{ id: uid(), name: 'Autumn & winter', emoji: '🍂', amount: 360000, start: planStart, months: 3, categoryIds: [] }],
  };
}
