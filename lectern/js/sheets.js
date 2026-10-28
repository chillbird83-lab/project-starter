// Sheets (modal forms): course, lecture details & actions, bookmark, settings, onboarding.
import {
  BOOKMARK_KINDS, COURSE_COLORS, COURSE_EMOJIS, DAYS, QUALITY, bytesPerHour, fileNameFor, formatBytes, formatClock, isISODate,
  sanitizeSlot, todayISO,
} from './logic.js';
import { closeSheet, confirmDialog, openSheet, toast } from './overlay.js';
import * as player from './player.js';
import * as recorder from './recorder.js';
import * as store from './store.js';
import { $, $$, downloadBlob, esc, haptic, shareFile, uid } from './util.js';
import { courseOf } from './views.js';

const header = (title, { cancel = 'Cancel', submit = 'Save' } = {}) =>
  `<div class="sheet-head"><button type="button" class="link" data-close>${cancel}</button><h2>${esc(title)}</h2>${submit ? `<button type="submit" class="link strong">${esc(submit)}</button>` : '<span></span>'}</div>`;

const fail = (errEl, msg, node) => {
  errEl.textContent = msg;
  errEl.hidden = false;
  node?.focus();
  node?.classList.add('shake');
  setTimeout(() => node?.classList.remove('shake'), 400);
};

// Monday-first, like a university timetable.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

// ---------------------------------------------------------------------------
// Course
// ---------------------------------------------------------------------------

