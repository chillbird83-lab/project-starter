// Sheets: add menu, niches, add channel, video (player + "Why did it work?"), channel, settings, first run.
import { closeSheet, confirmDialog, openSheet, sheetElement, toast } from './overlay.js';
import { age, compact, scoreLabel } from './rows.js';
import { engagement, isOutlier } from './score.js';
import * as store from './store.js';
import { $, esc, haptic } from './util.js';
import { LANGUAGES, languageName, videoLanguage } from './lang.js';
import { duration, heat, languagePicker } from './views.js';
import { channelURL, videoURL } from './youtube.js';

const header = (title, { cancel = 'Cancel', submit = 'Save' } = {}) =>
  `<div class="sheet-head"><button type="button" class="link" data-close>${cancel}</button><h2>${esc(title)}</h2>${submit ? `<button type="submit" class="link strong">${esc(submit)}</button>` : '<span></span>'}</div>`;

const switchRow = (id, title, sub, on) =>
  `<label class="row field toggle"><span class="grow"><span class="title">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span><input type="checkbox" class="switch" id="${id}" ${on ? 'checked' : ''}></label>`;

const nicheOptions = (selected) => [`<option value="">No niche</option>`, ...store.get().niches.map((n) => `<option value="${esc(n.id)}" ${n.id === selected ? 'selected' : ''}>${esc(n.name)}</option>`), '<option value="__new">+ New niche…</option>'].join('');

/** Handles the "+ New niche…" option of a niche <select>. Returns the chosen niche id or null. */
async function pickNiche(select) {
  if (select.value !== '__new') return select.value || null;
  const name = prompt('Your niche, e.g. “budget cooking”')?.trim().slice(0, NICHE_MAX);
  if (!name) { select.value = ''; return null; }
  const n = await store.saveNiche({ name, keywords: name });
  select.innerHTML = nicheOptions(n.id);
  return n.id;
}

/** A niche is one phrase: its name is also what Breakout searches YouTube for. */
const NICHE_MAX = 80;

const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy on this device.'); }
};

// ---------------------------------------------------------------------------
// "+" menu and niches
// ---------------------------------------------------------------------------

export function openAddMenu(app) {
  const el = openSheet(`${header('Add', { submit: '' })}
    <div class="options">
      <button type="button" class="option primary" data-pick="niche"><span aria-hidden="true">🔭</span><b>Find outliers in a niche</b><small>From any channel. Just describe the niche.</small></button>
      <button type="button" class="option" data-pick="channel"><span aria-hidden="true">📺</span><b>Track a channel</b><small>Follow a specific competitor closely</small></button>
    </div>`, { label: 'Add' });
  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]')?.dataset.pick;
    if (pick === 'niche') openNicheEditor(app);
    if (pick === 'channel') openAddChannel(app);
  });
}

const scanLabel = (n) => (n.scannedAt ? `searched ${age(n.scannedAt, Date.now())} ago` : 'not searched yet');

/** Runs a niche scan with a status line inside the open sheet. */
async function runScan(app, el, nicheId) {
  const status = $('#ne-status', el);
  if (status) status.hidden = false;
  const r = await store.scanNiche(nicheId);
  const n = r.videos.filter((v) => isOutlier(v, v.score, store.get().settings)).length;
  return n;
}

