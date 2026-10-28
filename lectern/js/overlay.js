// Bottom sheets, iOS-style alerts and toasts. An open sheet owns one browser-history entry, so the
// Android back button closes the sheet instead of leaving the screen.
import { $, $$, esc } from './util.js';

let sheet = null; // { backdrop, el, onClose, opener }
let ownBack = null; // resolves when the history.back() issued by closeSheet has landed

/** Wait for this before pushing a history entry, so it is not undone by a pending back(). */
export const historySettled = () => ownBack?.promise ?? Promise.resolve();

addEventListener('popstate', (e) => {
  if (ownBack) {
    const { resolve } = ownBack;
    ownBack = null;
    e.stopImmediatePropagation();
    resolve();
    return;
  }
  if (sheet) closeSheet(false, { fromHistory: true });
});

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Opens a bottom sheet containing `html`. Returns the sheet element so callers can wire it up. */
export function openSheet(html, { onClose, label = 'Dialog', focus = true } = {}) {
  const replacing = !!sheet;
  closeSheet(true, { keepHistory: true });
  if (!replacing) historySettled().then(() => history.pushState({ ...history.state, sheet: true }, ''));
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="grabber" aria-hidden="true"></div><div class="sheet-body">${html}</div></div>`;
  const el = $('.sheet', backdrop);
  sheet = { backdrop, el, onClose, opener: document.activeElement };
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  document.getElementById('app').setAttribute('inert', '');

  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) closeSheet(); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  enableDragToClose(el);
  if (focus) requestAnimationFrame(() => (el.querySelector('[autofocus]') || el.querySelector('input,select,button'))?.focus({ preventScroll: true }));
  return el;
}

export const sheetElement = () => sheet?.el ?? null;
export const sheetOpen = () => !!sheet;

export function closeSheet(immediate = false, { keepHistory = false, fromHistory = false } = {}) {
  if (!sheet) return;
  const { backdrop, onClose, opener } = sheet;
  sheet = null;
  document.body.classList.remove('no-scroll');
  document.getElementById('app').removeAttribute('inert');
  const done = () => backdrop.remove();
  if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else {
    backdrop.classList.add('closing');
    backdrop.addEventListener('animationend', done, { once: true });
    setTimeout(done, 450);
  }
  onClose?.();
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  if (!keepHistory && !fromHistory && history.state?.sheet) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    ownBack = { promise, resolve };
    history.back();
  }
}

function enableDragToClose(el) {
  const handle = $('.grabber', el);
  let startY = null;
  handle.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    handle.setPointerCapture(e.pointerId);
    el.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    el.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    el.style.transition = '';
    if (dy > 110) closeSheet();
    else el.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

document.addEventListener('keydown', (e) => {
  if (!sheet) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  if (e.key === 'Tab') {
    const items = $$(FOCUSABLE, sheet.el).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/** iOS-style alert. Resolves true when the confirm button is pressed. Pass cancelLabel: null for a single OK button. */
export function confirmDialog({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'alert-backdrop';
    wrap.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="alert-text"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}</div>
      <div class="alert-actions">
        ${cancelLabel === null ? '' : `<button type="button" data-v="0">${esc(cancelLabel)}</button>`}
        <button type="button" data-v="1" class="${destructive ? 'destructive' : 'strong'}">${esc(confirmLabel)}</button>
      </div></div>`;
    const prev = document.activeElement;
    const finish = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); prev?.focus?.({ preventScroll: true }); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    wrap.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) finish(b.dataset.v === '1'); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    $('button[data-v]', wrap).focus();
  });
}

let toastTimer;
/** Small pill at the bottom; optionally with an action button (e.g. Undo). */
export function toast(message, { actionLabel, onAction, ms = 4500 } = {}) {
  const host = document.getElementById('toast');
  clearTimeout(toastTimer);
  host.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  host.classList.add('show');
  const hide = () => host.classList.remove('show');
  host.querySelector('button')?.addEventListener('click', () => { hide(); onAction?.(); }, { once: true });
  toastTimer = setTimeout(hide, ms);
}
