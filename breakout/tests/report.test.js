import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanIdea, hasIdea, ideaFromAnalysis, ideasIn, nextStage } from '../public/js/ideas.js';
import { TRACKED_KEY, normaliseSummary, sharedWords, summaryRequest, titlePatterns, weekStart, weeklyReport } from '../public/js/report.js';
import { channelsFromScan, cleanDismissed, interestQuery, suggestChannels } from '../public/js/similar.js';

const NOW = Date.parse('2026-10-28T12:00:00Z'); // a Wednesday
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString();
const SETTINGS = { threshold: 3, minViews: 1000, includeShorts: true, alerts: true, language: 'any', hideMixed: true, hideLanguages: [] };
const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa', CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb', CH_C = 'UCcccccccccccccccccccccc';

let n = 0;
const vid = (o) => ({ id: `v${++n}`, ytVideoId: `yt${n}`, title: 'x', publishedAt: iso(NOW - 2 * DAY), views: 50000, score: 5, durationS: 600, nicheIds: [], channelId: null, ...o });

test('title patterns: what most breakouts share, and more often than the other videos', () => {
  const hits = [
    vid({ title: 'I cooked for 7 days on £5' }), vid({ title: 'Feed 4 people for £10' }),
    vid({ title: 'My 30 day budget challenge' }), vid({ title: 'Cheap dinners that taste rich' }),
  ];
  const ids = titlePatterns(hits).map((p) => p.id);
  assert.ok(ids.includes('number'));
  assert.ok(ids.includes('money'));
  const number = titlePatterns(hits).find((p) => p.id === 'number');
  assert.deepEqual([number.count, number.total], [3, 4]);
  // When the other videos use numbers just as often, numbers aren't what made these stand out.
  const others = Array.from({ length: 6 }, (_, i) => vid({ title: `Pasta night ${i + 1}`, score: 1.6 }));
  assert.ok(!titlePatterns(hits, others).some((p) => p.id === 'number'));
  assert.ok(titlePatterns(hits, others).some((p) => p.id === 'money'));
  assert.deepEqual(titlePatterns([hits[0]]), [], 'one video has no shared pattern');
});

test('shared words leave out stop words and the niche’s own words', () => {
  const list = [vid({ title: 'Budget cooking: lentil curry' }), vid({ title: 'Lentil soup for the week' }), vid({ title: 'Budget lentil bake' })];
  assert.deepEqual(sharedWords(list, 'budget cooking'), [{ word: 'lentil', count: 3 }]);
});

test('the weekly report groups breakouts by niche, best first, and respects filters', () => {
  const niches = [{ id: 'n1', name: 'budget cooking', keywords: 'budget cooking', exclude: 'vegan' }, { id: 'n2', name: 'history', keywords: 'history', exclude: '' }];
  const channels = [{ id: 'c1', ytChannelId: CH_A, title: 'Morning Maker', nicheId: null }];
  const videos = [
    vid({ title: 'Feed 4 for £5', nicheIds: ['n1'], score: 12 }),
    vid({ title: 'Week of meals for £20', nicheIds: ['n1'], score: 6 }),
    vid({ title: 'Vegan meals for £10', nicheIds: ['n1'], score: 20 }), // left out by the niche
    vid({ title: 'Old one', nicheIds: ['n1'], score: 30, publishedAt: iso(NOW - 12 * DAY) }), // older than a week
    vid({ title: 'Small one', nicheIds: ['n1'], score: 2 }), // below the threshold
    vid({ title: 'Видео на русском языке', nicheIds: ['n1'], score: 9 }),
    vid({ title: 'I tried waking at 5am', channelId: 'c1', score: 8 }),
  ];
  const r = weeklyReport({ niches, channels, videos, settings: { ...SETTINGS, language: 'en' }, now: NOW });
  const cooking = r.groups.find((g) => g.key === 'n1');
  assert.deepEqual(cooking.top.map((v) => v.title), ['Feed 4 for £5', 'Week of meals for £20']);
  assert.ok(cooking.patterns.some((p) => p.id === 'money'));
  assert.equal(r.groups.find((g) => g.key === 'n2').total, 0);
  const tracked = r.groups.find((g) => g.key === TRACKED_KEY);
  assert.equal(tracked.total, 1);
  assert.equal(r.total, 3);
});

test('reports belong to the Monday 08:00 UTC before them', () => {
  assert.equal(iso(weekStart(NOW)), '2026-10-26T08:00:00.000Z');
  assert.equal(iso(weekStart(Date.parse('2026-10-26T07:00:00Z'))), '2026-10-19T08:00:00.000Z');
  assert.equal(iso(weekStart(Date.parse('2026-10-26T08:00:00Z'))), '2026-10-26T08:00:00.000Z');
});

