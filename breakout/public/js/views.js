// Screens: Outliers feed, This week (report), Ideas, Channels (with suggestions), sign-in.
import { age, compact, scoreLabel } from './rows.js';
import { DAY, isOutlier } from './score.js';
import { isExcluded, nicheExcludes } from './discover.js';
import { STAGES, ideasIn, nextStage } from './ideas.js';
import { LANGUAGES, languageName, matchesLanguage } from './lang.js';
import { weeklyReport } from './report.js';
import { interestQuery, suggestChannels } from './similar.js';
import { velocity } from './trend.js';
import { esc } from './util.js';

export const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All']];
export const SORTS = [['score', 'Highest score'], ['rising', 'Rising fastest'], ['views', 'Most views'], ['new', 'Newest']];
export const SIZES = [['any', 'Any channel size'], ['10000', 'Under 10K subs'], ['100000', 'Under 100K subs'], ['1000000', 'Under 1M subs']];

const duration = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export const heat = (score) => (score >= 10 ? 'hot' : score >= 5 ? 'warm' : 'mild');

/** Whether a video belongs to a niche: through its tracked channel, or because the niche's search found it. */
export const inNicheOf = (v, byChannel, nicheId) => byChannel.get(v.channelId)?.nicheId === nicheId || !!v.nicheIds?.includes(nicheId);
export const channelTitleOf = (v, byChannel) => byChannel.get(v.channelId)?.title ?? v.channelTitle ?? '';

export function videoCard(v, channelTitle, now, { showSpeed = false } = {}) {
  const speed = velocity(v, now);
  return `<button type="button" class="vcard" data-action="video" data-id="${esc(v.id)}">
    <span class="vthumb">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <b class="badge ${heat(v.score)}">${scoreLabel(v.score)}</b>${v.isShort ? '<i class="tag">Short</i>' : `<i class="tag">${duration(v.durationS)}</i>`}${v.saved ? '<i class="star" aria-label="Saved">★</i>' : ''}
      ${speed.rising ? `<i class="rising" title="Gaining views faster than its average">🔥 +${compact(speed.recent)}/h</i>` : ''}</span>
    <span class="vmeta"><span class="vtitle">${esc(v.title)}</span>
      <span class="sub">${esc(channelTitle)} · ${compact(v.views)} views · ${age(v.publishedAt, now)}${showSpeed && !speed.rising ? ` · ${compact(speed.perHour)}/h` : ''}</span></span>
  </button>`;
}

/** Subscriber count behind a video: its tracked channel's, or the one saved when a niche search found it. */
const subsOf = (v, byChannel) => byChannel.get(v.channelId)?.subscribers ?? v.channelSubs ?? null;

const SORTERS = {
  score: (a, b) => b.score - a.score,
  views: (a, b) => b.views - a.views,
  new: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
};

const lastChecked = (state, now) => {
  const times = [...state.channels.map((c) => c.checkedAt), ...state.niches.map((n) => n.scannedAt)].filter(Boolean).sort();
  return times.length ? `checked ${age(times.at(-1), now)} ago` : 'not checked yet';
};
const scanning = (state) => state.niches;

