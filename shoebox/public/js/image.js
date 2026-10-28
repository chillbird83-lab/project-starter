// Prepares a picked photo or PDF for upload: photos are shrunk to a sharp-enough JPEG so uploads are
// quick on mobile data and R2 storage stays small.
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES } from './extract.js';

const MAX_SIDE = 1800;

export async function prepareFile(file) {
  const type = (file.type || '').toLowerCase() || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
  if (type === 'application/pdf') {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('That PDF is over 10 MB.');
    return { blob: file, type };
  }
  if (!type.startsWith('image/')) throw new Error('Choose a photo or a PDF.');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (blob) return { blob, type: 'image/jpeg' };
  } catch { /* the browser can't decode it (e.g. HEIC on Android) — send the original */ }
  if (!ACCEPTED_TYPES.includes(type)) throw new Error('This photo format isn’t supported. Try a JPEG or PNG.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That photo is over 10 MB.');
  return { blob: file, type };
}
