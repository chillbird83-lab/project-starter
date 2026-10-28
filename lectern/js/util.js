export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape user text before putting it into an HTML string. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const haptic = (ms = 8) => {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
};

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Opens the Android share sheet (Drive, WhatsApp, e-mail…) with a file, or downloads it where sharing is unavailable. */
export async function shareFile(filename, blob, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  downloadBlob(filename, blob);
  return 'downloaded';
}

export function debounce(fn, ms) {
  let t;
  const run = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  run.flush = (...args) => { clearTimeout(t); fn(...args); };
  return run;
}

/** Grows a textarea with its content. */
export function autogrow(el) {
  const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  el.addEventListener('input', fit);
  fit();
}
