// Similar channels: small channels worth tracking, based on the outliers you open, save, analyse and
// take ideas from. Two sources: channels already in your feed (free), and a YouTube search built from
// the words those videos share ("Find more like these", about 130 quota units). Pure functions.
import { matchesLanguage } from './lang.js';
import { isOutlier } from './score.js';

/** "Small" = under this many subscribers. */
export const SMALL_SUBS = 100_000;
export const MAX_SUGGESTIONS = 6;
const MAX_DISMISSED = 300;
export const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

const STOP = new Set(('a an and are as at be by for from has have how i if in into is it its just me my of on or our so than that the their them then there these they this to too up was we what when which who why will with you your vs im ive dont cant get got make made new full part video videos official shorts short ft feat episode ep day days week weeks year years time first last best worst most every').split(' '));

/** How interested you've shown you are in a video: opens (up to 3), saving, analysing, saving an idea. */
export function interest(v, ideaVideoIds = new Set()) {
  return Math.min(3, v.opens || 0) + (v.saved ? 2 : 0) + (v.analysis ? 2 : 0) + (ideaVideoIds.has(v.id) ? 2 : 0);
}

const reasonText = ({ opened, saved, analysed, ideas, outliers, best }) => [
  opened ? `you opened ${opened === 1 ? 'one' : opened} of their videos` : '',
  saved ? `${saved} saved` : '',
  ideas ? `${ideas} idea${ideas === 1 ? '' : 's'} saved` : analysed ? `${analysed} analysed` : '',
  outliers > 1 ? `${outliers} outliers` : '',
  best ? `best ${best >= 10 ? Math.round(best) : best.toFixed(1)}×` : '',
].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());

/**
 * Untracked small channels from your feed, ranked by how much you engaged with them, then by how many
 * breakouts they had. Channels found by "Find more like these" (`found`) come after them.
 */
export function suggestChannels({ videos = [], channels = [], ideas = [], settings, dismissed = [], found = [], max = MAX_SUGGESTIONS }) {
  const tracked = new Set(channels.map((c) => c.ytChannelId));
  const skip = new Set([...tracked, ...dismissed]);
  const ideaVideos = new Set(ideas.map((i) => i.videoId).filter(Boolean));
  const byChannel = new Map();
  for (const v of videos) {
    if (v.channelId || !v.ytChannelId || skip.has(v.ytChannelId)) continue;
    if (v.channelSubs != null && v.channelSubs >= SMALL_SUBS) continue;
    if (!matchesLanguage(v, settings)) continue;
    const c = byChannel.get(v.ytChannelId) ?? { ytChannelId: v.ytChannelId, title: v.channelTitle, subs: v.channelSubs, nicheId: v.nicheIds?.[0] ?? null, points: 0, opened: 0, saved: 0, analysed: 0, ideas: 0, outliers: 0, best: 0, sample: null };
    const out = isOutlier(v, v.score, settings);
    c.points += interest(v, ideaVideos) * 2 + (out ? 0.5 : 0);
    c.opened += v.opens ? 1 : 0;
    c.saved += v.saved ? 1 : 0;
    c.analysed += v.analysis ? 1 : 0;
    c.ideas += ideas.filter((i) => i.videoId === v.id).length;
    c.outliers += out ? 1 : 0;
    if (v.score > c.best) { c.best = v.score; c.sample = { id: v.id, ytVideoId: v.ytVideoId, title: v.title, thumb: v.thumb, score: v.score }; }
    byChannel.set(v.ytChannelId, c);
  }
  const yours = [...byChannel.values()]
    .filter((c) => c.points >= 2 || c.outliers >= 2)
    .sort((a, b) => b.points - a.points || b.best - a.best)
    .map((c) => ({ ytChannelId: c.ytChannelId, title: c.title, subs: c.subs, nicheId: c.nicheId, best: c.best, sample: c.sample, source: 'yours', reason: reasonText(c) }));
  const seen = new Set(yours.map((c) => c.ytChannelId));
  const more = (Array.isArray(found) ? found : []).filter((c) => c?.ytChannelId && !skip.has(c.ytChannelId) && !seen.has(c.ytChannelId))
    .map((c) => ({ ...c, source: 'search', reason: `Like the videos you open · ${reasonText({ best: c.best, outliers: c.outliers })}` }));
  return [...yours, ...more].slice(0, max);
}

/**
 * A YouTube search for "more like the outliers you open": the words that most of your top videos share
 * (titles and tags), most shared first. Null until you've shown interest in at least one video.
 */
export function interestQuery({ videos = [], ideas = [], max = 3 }) {
  const ideaVideos = new Set(ideas.map((i) => i.videoId).filter(Boolean));
  const top = videos.map((v) => ({ v, w: interest(v, ideaVideos) })).filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w || b.v.score - a.v.score).slice(0, 8);
  if (!top.length) return null;
  const counts = new Map();
  for (const { v, w } of top) {
    const ws = new Set([...(v.title || '').toLowerCase().matchAll(/\p{L}[\p{L}\p{N}'’]*/gu)].map((m) => m[0].replace(/['’]s$/, ''))
      .concat((v.tags || []).slice(0, 8).map((t) => t.toLowerCase().trim()))
      .filter((x) => x.length >= 3 && x.length <= 30 && !STOP.has(x)));
    for (const x of ws) counts.set(x, (counts.get(x) || 0) + w);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Words from more than one video first; with a single video, its strongest words.
  const shared = ranked.filter(([, n]) => n > top[0].w || top.length === 1);
  const terms = (shared.length ? shared : ranked).slice(0, max).map(([x]) => x);
  return terms.length ? { query: terms.join(' '), basis: top.slice(0, 3).map(({ v }) => v.title) } : null;
}

/** Small channels from a search's results, best breakout first. */
export function channelsFromScan(found, { tracked = new Set(), max = 8 } = {}) {
  const byChannel = new Map();
  for (const v of found) {
    if (!v.ytChannelId || tracked.has(v.ytChannelId) || (v.channelSubs != null && v.channelSubs >= SMALL_SUBS)) continue;
    const c = byChannel.get(v.ytChannelId) ?? { ytChannelId: v.ytChannelId, title: v.channelTitle, subs: v.channelSubs, best: 0, outliers: 0, sample: null };
    c.outliers += v.isOutlier ? 1 : 0;
    if (v.score > c.best) { c.best = v.score; c.sample = { ytVideoId: v.ytVideoId, title: v.title, thumb: v.thumb, score: v.score }; }
    byChannel.set(v.ytChannelId, c);
  }
  return [...byChannel.values()].filter((c) => c.best >= 2).sort((a, b) => b.best - a.best).slice(0, max);
}

/** Dismissed channel ids, valid and bounded (newest kept). */
export const cleanDismissed = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => CHANNEL_ID_RE.test(String(id))))].slice(-MAX_DISMISSED);
