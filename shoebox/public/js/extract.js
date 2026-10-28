// Receipt reading with Gemini: the prompt, the JSON schema it must answer in, and the clean-up of
// its answer into a draft record. Shared by the Worker (cloud mode) and the browser (own-key mode).
import { EXPENSE_CATEGORIES, EXPENSE_IDS } from './categories.js';
import { addDays, isISODate, parseAmount, todayISO } from './dates.js';

export const DEFAULT_MODEL = 'gemini-flash-latest';
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const PAYMENTS = ['card', 'cash', 'bank_transfer', 'other', 'unknown'];

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_receipt: { type: 'BOOLEAN', description: 'True if the image is a receipt, invoice or bill' },
    merchant: { type: 'STRING', description: 'Business name of the seller as printed' },
    date: { type: 'STRING', description: 'Purchase or invoice date as YYYY-MM-DD' },
    currency: { type: 'STRING', description: 'ISO 4217 code, e.g. GBP' },
    total: { type: 'NUMBER', description: 'Total amount paid including VAT' },
    vat: { type: 'NUMBER', nullable: true, description: 'Total VAT printed on the receipt; 0 if it shows none' },
    vat_number: { type: 'STRING', nullable: true, description: 'Seller VAT registration number if printed' },
    category: { type: 'STRING', enum: EXPENSE_IDS },
    description: { type: 'STRING', description: 'Short summary of what was bought, max 60 characters' },
    payment_method: { type: 'STRING', enum: PAYMENTS },
  },
  required: ['is_receipt', 'merchant', 'date', 'currency', 'total', 'category', 'description', 'payment_method'],
};

export const PROMPT = `You read receipts and invoices for a UK sole trader's bookkeeping.
Extract the fields in the schema from the attached image or PDF.

Rules:
- total: the final amount paid, including VAT, tips and service. Use the grand total, not a subtotal.
- vat: only VAT that is printed on the receipt (a VAT line, or a VAT summary table). Add up all VAT rates.
  If the receipt shows no VAT, use 0. Never invent VAT.
- date: dates on UK receipts are day/month/year (03/04/2026 is 3 April 2026). If no date is visible, use "".
- category: pick the best HMRC self-employment expense category:
${EXPENSE_CATEGORIES.map((c) => `  ${c.id}: ${c.hint}`).join('\n')}
  Food and drink for the trader alone while travelling is carVanTravelExpenses; meals with clients are businessEntertainmentCosts.
- description: what was bought, in plain English, e.g. "Diesel 42.1 litres" or "Printer ink x2".
- If the image is not a receipt or invoice, set is_receipt to false and fill what you can.`;

/** Gemini generateContent request body for one file. `base64` is the file without a data: prefix. */
export function geminiRequest(base64, mimeType) {
  return {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
  };
}

export const geminiURL = (model = DEFAULT_MODEL) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

/** Pulls the JSON object out of a generateContent response. Throws with a readable message. */
export function parseGeminiResponse(res) {
  const cand = res?.candidates?.[0];
  if (!cand) throw new Error(res?.promptFeedback?.blockReason ? `The AI refused this image (${res.promptFeedback.blockReason}).` : 'The AI returned no answer.');
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  const json = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(json); } catch { throw new Error('The AI answer could not be read.'); }
}

const toPence = (n) => {
  const p = parseAmount(typeof n === 'string' ? n : Number(n));
  return Number.isFinite(p) ? p : 0;
};

/**
 * Turns the AI's answer into a draft record plus warnings for the review screen.
 * Warnings: not-receipt, no-total, no-date, future-date, foreign-currency, vat-too-high, vat-no-number
 */
export function normaliseExtraction(raw, today = todayISO()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const gross = toPence(r.total);
  let vat = toPence(r.vat);
  let date = typeof r.date === 'string' ? r.date.trim() : '';
  if (!isISODate(date)) { date = today; warnings.push('no-date'); } else if (date > addDays(today, 1)) warnings.push('future-date');
  if (r.is_receipt === false) warnings.push('not-receipt');
  if (!gross) warnings.push('no-total');
  // Standard-rated VAT is 1/6 of the gross; anything above that is a misread.
  if (vat > Math.ceil(gross / 6) + 1) { vat = 0; warnings.push('vat-too-high'); }
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/i.test(r.currency.trim()) ? r.currency.trim().toUpperCase() : 'GBP';
  if (currency !== 'GBP') warnings.push('foreign-currency');
  const vatNumber = typeof r.vat_number === 'string' ? r.vat_number.replace(/\s+/g, ' ').trim().slice(0, 20) : '';
  if (vat && !vatNumber) warnings.push('vat-no-number');
  return {
    draft: {
      kind: 'expense',
      date,
      merchant: String(r.merchant ?? '').trim().slice(0, 80),
      description: String(r.description ?? '').trim().slice(0, 120),
      category: EXPENSE_IDS.includes(r.category) ? r.category : 'otherExpenses',
      gross,
      vat,
      vatNumber,
      currency,
      payment: PAYMENTS.includes(r.payment_method) && r.payment_method !== 'unknown' ? r.payment_method : '',
      businessPct: 100,
    },
    warnings,
  };
}

export const WARNING_TEXT = {
  'not-receipt': 'This doesn’t look like a receipt. Check the details.',
  'no-total': 'Couldn’t read the total. Please enter it.',
  'no-date': 'No date found. Today’s date has been used.',
  'future-date': 'The date is in the future. Please check it.',
  'foreign-currency': 'This receipt isn’t in pounds. Enter the amount in £ (your bank statement shows it).',
  'vat-too-high': 'The VAT looked wrong and has been cleared. Please check it.',
  'vat-no-number': 'No VAT number found. You need one on the receipt to reclaim VAT.',
};

/** Base64 of an ArrayBuffer, in chunks so large files don't overflow the call stack. */
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Calls Gemini and returns { draft, warnings }. Used by the Worker and by own-key mode. */
export async function extractReceipt({ apiKey, model = DEFAULT_MODEL, buffer, mimeType, fetchImpl = fetch, today }) {
  const res = await fetchImpl(geminiURL(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(geminiRequest(toBase64(buffer), mimeType)),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
    const hint = res.status === 404 ? ` The model "${model}" was not found; set another Gemini model.`
      : res.status === 429 ? ' The free Gemini quota is used up for now; try again later.'
        : res.status === 400 || res.status === 403 ? ' Check the Gemini API key.' : '';
    throw new Error(`Gemini error ${res.status}.${hint}${detail ? ` (${detail.slice(0, 160)})` : ''}`);
  }
  return normaliseExtraction(parseGeminiResponse(await res.json()), today);
}
