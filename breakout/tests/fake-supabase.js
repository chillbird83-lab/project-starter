// An in-memory stand-in for the parts of Supabase's REST API (PostgREST) the Worker uses.
import { randomUUID } from 'node:crypto';

const KEYS = { niches: ['id'], channels: ['id'], videos: ['id'], profiles: ['user_id'], telegram_links: ['user_id'], ideas: ['id'] };

function parseFilter(col, expr) {
  let not = false;
  if (expr.startsWith('not.')) { not = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  const test = (row) => {
    const v = row[col];
    switch (op) {
      case 'eq': return String(v) === val;
      case 'neq': return String(v) !== val;
      case 'gte': return v != null && String(v) >= val;
      case 'lt': return v != null && String(v) < val;
      case 'is': return val === 'null' ? v == null : String(v) === val;
      case 'in': return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
      default: throw new Error(`fake supabase: unsupported op ${op}`);
    }
  };
  return not ? (row) => !test(row) : test;
}

function parseQuery(params) {
  const filters = [];
  let order = null, limit = Infinity, onConflict = null;
  for (const [k, v] of params) {
    if (k === 'select') continue;
    if (k === 'order') { order = v; continue; }
    if (k === 'limit') { limit = Number(v); continue; }
    if (k === 'on_conflict') { onConflict = v.split(','); continue; }
    if (k === 'or') {
      const parts = v.replace(/^\(|\)$/g, '').split(',').map((p) => { const i = p.indexOf('.'); return parseFilter(p.slice(0, i), p.slice(i + 1)); });
      filters.push((row) => parts.some((f) => f(row)));
      continue;
    }
    filters.push(parseFilter(k, v));
  }
  return { filters, order, limit, onConflict };
}

export function fakeSupabase(seed = {}) {
  const db = { niches: [], channels: [], videos: [], profiles: [], telegram_links: [], ideas: [], ...structuredClone(seed) };
  const calls = [];
  const handle = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname + u.search, headers: init.headers, body: init.body });
    const table = u.pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return new Response('no table', { status: 404 });
    const { filters, order, limit, onConflict } = parseQuery(u.searchParams);
    const match = (r) => filters.every((f) => f(r));
    const prefer = init.headers?.Prefer || '';
    const out = (data, status = 200) => (prefer.includes('return=representation') || method === 'GET'
      ? new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 201 }));
    if (method === 'GET') {
      let res = rows.filter(match);
      if (order) {
        const [col, dir] = order.split('.');
        res = [...res].sort((a, b) => {
          if (a[col] == null) return -1;
          if (b[col] == null) return 1;
          return (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }
      return out(res.slice(0, limit));
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const list = Array.isArray(body) ? body : [body];
      const keys = onConflict || KEYS[table];
      const result = [];
      for (const item of list) {
        const existing = prefer.includes('merge-duplicates') && rows.find((r) => keys.every((k) => r[k] !== undefined && String(r[k]) === String(item[k])));
        if (existing) { Object.assign(existing, item); result.push(existing); continue; }
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...item };
        rows.push(row);
        result.push(row);
      }
      return out(result, 201);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, body));
      return out(hit);
    }
    if (method === 'DELETE') {
      db[table] = rows.filter((r) => !match(r));
      return out([]);
    }
    return new Response('bad method', { status: 405 });
  };
  return { db, calls, handle };
}
