// Database rows (snake_case, Supabase) ↔ app objects (camelCase), plus small text helpers that the
// Worker and the app share.

export const channelToRow = (c) => ({
  yt_channel_id: c.ytChannelId, title: c.title, handle: c.handle || '', thumb: c.thumb || '',
  subscribers: c.subscribers ?? null, video_count: c.videoCount ?? null, uploads_playlist: c.uploadsPlaylist || '',
  baseline_long: c.baselineLong ?? 0, baseline_short: c.baselineShort ?? 0, checked_at: c.checkedAt ?? null,
});

export const rowToChannel = (r) => ({
  id: r.id, nicheId: r.niche_id ?? null, ytChannelId: r.yt_channel_id, title: r.title, handle: r.handle, thumb: r.thumb,
  subscribers: r.subscribers, videoCount: r.video_count, uploadsPlaylist: r.uploads_playlist,
  baselineLong: Number(r.baseline_long) || 0, baselineShort: Number(r.baseline_short) || 0, checkedAt: r.checked_at, createdAt: r.created_at,
});

export const videoToRow = (v) => ({
  yt_video_id: v.ytVideoId, title: v.title, description: v.description || '', tags: v.tags || [], thumb: v.thumb || '',
  published_at: v.publishedAt, duration_s: v.durationS || 0, is_short: !!v.isShort, views: v.views || 0,
  likes: v.likes ?? null, comments: v.comments ?? null, score: v.score || 0, is_outlier: !!v.isOutlier,
  yt_channel_id: v.ytChannelId || '', lang: v.lang || '',
});

/** A video found by a niche scan (not from a tracked channel). */
export const discoveryToRow = (v) => ({
  ...videoToRow(v), channel_title: v.channelTitle || '', channel_subs: v.channelSubs ?? null,
  baseline: v.baseline || 0, baseline_kind: v.baselineKind || 'average', source: 'search',
});

export const rowToVideo = (r) => ({
  id: r.id, channelId: r.channel_id, ytVideoId: r.yt_video_id, title: r.title, description: r.description, tags: r.tags || [],
  thumb: r.thumb, publishedAt: r.published_at, durationS: r.duration_s, isShort: r.is_short, views: Number(r.views) || 0,
  likes: r.likes == null ? null : Number(r.likes), comments: r.comments == null ? null : Number(r.comments),
  score: Number(r.score) || 0, isOutlier: r.is_outlier, alertedAt: r.alerted_at ?? null,
  nicheIds: Array.isArray(r.niche_ids) ? r.niche_ids : [], ytChannelId: r.yt_channel_id || '', channelTitle: r.channel_title || '',
  channelSubs: r.channel_subs == null ? null : Number(r.channel_subs), baseline: Number(r.baseline) || 0,
  baselineKind: r.baseline_kind || 'median', source: r.source || 'channel', lang: r.lang || '',
  analysis: r.analysis ?? null, analysedAt: r.analysed_at ?? null, saved: !!r.saved, updatedAt: r.updated_at,
});

export const rowToNiche = (r) => ({ id: r.id, name: r.name, keywords: r.keywords || '', scannedAt: r.scanned_at ?? null });

/** A stand-in channel for a discovered video, so alerts and analysis can treat both kinds alike. */
export const pseudoChannel = (v) => ({
  title: v.channelTitle, subscribers: v.channelSubs, baselineLong: v.baseline, baselineShort: v.baseline, ytChannelId: v.ytChannelId,
});

export const settingsFromProfile = (p = {}) => ({
  threshold: Number(p.threshold) || 3, minViews: Number(p.min_views ?? 1000),
  includeShorts: p.include_shorts !== false, alerts: p.alerts !== false, language: p.language || 'any',
  hideMixed: p.hide_mixed !== false, hideLanguages: Array.isArray(p.hide_languages) ? p.hide_languages : [],
});

/** 950 → "950", 12750 → "12.8K", 1234567 → "1.2M" */
export function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  const v = Number(n);
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  const x = v / div;
  return `${x >= 100 ? Math.round(x) : Number(x.toFixed(1))}${unit}`;
}

/** "3 hours", "2 days", "5 weeks" */
export function age(publishedAt, now = Date.now()) {
  const h = Math.max(0, (now - Date.parse(publishedAt)) / 36e5);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)} days`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 730) return `${Math.round(d / 30.4)} months`;
  return `${Math.round(d / 365)} years`;
}

export const scoreLabel = (s) => `${s >= 10 ? Math.round(s) : s.toFixed(1)}×`;
