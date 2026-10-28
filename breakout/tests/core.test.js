import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelInput, parseDuration, ytClient } from '../public/js/youtube.js';
import { ageFactor, baselines, isOutlier, median, scoreAll, scoreVideo, shouldAlert } from '../public/js/score.js';
import { refreshChannel } from '../public/js/tracker.js';
import { analyseVideo, buildPrompt, normaliseAnalysis } from '../public/js/analyse.js';
import { CH, NOW, fakeYouTube } from './fake-youtube.js';

const day = 864e5;
const iso = (daysAgo) => new Date(NOW - daysAgo * day).toISOString();

test('parses everything people paste', () => {
  assert.deepEqual(parseChannelInput('UC1234567890123456789012'), { kind: 'id', value: CH });
  assert.deepEqual(parseChannelInput('@MrBeast'), { kind: 'handle', value: '@MrBeast' });
  assert.deepEqual(parseChannelInput('mrbeast'), { kind: 'handle', value: '@mrbeast' });
  assert.deepEqual(parseChannelInput('https://www.youtube.com/@MrBeast/videos'), { kind: 'handle', value: '@MrBeast' });
  assert.deepEqual(parseChannelInput('youtube.com/channel/UC1234567890123456789012'), { kind: 'id', value: CH });
  assert.deepEqual(parseChannelInput('https://youtu.be/dQw4w9WgXcQ?si=abc'), { kind: 'video', value: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseChannelInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), { kind: 'video', value: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseChannelInput('https://youtube.com/shorts/abcdefghijk'), { kind: 'video', value: 'abcdefghijk' });
  assert.deepEqual(parseChannelInput('https://m.youtube.com/user/oldname'), { kind: 'username', value: 'oldname' });
  assert.deepEqual(parseChannelInput('https://www.youtube.com/c/SomeName'), { kind: 'search', value: 'SomeName' });
  assert.deepEqual(parseChannelInput('morning maker'), { kind: 'search', value: 'morning maker' });
  assert.equal(parseChannelInput('  '), null);
  assert.equal(parseChannelInput('https://www.youtube.com/'), null);
});

test('durations', () => {
  assert.equal(parseDuration('PT12M30S'), 750);
  assert.equal(parseDuration('PT1H'), 3600);
  assert.equal(parseDuration('P1DT2H3M4S'), 93784);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('nonsense'), 0);
});

test('median and age factor', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(ageFactor(28), 1);
  assert.equal(ageFactor(100), 1);
  assert.equal(ageFactor(7), 0.5);
  assert.equal(ageFactor(0), 0.1);
});

test('baselines use settled videos, split long-form and Shorts', () => {
  const vids = [
    ...[8, 9, 10, 20, 30].map((d, i) => ({ publishedAt: iso(d), views: [1000, 2000, 3000, 4000, 100000][i], durationS: 600 })),
    { publishedAt: iso(2), views: 999999, durationS: 600 }, // too young to count
    ...[8, 9, 10].map((d) => ({ publishedAt: iso(d), views: 50000, durationS: 30 })),
  ];
  assert.deepEqual(baselines(vids, NOW), { long: 3000, short: 50000 });
  // a brand-new channel: young videos are scaled up by their age
  assert.deepEqual(baselines([{ publishedAt: iso(7), views: 500, durationS: 600 }], NOW), { long: 1000, short: 0 });
  assert.deepEqual(baselines([], NOW), { long: 0, short: 0 });
});

test('scores are age-adjusted and outliers respect settings', () => {
  const base = { long: 10000, short: 0 };
  assert.equal(scoreVideo({ publishedAt: iso(28), views: 30000, durationS: 600 }, base, NOW), 3);
  assert.equal(scoreVideo({ publishedAt: iso(7), views: 15000, durationS: 600 }, base, NOW), 3); // half the views at a week old is 1×; 15k is 3×
  assert.equal(scoreVideo({ publishedAt: iso(0.1), views: 50000, durationS: 600 }, base, NOW), 0); // too new to judge
  assert.equal(scoreVideo({ publishedAt: iso(9), views: 5000, durationS: 30 }, base, NOW), 0); // no Shorts baseline
  const v = { publishedAt: iso(28), views: 800, durationS: 600 };
  assert.equal(isOutlier(v, 5, { threshold: 3, minViews: 1000, includeShorts: true }), false); // below min views
  assert.equal(isOutlier({ ...v, views: 5000, durationS: 30 }, 5, { threshold: 3, minViews: 1000, includeShorts: false }), false);
  const [s] = scoreAll([{ publishedAt: iso(3), views: 60000, durationS: 840 }], base, NOW);
  assert.equal(s.isOutlier, true);
  assert.equal(shouldAlert({ ...s, alertedAt: null }, NOW), true);
  assert.equal(shouldAlert({ ...s, alertedAt: '2026-10-27T00:00:00Z' }, NOW), false);
  assert.equal(shouldAlert({ ...s, publishedAt: iso(20) }, NOW), false);
});

