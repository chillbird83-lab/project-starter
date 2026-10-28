// Screens: Outliers feed, Channels, sign-in.
import { age, compact, scoreLabel } from './rows.js';
import { DAY, isOutlier } from './score.js';
import { esc } from './util.js';

export const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All']];

const duration = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export const heat = (score) => (score >= 10 ? 'hot' : score >= 5 ? 'warm' : 'mild');

/** The niche a video belongs to: its tracked channel's niche, or the niche whose scan found it. */
/** Whether a video belongs to a niche: through its tracked channel, or because the niche's search found it. */
export const inNicheOf = (v, byChannel, nicheId) => byChannel.get(v.channelId)?.nicheId === nicheId || !!v.nicheIds?.includes(nicheId);
export const channelTitleOf = (v, byChannel) => byChannel.get(v.channelId)?.title ?? v.channelTitle ?? '';

export function videoCard(v, channelTitle, now) {
  return `<button type="button" class="vcard" data-action="video" data-id="${esc(v.id)}">
    <span class="vthumb">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <b class="badge ${heat(v.score)}">${scoreLabel(v.score)}</b>${v.isShort ? '<i class="tag">Short</i>' : `<i class="tag">${duration(v.durationS)}</i>`}${v.saved ? '<i class="star" aria-label="Saved">★</i>' : ''}</span>
    <span class="vmeta"><span class="vtitle">${esc(v.title)}</span>
      <span class="sub">${esc(channelTitle)} · ${compact(v.views)} views · ${age(v.publishedAt, now)}</span></span>
  </button>`;
}

const lastChecked = (state, now) => {
  const times = [...state.channels.map((c) => c.checkedAt), ...state.niches.map((n) => n.scannedAt)].filter(Boolean).sort();
  return times.length ? `checked ${age(times.at(-1), now)} ago` : 'not checked yet';
};
const scanning = (state) => state.niches;

export function outlierList(ctx) {
  const { videos, channels, niches, settings } = ctx.state;
  const f = ctx.ui;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const nicheIds = new Set(niches.map((n) => n.id));
  const visible = (v) => byId.has(v.channelId) || (!v.channelId && !!v.nicheIds?.some((id) => nicheIds.has(id)));
  const inNiche = (v) => f.niche === 'all' || f.niche === 'saved' || inNicheOf(v, byId, f.niche);
  const list = videos.filter((v) => visible(v) && inNiche(v)
    && (f.niche === 'saved' ? v.saved : isOutlier(v, v.score, settings))
    && (!f.period || ctx.now - Date.parse(v.publishedAt) <= f.period * DAY)
    && (f.kind === 'all' || (f.kind === 'short') === !!v.isShort))
    .sort((a, b) => b.score - a.score);
  if (!list.length) {
    if (!channels.length && !scanning(ctx.state).length) {
      return `<div class="empty"><div class="empty-emoji" aria-hidden="true">📈</div><h3>Find the outliers in your niche</h3>
        <p>Tell Breakout what your niche is about. It searches YouTube and shows the videos beating their own channel’s normal views — from any channel.</p>
        <button type="button" class="btn primary" data-action="add-niche">Add a niche</button>
        <button type="button" class="link center-link" data-action="add-channel">or track specific channels</button></div>`;
    }
    return `<div class="empty small-empty"><div class="empty-emoji" aria-hidden="true">${f.niche === 'saved' ? '☆' : '🔭'}</div>
      <h3>${f.niche === 'saved' ? 'Nothing saved yet' : 'No outliers here'}</h3>
      <p>${f.niche === 'saved' ? 'Tap ☆ on a video to keep it here.' : `Nothing beat ${scoreLabel(settings.threshold)} typical views in this view. Try a longer period or a lower threshold in Settings.`}</p></div>`;
  }
  return `<div class="vgrid">${list.slice(0, f.limit).map((v) => videoCard(v, channelTitleOf(v, byId), ctx.now)).join('')}</div>
    ${list.length > f.limit ? '<button type="button" class="btn secondary" data-action="more">Show more</button>' : ''}`;
}

/** Shown when one niche is selected: when it was searched, and ways to edit or remove it. */
function nicheBar(ctx) {
  const n = ctx.state.niches.find((x) => x.id === ctx.ui.niche);
  if (!n) return '';
  return `<div class="niche-bar"><span class="grow sub">🔭 ${esc(n.keywords || n.name)} · ${n.scannedAt ? `searched ${age(n.scannedAt, ctx.now)} ago` : 'not searched yet'}</span>
    <button type="button" class="chip-btn" data-action="edit-niche" data-id="${esc(n.id)}">Edit</button>
    <button type="button" class="chip-btn danger" data-action="remove-niche" data-id="${esc(n.id)}">Remove</button></div>`;
}