export function outlierList(ctx) {
  const { videos, channels, niches, settings } = ctx.state;
  const f = ctx.ui;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const excludes = new Map(niches.map((n) => [n.id, nicheExcludes(n)]));
  // A found video shows if at least one of its niches accepts it (isn't left out by that niche's words).
  const accepted = (v, ids) => ids.some((id) => excludes.has(id) && !isExcluded(v, excludes.get(id)));
  const visible = (v) => byId.has(v.channelId) || (!v.channelId && accepted(v, v.nicheIds ?? []));
  const inNiche = (v) => f.niche === 'all' || f.niche === 'saved'
    || byId.get(v.channelId)?.nicheId === f.niche || (!!v.nicheIds?.includes(f.niche) && accepted(v, [f.niche]));
  const maxSubs = f.size === 'any' ? Infinity : Number(f.size);
  const smallEnough = (v) => { const s = subsOf(v, byId); return s == null || s < maxSubs; };
  const filtered = videos.filter((v) => visible(v) && inNiche(v)
    && (f.niche === 'saved' ? v.saved : isOutlier(v, v.score, settings))
    && (!f.period || ctx.now - Date.parse(v.publishedAt) <= f.period * DAY)
    && (f.kind === 'all' || (f.kind === 'short') === !!v.isShort)
    && smallEnough(v)
    && matchesLanguage(v, settings));
  let list;
  if (f.sort === 'rising') {
    // Rising videos first (fastest first), then everything else by views per hour.
    const speed = new Map(filtered.map((v) => [v.id, velocity(v, ctx.now)]));
    list = filtered.sort((a, b) => (speed.get(b.id).rising - speed.get(a.id).rising) || (speed.get(b.id).perHour - speed.get(a.id).perHour));
  } else list = filtered.sort(SORTERS[f.sort] ?? SORTERS.score);
  if (!list.length) {
    if (!channels.length && !scanning(ctx.state).length) {
      return `<div class="empty"><div class="empty-emoji" aria-hidden="true">📈</div><h3>Find the outliers in your niche</h3>
        <p>Tell Breakout what your niche is about. It searches YouTube and shows the videos beating their own channel’s normal views — from any channel.</p>
        <button type="button" class="btn primary" data-action="add-niche">Add a niche</button>
        <button type="button" class="link center-link" data-action="add-channel">or track specific channels</button></div>`;
    }
    return `<div class="empty small-empty"><div class="empty-emoji" aria-hidden="true">${f.niche === 'saved' ? '☆' : '🔭'}</div>
      <h3>${f.niche === 'saved' ? 'Nothing saved yet' : 'No outliers here'}</h3>
      <p>${f.niche === 'saved' ? 'Tap ☆ on a video to keep it here.' : `Nothing${settings.language !== 'any' ? ` in ${esc(languageName(settings.language))}` : ''} beat ${scoreLabel(settings.threshold)} typical views in this view. Try a longer period, another language, or a lower threshold in Settings.`}</p></div>`;
  }
  return `<div class="vgrid">${list.slice(0, f.limit).map((v) => videoCard(v, channelTitleOf(v, byId), ctx.now, { showSpeed: f.sort === 'rising' })).join('')}</div>
    ${list.length > f.limit ? '<button type="button" class="btn secondary" data-action="more">Show more</button>' : ''}`;
}

