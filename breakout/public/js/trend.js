// "Rising now": a short view history per video, so we can tell a video that is speeding up from one
// that is coasting on old views. Pure functions, unit-tested.
import { scoreVideo } from './score.js';

/** How many view snapshots to keep per video. */
export const MAX_SNAPSHOTS = 12;
/** Snapshots closer together than this are skipped (the newest one stays). */
export const MIN_GAP_MINUTES = 20;
/** A rate is measured over at least this long. */
const MIN_SPAN_HOURS = 1;
/** …and from a snapshot no older than this. */
const MAX_SPAN_HOURS = 48;
/** Brand-new videos always look fast; judge them after this. */
const MIN_AGE_HOURS = 6;
/** Rising = gaining views at least this much faster than its own average so far. */
export const RISING_RATIO = 1.2;
const MIN_RISING_PER_HOUR = 50;

const valid = (list) => (Array.isArray(list) ? list : []).filter((s) => s && typeof s.t === 'string' && Number.isFinite(s.v));

/** Adds a { t, v } snapshot (time, views), keeping the list short and spaced out. */
export function addSnapshot(snapshots, views, now = Date.now()) {
  const list = valid(snapshots);
  const last = list.at(-1);
  if (last && now - Date.parse(last.t) < MIN_GAP_MINUTES * 6e4) return list;
  return [...list, { t: new Date(now).toISOString(), v: views }].slice(-MAX_SNAPSHOTS);
}

/**
 * Views per hour: `overall` since publishing, `recent` between snapshots (null until there are two far
 * enough apart), and whether it is `rising` — gaining faster now than its average so far. Most videos
 * slow down over time, so a recent rate above the overall one means it has picked up speed.
 */
export function velocity(v, now = Date.now()) {
  const ageHours = Math.max(1, (now - Date.parse(v.publishedAt)) / 36e5);
  const overall = (v.views || 0) / ageHours;
  const snaps = valid(v.snapshots);
  let recent = null;
  const last = snaps.at(-1);
  if (last) {
    const lastT = Date.parse(last.t);
    const ref = snaps.find((s) => {
      const span = (lastT - Date.parse(s.t)) / 36e5;
      return span >= MIN_SPAN_HOURS && span <= MAX_SPAN_HOURS;
    });
    if (ref) recent = Math.max(0, (last.v - ref.v) / ((lastT - Date.parse(ref.t)) / 36e5));
  }
  const rising = recent != null && ageHours >= MIN_AGE_HOURS && recent >= MIN_RISING_PER_HOUR && recent >= overall * RISING_RATIO;
  return { overall, recent, rising, perHour: recent ?? overall };
}

/** Fresh stats for a stored video: new views, a new snapshot, and its score against the stored baseline. */
export function withStats(v, fresh, now = Date.now()) {
  const views = fresh.views ?? v.views;
  const base = v.baseline || 0;
  return {
    ...v,
    views, likes: fresh.likes ?? v.likes, comments: fresh.comments ?? v.comments,
    snapshots: addSnapshot(v.snapshots, views, now),
    score: base ? scoreVideo({ ...v, views }, { long: base, short: base }, now) : v.score,
  };
}

/** Tiny SVG line of the view history, for the video screen. */
export function sparkline(snapshots, { width = 120, height = 32 } = {}) {
  const list = valid(snapshots);
  if (list.length < 2) return '';
  const t0 = Date.parse(list[0].t), t1 = Date.parse(list.at(-1).t);
  const vMin = Math.min(...list.map((s) => s.v)), vMax = Math.max(...list.map((s) => s.v));
  const x = (t) => (t1 === t0 ? 0 : ((Date.parse(t) - t0) / (t1 - t0)) * width);
  const y = (v) => (vMax === vMin ? height / 2 : height - ((v - vMin) / (vMax - vMin)) * (height - 4) - 2);
  const pts = list.map((s) => `${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
