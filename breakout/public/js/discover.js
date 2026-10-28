// Niche discovery: outliers from any channel, no competitor list needed.
// 1. YouTube search for the niche's most-watched videos of the last 30 days (100 units)
// 2. Their stats and their channels (2 units)
// 3. A rough first score against each channel's lifetime average views per video, only to pick candidates
// 4. Every candidate's channel is re-checked against its latest uploads (1 unit per channel, plus one
//    batched videos call per 50 uploads), and only those real scores are kept
// About 130 quota units per scan with the defaults.
import { DAY, DEFAULT_SETTINGS, baselines, isOutlier, isShort, scoreVideo } from './score.js';

export const NICHE_DAYS = 30;
/** Channels re-checked per scan. Candidates beyond this are dropped rather than shown with a guessed score. */
export const REFINE_TOP = 20;
/** Recent uploads read per channel for its real baseline. */
export const REFINE_UPLOADS = 20;
/** Videos scoring below this are not kept (the lowest threshold a user can pick is 1.5×). */
export const KEEP_SCORE = 1.5;

/** A niche's words to leave out, e.g. "marvel, anime" → ["marvel", "anime"]. */
export const nicheExcludes = (niche) => String(niche?.exclude ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10);

/**
 * "meal prep, budget recipes" → "meal prep | budget recipes" (YouTube search OR), plus "-marvel -anime"
 * for the words to leave out. Falls back to the niche name.
 */
export function nicheQuery(niche) {
  const terms = String(niche.keywords || niche.name || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!terms.length) return '';
  const minus = nicheExcludes(niche).map((w) => (/\s/.test(w) ? `-"${w}"` : `-${w}`)).join(' ');
  return `${terms.join(' | ')}${minus ? ` ${minus}` : ''}`;
}

/**
 * Whether a video mentions a left-out word in its title, description or tags. Single words match whole
 * words and their longer forms ("movie" → "movies", "marvel" → "Marvel's"); phrases match as written.
 */
export function isExcluded(v, words) {
  if (!words?.length) return false;
  const text = `${v.title ?? ''} ${v.description ?? ''} ${(v.tags ?? []).join(' ')}`.toLowerCase();
  const tokens = (text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).map((t) => t.replace(/['’]s$/, ''));
  return words.some((w) => (/\s/.test(w) ? text.includes(w) : tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w)))));
}

export async function scanNiche(yt, query, { now = Date.now(), settings = DEFAULT_SETTINGS, days = NICHE_DAYS, refineTop = REFINE_TOP, exclude = [] } = {}) {
  if (!query) return [];
  const ids = await yt.searchVideos(query, { publishedAfter: new Date(now - days * DAY).toISOString(), order: 'viewCount', max: 50, language: settings.language });
  if (!ids.length) return [];
  // YouTube's "-word" search is loose, so left-out words are checked again here.
  const vids = (await yt.videos(ids)).filter((v) => !v.live && !isExcluded(v, exclude));
  if (!vids.length) return [];
  const channels = new Map((await yt.channels([...new Set(vids.map((v) => v.ytChannelId))])).map((c) => [c.ytChannelId, c]));

  const lifetime = (c) => {
    const avg = c?.videoCount ? Math.round((c.totalViews || 0) / c.videoCount) : 0;
    return { long: avg, short: avg };
  };
  const scored = vids.map((v) => {
    const base = lifetime(channels.get(v.ytChannelId));
    return { v, base, kind: 'average', score: scoreVideo(v, base, now) };
  });

  // Lifetime averages are unreliable (channels grow, old hits skew them), so they only pick candidates.
  // Each candidate channel is then scored against its recent uploads; nothing is shown on a guess.
  const candidates = [...new Set([...scored].filter((s) => s.score >= KEEP_SCORE).sort((a, b) => b.score - a.score)
    .map((s) => s.v.ytChannelId))].slice(0, refineTop);
  const uploadIds = new Map();
  for (const chId of candidates) {
    const c = channels.get(chId);
    if (!c?.uploadsPlaylist) continue;
    try { uploadIds.set(chId, await yt.uploads(c.uploadsPlaylist, REFINE_UPLOADS)); } catch (e) {
      if (/quota/i.test(e.message)) throw e;
    }
  }
  // One batched stats call per 50 uploads, across all the channels.
  const uploads = (await yt.videos([...new Set([...uploadIds.values()].flat())])).filter((u) => !u.live);
  const checked = new Set();
  for (const [chId] of uploadIds) {
    const base = baselines(uploads.filter((u) => u.ytChannelId === chId), now);
    checked.add(chId);
    for (const s of scored) {
      if (s.v.ytChannelId !== chId) continue;
      s.base = base;
      s.kind = 'median';
      s.score = scoreVideo(s.v, base, now);
    }
  }

  return scored.filter((s) => checked.has(s.v.ytChannelId) && s.score >= KEEP_SCORE).map(({ v, base, kind, score }) => {
    const c = channels.get(v.ytChannelId);
    const short = isShort(v);
    return {
      ...v, isShort: short, score, isOutlier: isOutlier(v, score, settings),
      channelTitle: c?.title ?? '', channelSubs: c?.subscribers ?? null,
      baseline: short ? base.short : base.long, baselineKind: kind, source: 'search',
    };
  });
}
