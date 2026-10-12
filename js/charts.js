// Tiny SVG chart helpers — no libraries.
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Fuel-gauge ring that drains as you spend. `fraction` = share of the budget still left (0..1). */
export function ring({ fraction, status = 'ok', size = 240, stroke = 20, label = '' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = clamp01(fraction);
  const mid = size / 2;
  return `<svg class="ring ring-${status}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" style="--circ:${c.toFixed(2)};--off:${(c * (1 - p)).toFixed(2)}">
    <circle class="ring-track" cx="${mid}" cy="${mid}" r="${r}" stroke-width="${stroke}" fill="none"/>
    ${p > 0.004 ? `<circle class="ring-bar" cx="${mid}" cy="${mid}" r="${r}" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>` : ''}
  </svg>`;
}

/** Donut chart. items: [{ value, color }]. */
export function donut(items, { size = 168, stroke = 26, label = '' } = {}) {
  const total = items.reduce((a, i) => a + i.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  let offset = 0;
  const gap = items.length > 1 ? 2.5 : 0;
  const segs = total
    ? items.map((i) => {
        const len = (i.value / total) * c;
        const seg = `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${i.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${(c - Math.max(0, len - gap)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>`;
        offset += len;
        return seg;
      }).join('')
    : '';
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}">
    <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${stroke}"/>${segs}</svg>`;
}
