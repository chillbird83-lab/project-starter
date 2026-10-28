// One channel refresh: latest 50 uploads → stats → baselines → scores. 3 YouTube quota units.
import { DEFAULT_SETTINGS, baselines, scoreAll } from './score.js';

export async function refreshChannel(yt, ytChannelId, { now = Date.now(), settings = DEFAULT_SETTINGS } = {}) {
  const channel = await yt.channel({ id: ytChannelId });
  if (!channel) throw new Error('This channel no longer exists on YouTube.');
  const ids = channel.uploadsPlaylist ? await yt.uploads(channel.uploadsPlaylist, 50) : [];
  const videos = (await yt.videos(ids)).filter((v) => !v.live);
  const base = baselines(videos, now);
  return {
    channel: { ...channel, baselineLong: base.long, baselineShort: base.short, checkedAt: new Date(now).toISOString() },
    videos: scoreAll(videos, base, now, settings),
  };
}