test('YouTube client resolves channels several ways and explains quota errors', async () => {
  const { fetchImpl, calls } = fakeYouTube();
  const yt = ytClient('KEY', fetchImpl);
  assert.equal((await yt.resolveChannel('@morningmaker')).title, 'Morning Maker');
  assert.equal((await yt.resolveChannel('https://youtu.be/breakout001')).ytChannelId, CH);
  assert.equal((await yt.resolveChannel('morning maker')).ytChannelId, CH); // search fallback
  await assert.rejects(yt.resolveChannel('@nobody'), /No YouTube channel found/);
  assert.ok(calls.every((u) => u.hostname !== 'www.googleapis.com' || u.searchParams.get('key') === 'KEY'));
  assert.deepEqual(await yt.comments('nocomments1'), []);
  const bad = ytClient('KEY', fakeYouTube({ quotaExceeded: true }).fetchImpl);
  await assert.rejects(bad.channel({ id: CH }), /quota is used up/);
});

test('refreshChannel finds the breakout and costs 3 quota units', async () => {
  const { fetchImpl, calls } = fakeYouTube();
  const out = await refreshChannel(ytClient('KEY', fetchImpl), CH, { now: NOW });
  assert.equal(calls.length, 3);
  assert.equal(out.channel.title, 'Morning Maker');
  assert.equal(out.channel.subscribers, 120000);
  assert.equal(out.videos.length, 14); // the upcoming premiere is dropped
  const outliers = out.videos.filter((v) => v.isOutlier).map((v) => v.ytVideoId);
  assert.deepEqual(outliers, ['breakout001']);
  const b = out.videos.find((v) => v.ytVideoId === 'breakout001');
  assert.equal(b.score, 14.38); // 60,000 views at 3 days vs a 12,750 baseline × 0.33 age factor
  assert.equal(out.videos.find((v) => v.ytVideoId === 'short000001').isShort, true);
});

test('analysis prompt carries the evidence and the answer is cleaned up', async () => {
  const { fetchImpl } = fakeYouTube();
  const { videos, channel } = await refreshChannel(ytClient('KEY', fetchImpl), CH, { now: NOW });
  const video = videos.find((v) => v.ytVideoId === 'breakout001');
  const others = videos.filter((v) => v !== video);
  const prompt = buildPrompt({ video, channel, others, comments: [{ text: 'Day 12 is where it clicked', likes: 340 }], now: NOW });
  assert.match(prompt, /I tried the 5am routine for 30 days/);
  assert.match(prompt, /Typical views for its long-form videos: 12,750/);
  assert.match(prompt, /Normal video 0 — 10,000/);
  assert.match(prompt, /\(340 likes\) Day 12/);

  let sent;
  const gemini = async (url, init) => {
    if (!String(url).includes('generativelanguage')) return fetchImpl(url, init);
    sent = JSON.parse(init.body);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: 'A clear personal challenge with a time frame.', factors: [{ factor: 'Title', insight: 'Challenge + duration' }, { factor: 'Bogus', insight: 'x' }, { factor: 'Topic', insight: '' }],
      title_formula: 'I tried [habit] for [N] days', thumbnail_notes: 'Before/after split', audience_reaction: 'People share their own attempts',
      ideas: [{ title: 'I quit sugar for 30 days', angle: 'Same challenge format' }], confidence: 'maybe',
    }) }] } }] });
  };
  const a = await analyseVideo({ yt: ytClient('KEY', gemini), apiKey: 'G', video, channel, others, fetchImpl: gemini, now: NOW });
  assert.equal(sent.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  assert.equal(a.titleFormula, 'I tried [habit] for [N] days');
  assert.deepEqual(a.factors, [{ factor: 'Title', insight: 'Challenge + duration' }, { factor: 'Other', insight: 'x' }]);
  assert.equal(a.confidence, 'low');
  assert.deepEqual(normaliseAnalysis(null).ideas, []);
});