export function openNicheEditor(app, { id } = {}) {
  const niche = id ? store.get().niches.find((n) => n.id === id) : null;
  const max = app.backend.config.maxNiches ?? 8;
  const el = openSheet(`<form id="ne-form" novalidate>
    ${header(niche ? 'Edit niche' : 'New niche', { submit: niche ? 'Save' : 'Find outliers' })}
    <div class="card list inset">
      <label class="row field"><span class="title">Niche</span><input id="ne-name" maxlength="${NICHE_MAX}" placeholder="e.g. budget cooking" value="${esc(niche?.keywords || niche?.name || '')}" autocomplete="off" enterkeyhint="search" ${niche ? '' : 'autofocus'}></label>
    </div>
    <p class="hint">Type it the way you’d search YouTube. Breakout looks at the most-watched videos of the last 30 days and keeps the ones beating their own channel’s normal. For a wider net, add a couple more with commas: “budget cooking, meal prep”.${niche ? ` Last searched: ${scanLabel(niche).replace('searched ', '')}.` : ''}</p>
    <p class="hint">Each search uses about 130 of the 10,000 free daily YouTube units. ${app.backend.mode === 'cloud' ? `Niches are searched again about every ${app.backend.config.nicheHours ?? 12} hours (up to ${max} niches).` : 'Niches are searched again when you open the app, at most twice a day.'}</p>
    <div class="scan-status" id="ne-status" role="status" hidden><span class="spinner" aria-hidden="true"></span> Searching YouTube and checking each channel’s normal…</div>
    <p class="form-error" id="ne-error" role="alert" hidden></p>
    ${niche ? '<button type="button" class="btn secondary" data-scan>Search again now</button>' : ''}
    ${niche ? '<button type="button" class="btn danger-text" data-del>Delete niche</button>' : ''}
  </form>`, { label: niche ? niche.name : 'New niche' });
  const err = $('#ne-error', el);
  const fail = (m) => { $('#ne-status', el).hidden = true; err.textContent = m; err.hidden = false; };
  const finish = (nicheId, n) => {
    closeSheet();
    app.showNiche(nicheId);
    toast(n == null ? 'Saved' : n ? `Found ${n} outlier${n === 1 ? '' : 's'}` : 'No outliers right now. Breakout will keep looking.');
  };
  $('#ne-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#ne-name', el).value.trim().replace(/\s+/g, ' ').slice(0, NICHE_MAX);
    const keywords = name;
    if (!name) { $('#ne-name', el).focus(); return; }
    const btn = $('button[type="submit"]', el);
    btn.disabled = true; err.hidden = true;
    try {
      const saved = await store.saveNiche({ id: niche?.id, name, keywords });
      const changed = keywords !== (niche?.keywords || niche?.name) || !niche?.scannedAt;
      finish(saved.id, changed ? await runScan(app, el, saved.id) : null);
    } catch (ex) { btn.disabled = false; fail(ex.message); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-scan]')) {
      const b = e.target.closest('[data-scan]');
      b.disabled = true; err.hidden = true;
      try { finish(niche.id, await runScan(app, el, niche.id)); } catch (ex) { b.disabled = false; fail(ex.message); }
    }
    if (e.target.closest('[data-del]')) {
      if (!await confirmDialog({ title: `Delete ${niche.name}?`, message: 'Videos found by its searches are removed. Tracked channels stay, without a niche.', confirmLabel: 'Delete', destructive: true })) return;
      try { await store.deleteNiche(niche.id); closeSheet(); toast('Deleted'); } catch (ex) { toast(ex.message); }
    }
  });
}

// ---------------------------------------------------------------------------
// Add a channel
// ---------------------------------------------------------------------------