/** app: { openCourse(id), back() } */
export function openCourseSheet(app, { id } = {}) {
  const st = store.get();
  const editing = id ? st.courses.find((c) => c.id === id) : null;
  const form = {
    color: editing?.color ?? COURSE_COLORS[st.courses.length % COURSE_COLORS.length],
    slots: editing ? editing.slots.map((s) => ({ ...s })) : [],
  };

  const slotRows = () => form.slots.map((s, i) => `<div class="row slot-edit" data-i="${i}">
      <select class="slot-day" aria-label="Day">${WEEK_ORDER.map((d) => `<option value="${d}" ${d === s.day ? 'selected' : ''}>${DAYS[d]}</option>`).join('')}</select>
      <input class="slot-start" type="time" value="${esc(s.start)}" aria-label="Starts" required>
      <span class="muted" aria-hidden="true">–</span>
      <input class="slot-end" type="time" value="${esc(s.end)}" aria-label="Ends" required>
      <button type="button" class="icon-btn subtle" data-del-slot="${i}" aria-label="Remove time">✕</button>
    </div>`).join('');

  const colors = () => COURSE_COLORS.map((c) => `<button type="button" class="swatch ${c === form.color ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}" aria-pressed="${c === form.color}"></button>`).join('');

  const el = openSheet(`<form id="course-form" novalidate>
    ${header(editing ? 'Edit course' : 'New course')}
    <div class="card list inset">
      <div class="row field"><input id="c-emoji" class="emoji-input" maxlength="8" value="${esc(editing?.emoji ?? COURSE_EMOJIS[st.courses.length % COURSE_EMOJIS.length])}" aria-label="Emoji">
        <input id="c-name" class="grow" maxlength="50" placeholder="Course name, e.g. Calculus I" value="${esc(editing?.name ?? '')}" aria-label="Course name" ${editing ? '' : 'autofocus'}></div>
      <label class="row field"><span class="title">Lecturer</span><input id="c-lecturer" maxlength="60" placeholder="Optional" value="${esc(editing?.lecturer ?? '')}"></label>
      <label class="row field"><span class="title">Room</span><input id="c-room" maxlength="40" placeholder="Optional" value="${esc(editing?.room ?? '')}"></label>
    </div>
    <h3 class="mini-title">Colour</h3>
    <div class="swatches" id="c-colors">${colors()}</div>
    <h3 class="mini-title">Weekly times</h3>
    <div class="card list inset" id="c-slots">${slotRows()}<button type="button" class="row add-row" data-add-slot><span class="ico add-ico" aria-hidden="true">＋</span><span class="grow title">Add a weekly time</span></button></div>
    <p class="hint">Lectern uses these to pick the right course when you start recording, and to build your week.</p>
    <p class="form-error" id="c-error" role="alert" hidden></p>
    ${editing ? `<button type="button" class="btn secondary" data-archive>${editing.archived ? 'Restore from archive' : 'Archive course (end of semester)'}</button>
      <button type="button" class="btn danger-text" data-del>Delete course</button>` : ''}
  </form>`, { label: editing ? 'Edit course' : 'New course' });

  const readSlots = () => {
    $$('.slot-edit', el).forEach((row) => {
      const s = form.slots[Number(row.dataset.i)];
      s.day = Number($('.slot-day', row).value);
      s.start = $('.slot-start', row).value;
      s.end = $('.slot-end', row).value;
    });
  };
  const mountSlots = () => {
    readSlots();
    $('#c-slots', el).innerHTML = `${slotRows()}<button type="button" class="row add-row" data-add-slot><span class="ico add-ico" aria-hidden="true">＋</span><span class="grow title">Add a weekly time</span></button>`;
  };

  el.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) { form.color = sw.dataset.color; $('#c-colors', el).innerHTML = colors(); haptic(); return; }
    if (e.target.closest('[data-add-slot]')) {
      readSlots();
      const last = form.slots.at(-1);
      // Next weekday after the last one, same times — most courses meet at a regular time.
      const day = last ? WEEK_ORDER[(WEEK_ORDER.indexOf(last.day) + 1) % 7] : 1;
      form.slots.push({ day, start: last?.start ?? '10:00', end: last?.end ?? '11:30' });
      mountSlots();
      $$('.slot-day', el).at(-1)?.focus();
      return;
    }
    const del = e.target.closest('[data-del-slot]');
    if (del) { readSlots(); form.slots.splice(Number(del.dataset.delSlot), 1); mountSlots(); return; }
    if (e.target.closest('[data-archive]')) {
      store.saveCourse({ ...editing, archived: !editing.archived });
      closeSheet();
      toast(editing.archived ? 'Course restored' : 'Course archived');
      return;
    }
    if (e.target.closest('[data-del]')) {
      const n = store.get().lectures.filter((l) => l.courseId === editing.id).length;
      const ok = await confirmDialog({
        title: `Delete “${editing.name}”?`,
        message: n ? `Its ${n} recording${n === 1 ? '' : 's'} will be kept under “No course”.` : '',
        confirmLabel: 'Delete', destructive: true,
      });
      if (!ok) return;
      store.deleteCourse(editing.id);
      closeSheet();
      app.back();
      toast('Course deleted');
    }
  });

  $('#course-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    readSlots();
    const err = $('#c-error', el);
    const name = $('#c-name', el).value.trim();
    if (!name) return fail(err, 'Give the course a name.', $('#c-name', el));
    const bad = form.slots.findIndex((s) => !sanitizeSlot(s));
    if (bad >= 0) return fail(err, 'Each weekly time needs a start and an end after it.', $$('.slot-end', el)[bad]);
    const course = {
      id: editing?.id ?? uid(), name, emoji: $('#c-emoji', el).value.trim() || '📘', color: form.color,
      lecturer: $('#c-lecturer', el).value.trim(), room: $('#c-room', el).value.trim(),
      slots: form.slots.map(sanitizeSlot), archived: editing?.archived ?? false, createdAt: editing?.createdAt ?? Date.now(),
    };
    store.saveCourse(course);
    haptic(12);
    closeSheet();
    toast(editing ? 'Saved' : 'Course added');
    if (!editing) app.afterCourseAdded?.(course.id);
  });
}

// ---------------------------------------------------------------------------
// Lecture details & actions
// ---------------------------------------------------------------------------

export function openLectureDetails(id) {
  const st = store.get();
  const l = store.lecture(id);
  const el = openSheet(`<form id="lec-form" novalidate>
    ${header('Details')}
    <div class="card list inset">
      <label class="row field"><span class="title">Title</span><input id="l-title" maxlength="80" value="${esc(l.title)}"></label>
      <label class="row field"><span class="title">Course</span><select id="l-course">
        <option value="">No course</option>${st.courses.map((c) => `<option value="${esc(c.id)}" ${c.id === l.courseId ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}${c.archived ? ' (archived)' : ''}</option>`).join('')}
      </select></label>
      <label class="row field"><span class="title">Date</span><input id="l-date" type="date" value="${esc(l.date)}" max="${todayISO()}"></label>
    </div>
    <p class="form-error" id="l-error" role="alert" hidden></p>
  </form>`, { label: 'Recording details' });

  $('#lec-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#l-title', el).value.trim();
    const date = $('#l-date', el).value;
    if (!title) return fail($('#l-error', el), 'Give the recording a title.', $('#l-title', el));
    if (!isISODate(date)) return fail($('#l-error', el), 'Pick a date.', $('#l-date', el));
    store.updateLecture(id, { title, date, courseId: $('#l-course', el).value || null });
    closeSheet();
    toast('Saved');
  });
}

