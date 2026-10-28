// Weekly report: each niche's top breakouts of the last 7 days and the title patterns they share.
// The patterns are worked out here, for free; Gemini can add a one-line summary and an idea per niche.
// Pure functions, shared by the app (Report tab) and the Worker (Monday Telegram message).
import { isExcluded, nicheExcludes } from './discover.js';
import { matchesLanguage } from './lang.js';
import { DAY, isOutlier } from './score.js';
import { velocity } from './trend.js';

export const REPORT_DAYS = 7;
/** Breakouts listed per niche. */
export const REPORT_TOP = 5;
/** Videos the patterns are compared with: the same niche's other videos of the last month. */
const COMPARE_DAYS = 30;
/** The key of the group for tracked channels that have no niche. */
export const TRACKED_KEY = 'tracked';

/** Title patterns worth knowing about. Each test gets the title. */
export const PATTERNS = [
  ['number', 'A number', (t) => /\d/.test(t)],
  ['first-person', 'First person (“I”, “my”)', (t) => /\b(i|i'm|i’m|i've|i’ve|my|me|we|our)\b/i.test(t)],
  ['time', 'A time frame or challenge', (t) => /\b(\d+\s*(hours?|days?|weeks?|months?|years?|hrs?)|24h|challenge|for a (day|week|month|year))\b/i.test(t)],
  ['money', 'Money or price', (t) => /[£$€¥₹]|\b(cheap|cheapest|budget|free|cost|costs|price|money|rich|broke|expensive)\b/i.test(t)],
  ['question', 'A question', (t) => /\?/.test(t) || /^(how|why|what|which|who|is|are|can|should|does|do|did|will)\b/i.test(t.trim())],
  ['superlative', 'Best / worst / most', (t) => /\b(best|worst|most|least|top|biggest|smallest|ultimate|easiest|hardest|fastest|cheapest|craziest|only)\b/i.test(t)],
  ['warning', 'A warning or secret', (t) => /\b(mistakes?|never|stop|don't|don’t|avoid|wrong|truth|secrets?|nobody|hidden|warning|banned)\b/i.test(t)],
  ['how-to', 'How-to or guide', (t) => /\b(how to|guide|tutorial|explained|step by step|beginners?)\b/i.test(t)],
  ['versus', 'A comparison (“vs”)', (t) => /\b(vs\.?|versus)\b/i.test(t)],
  ['caps', 'A word in CAPITALS', (t) => /\b[A-Z]{3,}\b/.test(t.replace(/\b(USA|UK|EU|DIY|ASMR|NYC|LA|TV|AI|PC|WW2|WWII|WWI|USSR|NASA|FBI|CIA)\b/g, ''))],
  ['brackets', 'Brackets, e.g. “(gone wrong)”', (t) => /[([]/.test(t)],
  ['emoji', 'An emoji', (t) => /\p{Extended_Pictographic}/u.test(t)],
  ['short', 'Short (under 45 characters)', (t) => t.trim().length < 45],
];

const STOP = new Set(('a an and are as at be by for from has have he her his how i if in into is it its just me my of on or our so than that the their them then there these they this to too up was we what when which who why will with you your vs my me im ive dont cant get got make made new full part video videos official shorts short ft feat episode ep').split(' '));

const words = (title) => [...new Set((String(title).toLowerCase().match(/\p{L}[\p{L}\p{N}'’]*/gu) || [])
  .map((w) => w.replace(/['’]s$/, '')).filter((w) => w.length >= 3 && !STOP.has(w)))];

/**
 * Patterns that at least 2 videos and 40% of them share, most common first. With enough other videos
 * to compare with, a pattern only counts if the breakouts use it more often than those do.
 */
export function titlePatterns(videos, others = [], { max = 4 } = {}) {
  if (videos.length < 2) return [];
  const share = (list, test) => list.filter((v) => test(v.title || '')).length;
  const compare = others.length >= 5;
  return PATTERNS.map(([id, label, test]) => {
    const count = share(videos, test);
    const otherShare = compare ? share(others, test) / others.length : null;
    return { id, label, count, total: videos.length, otherShare, example: videos.find((v) => test(v.title || ''))?.title ?? '' };
  })
    .filter((p) => p.count >= 2 && p.count / p.total >= 0.4 && (p.otherShare == null || p.count / p.total > p.otherShare + 0.1))
    .sort((a, b) => b.count / b.total - a.count / a.total || (a.otherShare ?? 0) - (b.otherShare ?? 0))
    .slice(0, max);
}

/** Words that 2 or more titles share, leaving out the niche's own words (they say nothing new). */
export function sharedWords(videos, ignore = '', { max = 5 } = {}) {
  const skip = new Set(words(ignore));
  const counts = new Map();
  for (const v of videos) for (const w of words(v.title)) if (!skip.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w, n]) => ({ word: w, count: n }));
}

/** "4 of 6 have a number" */
export const patternLine = (p) => `${p.count} of ${p.total} · ${p.label.charAt(0).toLowerCase()}${p.label.slice(1)}`;

/**
 * The report: one group per niche (and one for tracked channels without a niche), each with its
 * breakouts of the last `days` days, best first, and what their titles have in common.
 */
export function weeklyReport({ niches = [], channels = [], videos = [], settings, now = Date.now(), days = REPORT_DAYS }) {
  const byChannel = new Map(channels.map((c) => [c.id, c]));
  const excludes = new Map(niches.map((n) => [n.id, nicheExcludes(n)]));
  const recent = (v, d) => now - Date.parse(v.publishedAt) <= d * DAY && Date.parse(v.publishedAt) <= now;
  const shown = videos.filter((v) => recent(v, COMPARE_DAYS) && matchesLanguage(v, settings));
  const inGroup = (v, key) => (key === TRACKED_KEY
    ? !!v.channelId && byChannel.has(v.channelId) && !excludes.has(byChannel.get(v.channelId).nicheId)
    : byChannel.get(v.channelId)?.nicheId === key || (!!v.nicheIds?.includes(key) && !isExcluded(v, excludes.get(key))));
  const groups = [
    ...niches.map((n) => ({ key: n.id, nicheId: n.id, name: n.name, words: `${n.name} ${n.keywords || ''}` })),
    ...(channels.some((c) => !excludes.has(c.nicheId)) ? [{ key: TRACKED_KEY, nicheId: null, name: 'Tracked channels', words: '' }] : []),
  ].map((g) => {
    const all = shown.filter((v) => inGroup(v, g.key));
    const breakouts = all.filter((v) => recent(v, days) && isOutlier(v, v.score, settings)).sort((a, b) => b.score - a.score);
    const others = all.filter((v) => !isOutlier(v, v.score, settings));
    const formulas = [...new Set(breakouts.map((v) => v.analysis?.titleFormula).filter(Boolean))].slice(0, 3);
    return {
      key: g.key, nicheId: g.nicheId, name: g.name, total: breakouts.length,
      rising: breakouts.filter((v) => velocity(v, now).rising).length,
      top: breakouts.slice(0, REPORT_TOP),
      patterns: titlePatterns(breakouts, others),
      words: sharedWords(breakouts, g.words),
      formulas,
    };
  });
  return {
    from: new Date(now - days * DAY).toISOString(), to: new Date(now).toISOString(), days,
    total: groups.reduce((n, g) => n + g.total, 0),
    rising: groups.reduce((n, g) => n + g.rising, 0),
    groups,
  };
}

/** The Monday a weekly report belongs to: the latest Monday 08:00 UTC at or before `now`. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7), 8);
  return monday <= now ? monday : monday - 7 * DAY;
}

// ---------------------------------------------------------------------------
// Gemini: one sentence on what each niche's breakouts share, and one idea
// ---------------------------------------------------------------------------

export const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    niches: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING' },
          pattern: { type: 'STRING', description: 'One sentence: what these breakout videos have in common' },
          idea: { type: 'STRING', description: 'One new video title that reuses that pattern' },
        },
        required: ['key', 'pattern', 'idea'],
      },
    },
  },
  required: ['niches'],
};

export function summaryRequest(report) {
  const groups = report.groups.filter((g) => g.total >= 1);
  const text = `You are a YouTube strategist. For each niche below you get this week's breakout videos (each beat its own channel's normal views; the number is how many times). Say what they have in common and suggest one new video.

${groups.map((g) => `NICHE key=${g.key} "${g.name}"
${g.top.map((v) => `- ${v.score}× · ${v.title}${v.channelTitle ? ` (${v.channelTitle})` : ''}`).join('\n')}
${g.patterns.length ? `Counted patterns: ${g.patterns.map(patternLine).join('; ')}` : ''}`).join('\n\n')}

Rules:
- pattern: one plain sentence about the titles, topics or formats they share. Only claim what the titles show; with one or two videos, say what made that one stand out.
- idea: one new video title for a creator in that niche that reuses the pattern without copying any video.
- Return one item per niche, using its key exactly. No hashtags or emojis.`;
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { temperature: 0.5, responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA },
  };
}

/** Keeps answers for niches that are in the report: { at, items: { [key]: { pattern, idea } } }. */
export function normaliseSummary(raw, report, now = Date.now()) {
  const keys = new Set(report.groups.map((g) => g.key));
  const items = {};
  for (const n of Array.isArray(raw?.niches) ? raw.niches : []) {
    const key = String(n?.key ?? '');
    const pattern = String(n?.pattern ?? '').trim().slice(0, 300);
    if (keys.has(key) && pattern) items[key] = { pattern, idea: String(n?.idea ?? '').trim().slice(0, 150) };
  }
  return { at: new Date(now).toISOString(), items };
}