export const languagePicker = (current, id = 'lang-filter') => `<label class="lang-pick"><span class="sr-only">Language</span><span aria-hidden="true">🌐</span>
  <select id="${id}" data-action="language">${LANGUAGES.map(([c, n]) => `<option value="${c}" ${c === current ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;

/** Shown when one niche is selected: when it was searched, and ways to edit or remove it. */
function nicheBar(ctx) {
  const n = ctx.state.niches.find((x) => x.id === ctx.ui.niche);
  if (!n) return '';
  const left = nicheExcludes(n);
  return `<div class="niche-bar"><span class="grow sub">🔭 ${esc(n.keywords || n.name)}${left.length ? ` · without ${esc(left.join(', '))}` : ''} · ${n.scannedAt ? `searched ${age(n.scannedAt, ctx.now)} ago` : 'not searched yet'}</span>
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
    <div class="head-actions">${anything ? languagePicker(settings.language) : ''}${anything ? `<button type="button" class="icon-btn ${ctx.ui.refreshing ? 'spinning' : ''}" data-action="refresh" aria-label="Check channels now" ${ctx.ui.refreshing ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>` : ''}</div></div>
    ${niches.length || channels.length ? `<div class="chips scroll" role="group" aria-label="Niche">${chips.map(([id, name]) => `<button type="button" class="chip ${f.niche === id ? 'on' : ''}" data-action="niche" data-value="${esc(id)}" aria-pressed="${f.niche === id}">${esc(name)}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Published">${PERIODS.map(([d, l]) => `<button type="button" data-action="period" data-value="${d}" class="${f.period === d ? 'on' : ''}" aria-pressed="${f.period === d}">${l}</button>`).join('')}</div>
    ${settings.includeShorts ? `<div class="seg" role="group" aria-label="Type">${[['all', 'All'], ['long', 'Long-form'], ['short', 'Shorts']].map(([k, l]) => `<button type="button" data-action="kind" data-value="${k}" class="${f.kind === k ? 'on' : ''}" aria-pressed="${f.kind === k}">${l}</button>`).join('')}</div>` : ''}` : ''}
    ${nicheBar(ctx)}
    ${anything ? `<div class="feed-tools">
      <label class="tool-pick"><span class="sr-only">Sort</span><select data-action="sort">${SORTS.map(([k, l]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="tool-pick"><span class="sr-only">Channel size</span><select data-action="size">${SIZES.map(([k, l]) => `<option value="${k}" ${f.size === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>` : ''}
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
    ${suggestionsSection(ctx)}
    ${channels.length ? '' : `<div class="empty"><div class="empty-emoji" aria-hidden="true">📺</div><h3>No channels yet</h3>
      <p>Optional: niches already find outliers from any channel. Track a channel to follow a specific competitor closely.</p><button type="button" class="btn primary" data-action="add-channel">Track a channel</button></div>`}
    ${groups.map(([n, list]) => `<section class="group"><h3 class="group-title"><span>${esc(n ? n.name : 'No niche')}</span><span>${list.length || ''}</span></h3>
      <div class="card list">${list.map(row).join('') || `<button type="button" class="row add-row" data-action="add-channel" data-niche="${esc(n.id)}"><span class="ico add-ico" aria-hidden="true">+</span><span class="title">Add a channel</span></button>`}</div></section>`).join('')}
    <p class="footnote">Channels are checked ${ctx.backend.mode === 'cloud' ? `about every ${ctx.backend.config.refreshHours ?? 4} hours` : 'when you open the app'}. Scores compare each video with the channel’s typical views at the same age.</p>`;
}

// ---------------------------------------------------------------------------
// Suggested channels
// ---------------------------------------------------------------------------

export const suggestionsFor = (state) => suggestChannels({
  videos: state.videos, channels: state.channels, ideas: state.ideas, settings: state.settings,
  dismissed: state.settings.dismissedChannels, found: state.similar?.channels,
});

function suggestionsSection(ctx) {
  const { state, ui } = ctx;
  const list = suggestionsFor(state);
  const q = interestQuery({ videos: state.videos, ideas: state.ideas });
  if (!list.length && !q && !state.videos.some((v) => !v.channelId)) return '';
  const row = (c) => `<div class="row suggest">
      <button type="button" class="suggest-main" data-action="suggest-open" data-yt="${esc(c.ytChannelId)}" ${c.sample?.id ? `data-id="${esc(c.sample.id)}"` : c.sample?.ytVideoId ? `data-video="${esc(c.sample.ytVideoId)}"` : ''}>
        ${c.sample?.thumb ? `<img class="suggest-thumb" src="${esc(c.sample.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar letter" aria-hidden="true">${esc((c.title || '?').charAt(0).toUpperCase())}</span>`}
        <span class="grow"><span class="title">${esc(c.title)}</span>
          <span class="sub wrap">${c.subs != null ? `${compact(c.subs)} subs · ` : ''}${esc(c.reason)}</span></span></button>
      <button type="button" class="chip-btn mini" data-action="track-suggested" data-yt="${esc(c.ytChannelId)}" data-niche="${esc(c.nicheId ?? '')}" aria-label="Track ${esc(c.title)}">Track</button>
      <button type="button" class="icon-btn mini-x" data-action="dismiss-suggested" data-yt="${esc(c.ytChannelId)}" aria-label="Not interested in ${esc(c.title)}">✕</button>
    </div>`;
  const last = state.similar?.at ? ` Last search: “${esc(state.similar.query)}”, ${age(state.similar.at, ctx.now)} ago.` : '';
  return `<section class="group"><h3 class="group-title"><span>Suggested for you</span><span>${list.length || ''}</span></h3>
    <div class="card list">${list.map(row).join('')}
      <button type="button" class="row add-row" data-action="find-similar" ${q && !ui.findingSimilar ? '' : 'disabled'}>
        <span class="ico add-ico" aria-hidden="true">${ui.findingSimilar ? '<span class="spinner"></span>' : '🔎'}</span>
        <span class="grow"><span class="title">${ui.findingSimilar ? 'Looking for channels like these…' : 'Find more like these'}</span>
        <span class="sub wrap">${q ? `Searches YouTube for “${esc(q.query)}” and keeps small channels (about 130 quota units).` : 'Open a few outliers you like first.'}</span></span></button>
    </div>
    <p class="hint">${list.length ? 'Small channels (under 100K subscribers) behind the outliers you open, save and analyse.' : 'Open, save or analyse a few outliers you like, and Breakout will suggest small channels behind them.'}${last}</p></section>`;
}

// ---------------------------------------------------------------------------
// This week
// ---------------------------------------------------------------------------

const dayMonth = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pct = (p) => `<b>${p.count} of ${p.total}</b>`;

export const reportFor = (state, now) => weeklyReport({ ...state, now });

export function reportView(ctx) {
  const { state, ui, now, backend } = ctx;
  const report = reportFor(state, now);
  const sum = state.reportSummary?.at && now - Date.parse(state.reportSummary.at) < 7 * DAY ? state.reportSummary : null;
  const ai = backend.mode === 'local' || backend.config.ai;
  const active = report.groups.filter((g) => g.total);
  const head = `<div class="screen-head"><div><h1 class="large-title">This week</h1>
    <p class="subtitle">Breakouts from ${dayMonth(report.from)} to ${dayMonth(report.to)}</p></div></div>`;
  if (!report.groups.length) {
    return `${head}<div class="empty"><div class="empty-emoji" aria-hidden="true">📊</div><h3>Your weekly report</h3>
      <p>Add a niche and each week you’ll see its top breakouts here, with the title patterns they share.</p>
      <button type="button" class="btn primary" data-action="add-niche">Add a niche</button></div>`;
  }
  const tg = backend.mode === 'cloud' && backend.config.telegram;
  const note = tg ? (state.telegram.linked && state.settings.weeklyReport ? 'This report also arrives on Telegram every Monday morning.' : 'Get this report on Telegram every Monday: Settings → Connect Telegram.') : '';
  const aiCard = !report.total || !ai ? '' : sum
    ? `<p class="hint ai-note">✨ AI summary from ${age(sum.at, now)} ago · <button type="button" class="link small" data-action="summarise" ${ui.summarising ? 'disabled' : ''}>${ui.summarising ? 'Updating…' : 'Update'}</button></p>`
    : `<button type="button" class="btn primary ai-btn" data-action="summarise" ${ui.summarising ? 'disabled' : ''}>${ui.summarising ? 'Reading this week’s titles…' : '✨ What do they have in common?'}</button>`;
  const group = (g) => {
    const s = sum?.items?.[g.key];
    const body = !g.total ? '<p class="muted">No breakouts this week. Breakout keeps looking.</p>' : `
      ${s ? `<p class="ai-pattern">✨ ${esc(s.pattern)}</p>${s.idea ? `<div class="ai-idea"><span class="grow">💡 Try: <b>${esc(s.idea)}</b></span><button type="button" class="chip-btn mini" data-action="save-report-idea" data-key="${esc(g.key)}">Save idea</button></div>` : ''}` : ''}
      ${g.patterns.length ? `<h4 class="mini-head">What their titles share</h4><ul class="patterns">${g.patterns.map((p) => `<li>${pct(p)} · ${esc(p.label)}<span class="sub wrap">e.g. “${esc(p.example)}”</span></li>`).join('')}</ul>`
        : g.total === 1 ? '<p class="muted small">One breakout so far: patterns show up once there are a few.</p>' : '<p class="muted small">No common title pattern this week: these broke out for different reasons.</p>'}
      ${g.words.length ? `<p class="small shared-words">Shared words: ${g.words.map((w) => `<span class="word">${esc(w.word)} <i>${w.count}</i></span>`).join(' ')}</p>` : ''}
      ${g.formulas.length ? `<h4 class="mini-head">Title formulas from your analyses</h4>${g.formulas.map((f) => `<button type="button" class="formula-line" data-action="copy" data-value="${esc(f)}">${esc(f)}</button>`).join('')}` : ''}`;
    return `<section class="group report-group"><h3 class="group-title"><span>${g.key === 'tracked' ? '📺' : '🔭'} ${esc(g.name)}</span><span>${g.total ? `${g.total} breakout${g.total === 1 ? '' : 's'}${g.rising ? ` · 🔥 ${g.rising}` : ''}` : ''}</span></h3>
      <div class="card pad report-card">${body}</div>
      ${g.total ? `<div class="vgrid">${g.top.slice(0, 4).map((v) => videoCard(v, v.channelTitle || state.channels.find((c) => c.id === v.channelId)?.title || '', now)).join('')}</div>
        ${g.nicheId && g.total > 4 ? `<button type="button" class="link center-link" data-action="show-niche" data-id="${esc(g.nicheId)}">See all ${g.total} in Outliers ›</button>` : ''}` : ''}</section>`;
  };
  return `${head}
    <dl class="card stats report-stats"><div><dt>Breakouts</dt><dd>${report.total}</dd></div><div><dt>Rising now</dt><dd>${report.rising}</dd></div><div><dt>Niches</dt><dd>${active.length} of ${report.groups.length}</dd></div></dl>
    ${aiCard}
    ${[...active, ...report.groups.filter((g) => !g.total)].map(group).join('')}
    ${note ? `<p class="footnote">${note}</p>` : ''}`;
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

const MOVE_LABEL = { todo: 'Start making →', making: '✓ Published', done: 'Make another' };

export function ideasView(ctx) {
  const { ideas } = ctx.state;
  const stage = ctx.ui.stage;
  const count = (s) => ideas.filter((i) => i.status === s).length;
  const list = ideasIn(ideas, stage);
  const card = (i) => `<div class="card idea-card">
      <button type="button" class="idea-main" data-action="idea" data-id="${esc(i.id)}">
        <span class="title">${esc(i.title)}</span>
        ${i.angle ? `<span class="sub wrap">${esc(i.angle)}</span>` : ''}
        ${i.notes ? `<span class="sub wrap idea-notes">📝 ${esc(i.notes.slice(0, 140))}${i.notes.length > 140 ? '…' : ''}</span>` : ''}
        ${i.sourceTitle ? `<span class="idea-src">From “${esc(i.sourceTitle)}”${i.sourceScore ? ` · ${scoreLabel(i.sourceScore)}` : ''}</span>` : ''}
      </button>
      <div class="idea-actions"><button type="button" class="chip-btn mini" data-action="idea-move" data-id="${esc(i.id)}" data-to="${nextStage(i.status)}">${MOVE_LABEL[i.status]}</button></div>
    </div>`;
  const empty = {
    todo: ideas.length ? 'Nothing waiting. Save more from “Why did it work?” on any outlier.' : 'Tap 🧠 Why did it work? on an outlier, then Save on the ideas you like. Or add your own.',
    making: 'Nothing in progress. Tap “Start making” on an idea.',
    done: 'Nothing published yet. Mark an idea ✓ Published when it’s out.',
  }[stage];
  return `<div class="screen-head"><div><h1 class="large-title">Ideas</h1>
      <p class="subtitle">${ideas.length ? `${ideas.length} idea${ideas.length === 1 ? '' : 's'} · ${count('making')} in progress` : 'Your next videos, from what’s working'}</p></div>
    <button type="button" class="chip-btn" data-action="new-idea">+ New</button></div>
    <div class="seg" role="group" aria-label="Stage">${STAGES.map(([s, l]) => `<button type="button" data-action="stage" data-value="${s}" class="${stage === s ? 'on' : ''}" aria-pressed="${stage === s}">${l}${count(s) ? ` <span class="count">${count(s)}</span>` : ''}</button>`).join('')}</div>
    ${list.length ? `<div class="idea-list">${list.map(card).join('')}</div>` : `<div class="empty small-empty"><div class="empty-emoji" aria-hidden="true">💡</div><p>${empty}</p>
      ${stage === 'todo' ? '<button type="button" class="btn secondary" data-action="new-idea">Add an idea</button>' : ''}</div>`}`;
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