export function openAddChannel(app, { nicheId = app.ui.niche?.length === 36 ? app.ui.niche : null } = {}) {
  const max = app.backend.config.maxChannels ?? 30;
  const el = openSheet(`<form id="add-form" novalidate>
    ${header('Track a channel', { submit: 'Add' })}
    <div class="card list inset">
      <label class="row field"><span class="title">Channel</span><input id="add-input" placeholder="@handle or link" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" autofocus></label>
      <label class="row field"><span class="title">Niche</span><select id="add-niche">${nicheOptions(nicheId)}</select></label>
    </div>
    <p class="hint">Paste a channel link (youtube.com/@name), an @handle, or a link to any of their videos. ${store.get().channels.length}/${max} tracked.</p>
    <div class="scan-status" id="add-status" role="status" hidden><span class="spinner" aria-hidden="true"></span> Reading their latest 50 videos…</div>
    <p class="form-error" id="add-error" role="alert" hidden></p>
  </form>`, { label: 'Track a channel' });
  const input = $('#add-input', el), select = $('#add-niche', el), err = $('#add-error', el), status = $('#add-status', el);
  select.addEventListener('change', () => pickNiche(select).catch((e) => toast(e.message)));
  $('#add-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) { input.focus(); return; }
    const btn = $('button[type="submit"]', el);
    btn.disabled = true; err.hidden = true; status.hidden = false;
    try {
      const nid = await pickNiche(select);
      const r = await store.addChannel(input.value.trim(), nid);
      haptic(12);
      closeSheet();
      const n = r.videos.filter((v) => isOutlier(v, v.score, store.get().settings)).length;
      toast(r.error ? `${r.channel.title} added, but: ${r.error}` : `${r.channel.title} added · ${n} outlier${n === 1 ? '' : 's'} in their last 50 videos`);
      app.afterAdd(r.channel);
    } catch (ex) {
      btn.disabled = false; status.hidden = true;
      err.textContent = ex.message; err.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function analysisHTML(a) {
  if (!a) return '';
  return `<div class="analysis">
    <p class="a-summary">${esc(a.summary)}</p>
    <span class="pill ${a.confidence === 'high' ? 'pill-ok' : a.confidence === 'medium' ? 'pill-neutral' : 'pill-warn'}">${esc(a.confidence)} confidence</span>
    <h3 class="mini-title">Why it worked</h3>
    <div class="card list inset">${a.factors.map((f) => `<div class="row factor"><span class="ftag">${esc(f.factor)}</span><span class="grow">${esc(f.insight)}</span></div>`).join('')}</div>
    ${a.titleFormula ? `<h3 class="mini-title">Title formula</h3><button type="button" class="card formula" data-copy="${esc(a.titleFormula)}">${esc(a.titleFormula)}<small>Tap to copy</small></button>` : ''}
    ${a.thumbnailNotes ? `<h3 class="mini-title">Thumbnail</h3><p class="card pad">${esc(a.thumbnailNotes)}</p>` : ''}
    ${a.audienceReaction ? `<h3 class="mini-title">What viewers reacted to</h3><p class="card pad">${esc(a.audienceReaction)}</p>` : ''}
    ${a.ideas.length ? `<h3 class="mini-title">Ideas for your channel</h3><div class="card list inset">${a.ideas.map((i) => `<button type="button" class="row idea" data-copy="${esc(i.title)}"><span class="grow"><span class="title">${esc(i.title)}</span><span class="sub wrap">${esc(i.angle)}</span></span><span class="muted small">Copy</span></button>`).join('')}</div>` : ''}
  </div>`;
}

/** "Language: Hindi · Hide Hindi videos" when a video is in a language you might not want. */
function langRow(v) {
  const l = videoLanguage(v);
  const { language, hideLanguages } = store.get().settings;
  if (!l || l === language || hideLanguages.includes(l)) return l ? `<p class="muted small lang-row">Language: ${esc(languageName(l))}</p>` : '';
  return `<div class="lang-row"><span class="muted small">Language: ${esc(languageName(l))}</span><button type="button" class="chip-btn mini danger" data-hide-lang="${l}">Hide ${esc(languageName(l))} videos</button></div>`;
}

const EMBED = (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;

export function openVideo(app, id) {
  const s = store.get();
  const v = s.videos.find((x) => x.id === id);
  if (!v) return;
  const c = s.channels.find((x) => x.id === v.channelId);
  const channelTitle = c?.title ?? v.channelTitle;
  const baseline = c ? (v.isShort ? c.baselineShort : c.baselineLong) : v.baseline;
  const e = engagement(v);
  const pct = (r) => (r == null ? '–' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`);
  const canAnalyse = app.backend.mode === 'local' || app.backend.config.ai;
  const tracked = !!c || s.channels.some((x) => x.ytChannelId === v.ytChannelId);
  const el = openSheet(`${header('', { cancel: 'Close', submit: '' })}
    <div class="player ${v.isShort ? 'short' : ''}" id="v-player">
      <button type="button" class="hero-thumb" data-play aria-label="Play video">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" referrerpolicy="no-referrer">` : ''}<b class="badge big ${heat(v.score)}">${scoreLabel(v.score)}</b><i class="play" aria-hidden="true">▶</i></button>
    </div>
    <h2 class="v-title">${esc(v.title)}</h2>
    <p class="muted small">${esc(channelTitle)}${!c && v.channelSubs != null ? ` (${compact(v.channelSubs)} subs)` : ''} · ${new Date(v.publishedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
    <dl class="stats stats-grid">
      <div><dt>Views</dt><dd>${compact(v.views)}</dd></div>
      <div><dt>${v.baselineKind === 'average' && !c ? 'Channel avg' : 'Typical'}</dt><dd>${compact(baseline)}</dd></div>
      <div><dt>Age</dt><dd>${age(v.publishedAt, Date.now())}</dd></div>
      <div><dt>Likes</dt><dd>${pct(e.likeRate)}</dd></div>
      <div><dt>Comments</dt><dd>${pct(e.commentRate)}</dd></div>
      <div><dt>${v.isShort ? 'Short' : 'Length'}</dt><dd>${duration(v.durationS)}</dd></div>
    </dl>
    <div class="btn-row">
      <a class="btn secondary" href="${esc(videoURL(v.ytVideoId))}" target="_blank" rel="noopener">Open in YouTube</a>
      <button type="button" class="btn secondary" data-save>${v.saved ? '★ Saved' : '☆ Save'}</button>
    </div>
    ${langRow(v)}
    ${!tracked && v.ytChannelId ? `<button type="button" class="btn secondary" data-track>📺 Track ${esc(channelTitle || 'this channel')}</button>` : ''}
    <div id="v-analysis">${v.analysis ? analysisHTML(v.analysis) : canAnalyse ? '<button type="button" class="btn primary ai-btn" data-analyse>🧠 Why did it work?</button>' : '<p class="hint">AI analysis isn’t set up on this server yet.</p>'}</div>
    ${v.analysis ? '<button type="button" class="link small center-link" data-analyse data-force="1">Analyse again</button>' : ''}`, { label: v.title, focus: false });

  el.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-play]')) {
      $('#v-player', el).innerHTML = `<iframe src="${esc(EMBED(v.ytVideoId))}" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      return;
    }
    const cp = ev.target.closest('[data-copy]');
    if (cp) { copy(cp.dataset.copy); return; }
    const hl = ev.target.closest('[data-hide-lang]');
    if (hl) {
      const l = hl.dataset.hideLang;
      try {
        await store.saveSettings({ hideLanguages: [...store.get().settings.hideLanguages, l] });
        closeSheet();
        toast(`${languageName(l)} videos hidden. Undo in Settings.`);
      } catch (err) { toast(err.message); }
      return;
    }
    if (ev.target.closest('[data-save]')) {
      const cur = store.get().videos.find((x) => x.id === id);
      const b = ev.target.closest('[data-save]');
      try { await store.setSaved(id, !cur.saved); b.textContent = !cur.saved ? '★ Saved' : '☆ Save'; haptic(); } catch (err) { toast(err.message); }
      return;
    }
    if (ev.target.closest('[data-track]')) {
      const b = ev.target.closest('[data-track]');
      b.disabled = true; b.textContent = 'Adding…';
      try {
        const r = await store.addChannel(v.ytChannelId, v.nicheIds?.[0] ?? null);
        b.remove();
        toast(`Now tracking ${r.channel.title}`);
      } catch (err) { b.disabled = false; b.textContent = `📺 Track ${channelTitle}`; toast(err.message); }
      return;
    }
    if (ev.target.closest('[data-save-key]')) {
      const key = $('#v-gem-key', el).value.trim();
      if (!key) { $('#v-gem-key', el).focus(); return; }
      try { await store.saveSettings({ geminiKey: key }); } catch (err) { toast(err.message); return; }
    }
    const an = ev.target.closest('[data-analyse], [data-save-key]');
    if (an && app.backend.mode === 'local' && !store.get().settings.geminiKey) {
      // This-device mode without a Gemini key: ask for it right here instead of sending people to Settings.
      $('#v-analysis', el).innerHTML = `<div class="card key-card">
        <p class="title">🧠 One more free key for this part</p>
        <p class="sub wrap">“Why did it work?” uses Google’s Gemini AI. Everything else only needs your YouTube key.</p>
        <ol class="steps"><li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with Google</li><li>Tap <b>Create API key</b> and copy it</li><li>Paste it here</li></ol>
        <input id="v-gem-key" class="key-input" type="password" placeholder="Paste your Gemini key" autocomplete="off" spellcheck="false">
        <button type="button" class="btn primary" data-save-key>Save and analyse</button>
        <p class="hint">It stays on this device. You can change it later in Settings.</p></div>`;
      $('#v-gem-key', el).focus();
      return;
    }
    if (an) {
      const box = $('#v-analysis', el);
      box.innerHTML = '<div class="scan-status"><span class="spinner" aria-hidden="true"></span> Comparing it with the channel’s other videos…</div>';
      el.querySelector('.center-link')?.remove();
      try {
        const a = await store.analyse(id, an.dataset.force === '1');
        if (sheetElement() === el) box.innerHTML = analysisHTML(a);
      } catch (err) {
        if (sheetElement() === el) box.innerHTML = `<p class="form-error">${esc(err.message)}</p><button type="button" class="btn primary ai-btn" data-analyse>Try again</button>`;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export function openChannel(app, id) {
  const s = store.get();
  const c = s.channels.find((x) => x.id === id);
  if (!c) return;
  const vids = s.videos.filter((v) => v.channelId === id).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const max = Math.max(1, ...vids.map((v) => v.score));
  const el = openSheet(`${header(c.title, { cancel: 'Close', submit: '' })}
    <div class="ch-head">${c.thumb ? `<img class="avatar big" src="${esc(c.thumb)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div><a class="title blue" href="${esc(channelURL(c.ytChannelId))}" target="_blank" rel="noopener">${esc(c.handle || c.title)} ↗</a>
      <p class="muted small">${c.subscribers != null ? `${compact(c.subscribers)} subscribers · ` : ''}checked ${c.checkedAt ? `${age(c.checkedAt, Date.now())} ago` : 'never'}</p></div></div>
    <dl class="stats"><div><dt>Typical video</dt><dd>${compact(c.baselineLong)}</dd></div><div><dt>Typical Short</dt><dd>${compact(c.baselineShort)}</dd></div>
      <div><dt>Outliers</dt><dd>${vids.filter((v) => isOutlier(v, v.score, s.settings)).length}</dd></div></dl>
    <div class="card list inset">
      <label class="row field"><span class="title">Niche</span><select id="ch-niche">${nicheOptions(c.nicheId)}</select></label>
    </div>
    <h3 class="mini-title">Latest ${vids.length} videos</h3>
    <div class="card list inset">${vids.map((v) => `<button type="button" class="row vrow" data-video="${esc(v.id)}">
      <span class="grow"><span class="title">${esc(v.title)}</span><span class="sub">${compact(v.views)} views · ${age(v.publishedAt, Date.now())}${v.isShort ? ' · Short' : ''}</span>
      <span class="meter slim"><i class="fill ${heat(v.score)}" style="width:${Math.max(2, (v.score / max) * 100)}%"></i></span></span>
      <span class="amt ${isOutlier(v, v.score, s.settings) ? heat(v.score) : 'muted'}">${scoreLabel(v.score)}</span></button>`).join('') || '<p class="pad muted">No videos yet.</p>'}</div>
    <button type="button" class="btn secondary" data-refresh>Check this channel now</button>
    <button type="button" class="btn danger-text" data-remove>Stop tracking</button>`, { label: c.title, focus: false });

  $('#ch-niche', el).addEventListener('change', async (e) => {
    try { await store.moveChannel(id, await pickNiche(e.target)); toast('Moved'); } catch (err) { toast(err.message); }
  });
  el.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-video]');
    if (row) { openVideo(app, row.dataset.video); return; }
    if (e.target.closest('[data-refresh]')) {
      const b = e.target.closest('[data-refresh]');
      b.disabled = true; b.textContent = 'Checking…';
      try { await store.refresh(id); closeSheet(true); openChannel(app, id); toast('Up to date'); } catch (err) { b.disabled = false; b.textContent = 'Check this channel now'; toast(err.message); }
      return;
    }
    if (e.target.closest('[data-remove]')) {
      if (!await confirmDialog({ title: `Stop tracking ${c.title}?`, message: 'Its videos and any analyses are removed.', confirmLabel: 'Remove', destructive: true })) return;
      try { await store.deleteChannel(id); closeSheet(); toast('Removed'); } catch (err) { toast(err.message); }
    }
  });
}

// ---------------------------------------------------------------------------
// Niches
// ---------------------------------------------------------------------------

export function openNiches(app) {
  const { niches, channels } = store.get();
  const el = openSheet(`${header('Niches', { cancel: 'Done', submit: '' })}
    <p class="hint">Each niche finds outliers from any channel. Tracked channels can be grouped under a niche too.</p>
    <div class="card list inset">${niches.map((n) => `<button type="button" class="row" data-edit="${esc(n.id)}">
        <span class="ico" style="--c:#ff3b30" aria-hidden="true">🔭</span>
        <span class="grow"><span class="title">${esc(n.name)}</span><span class="sub">${scanLabel(n)} · ${channels.filter((c) => c.nicheId === n.id).length} tracked channels</span></span>
        <span class="chev" aria-hidden="true">›</span></button>`).join('')}
      <button type="button" class="row add-row" data-new><span class="ico add-ico" aria-hidden="true">+</span><span class="title">New niche</span></button></div>`, { label: 'Niches' });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) openNicheEditor(app);
    const r = e.target.closest('[data-edit]');
    if (r) openNicheEditor(app, { id: r.dataset.edit });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const THRESHOLDS = [2, 3, 5, 10];

const hiddenChips = (list) => (list.length
  ? list.map((c) => `<button type="button" class="chip-btn mini" data-unhide="${c}" aria-label="Show ${esc(languageName(c))} again">${esc(languageName(c))} ✕</button>`).join(' ')
  : '<span class="sub">none</span>');
const MIN_VIEWS = [0, 1000, 10000, 100000];

export function openSettings(app) {
  const s = store.get().settings;
  const b = app.backend;
  const cloud = b.mode === 'cloud';
  const tgOn = cloud && b.config.telegram;
  const tgRow = () => (store.get().telegram.linked
    ? `<div class="row"><span class="grow"><span class="title">Telegram</span><span class="sub">Connected</span></span><button type="button" class="link" data-act="tg-test">Test</button><button type="button" class="link destructive" data-act="tg-unlink">Disconnect</button></div>`
    : `<button type="button" class="row" data-act="tg-link"><span class="ico" style="--c:#2aabee" aria-hidden="true">✈️</span><span class="grow"><span class="title blue">Connect Telegram</span><span class="sub">Get a message when a channel breaks out</span></span></button>`);
  const el = openSheet(`${header('Settings', { cancel: 'Done', submit: '' })}
    <h3 class="group-label">Account</h3>
    <div class="card list inset">${cloud
      ? `<div class="row"><span class="grow"><span class="title">Signed in</span><span class="sub">${esc(b.user?.email ?? '')}</span></span><button type="button" class="link" data-act="sign-out">Sign out</button></div>`
      : `<div class="row"><span class="grow"><span class="title">This device only</span><span class="sub">Uses your own API keys. Channels are checked while the app is open.</span></span>${b.config.cloud ? '<button type="button" class="link" data-act="use-cloud">Sign in</button>' : ''}</div>`}</div>

    <h3 class="group-label">What counts as an outlier</h3>
    <div class="card list inset">
      <label class="row field"><span class="title">At least</span><select id="set-threshold">${[...new Set([...THRESHOLDS, s.threshold])].sort((x, y) => x - y).map((t) => `<option value="${t}" ${t === s.threshold ? 'selected' : ''}>${t}× typical views</option>`).join('')}</select></label>
      <label class="row field"><span class="title">And at least</span><select id="set-min">${[...new Set([...MIN_VIEWS, s.minViews])].sort((x, y) => x - y).map((m) => `<option value="${m}" ${m === s.minViews ? 'selected' : ''}>${m ? `${compact(m)} views` : 'any views'}</option>`).join('')}</select></label>
      ${switchRow('set-shorts', 'Include Shorts', 'Shorts are compared with the channel’s other Shorts', s.includeShorts)}
      <div class="row field"><span class="title">Language</span><span class="grow"></span>${languagePicker(s.language, 'set-language')}</div>
      ${switchRow('set-mixed', 'Hide mixed-language videos', 'Titles that mix in another alphabet, e.g. Hindi words in an English title', s.hideMixed)}
      <div class="row field hide-langs"><span class="title">Never show</span><span class="grow" id="hidden-langs">${hiddenChips(s.hideLanguages)}</span></div>
      <label class="row field"><span class="title">Hide a language</span><select id="set-hide-lang"><option value="">Choose…</option>${LANGUAGES.filter(([c]) => c !== 'any').map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}</select></label>
    </div>
    <p class="hint">Niche searches favour your language. Videos clearly in another language are hidden; ones the app can’t place stay visible.</p>

    ${cloud ? `<h3 class="group-label">Alerts</h3>
    <div class="card list inset">
      ${tgOn ? `<div id="tg-row">${tgRow()}</div>` : '<div class="row"><span class="grow sub">Telegram alerts aren’t set up on this server yet.</span></div>'}
      ${tgOn ? switchRow('set-alerts', 'Send alerts', 'Fresh breakouts from the last 14 days', s.alerts) : ''}
    </div>` : `<h3 class="group-label">Your API keys</h3>
    <div class="card list inset">
      <label class="row field"><span class="title">YouTube key</span><input id="set-yt" type="password" placeholder="Required" value="${esc(s.youtubeKey || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="row field"><span class="title">Gemini key</span><input id="set-gem" type="password" placeholder="For “Why did it work?”" value="${esc(s.geminiKey || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="row field"><span class="title">Gemini model</span><input id="set-model" placeholder="gemini-flash-latest" value="${esc(s.geminiModel || '')}" autocomplete="off" spellcheck="false"></label>
    </div>
    <p class="hint">YouTube key: Google Cloud Console → APIs &amp; Services → enable “YouTube Data API v3” → Credentials → Create API key (free, 10,000 units a day; one channel check uses 3). Gemini key: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Keys stay in this browser.</p>`}

    <h3 class="group-label">Data</h3>
    <div class="card list inset">
      <button type="button" class="row" data-act="wipe"><span class="grow title red">${cloud ? 'Delete my account and data' : 'Delete everything on this device'}</span></button>
    </div>
    <p class="about">Breakout · YouTube outlier tracker<br>Scores compare views with the channel’s typical views at the same age.</p>`, { label: 'Settings', focus: false });

  const save = (patch) => store.saveSettings(patch).catch((err) => toast(err.message));
  const on = (sel, ev, fn) => $(sel, el)?.addEventListener(ev, fn);
  on('#set-threshold', 'change', (e) => save({ threshold: Number(e.target.value) }));
  on('#set-min', 'change', (e) => save({ minViews: Number(e.target.value) }));
  on('#set-shorts', 'change', (e) => save({ includeShorts: e.target.checked }));
  on('#set-mixed', 'change', (e) => save({ hideMixed: e.target.checked }));
  const showHidden = () => { $('#hidden-langs', el).innerHTML = hiddenChips(store.get().settings.hideLanguages); };
  on('#set-hide-lang', 'change', async (e) => {
    if (!e.target.value) return;
    await save({ hideLanguages: [...store.get().settings.hideLanguages, e.target.value] });
    e.target.value = '';
    showHidden();
  });
  el.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-unhide]');
    if (!u) return;
    await save({ hideLanguages: store.get().settings.hideLanguages.filter((c) => c !== u.dataset.unhide) });
    showHidden();
  });
  on('#set-alerts', 'change', (e) => save({ alerts: e.target.checked }));
  on('#set-yt', 'change', (e) => save({ youtubeKey: e.target.value.trim() }));
  on('#set-gem', 'change', (e) => save({ geminiKey: e.target.value.trim() }));
  on('#set-model', 'change', (e) => save({ geminiModel: e.target.value.trim() }));

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'sign-out') { closeSheet(true); await app.signOut(); }
      if (act === 'use-cloud') { closeSheet(true); app.useCloud(); }
      if (act === 'tg-link') {
        const w = window.open('', '_blank');
        const url = await b.telegramLink();
        if (w) w.location = url; else location.href = url;
        toast('Tap Start in Telegram, then come back here.', { ms: 8000 });
        app.watchTelegram(() => { const r = $('#tg-row', el); if (r) r.innerHTML = tgRow(); });
      }
      if (act === 'tg-test') { await b.telegramTest(); toast('Test message sent'); }
      if (act === 'tg-unlink') { await b.telegramUnlink(); store.setTelegram({ linked: false }); $('#tg-row', el).innerHTML = tgRow(); }
      if (act === 'wipe') {
        const ok = await confirmDialog({ title: cloud ? 'Delete your account?' : 'Delete everything?', message: 'All channels, videos and analyses are removed for good.', confirmLabel: 'Delete', destructive: true });
        if (ok) { closeSheet(true); await app.wipe(); }
      }
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

export function openOnboarding(app) {
  const local = app.backend.mode === 'local';
  const el = openSheet(`<form id="ob-form" class="welcome" novalidate>
    <div class="welcome-art" aria-hidden="true">📈</div>
    <h2 class="welcome-title">What’s your niche?</h2>
    <p class="welcome-text">Breakout searches YouTube for it and shows the videos beating their own channel’s normal views.</p>
    <div class="card list inset">
      <label class="row field"><span class="title">Niche</span><input id="ob-niche" maxlength="${NICHE_MAX}" placeholder="e.g. budget cooking" autocomplete="off" enterkeyhint="search"></label>
      <label class="row field"><span class="title">Outlier at</span><select id="ob-threshold">${THRESHOLDS.map((t) => `<option value="${t}" ${t === 3 ? 'selected' : ''}>${t}× typical views</option>`).join('')}</select></label>
      ${local ? '<label class="row field"><span class="title">YouTube key</span><input id="ob-yt" type="password" placeholder="Required" autocomplete="off" spellcheck="false"></label>' : ''}
    </div>
    <p class="hint">Type it the way you’d search YouTube.${local ? ' YouTube key: free from Google Cloud Console → enable “YouTube Data API v3” → Credentials → Create API key. It stays in this browser.' : ''}</p>
    <div class="scan-status" id="ne-status" role="status" hidden><span class="spinner" aria-hidden="true"></span> Searching YouTube…</div>
    <p class="form-error" id="ob-error" role="alert" hidden></p>
    <button type="submit" class="btn primary">Find outliers</button>
    <button type="button" class="link center-link" data-skip>Skip — I’ll track specific channels</button>
  </form>`, { label: 'Set up Breakout' });
  const er = $('#ob-error', el);
  const settingsPatch = () => ({ onboarded: true, threshold: Number($('#ob-threshold', el).value), ...(local ? { youtubeKey: $('#ob-yt', el).value.trim() } : {}) });
  const needKey = () => { if (local && !$('#ob-yt', el).value.trim()) { er.textContent = 'Add a YouTube API key to search YouTube.'; er.hidden = false; return true; } return false; };
  $('#ob-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#ob-niche', el).value.trim().replace(/\s+/g, ' ').slice(0, NICHE_MAX);
    if (!name) { $('#ob-niche', el).focus(); return; }
    if (needKey()) return;
    const btn = $('button[type="submit"]', el);
    btn.disabled = true; er.hidden = true;
    try {
      await store.saveSettings(settingsPatch());
      const n = await store.saveNiche({ name, keywords: name });
      const found = await runScan(app, el, n.id);
      closeSheet();
      app.showNiche(n.id);
      toast(found ? `Found ${found} outlier${found === 1 ? '' : 's'} in ${name}` : `No outliers in ${name} right now. Breakout will keep looking.`);
    } catch (err) {
      btn.disabled = false; $('#ne-status', el).hidden = true;
      er.textContent = err.message; er.hidden = false;
    }
  });
  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-skip]') || needKey()) return;
    try { await store.saveSettings(settingsPatch()); closeSheet(true); openAddChannel(app); } catch (err) { toast(err.message); }
  });
}
