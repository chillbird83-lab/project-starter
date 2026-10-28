// Outlier maths. A video's score is its views divided by what this channel's videos usually get
// at the same age, so 5 means "five times its normal". Pure functions, fully unit-tested.

export const DAY = 864e5;
/** YouTube allows Shorts up to 3 minutes. */
export const SHORT_MAX_SECONDS = 180;
/** Videos this old count as "settled" when working out a channel's typical views. */
export const MATURE_DAYS = 7;
/** Brand-new videos are too noisy to judge. */
export const MIN_AGE_DAYS = 0.25;
/** Alerts are for fresh breakouts, not old videos that slowly climbed. */
export const ALERT_MAX_AGE_DAYS = 14;

/** language is left out on purpose: the app defaults it to the browser's language. */
export const DEFAULT_SETTINGS = { threshold: 3, minViews: 1000, includeShorts: true, alerts: true };

export const isShort = (v) => v.durationS > 0 && v.durationS <= SHORT_MAX_SECONDS;
export const ageDays = (publishedAt, now = Date.now()) => Math.max(0, (now - Date.parse(publishedAt)) / DAY);

export function median(nums) {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Share of its first-month views a typical video has at `days` old. Most views arrive early, so a
 * square-root curve: about a third by day 3, half by day 7, all of it by day 28. A heuristic.
 */
export const ageFactor = (days) => Math.min(1, Math.max(0.1, Math.sqrt(days / 28)));

/**
 * Typical views per video, separately for long-form and Shorts: the median of the latest 30 videos
 * that are at least a week old. With fewer than 3 of those, younger videos are scaled up by age.
 */
export function baselines(videos, now = Date.now()) {
  const calc = (list) => {
    const recent = [...list].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const mature = recent.filter((v) => ageDays(v.publishedAt, now) >= MATURE_DAYS).slice(0, 30);
    if (mature.length >= 3) return Math.round(median(mature.map((v) => v.views)));
    const young = recent.filter((v) => ageDays(v.publishedAt, now) >= MIN_AGE_DAYS).slice(0, 30);
    if (!young.length) return 0;
    return Math.round(median(young.map((v) => v.views / ageFactor(ageDays(v.publishedAt, now)))));
  };
  const live = videos.filter((v) => !v.live);
  return { long: calc(live.filter((v) => !isShort(v))), short: calc(live.filter(isShort)) };
}

export function scoreVideo(v, base, now = Date.now()) {
  const b = isShort(v) ? base.short : base.long;
  const age = ageDays(v.publishedAt, now);
  if (!b || v.live || age < MIN_AGE_DAYS) return 0;
  return Math.round((v.views / (b * ageFactor(age))) * 100) / 100;
}

export function isOutlier(v, score, settings = DEFAULT_SETTINGS) {
  // Scores against a channel's lifetime average are only estimates (older versions stored some).
  if (v.baselineKind === 'average') return false;
  return score >= settings.threshold && v.views >= settings.minViews && (settings.includeShorts || !isShort(v));
}

/** Adds score, isShort and isOutlier to every video. */
export function scoreAll(videos, base, now = Date.now(), settings = DEFAULT_SETTINGS) {
  return videos.map((v) => {
    const score = scoreVideo(v, base, now);
    return { ...v, isShort: isShort(v), score, isOutlier: isOutlier(v, score, settings) };
  });
}

/** Outliers that deserve an alert: fresh, never alerted before. */
export const shouldAlert = (v, now = Date.now()) => v.isOutlier && !v.alertedAt && ageDays(v.publishedAt, now) <= ALERT_MAX_AGE_DAYS;

export function engagement(v) {
  return {
    likeRate: v.views && v.likes != null ? v.likes / v.views : null,
    commentRate: v.views && v.comments != null ? v.comments / v.views : null,
  };
}