async function audioFile(l) {
  const blob = await store.getAudio(l.id);
  if (!blob) throw new Error('Audio not found');
  return { blob, name: fileNameFor(l, courseOf(store.get(), l.courseId).name || '') };
}

/** app: { back() } */
export function openLectureMenu(app, id) {
  const l = store.lecture(id);
  const el = openSheet(`${header('Recording', { cancel: 'Done', submit: '' })}
    <div class="card list inset">
      <button type="button" class="row" data-act="details"><span class="ico" style="--c:#007aff" aria-hidden="true">✏️</span><span class="grow title">Edit title, course or date</span></button>
      ${l.hasAudio ? `<button type="button" class="row" data-act="share"><span class="ico" style="--c:#34c759" aria-hidden="true">📤</span><span class="grow"><span class="title">Share audio</span><span class="sub">Google Drive, WhatsApp, e-mail… · ${esc(formatBytes(l.size))}</span></span></button>
      <button type="button" class="row" data-act="download"><span class="ico" style="--c:#5856d6" aria-hidden="true">⬇️</span><span class="grow title">Save audio file to phone</span></button>` : ''}
      <button type="button" class="row" data-act="copy-notes"><span class="ico" style="--c:#ff9500" aria-hidden="true">📋</span><span class="grow title">Copy notes & bookmarks</span></button>
    </div>
    <div class="card list inset">
      ${l.hasAudio ? `<button type="button" class="row" data-act="strip"><span class="ico" style="--c:#ff9500" aria-hidden="true">🧹</span><span class="grow"><span class="title">Remove audio, keep notes</span><span class="sub">Frees ${esc(formatBytes(l.size))}</span></span></button>` : ''}
      <button type="button" class="row" data-act="delete"><span class="ico" style="--c:#ff3b30" aria-hidden="true">🗑️</span><span class="grow title red">Delete recording</span></button>
    </div>`, { label: 'Recording actions' });

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'details') openLectureDetails(id);
      if (act === 'share') {
        const f = await audioFile(l);
        const r = await shareFile(f.name, f.blob, l.title);
        if (r === 'downloaded') toast('Saved to Downloads');
      }
      if (act === 'download') { const f = await audioFile(l); downloadBlob(f.name, f.blob); toast('Saved to Downloads'); }
      if (act === 'copy-notes') {
        const c = courseOf(store.get(), l.courseId);
        const text = [`${l.title} — ${c.name} — ${l.date}`, '',
          ...(l.bookmarks.length ? ['Bookmarks:', ...l.bookmarks.map((b) => `[${formatClock(b.t)}] ${BOOKMARK_KINDS[b.kind].emoji} ${b.label || BOOKMARK_KINDS[b.kind].label}`), ''] : []),
          l.notes].join('\n').trim();
        await navigator.clipboard.writeText(text);
        toast('Copied — paste it into your notes app');
      }
      if (act === 'strip' && await confirmDialog({ title: 'Remove the audio?', message: `Frees ${formatBytes(l.size)}. Notes and bookmarks stay. Share or save the audio first if you might need it.`, confirmLabel: 'Remove', destructive: true })) {
        if (player.loadedId() === id) player.unload();
        store.removeAudio(id);
        closeSheet();
        toast('Audio removed');
      }
      if (act === 'delete' && await confirmDialog({ title: 'Delete this recording?', message: 'The audio, notes and bookmarks will be deleted. This cannot be undone.', confirmLabel: 'Delete', destructive: true })) {
        if (player.loadedId() === id) player.unload();
        store.deleteLecture(id);
        closeSheet();
        app.back();
        toast('Recording deleted');
      }
    } catch (err) {
      toast(err.message || 'That did not work');
    }
  });
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

/**
 * Add or edit a bookmark. For a saved lecture pass `lectureId` (and `bookmarkId` to edit);
 * while recording, pass `live: true` with the time captured when the button was tapped.
 */
