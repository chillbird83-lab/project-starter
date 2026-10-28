import test from 'node:test';
import assert from 'node:assert/strict';
import { addSnapshot, sparkline, velocity, withStats } from '../public/js/trend.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const h = 36e5;
const iso = (t) => new Date(t).toISOString();

test('snapshots are spaced out and capped', () => {
  let s = addSnapshot([], 100, NOW);
  s = addSnapshot(s, 150, NOW + 5 * 60e3); // too soon — skipped
  assert.equal(s.length, 1);
  for (let i = 1; i <= 20; i++) s = addSnapshot(s, 100 + i * 10, NOW + i * h);
  assert.equal(s.length, 12);
  assert.equal(s.at(-1).v, 300);
  assert.deepEqual(addSnapshot('garbage', 5, NOW), [{ t: iso(NOW), v: 5 }]);
});

test('a video speeding up is rising; one slowing down is not', () => {
  // 10 days old, 240K views → 1,000/hour on average. Gained 30K in the last 6 hours → 5,000/hour now.
  const speeding = { publishedAt: iso(NOW - 240 * h), views: 240000, snapshots: [{ t: iso(NOW - 6 * h), v: 210000 }, { t: iso(NOW), v: 240000 }] };
  const v1 = velocity(speeding, NOW);
  assert.equal(v1.overall, 1000);
  assert.equal(v1.recent, 5000);
  assert.equal(v1.rising, true);
  // Same video gaining only 1,200 in 6 hours → 200/hour now: slowing down
  const slowing = { ...speeding, snapshots: [{ t: iso(NOW - 6 * h), v: 238800 }, { t: iso(NOW), v: 240000 }] };
  assert.equal(velocity(slowing, NOW).rising, false);
  // One snapshot: no recent rate yet; per-hour falls back to the average
  const fresh = { publishedAt: iso(NOW - 48 * h), views: 4800, snapshots: [{ t: iso(NOW), v: 4800 }] };
  assert.deepEqual(velocity(fresh, NOW), { overall: 100, recent: null, rising: false, perHour: 100 });
  // Very new videos are never "rising" (they always look fast)
  const baby = { publishedAt: iso(NOW - 3 * h), views: 9000, snapshots: [{ t: iso(NOW - 2 * h), v: 1000 }, { t: iso(NOW), v: 9000 }] };
  assert.equal(velocity(baby, NOW).rising, false);
});

test('fresh stats update views, history and score', () => {
  const v = { publishedAt: iso(NOW - 28 * 24 * h), views: 30000, baseline: 10000, durationS: 600, score: 3, snapshots: [] };
  const u = withStats(v, { views: 50000, likes: 900 }, NOW);
  assert.equal(u.views, 50000);
  assert.equal(u.likes, 900);
  assert.equal(u.score, 5);
  assert.equal(u.snapshots.length, 1);
  assert.equal(withStats({ ...v, baseline: 0 }, { views: 99 }, NOW).score, 3); // no baseline → keep score
});

test('sparkline draws a line once there are two points', () => {
  assert.equal(sparkline([{ t: iso(NOW), v: 1 }]), '');
  assert.match(sparkline([{ t: iso(NOW - h), v: 1 }, { t: iso(NOW), v: 5 }]), /<polyline points="0.0,30.0 120.0,2.0"/);
});
