// YouTube Data API v3 client. Quota-friendly: a channel refresh costs 3 units (channels, playlistItems,
// videos). search.list costs 100 units: used for niche scans and to resolve old-style /c/ custom URLs.
// Shared by the Worker (server key) and this-device mode (the user's own key).

const API = 'https://www.googleapis.com/youtube/v3/';

/** Understands channel IDs, @handles, channel / video / Shorts URLs and plain names. */
export function parseChannelInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^UC[\w-]{22}$/.test(s)) return { kind: 'id', value: s };
  if (/^@[\w.\-·]{2,}$/u.test(s)) return { kind: 'handle', value: s };
  if (/^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(s)) s = `https://${s}`;
  let url = null;
  try { url = new URL(s); } catch { /* not a URL */ }
  if (url && /(^|\.)youtube\.com$|^youtu\.be$/i.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.hostname.toLowerCase() === 'youtu.be' && parts[0]) return { kind: 'video', value: parts[0].slice(0, 11) };
    if (url.searchParams.get('v')) return { kind: 'video', value: url.searchParams.get('v').slice(0, 11) };
    const [first = '', second = ''] = parts;
    if (first.startsWith('@')) return { kind: 'handle', value: first };
    if (first === 'channel' && /^UC[\w-]{22}$/.test(second)) return { kind: 'id', value: second };
    if (['shorts', 'live', 'embed'].includes(first) && second) return { kind: 'video', value: second.slice(0, 11) };
    if (first === 'user' && second) return { kind: 'username', value: second };
    if (first === 'c' && second) return { kind: 'search', value: second };
    if (first && !['watch', 'results', 'feed', 'playlist'].includes(first)) return { kind: 'search', value: first };
    return null;
  }
  if (/^[\w.-]{3,30}$/.test(s)) return { kind: 'handle', value: `@${s}` };
  return { kind: 'search', value: s.slice(0, 100) };
}

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") → seconds. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, sec = 0] = m;
  return Math.round(Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(sec));
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const bestThumb = (t = {}) => (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || '';

export function mapChannel(item) {
  return {
    ytChannelId: item.id,
    title: item.snippet?.title ?? '',
    handle: item.snippet?.customUrl ?? '',
    thumb: (item.snippet?.thumbnails?.medium || item.snippet?.thumbnails?.default || {}).url || '',
    subscribers: item.statistics?.hiddenSubscriberCount ? null : num(item.statistics?.subscriberCount),
    videoCount: num(item.statistics?.videoCount),
    totalViews: num(item.statistics?.viewCount),
    uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads ?? (item.id ? `UU${item.id.slice(2)}` : ''),
  };
}

export function mapVideo(item) {
  return {
    ytVideoId: item.id,
    ytChannelId: item.snippet?.channelId ?? '',
    title: item.snippet?.title ?? '',
    description: (item.snippet?.description ?? '').slice(0, 1500),
    tags: (item.snippet?.tags ?? []).slice(0, 25),
    thumb: bestThumb(item.snippet?.thumbnails),
    publishedAt: item.snippet?.publishedAt ?? new Date(0).toISOString(),
    durationS: parseDuration(item.contentDetails?.duration),
    views: num(item.statistics?.viewCount) ?? 0,
    likes: num(item.statistics?.likeCount),
    comments: num(item.statistics?.commentCount),
    live: (item.snippet?.liveBroadcastContent ?? 'none') !== 'none',
  };
}

export class YouTubeError extends Error {
  constructor(message, { status, reason } = {}) { super(message); this.status = status; this.reason = reason; }
}

const REASONS = {
  quotaExceeded: 'The YouTube API daily quota is used up. It resets at midnight Pacific time.',
  dailyLimitExceeded: 'The YouTube API daily quota is used up. It resets at midnight Pacific time.',
  keyInvalid: 'The YouTube API key isn’t valid.',
  accessNotConfigured: 'YouTube Data API v3 isn’t enabled for this API key’s Google Cloud project.',
  forbidden: 'YouTube refused the request.',
};

export function ytClient(apiKey, fetchImpl = fetch) {
  async function get(path, params) {
    const qs = new URLSearchParams({ ...params, key: apiKey });
    let res;
    try { res = await fetchImpl(`${API}${path}?${qs}`); } catch { throw new YouTubeError('Couldn’t reach YouTube. Check the connection.'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.details?.[0]?.reason || '';
      const known = REASONS[reason] || (/API key/i.test(body?.error?.message || '') ? REASONS.keyInvalid : '');
      throw new YouTubeError(known || `YouTube error ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`, { status: res.status, reason });
    }
    return body;
  }

  const client = {
    get,
    async channel(by) {
      const body = await get('channels', { part: 'snippet,statistics,contentDetails', ...by });
      return body.items?.[0] ? mapChannel(body.items[0]) : null;
    },
    /** Finds a channel from whatever the user typed. Throws when nothing matches. */
    async resolveChannel(input) {
      const p = parseChannelInput(input);
      if (!p) throw new YouTubeError('Paste a channel link, an @handle or a video link.');
      let ch = null;
      if (p.kind === 'id') ch = await client.channel({ id: p.value });
      else if (p.kind === 'handle') ch = await client.channel({ forHandle: p.value });
      else if (p.kind === 'username') ch = await client.channel({ forUsername: p.value });
      else if (p.kind === 'video') {
        const v = await get('videos', { part: 'snippet', id: p.value });
        const id = v.items?.[0]?.snippet?.channelId;
        if (id) ch = await client.channel({ id });
      }
      if (!ch && (p.kind === 'search' || p.kind === 'handle' || p.kind === 'username')) {
        const q = p.value.replace(/^@/, '');
        const s = await get('search', { part: 'snippet', type: 'channel', q, maxResults: '1' });
        const id = s.items?.[0]?.snippet?.channelId || s.items?.[0]?.id?.channelId;
        if (id) ch = await client.channel({ id });
      }
      if (!ch) throw new YouTubeError('No YouTube channel found for that.');
      return ch;
    },
    /** Several channels by ID (1 unit per 50). */
    async channels(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const body = await get('channels', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
        out.push(...(body.items ?? []).map(mapChannel));
      }
      return out;
    },
    /** Video IDs matching a search (100 units). */
    async searchVideos(q, { publishedAfter, order = 'viewCount', max = 50 } = {}) {
      const body = await get('search', {
        part: 'id', type: 'video', q, order, maxResults: String(Math.min(50, max)),
        ...(publishedAfter ? { publishedAfter } : {}),
      });
      return (body.items ?? []).map((i) => i.id?.videoId).filter(Boolean);
    },
    /** IDs of the most recent uploads (newest first). */
    async uploads(playlistId, max = 50) {
      const body = await get('playlistItems', { part: 'contentDetails', playlistId, maxResults: String(Math.min(50, max)) });
      return (body.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    },
    async videos(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const body = await get('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
        out.push(...(body.items ?? []).map(mapVideo));
      }
      return out;
    },
    /** Top comments by relevance; [] when comments are off. */
    async comments(videoId, n = 20) {
      try {
        const body = await get('commentThreads', { part: 'snippet', videoId, order: 'relevance', maxResults: String(n), textFormat: 'plainText' });
        return (body.items ?? []).map((t) => {
          const c = t.snippet?.topLevelComment?.snippet ?? {};
          return { text: String(c.textDisplay ?? '').slice(0, 300), likes: Number(c.likeCount ?? 0) };
        });
      } catch (e) {
        if (e.status === 403 || e.status === 404) return [];
        throw e;
      }
    },
  };
  return client;
}

export const videoURL = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
export const channelURL = (id) => `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