export function outliersView(ctx) {
  const { niches, channels, settings } = ctx.state;
  const f = ctx.ui;
  const chips = [['all', 'All niches'], ...niches.map((n) => [n.id, n.name]), ['saved', '★ Saved']];
  const sources = [
    scanning(ctx.state).length ? `${scanning(ctx.state).length} niche${scanning(ctx.state).length === 1 ? '' : 's'}` : '',
    channels.length ? `${channels.length} channel${channels.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const anything = sources.length > 0;
  return `<div class="screen-head"><div><h1 class="large-title">Outliers</h1>
      <p class="subtitle">${anything ? `${sources.join(' · ')} · ${lastChecked(ctx.state, ctx.now)}` : 'Videos beating their channel’s normal'}</p></div>
    ${anything ? `<button type="button" class="icon-btn ${ctx.ui.refreshing ? 'spinning' : ''}" data-action="refresh" aria-label="Check channels now" ${ctx.ui.refreshing ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>` : ''}</div>
    ${niches.length || channels.length ? `<div class="chips scroll" role="group" aria-label="Niche">${chips.map(([id, name]) => `<button type="button" class="chip ${f.niche === id ? 'on' : ''}" data-action="niche" data-value="${esc(id)}" aria-pressed="${f.niche === id}">${esc(name)}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Published">${PERIODS.map(([d, l]) => `<button type="button" data-action="period" data-value="${d}" class="${f.period === d ? 'on' : ''}" aria-pressed="${f.period === d}">${l}</button>`).join('')}</div>
    ${settings.includeShorts ? `<div class="seg" role="group" aria-label="Type">${[['all', 'All'], ['long', 'Long-form'], ['short', 'Shorts']].map(([k, l]) => `<button type="button" data-action="kind" data-value="${k}" class="${f.kind === k ? 'on' : ''}" aria-pressed="${f.kind === k}">${l}</button>`).join('')}</div>` : ''}` : ''}
    ${nicheBar(ctx)}
    <div id="outlier-list">${outlierList(ctx)}</div>`;
}

export function channelsView(ctx) {
  const { niches, channels, videos, settings } = ctx.state;
  const counts = new Map();
  for (const v of videos) if (isOutlier(v, v.score, settings) && ctx.now - Date.parse(v.publishedAt) <= 90 * DAY) counts.set(v.channelId, (counts.get(v.channelId) || 0) + 1);
  const row = (c) => `<button type="button" class="row" data-action="channel" data-id="${esc(c.id)}">
    ${c.thumb ? `<img class="avatar" src="${esc(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="avatar"></span>'}
    <span class="grow"><span class="title">${esc(c.title)}</span>
      <span class="sub">${c.subscribers != null ? `${compact(c.subscribers)} subs · ` : ''}typical ${compact(c.baselineLong)} views</span></span>
    ${counts.get(c.id) ? `<span class="pill pill-warn">${counts.get(c.id)} outlier${counts.get(c.id) === 1 ? '' : 's'}</span>` : ''}
    <span class="chev" aria-hidden="true">›</span></button>`;
  const groups = [...niches.map((n) => [n, channels.filter((c) => c.nicheId === n.id)]), [null, channels.filter((c) => !niches.some((n) => n.id === c.nicheId))]]
    .filter(([n, list]) => list.length || n);
  return `<div class="screen-head"><div><h1 class="large-title">Channels</h1>
      <p class="subtitle">${channels.length} of ${ctx.backend.config.maxChannels ?? 30} tracked</p></div>
    <button type="button" class="chip-btn" data-action="niches">Niches</button></div>
    ${channels.length ? '' : `<div class="empty"><div class="empty-emoji" aria-hidden="true">📺</div><h3>No channels yet</h3>
      <p>Optional: niches already find outliers from any channel. Track a channel to follow a specific competitor closely.</p><button type="button" class="btn primary" data-action="add-channel">Track a channel</button></div>`}
    ${groups.map(([n, list]) => `<section class="group"><h3 class="group-title"><span>${esc(n ? n.name : 'No niche')}</span><span>${list.length || ''}</span></h3>
      <div class="card list">${list.map(row).join('') || `<button type="button" class="row add-row" data-action="add-channel" data-niche="${esc(n.id)}"><span class="ico add-ico" aria-hidden="true">+</span><span class="title">Add a channel</span></button>`}</div></section>`).join('')}
    <p class="footnote">Channels are checked ${ctx.backend.mode === 'cloud' ? `about every ${ctx.backend.config.refreshHours ?? 4} hours` : 'when you open the app'}. Scores compare each video with the channel’s typical views at the same age.</p>`;
}

export function signInView({ step = 'email', email = '', busy = false, error = '' }) {
  return `<div class="welcome-screen">
    <img src="icons/icon.svg" alt="" width="84" height="84" class="welcome-logo">
    <h1 class="welcome-title">Breakout</h1>
    <p class="welcome-text">Track the channels in your niche, catch the videos that break out, and learn why they worked.</p>
    <form id="signin" class="card signin" novalidate>
      ${step === 'email'
        ? `<label class="field-block"><span class="eyebrow">Email</span><input id="si-email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(email)}" required autofocus></label>
           <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Email me a sign-in code'}</button>`
        : `<p class="small muted">We sent a code to <b>${esc(email)}</b>. It can take a minute to arrive.</p>
           <label class="field-block"><span class="eyebrow">Code</span><input id="si-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456" required autofocus></label>
           <button type="submit" class="btn primary" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Sign in'}</button>
           <button type="button" class="btn secondary" data-action="signin-back">Use a different email</button>`}
      <p class="form-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
    </form>
    <button type="button" class="link" data-action="use-local">Use without an account (your own API keys)</button>
  </div>`;
}

export const loadingView = (text = 'Loading…') => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
export { duration };
