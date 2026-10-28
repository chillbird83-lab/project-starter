// "Why did this video work?" — Gemini compares the outlier with the channel's normal videos
// (title, thumbnail, topic, timing, length, audience comments) and suggests ideas that reuse the pattern.
import { generateJSON, toBase64 } from './gemini.js';
import { ageDays, engagement } from './score.js';
import { videoURL } from './youtube.js';

export const FACTORS = ['Title', 'Thumbnail', 'Topic', 'Hook', 'Format', 'Length', 'Timing', 'Audience', 'Trend', 'Other'];

export const ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Two sentences: why this video beat the channel’s normal views' },
    factors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { factor: { type: 'STRING', enum: FACTORS }, insight: { type: 'STRING' } },
        required: ['factor', 'insight'],
      },
    },
    title_formula: { type: 'STRING', description: 'The reusable title pattern, with [placeholders]' },
    thumbnail_notes: { type: 'STRING' },
    audience_reaction: { type: 'STRING', description: 'What the comments show viewers responded to' },
    ideas: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, angle: { type: 'STRING' } }, required: ['title', 'angle'] },
    },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  },
  required: ['summary', 'factors', 'title_formula', 'thumbnail_notes', 'audience_reaction', 'ideas', 'confidence'],
};

const fmt = (n) => (n == null ? 'hidden' : Math.round(n).toLocaleString('en-GB'));
const pct = (r) => (r == null ? 'hidden' : `${(r * 100).toFixed(2)}%`);

/** The facts the model gets. Everything it says must be backed by these. */
export function buildPrompt({ video, channel, others = [], comments = [], now = Date.now() }) {
  const baseline = video.isShort ? channel.baselineShort : channel.baselineLong;
  const e = engagement(video);
  const when = new Date(video.publishedAt);
  return `You are a YouTube strategist. Explain why one video outperformed its channel, then suggest new ideas.

CHANNEL: ${channel.title}${channel.subscribers != null ? ` (${fmt(channel.subscribers)} subscribers)` : ''}
Typical views for its ${video.isShort ? 'Shorts' : 'long-form videos'}: ${fmt(baseline)}

OUTLIER VIDEO (${video.score}× typical for its age)
Title: ${video.title}
Published: ${when.toUTCString()} (${Math.round(ageDays(video.publishedAt, now))} days ago)
Length: ${Math.floor(video.durationS / 60)}m ${video.durationS % 60}s${video.isShort ? ' (Short)' : ''}
Views: ${fmt(video.views)} · Likes: ${fmt(video.likes)} (${pct(e.likeRate)}) · Comments: ${fmt(video.comments)} (${pct(e.commentRate)})
Tags: ${video.tags?.length ? video.tags.join(', ') : 'none'}
Description (start): ${(video.description || '').slice(0, 600).replace(/\s+/g, ' ')}
The thumbnail image is attached.

THE CHANNEL'S OTHER RECENT VIDEOS (title — views — score):
${others.slice(0, 15).map((o) => `- ${o.title} — ${fmt(o.views)} — ${o.score}×`).join('\n') || '- none'}

TOP COMMENTS:
${comments.slice(0, 15).map((c) => `- (${c.likes} likes) ${c.text.replace(/\s+/g, ' ')}`).join('\n') || '- none available'}

Rules:
- Compare against the channel's other videos: what is different about this one? Be specific and cite evidence above.
- Don't invent facts you can't see. If the evidence is thin, say so and set confidence to "low".
- factors: 2 to 5 of the most important reasons, most important first.
- ideas: exactly 3 new video ideas for a creator in the same niche that reuse the winning pattern without copying the video.
- Plain, punchy English. No hashtags or emojis.`;
}

export function analysisRequest(input, { thumbnail, watch = false } = {}) {
  const parts = [];
  if (thumbnail) parts.push({ inline_data: { mime_type: thumbnail.type, data: thumbnail.base64 } });
  if (watch) parts.push({ file_data: { file_uri: videoURL(input.video.ytVideoId) } });
  parts.push({ text: buildPrompt(input) });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA },
  };
}

/** Keeps only well-formed parts of the model's answer. */
export function normaliseAnalysis(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n = 600) => String(v ?? '').trim().slice(0, n);
  return {
    summary: str(r.summary, 800),
    factors: (Array.isArray(r.factors) ? r.factors : []).slice(0, 6)
      .map((f) => ({ factor: FACTORS.includes(f?.factor) ? f.factor : 'Other', insight: str(f?.insight) })).filter((f) => f.insight),
    titleFormula: str(r.title_formula, 200),
    thumbnailNotes: str(r.thumbnail_notes),
    audienceReaction: str(r.audience_reaction),
    ideas: (Array.isArray(r.ideas) ? r.ideas : []).slice(0, 5).map((i) => ({ title: str(i?.title, 150), angle: str(i?.angle, 400) })).filter((i) => i.title),
    confidence: ['low', 'medium', 'high'].includes(r.confidence) ? r.confidence : 'low',
  };
}

/** Downloads the thumbnail for the model; null if it can't be fetched. */
export async function fetchThumbnail(url, fetchImpl = fetch) {
  if (!url) return null;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const type = (res.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
    if (!type.startsWith('image/')) return null;
    return { type, base64: toBase64(await res.arrayBuffer()) };
  } catch { return null; }
}

/** Fetches comments + thumbnail, asks Gemini, returns a clean analysis. */
export async function analyseVideo({ yt, apiKey, model, video, channel, others, watch = false, fetchImpl = fetch, now = Date.now() }) {
  const [comments, thumbnail] = await Promise.all([
    yt.comments(video.ytVideoId, 20).catch(() => []),
    fetchThumbnail(video.thumb, fetchImpl),
  ]);
  const body = analysisRequest({ video, channel, others, comments, now }, { thumbnail, watch });
  return normaliseAnalysis(await generateJSON({ apiKey, model, body, fetchImpl }));
}
