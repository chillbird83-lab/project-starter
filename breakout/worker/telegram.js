// Telegram Bot API: alert and analysis messages, and the webhook secret.
import { age, compact, scoreLabel } from '../public/js/rows.js';
import { videoURL } from '../public/js/youtube.js';

const MAX_TEXT = 4096;
const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.ok) console.error('telegram', method, res.status, out.description);
  return out;
}

/** The secret Telegram sends back on every webhook call, derived from the bot token so it needs no extra setting. */
export async function webhookSecret(env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`breakout:${env.TELEGRAM_BOT_TOKEN}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

export function alertMessage(video, channel, now = Date.now(), niche = '') {
  const baseline = video.isShort ? channel.baselineShort : channel.baselineLong;
  return {
    parse_mode: 'HTML',
    text: [
      `🚀 <b>${scoreLabel(video.score)} typical views</b> · ${h(channel.title)}${video.isShort ? ' · Short' : ''}${niche ? ` · in “${h(niche)}”` : ''}`,
      `<b>${h(video.title)}</b>`,
      `${compact(video.views)} views in ${age(video.publishedAt, now)} (usually ~${compact(baseline)})`,
      videoURL(video.ytVideoId),
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🧠 Why did it work?', callback_data: `an:${video.id}` }, { text: '▶️ Watch', url: videoURL(video.ytVideoId) }]] },
  };
}

export function analysisMessage(video, a) {
  const lines = [
    `🧠 <b>Why “${h(video.title)}” worked</b> <i>(${h(a.confidence)} confidence)</i>`,
    '',
    h(a.summary),
    '',
    ...a.factors.map((f) => `• <b>${h(f.factor)}</b> — ${h(f.insight)}`),
  ];
  if (a.titleFormula) lines.push('', `<b>Title formula:</b> ${h(a.titleFormula)}`);
  if (a.thumbnailNotes) lines.push(`<b>Thumbnail:</b> ${h(a.thumbnailNotes)}`);
  if (a.audienceReaction) lines.push(`<b>Audience:</b> ${h(a.audienceReaction)}`);
  if (a.ideas.length) lines.push('', '<b>Ideas for you</b>', ...a.ideas.map((i, n) => `${n + 1}. <b>${h(i.title)}</b> — ${h(i.angle)}`));
  const text = lines.join('\n');
  if (text.length <= MAX_TEXT) return { parse_mode: 'HTML', text, link_preview_options: { is_disabled: true } };
  // Too long: cutting HTML could leave a tag open, so send it as plain text instead.
  const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { text: `${plain.slice(0, MAX_TEXT - 1)}…`, link_preview_options: { is_disabled: true } };
}
