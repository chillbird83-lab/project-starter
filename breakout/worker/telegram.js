// Telegram Bot API: alert and analysis messages, and the webhook secret.
import { patternLine } from '../public/js/report.js';
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

export function risingMessage(video, speed, now = Date.now()) {
  return {
    parse_mode: 'HTML',
    text: [
      `🔥 <b>Rising now: +${compact(speed.recent)} views/hour</b>${video.channelTitle ? ` · ${h(video.channelTitle)}` : ''}`,
      `<b>${h(video.title)}</b>`,
      `${compact(video.views)} views in ${age(video.publishedAt, now)} · ${scoreLabel(video.score)} typical · gaining ${(speed.recent / Math.max(1, speed.overall)).toFixed(1)}× faster than its average`,
      videoURL(video.ytVideoId),
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🧠 Why did it work?', callback_data: `an:${video.id}` }, { text: '▶️ Watch', url: videoURL(video.ytVideoId) }]] },
  };
}

const dayMonth = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The Monday report: per niche, the top breakouts and what their titles share (plus the AI's one-liner
 * and idea when there is one). Niches are added until the message would pass Telegram's limit.
 */
export function reportMessage(report, summary = null, appUrl = '') {
  const items = summary?.items ?? {};
  const active = report.groups.filter((g) => g.total);
  const quiet = report.groups.filter((g) => !g.total).map((g) => h(g.name));
  const head = [
    `📊 <b>Your week on Breakout</b> · ${dayMonth(report.from)} – ${dayMonth(report.to)}`,
    active.length
      ? `${report.total} breakout${report.total === 1 ? '' : 's'} across ${active.length} niche${active.length === 1 ? '' : 's'}${report.rising ? ` · 🔥 ${report.rising} rising now` : ''}`
      : 'No breakouts in your niches this week. Breakout keeps looking.',
  ].join('\n');
  const section = (g) => {
    const lines = [`🔭 <b>${h(g.name)}</b> — ${g.total} breakout${g.total === 1 ? '' : 's'}`];
    g.top.slice(0, 3).forEach((v, i) => lines.push(`${i + 1}. <b>${scoreLabel(v.score)}</b> <a href="${videoURL(v.ytVideoId)}">${h(v.title)}</a>${v.channelTitle ? ` · ${h(v.channelTitle)}` : ''}`));
    if (g.patterns.length) lines.push(`<i>What they share:</i> ${g.patterns.slice(0, 3).map((p) => h(patternLine(p))).join('; ')}`);
    if (g.words.length) lines.push(`<i>Shared words:</i> ${g.words.slice(0, 4).map((w) => h(w.word)).join(', ')}`);
    if (items[g.key]?.pattern) lines.push(`✨ ${h(items[g.key].pattern)}`);
    if (items[g.key]?.idea) lines.push(`💡 Try: <b>${h(items[g.key].idea)}</b>`);
    return lines.join('\n');
  };
  const foot = [quiet.length ? `Quiet this week: ${quiet.join(', ')}` : '', appUrl ? `<a href="${h(appUrl)}">Open Breakout</a> for the full report.` : ''].filter(Boolean).join('\n');
  let text = head;
  let left = active.length;
  for (const g of active) {
    const next = `${text}\n\n${section(g)}`;
    if (next.length + foot.length + 60 > MAX_TEXT) break;
    text = next;
    left--;
  }
  if (left) text += `\n\n…and ${left} more niche${left === 1 ? '' : 's'} in the app.`;
  if (foot) text += `\n\n${foot}`;
  return { parse_mode: 'HTML', text, link_preview_options: { is_disabled: true } };
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
