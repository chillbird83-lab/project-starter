// Niche validation pipeline, shared by the Worker (/api/validate, /api/analyze) and its tests.
//   1. Quant filter: YouTube's top 50 videos for a keyword, kept when views > subscribers × 5.
//   2. Comments of those outliers → the audience's unmet needs → video titles + thumbnail concepts.
// The LLM call itself lives in the Worker (Workers AI or Claude); everything here is pure or takes a client.

/** Kept when views exceed subscribers × this. */
export const MIN_MULTIPLIER = 5;
/** Videos whose comments are read per analysis (1 YouTube unit each, and Worker subrequest limits). */
export const MAX_ANALYZE_VIDEOS = 10;
export const COMMENTS_PER_VIDEO = 20;
const VIDEO_ID_RE = /^[\w-]{11}$/;

/**
 * The quant filter. One search (100 units), one batched videos call and one batched channels call
 * (1 unit each): about 102 quota units. Channels that hide their subscriber count are left out, as
 * a multiplier can't be worked out for them; `skipped` says how many.
 */
export async function findOutliers(yt, q, { max = 50, minMultiplier = MIN_MULTIPLIER } = {}) {
  const search = await yt.get('search', { part: 'snippet', type: 'video', q, order: 'relevance', maxResults: String(Math.min(50, max)) });
  const hits = (search.items ?? []).map((i) => ({ videoId: i.id?.videoId, channelId: i.snippet?.channelId })).filter((h) => h.videoId);
  if (!hits.length) return { query: q, scanned: 0, outliers: [], skipped: 0 };
  const videos = new Map((await yt.videos(hits.map((h) => h.videoId))).filter((v) => !v.live).map((v) => [v.ytVideoId, v]));
  // Search results carry the channel ID; the video details are the fallback.
  const channelIds = [...new Set(hits.map((h) => h.channelId || videos.get(h.videoId)?.ytChannelId).filter(Boolean))];
  const channels = new Map((await yt.channels(channelIds)).map((c) => [c.ytChannelId, c]));
  let skipped = 0;
  const outliers = [];
  for (const h of hits) {
    const v = videos.get(h.videoId);
    const c = channels.get(h.channelId || v?.ytChannelId);
    if (!v || !c) continue;
    if (!c.subscribers) { skipped++; continue; } // hidden (or zero) subscribers: no multiplier
    if (v.views > c.subscribers * minMultiplier) {
      outliers.push({
        videoId: v.ytVideoId, title: v.title, thumb: v.thumb, publishedAt: v.publishedAt,
        channelId: c.ytChannelId, channelTitle: c.title, views: v.views, subs: c.subscribers,
        multiplier: Math.round((v.views / c.subscribers) * 10) / 10,
      });
    }
  }
  outliers.sort((a, b) => b.multiplier - a.multiplier);
  return { query: q, scanned: hits.length, outliers, skipped };
}

/** Valid, unique video IDs, at most MAX_ANALYZE_VIDEOS. */
export const cleanVideoIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => VIDEO_ID_RE.test(id)))].slice(0, MAX_ANALYZE_VIDEOS);

/**
 * One text block of comments. With `maxChars` (for small-context models), comments are taken
 * round-robin across videos, most-liked first, so every video is represented; `used` reports how many fit.
 */
export function commentBlock(byVideo, { maxChars = Infinity } = {}) {
  const queues = byVideo.map((list) => [...list].sort((a, b) => b.likes - a.likes));
  const total = queues.reduce((n, q) => n + q.length, 0);
  const lines = [];
  let size = 0;
  for (let round = 0; queues.some((q) => q.length); round++) {
    for (const q of queues) {
      const c = q.shift();
      if (!c) continue;
      const line = `- ${c.text.replace(/\s+/g, ' ').trim()}`;
      if (size + line.length + 1 > maxChars) return { text: lines.join('\n'), used: lines.length, total };
      lines.push(line);
      size += line.length + 1;
    }
  }
  return { text: lines.join('\n'), used: lines.length, total };
}

export const painPointsPrompt = (comments) => `Analyze these YouTube comments. Extract the top 3 unmet needs, complaints, or questions the audience has. Format as a bulleted list.
Write exactly 3 bullets, each starting with "- ", one sentence each, and nothing else.

COMMENTS:
${comments}`;

export const ideasPrompt = (painPoints) => `Based on these 3 unmet needs, generate 5 high-CTR YouTube video titles and brief thumbnail concepts that solve these specific gaps.

UNMET NEEDS:
${painPoints}

Keep each title under 70 characters, so YouTube doesn't cut it off.
Write exactly 5 lines and nothing else, each in this form:
1. TITLE: <video title> | THUMBNAIL: <one-sentence thumbnail concept>`;

const stripMarks = (s) => s.replace(/\*\*|__/g, '').trim().replace(/^["“]|["”]$/g, '').trim();

/** "- one\n* two\n1. three" → ["one", "two", "three"]; plain lines if the model skipped the bullets. */
export function parseBullets(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l)).map((l) => stripMarks(l.replace(/^([-*•]|\d+[.)])\s+/, '')));
  return (bullets.length ? bullets : lines.filter((l) => !/:$/.test(l)).map(stripMarks)).filter(Boolean).slice(0, 5);
}

/** The ideas list → [{ title, thumbnail }]. Tolerates bold markers, missing numbers and other separators. */
export function parseIdeas(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = stripMarks(raw.replace(/\*\*|__/g, '').trim().replace(/^([-*•]|\d+[.)])\s+/, ''));
    const m = line.match(/^(?:title\s*:\s*)?(.+?)\s*(?:\||[-–—]\s*)\s*thumbnail(?:\s*concept)?\s*:\s*(.+)$/i);
    if (m) out.push({ title: stripMarks(m[1]), thumbnail: stripMarks(m[2]) });
    else if (/^title\s*:/i.test(line)) out.push({ title: stripMarks(line.replace(/^title\s*:\s*/i, '')), thumbnail: '' });
    else if (/^thumbnail(?:\s*concept)?\s*:/i.test(line) && out.length && !out.at(-1).thumbnail) out.at(-1).thumbnail = stripMarks(line.replace(/^thumbnail(?:\s*concept)?\s*:\s*/i, ''));
  }
  return out.filter((i) => i.title).slice(0, 5);
}

/** Seconds until YouTube's quota resets (midnight Pacific time). */
export function secondsToQuotaReset(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
  return Math.max(60, 86400 - (parts.hour * 3600 + parts.minute * 60 + parts.second));
}
