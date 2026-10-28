// Niche discovery: outliers from any channel, no competitor list needed.
// 1. YouTube search for the niche's most-watched videos of the last 30 days (100 units)
// 2. Their stats and their channels (2 units)
// 3. A first score against each channel's lifetime average views per video
// 4. For the most promising channels, the real baseline from their latest uploads (2 units each)
// About 122 quota units per scan with the defaults.
import { DAY, DEFAULT_SETTINGS, baselines, isOutlier, isShort, scoreVideo } from './score.js';

export const NICHE_DAYS = 30;
export const REFINE_TOP = 10;
/** Videos scoring below this are not kept (the lowest threshold a user can pick is 1.5×). */
export const KEEP_SCORE = 1.5;

/** "meal prep, budget recipes" → "meal prep | budget recipes" (YouTube search OR). Falls back to the niche name. */
export function nicheQuery(niche) {
  const terms = String(niche.keywords || niche.name || '').split(',').map((s) => s.trim()).filter(Boolean);
  return terms.slice(0, 5).join(' | ');
}

export async function scanNiche(yt, query, { now = Date.now(), settings = DEFAULT_SETTINGS, days = NICHE_DAYS, refineTop = REFINE_TOP } = {}) {
  if (!query) return [];
  const ids = await yt.searchVideos(query, { publishedAfter: new Date(now - days * DAY).toISOString(), order: 'viewCount', max: 50 });
  if (!ids.length) return [];
  const vids = (await yt.videos(ids)).filter((v) => !v.live);
  const channels = new Map((await yt.channels([...new Set(vids.map((v) => v.ytChannelId))])).map((c) => [c.ytChannelId, c]));

  const lifetime = (c) => {
    const avg = c?.videoCount ? Math.round((c.totalViews || 0) / c.videoCount) : 0;
    return { long: avg, short: avg };
  };
  const scored = vids.map((v) => {
    const base = lifetime(channels.get(v.ytChannelId));
    return { v, base, kind: 'average', score: scoreVideo(v, base, now) };
  });

  // Lifetime averages are skewed by old hits, so re-check the best candidates against recent uploads.
  const top = [...new Set([...scored].sort((a, b) => b.score - a.score).map((s) => s.v.ytChannelId))].slice(0, refineTop);
  for (const chId of top) {
    const c = channels.get(chId);
    if (!c?.uploadsPlaylist) continue;
    try {
      const uploads = (await yt.videos(await yt.uploads(c.uploadsPlaylist, 30))).filter((u) => !u.live);
      const base = baselines(uploads, now);
      for (const s of scored) {
        if (s.v.ytChannelId !== chId) continue;
        s.base = base;
        s.kind = 'median';
        s.score = scoreVideo(s.v, base, now);
      }
    } catch (e) {
      if (/quota/i.test(e.message)) throw e;
    }
  }

  return scored.filter((s) => s.score >= KEEP_SCORE).map(({ v, base, kind, score }) => {
    const c = channels.get(v.ytChannelId);
    const short = isShort(v);
    return {
      ...v, isShort: short, score, isOutlier: isOutlier(v, score, settings),
      channelTitle: c?.title ?? '', channelSubs: c?.subscribers ?? null,
      baseline: short ? base.short : base.long, baselineKind: kind, source: 'search',
    };
  });
}