test('the AI summary keeps only niches that are in the report', () => {
  const report = { groups: [{ key: 'n1', name: 'cooking', total: 1, top: [vid({ title: 'Feed 4 for £5' })], patterns: [] }, { key: 'n2', name: 'quiet', total: 0, top: [], patterns: [] }] };
  const body = summaryRequest(report);
  assert.match(body.contents[0].parts[0].text, /key=n1 "cooking"/);
  assert.doesNotMatch(body.contents[0].parts[0].text, /quiet/);
  const s = normaliseSummary({ niches: [{ key: 'n1', pattern: ' Cheap, specific meals. ', idea: 'Feed 6 for £6' }, { key: 'zzz', pattern: 'made up' }] }, report, NOW);
  assert.deepEqual(s.items, { n1: { pattern: 'Cheap, specific meals.', idea: 'Feed 6 for £6' } });
});

test('ideas: saved from an analysis, deduplicated and moved through the stages', () => {
  const v = vid({ title: 'Feed 4 for £5', channelTitle: 'Tiny Kitchen', score: 14 });
  const idea = ideaFromAnalysis(v, { title: '  Feed 6 for £6 ', angle: 'Bigger family' }, { titleFormula: 'Feed [N] for £[N]' });
  assert.equal(idea.title, 'Feed 6 for £6');
  assert.equal(idea.formula, 'Feed [N] for £[N]');
  assert.equal(idea.sourceScore, 14);
  assert.equal(idea.status, 'todo');
  assert.ok(hasIdea([{ ...idea, id: 'i1' }], v.id, 'feed 6 for £6!'));
  assert.ok(!hasIdea([{ ...idea, id: 'i1' }], 'other', 'Feed 6 for £6'));
  assert.equal(cleanIdea({ title: 'x', status: 'bogus' }).status, 'todo');
  assert.equal(nextStage('todo'), 'making');
  assert.equal(nextStage('making'), 'done');
  const list = [{ id: 'a', status: 'todo', updatedAt: '2026-10-01' }, { id: 'b', status: 'todo', updatedAt: '2026-10-05' }, { id: 'c', status: 'done' }];
  assert.deepEqual(ideasIn(list, 'todo').map((i) => i.id), ['b', 'a']);
});

test('similar channels: small, untracked channels you engaged with come first', () => {
  const videos = [
    vid({ ytChannelId: CH_A, channelTitle: 'Tiny Kitchen', channelSubs: 900, opens: 3, score: 14, nicheIds: ['n1'] }),
    vid({ ytChannelId: CH_A, channelTitle: 'Tiny Kitchen', channelSubs: 900, saved: true, score: 6 }),
    vid({ ytChannelId: CH_B, channelTitle: 'Big Chef', channelSubs: 2_000_000, opens: 5, score: 9 }), // not small
    vid({ ytChannelId: CH_C, channelTitle: 'Quiet Cook', channelSubs: 4000, score: 2 }), // no interest, not an outlier
    vid({ ytChannelId: 'UCdddddddddddddddddddddd', channelTitle: 'Two Hits', channelSubs: 5000, score: 5 }),
    vid({ ytChannelId: 'UCdddddddddddddddddddddd', channelTitle: 'Two Hits', channelSubs: 5000, score: 4 }),
  ];
  const s = suggestChannels({ videos, channels: [], settings: SETTINGS });
  assert.deepEqual(s.map((c) => c.title), ['Tiny Kitchen', 'Two Hits']);
  assert.equal(s[0].reason, 'You opened one of their videos · 1 saved · 2 outliers · best 14×');
  assert.equal(s[0].nicheId, 'n1');
  // Tracked or dismissed channels are never suggested; search finds come after your own.
  const found = [{ ytChannelId: CH_C, title: 'Quiet Cook', subs: 4000, best: 7, outliers: 1 }];
  const s2 = suggestChannels({ videos, channels: [{ ytChannelId: CH_A }], dismissed: ['UCdddddddddddddddddddddd'], settings: SETTINGS, found });
  assert.deepEqual(s2.map((c) => [c.title, c.source]), [['Quiet Cook', 'search']]);
});

test('the "more like these" search uses words your opened videos share', () => {
  const videos = [
    vid({ title: 'Lentil curry for £2', opens: 2, tags: ['budget recipes'] }),
    vid({ title: 'Lentil soup meal prep', saved: true, tags: ['budget recipes'] }),
    vid({ title: 'Totally unrelated', score: 9 }),
  ];
  const q = interestQuery({ videos });
  assert.equal(q.query.split(' ')[0], 'budget');
  assert.ok(q.query.includes('lentil'));
  assert.equal(interestQuery({ videos: [vid({ title: 'never opened' })] }), null);
});

test('search finds become small-channel suggestions', () => {
  const found = [
    { ytChannelId: CH_A, channelTitle: 'A', channelSubs: 5000, score: 8, isOutlier: true, title: 'hit' },
    { ytChannelId: CH_A, channelTitle: 'A', channelSubs: 5000, score: 2, isOutlier: false, title: 'meh' },
    { ytChannelId: CH_B, channelTitle: 'B', channelSubs: 500_000, score: 20, isOutlier: true },
    { ytChannelId: CH_C, channelTitle: 'C', channelSubs: 100, score: 1.6 },
  ];
  const out = channelsFromScan(found);
  assert.deepEqual(out.map((c) => [c.title, c.best, c.outliers]), [['A', 8, 1]]);
  assert.deepEqual(cleanDismissed([CH_A, CH_A, 'nope', CH_B]), [CH_A, CH_B]);
});
