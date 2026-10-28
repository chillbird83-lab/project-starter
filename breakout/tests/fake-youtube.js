// A fake YouTube Data API for tests: one channel with 12 normal videos and one breakout, and a small
// second channel ("Tiny Kitchen") with one hit, which niche searches find.
export const NOW = Date.parse('2026-10-28T12:00:00Z');
export const CH = 'UC1234567890123456789012';
export const OTHER = 'UC9876543210987654321098';
const day = 864e5;

export function makeOtherVideos(now = NOW) {
  const list = [{ id: 'tinyhit0001', title: 'Feed 4 people for £5', ageDays: 5, views: 25000 }];
  for (let i = 0; i < 5; i++) list.push({ id: `tinynorm00${i}`, title: `Weeknight pasta ${i}`, ageDays: 10 + i * 6, views: 700 + i * 50 });
  return list.map((v) => ({
    id: v.id,
    snippet: { channelId: OTHER, title: v.title, liveBroadcastContent: 'none', publishedAt: new Date(now - v.ageDays * day).toISOString(), thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` } } },
    statistics: { viewCount: String(v.views), likeCount: String(Math.round(v.views * 0.05)), commentCount: '12' },
    contentDetails: { duration: 'PT9M10S' },
  }));
}

export const otherItem = {
  id: OTHER,
  snippet: { title: 'Tiny Kitchen', customUrl: '@tinykitchen', thumbnails: { medium: { url: 'https://yt3.ggpht.com/tiny' } } },
  statistics: { subscriberCount: '900', videoCount: '40', viewCount: '40000' },
  contentDetails: { relatedPlaylists: { uploads: `UU${OTHER.slice(2)}` } },
};

export function makeVideos(now = NOW) {
  const list = [];
  for (let i = 0; i < 12; i++) {
    list.push({ id: `normal${String(i).padStart(5, '0')}`, title: `Normal video ${i}`, ageDays: 10 + i * 5, views: 10000 + i * 500, duration: 'PT12M30S' });
  }
  list.push({ id: 'breakout001', title: 'I tried the 5am routine for 30 days', ageDays: 3, views: 60000, duration: 'PT14M2S' });
  list.push({ id: 'short000001', title: 'quick tip', ageDays: 2, views: 900, duration: 'PT45S' });
  list.push({ id: 'premiere001', title: 'Upcoming premiere', ageDays: -1, views: 0, duration: 'P0D', live: 'upcoming' });
  return list.map((v) => ({
    id: v.id,
    snippet: {
      channelId: CH, title: v.title, description: `About ${v.title}`, tags: ['routine'], liveBroadcastContent: v.live || 'none',
      publishedAt: new Date(now - v.ageDays * day).toISOString(),
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` } },
    },
    statistics: { viewCount: String(v.views), likeCount: String(Math.round(v.views * 0.04)), commentCount: String(Math.round(v.views * 0.003)) },
    contentDetails: { duration: v.duration },
  }));
}

export const channelItem = {
  id: CH,
  snippet: { title: 'Morning Maker', customUrl: '@morningmaker', thumbnails: { medium: { url: 'https://yt3.ggpht.com/abc' } } },
  statistics: { subscriberCount: '120000', videoCount: '15', viewCount: '400000' },
  contentDetails: { relatedPlaylists: { uploads: `UU${CH.slice(2)}` } },
};

/** fetch() stand-in. Records every call in `calls`. */
export function fakeYouTube({ quotaExceeded = false } = {}) {
  const calls = [];
  const videos = makeVideos();
  const others = makeOtherVideos();
  const all = [...videos, ...others];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'i.ytimg.com') return new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpeg' } });
    if (quotaExceeded) return json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403);
    const p = url.searchParams;
    switch (url.pathname.split('/').pop()) {
      case 'channels': {
        if (p.get('forHandle') === '@morningmaker') return json({ items: [channelItem] });
        const ids = (p.get('id') || '').split(',');
        return json({ items: [channelItem, otherItem].filter((c) => ids.includes(c.id)) });
      }
      case 'playlistItems': {
        const list = p.get('playlistId') === otherItem.contentDetails.relatedPlaylists.uploads ? others : videos;
        return json({ items: list.slice(0, Number(p.get('maxResults') || 50)).map((v) => ({ contentDetails: { videoId: v.id } })) });
      }
      case 'videos': {
        const ids = p.get('id').split(',');
        return json({ items: all.filter((v) => ids.includes(v.id)) });
      }
      case 'search':
        if (p.get('type') === 'video') return json({ items: ['breakout001', 'tinyhit0001', 'normal00001', 'short000001'].map((videoId) => ({ id: { kind: 'youtube#video', videoId } })) });
        return json({ items: p.get('q') === 'morning maker' ? [{ id: { channelId: CH }, snippet: { channelId: CH } }] : [] });
      case 'commentThreads':
        if (p.get('videoId') === 'nocomments1') return json({ error: { code: 403, errors: [{ reason: 'commentsDisabled' }] } }, 403);
        return json({ items: [{ snippet: { topLevelComment: { snippet: { textDisplay: 'Day 12 is where it clicked for me', likeCount: 340 } } } }] });
      default: return json({ error: { code: 404 } }, 404);
    }
  };
  return { fetchImpl, calls };
}