export function openBookmarkSheet({ lectureId, bookmarkId, t, kind = 'note', live = false }) {
  const l = lectureId ? store.lecture(lectureId) : null;
  const editing = l && bookmarkId ? l.bookmarks.find((b) => b.id === bookmarkId) : null;
  const form = { kind: editing?.kind ?? kind };
  const time = editing?.t ?? t;
  const kinds = () => Object.entries(BOOKMARK_KINDS).map(([k, b]) => `<button type="button" class="chip ${k === form.kind ? 'on' : ''}" data-kind="${k}" style="--c:${b.color}" aria-pressed="${k === form.kind}"><span aria-hidden="true">${b.emoji}</span>${esc(b.label)}</button>`).join('');

  const el = openSheet(`<form id="bm-form" novalidate>
    ${header(editing ? 'Bookmark' : `Bookmark at ${formatClock(time)}`, { submit: editing ? 'Save' : 'Add' })}
    <div class="chips" id="bm-kinds">${kinds()}</div>
    <div class="card list inset"><label class="row field"><span class="title">Label</span><input id="bm-label" maxlength="80" placeholder="What happens here?" value="${esc(editing?.label ?? '')}" autofocus enterkeyhint="done"></label>
      ${editing ? `<div class="row"><span class="title grow">Time</span><span class="muted tnum">${formatClock(time)}</span></div>` : ''}</div>
    ${editing ? '<button type="button" class="btn danger-text" data-del>Delete bookmark</button>' : ''}
  </form>`, { label: 'Bookmark' });

  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { form.kind = k.dataset.kind; $('#bm-kinds', el).innerHTML = kinds(); haptic(); return; }
    if (e.target.closest('[data-del]')) {
      store.updateLecture(lectureId, { bookmarks: l.bookmarks.filter((b) => b.id !== bookmarkId) });
      closeSheet();
      toast('Bookmark deleted', { actionLabel: 'Undo', onAction: () => store.updateLecture(lectureId, { bookmarks: [...store.lecture(lectureId).bookmarks, editing].sort((a, b) => a.t - b.t) }) });
    }
  });

  $('#bm-form', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const label = $('#bm-label', el).value.trim();
    if (live) {
      recorder.addBookmark(form.kind, label, time);
    } else if (editing) {
      store.updateLecture(lectureId, { bookmarks: l.bookmarks.map((b) => (b.id === bookmarkId ? { ...b, kind: form.kind, label } : b)) });
    } else {
      store.updateLecture(lectureId, { bookmarks: [...l.bookmarks, { id: uid(), t: Math.round(time), kind: form.kind, label }].sort((a, b) => a.t - b.t) });
    }
    haptic(12);
    closeSheet();
    if (!editing) toast(`${BOOKMARK_KINDS[form.kind].emoji} Bookmarked ${formatClock(time)}`);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function openSettings(app) {
  const el = openSheet('<div id="settings"></div>', { label: 'Settings', focus: false });
  const root = $('#settings', el);

  const mount = async () => {
    const st = store.get();
    const s = st.settings;
    let usage = '', persisted = false;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) usage = `${formatBytes(est.usage)} used · about ${formatBytes(Math.max(0, est.quota - est.usage))} free for Lectern`;
      persisted = (await navigator.storage?.persisted?.()) ?? false;
    } catch { /* estimate not available */ }
    const audioCount = st.lectures.filter((l) => l.hasAudio).length;
    root.innerHTML = `${header('Settings', { cancel: 'Done', submit: '' })}
      <h3 class="group-label">Recording quality</h3>
      <div class="seg" role="group" aria-label="Recording quality">${Object.entries(QUALITY).map(([k, q]) => `<button type="button" class="${s.quality === k ? 'on' : ''}" aria-pressed="${s.quality === k}" data-quality="${k}">${q.label}</button>`).join('')}</div>
      <p class="hint">${QUALITY[s.quality].bps / 1000} kbps · about ${formatBytes(bytesPerHour(s.quality))} per hour. Standard is clear for speech; High suits music or seminars with many voices.</p>
      <div class="card list inset">
        <label class="row field"><span class="title grow">Noise reduction</span><input type="checkbox" class="switch" id="s-noise" ${s.noiseReduction ? 'checked' : ''}></label>
      </div>
      <p class="hint">Filters out hum and fans. Turn it off if the lecturer sounds muffled.</p>

      <h3 class="group-label">Appearance</h3>
      <div class="seg" role="group" aria-label="Theme">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => `<button type="button" class="${s.theme === v ? 'on' : ''}" aria-pressed="${s.theme === v}" data-theme="${v}">${t}</button>`).join('')}</div>

      <h3 class="group-label">Storage</h3>
      <div class="card list inset">
        <div class="row"><span class="grow"><span class="title">${audioCount} recording${audioCount === 1 ? '' : 's'} on this phone</span>${usage ? `<span class="sub">${esc(usage)}</span>` : ''}</span></div>
        <div class="row"><span class="grow"><span class="title">Protected from clean-up</span><span class="sub">${persisted ? 'Chrome will not delete Lectern’s data when space runs low.' : 'Install Lectern to your home screen so Chrome keeps your recordings safe.'}</span></span>${persisted ? '<span class="pill pill-ok">On</span>' : '<button type="button" class="chip-btn" data-act="persist">Turn on</button>'}</div>
      </div>
      <p class="hint">Recordings live only on this phone. Clearing Chrome’s site data deletes them — make a backup now and then.</p>

      <h3 class="group-label">Backup</h3>
      <div class="card list inset">
        <button type="button" class="row" data-act="backup"><span class="ico" style="--c:#007aff" aria-hidden="true">💾</span><span class="grow"><span class="title">Download full backup</span><span class="sub" id="backup-sub">A .zip with every recording, plus courses, notes and bookmarks</span></span></button>
        <button type="button" class="row" data-act="restore"><span class="ico" style="--c:#34c759" aria-hidden="true">📥</span><span class="grow"><span class="title">Restore from backup</span><span class="sub">Adds what is missing; keeps what is already here</span></span></button>
      </div>
      <input type="file" id="restore-file" accept=".zip,application/zip" hidden>
      <button type="button" class="btn danger-text" data-act="erase">Erase all data</button>
      <p class="about">Lectern · private, offline, free · everything stays on your phone</p>`;
  };

  root.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-quality]');
    if (q) { store.updateSettings({ quality: q.dataset.quality }); mount(); return; }
    const th = e.target.closest('[data-theme]');
    if (th) { store.updateSettings({ theme: th.dataset.theme }); mount(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'persist') {
      toast((await store.persistStorage()) ? 'Recordings are protected' : 'Chrome said no — install Lectern to your home screen first');
      mount();
    }
    if (act === 'backup') {
      const sub = $('#backup-sub', root);
      try {
        const zip = await store.exportBackup((p) => { sub.textContent = `Preparing… ${Math.round(p * 100)}%`; });
        downloadBlob(`lectern-backup-${todayISO()}.zip`, zip);
        sub.textContent = `Saved to Downloads · ${formatBytes(zip.size)}`;
        toast('Backup saved to Downloads');
      } catch (err) {
        sub.textContent = 'A .zip with every recording, plus courses, notes and bookmarks';
        toast(err.message || 'Backup failed');
      }
    }
    if (act === 'restore') $('#restore-file', root).click();
    if (act === 'erase' && await confirmDialog({ title: 'Erase everything?', message: 'All recordings, courses, notes and bookmarks on this phone will be deleted. This cannot be undone.', confirmLabel: 'Erase', destructive: true })) {
      if (recorder.current()) { toast('Stop the recording first'); return; }
      player.unload();
      await store.eraseAll();
      closeSheet();
      app.home();
      toast('All data erased');
    }
  });

  root.addEventListener('change', async (e) => {
    if (e.target.id === 's-noise') store.updateSettings({ noiseReduction: e.target.checked });
    if (e.target.id === 'restore-file') {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        toast('Restoring…', { ms: 60_000 });
        const r = await store.importBackup(file);
        toast(r.lectures || r.courses ? `Restored ${r.lectures} recording${r.lectures === 1 ? '' : 's'} and ${r.courses} course${r.courses === 1 ? '' : 's'}` : 'Everything in that backup is already here');
        mount();
      } catch (err) {
        toast(err.message || 'That backup could not be read');
      }
    }
  });

  mount();
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/** app: { newCourse(), record() } */
export function openOnboarding(app) {
  const el = openSheet(`<div class="welcome">
    <div class="welcome-art" aria-hidden="true">🎓</div>
    <h2 class="welcome-title">Welcome to Lectern</h2>
    <p class="welcome-text">Record your lectures and keep them organised — free, private, and offline.</p>
    <ul class="features">
      <li><span aria-hidden="true">🎙️</span><span><b>Record whole lectures.</b> The screen stays on and audio is saved every few seconds, so nothing is lost.</span></li>
      <li><span aria-hidden="true">🔖</span><span><b>Bookmark key moments</b> — “exam”, “important”, “question” — and jump straight back to them.</span></li>
      <li><span aria-hidden="true">📚</span><span><b>Organised by course.</b> Add your timetable and every recording is filed and titled for you.</span></li>
      <li><span aria-hidden="true">📝</span><span><b>Notes, review list and search</b> across everything you recorded.</span></li>
    </ul>
    <button type="button" class="btn primary" data-go="course">Add my first course</button>
    <button type="button" class="btn secondary" data-go="skip">Skip for now</button>
  </div>`, { label: 'Welcome', focus: false });

  el.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (!go) return;
    store.markOnboarded();
    closeSheet();
    if (go === 'course') app.newCourse();
  });
}
