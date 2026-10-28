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

export function download(filename, data, type = 'text/plain') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Makes a text input exactly as wide as its content so a currency symbol can sit right next to it. */
export function autosize(input) {
  const fit = () => { input.style.width = `${Math.max(1, (input.value || input.placeholder || '0').length) + 0.5}ch`; };
  input.addEventListener('input', fit);
  fit();
}
