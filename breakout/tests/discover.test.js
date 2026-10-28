import test from 'node:test';
import assert from 'node:assert/strict';
import { nicheQuery, scanNiche } from '../public/js/discover.js';
import { ytClient } from '../public/js/youtube.js';
import { NOW, OTHER, fakeYouTube } from './fake-youtube.js';

test('niche search words become a YouTube OR query', () => {
  assert.equal(nicheQuery({ name: 'Cooking', keywords: ' meal prep, budget recipes ,' }), 'meal prep | budget recipes');
  assert.equal(nicheQuery({ name: 'Cooking', keywords: '' }), 'Cooking');
  assert.equal(nicheQuery({ keywords: 'a,b,c,d,e,f,g' }), 'a | b | c | d | e');
  assert.equal(nicheQuery({}), '');
});

test('a niche scan finds outliers from any channel, checked against their real baseline', async () => {
  const { fetchImpl, calls } = fakeYouTube();
  const found = await scanNiche(ytClient('KEY', fetchImpl), 'budget cooking', { now: NOW });
  const search = calls.find((u) => u.pathname.endsWith('/search'));
  assert.equal(search.searchParams.get('type'), 'video');
  assert.equal(search.searchParams.get('order'), 'viewCount');
  assert.equal(search.searchParams.get('publishedAfter'), new Date(NOW - 30 * 864e5).toISOString());
  // search 1 + videos 1 + channels 1 + (uploads + videos) for each of the 2 channels = 7 calls, ~107 units
  assert.equal(calls.length, 7);
  const byId = Object.fromEntries(found.map((v) => [v.ytVideoId, v]));
  assert.deepEqual(Object.keys(byId).sort(), ['breakout001', 'tinyhit0001']); // ordinary videos are dropped
  const tiny = byId.tinyhit0001;
  assert.equal(tiny.channelTitle, 'Tiny Kitchen');
  assert.equal(tiny.ytChannelId, OTHER);
  assert.equal(tiny.baselineKind, 'median');
  assert.equal(tiny.baseline, 800); // median of its settled videos, not the 1,000 lifetime average
  assert.equal(tiny.isOutlier, true);
  assert.equal(tiny.source, 'search');
  assert.equal(byId.breakout001.score, 14.38);
  assert.deepEqual(await scanNiche(ytClient('KEY', fetchImpl), '', { now: NOW }), []);
});

test('only the top channels are re-checked; the rest keep the lifetime-average score', async () => {
  const { fetchImpl } = fakeYouTube();
  const found = await scanNiche(ytClient('KEY', fetchImpl), 'x', { now: NOW, refineTop: 0 });
  assert.ok(found.every((v) => v.baselineKind === 'average'));
  const tiny = found.find((v) => v.ytVideoId === 'tinyhit0001');
  assert.equal(tiny.baseline, 1000); // 40,000 lifetime views / 40 videos
});
