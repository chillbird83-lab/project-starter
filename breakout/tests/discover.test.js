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
  // search 1 + videos 1 + channels 1 + uploads for each of the 2 channels + 1 batched videos call = 6 calls, ~105 units
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((u) => u.pathname.endsWith('/videos')).length, 2);
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

test('only re-checked channels are kept; a guessed score never shows', async () => {
  const { fetchImpl } = fakeYouTube();
  assert.deepEqual(await scanNiche(ytClient('KEY', fetchImpl), 'x', { now: NOW, refineTop: 0 }), []);
  // With room for one channel, the strongest candidate (Tiny Kitchen) is checked; Morning Maker is dropped
  const one = await scanNiche(ytClient('KEY', fakeYouTube().fetchImpl), 'x', { now: NOW, refineTop: 1 });
  assert.deepEqual(one.map((v) => v.ytVideoId), ['tinyhit0001']);
  assert.ok(one.every((v) => v.baselineKind === 'median'));
});

test('videos stored with an estimated (lifetime-average) score are never outliers', async () => {
  const { isOutlier } = await import('../public/js/score.js');
  const v = { views: 20_000_000, durationS: 50, baselineKind: 'average' };
  assert.equal(isOutlier(v, 252, { threshold: 3, minViews: 1000, includeShorts: true }), false);
  assert.equal(isOutlier({ ...v, baselineKind: 'median' }, 252, { threshold: 3, minViews: 1000, includeShorts: true }), true);
});

test('a big channel whose Shorts all get millions is not called an outlier', async () => {
  const BIG = 'UCbigbigbigbigbigbigbig0';
  const day = 864e5;
  const item = (id, views, ageDays) => ({
    id, snippet: { channelId: BIG, title: `Clip ${id}`, liveBroadcastContent: 'none', publishedAt: new Date(NOW - ageDays * day).toISOString(), thumbnails: {} },
    statistics: { viewCount: String(views) }, contentDetails: { duration: 'PT50S' },
  });
  const recent = Array.from({ length: 20 }, (_, i) => item(`bigrecent${String(i).padStart(2, '0')}`, 15_000_000 + i * 100_000, 8 + i));
  const hit = item('bigclip0001', 20_000_000, 12);
  const fetchImpl = async (input) => {
    const u = new URL(String(input));
    const p = u.searchParams;
    const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    switch (u.pathname.split('/').pop()) {
      case 'search': return json({ items: [{ id: { videoId: 'bigclip0001' } }] });
      case 'channels': return json({ items: [{ id: BIG, snippet: { title: 'Huge Studio' }, statistics: { subscriberCount: '20000000', videoCount: '8000', viewCount: '1000000000' }, contentDetails: { relatedPlaylists: { uploads: 'UUbig' } } }] });
      case 'playlistItems': return json({ items: recent.map((v) => ({ contentDetails: { videoId: v.id } })) });
      case 'videos': { const ids = p.get('id').split(','); return json({ items: [hit, ...recent].filter((v) => ids.includes(v.id)) }); }
      default: return json({ items: [] });
    }
  };
  // Against the lifetime average (125K per video) this Short looked like ~250×; against its recent Shorts it's ~2×.
  const found = await scanNiche(ytClient('KEY', fetchImpl), 'marvel', { now: NOW });
  assert.ok(found.every((v) => !v.isOutlier), JSON.stringify(found.map((v) => [v.ytVideoId, v.score])));
});

test('left-out words go into the search and filter what comes back', async () => {
  const { nicheQuery: q, isExcluded } = await import('../public/js/discover.js');
  assert.equal(q({ keywords: 'history, ww2', exclude: 'Marvel, anime , video game' }), 'history | ww2 -marvel -anime -"video game"');
  assert.equal(isExcluded({ title: "Vision's MCU History (summarized by Vision)", tags: ['Marvel Studios'] }, ['marvel']), true);
  assert.equal(isExcluded({ title: "Marvel's best moments" }, ['marvel']), true);
  assert.equal(isExcluded({ title: 'Top 10 war movies' }, ['movie']), true);
  assert.equal(isExcluded({ title: 'The art of war' }, ['art']), true);
  assert.equal(isExcluded({ title: 'Article about the war' }, ['art']), false, 'short words match whole words only');
  assert.equal(isExcluded({ title: 'Best video game history' }, ['video game']), true);
  assert.equal(isExcluded({ title: 'Stalingrad 1942' }, []), false);
  const { fetchImpl, calls } = fakeYouTube();
  const found = await scanNiche(ytClient('KEY', fetchImpl), 'x', { now: NOW, exclude: ['routine'] });
  assert.deepEqual(found.map((v) => v.ytVideoId), ['tinyhit0001']); // "I tried the 5am routine…" left out
  assert.equal(calls.filter((u) => u.pathname.endsWith('/playlistItems')).length, 1, 'no quota spent checking its channel');
});
