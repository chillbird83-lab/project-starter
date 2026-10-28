import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReceipt, geminiRequest, normaliseExtraction, parseGeminiResponse, RESPONSE_SCHEMA, toBase64 } from '../public/js/extract.js';
import { EXPENSE_IDS } from '../public/js/categories.js';

const answer = (obj, extraParts = []) => ({ candidates: [{ content: { parts: [...extraParts, { text: JSON.stringify(obj) }] } }] });

test('request asks for JSON in the schema, with the file first', () => {
  const body = geminiRequest('QUJD', 'image/jpeg');
  assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
  assert.match(body.contents[0].parts[1].text, /UK sole trader/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(RESPONSE_SCHEMA.properties.category.enum, EXPENSE_IDS);
});

test('parses answers, skipping thought parts and code fences', () => {
  assert.deepEqual(parseGeminiResponse(answer({ a: 1 }, [{ thought: true, text: 'thinking…' }])), { a: 1 });
  assert.deepEqual(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: '```json\n{"b":2}\n```' }] } }] }), { b: 2 });
  assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /refused.*SAFETY/);
  assert.throws(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'nope' }] } }] }), /could not be read/);
});

test('normalises a good UK receipt', () => {
  const { draft, warnings } = normaliseExtraction({
    is_receipt: true, merchant: ' Screwfix ', date: '2026-10-20', currency: 'gbp', total: 43.19, vat: 7.2,
    vat_number: 'GB 232  4731 18', category: 'maintenanceCosts', description: 'Copper pipe', payment_method: 'card',
  }, '2026-10-28');
  assert.deepEqual(warnings, []);
  assert.deepEqual(draft, {
    kind: 'expense', date: '2026-10-20', merchant: 'Screwfix', description: 'Copper pipe', category: 'maintenanceCosts',
    gross: 4319, vat: 720, vatNumber: 'GB 232 4731 18', currency: 'GBP', payment: 'card', businessPct: 100,
  });
});

test('flags problems instead of trusting them', () => {
  const { draft, warnings } = normaliseExtraction({
    is_receipt: false, merchant: 'Café', date: '28/10/2026', currency: 'EUR', total: '€12,00', vat: 9, category: 'snacks', payment_method: 'unknown',
  }, '2026-10-28');
  assert.equal(draft.date, '2026-10-28');
  assert.equal(draft.category, 'otherExpenses');
  assert.equal(draft.payment, '');
  assert.equal(draft.vat, 0); // £9 VAT on a £12 receipt is impossible
  assert.deepEqual(warnings.sort(), ['foreign-currency', 'no-date', 'not-receipt', 'vat-too-high'].sort());
  assert.ok(normaliseExtraction({ date: '2027-01-01', total: 10, vat: 1 }, '2026-10-28').warnings.includes('future-date'));
  assert.ok(normaliseExtraction({ date: '2026-10-01', total: 12, vat: 2 }, '2026-10-28').warnings.includes('vat-no-number'));
  assert.ok(normaliseExtraction(null, '2026-10-28').warnings.includes('no-total'));
});

test('extractReceipt calls Gemini with the key header and explains errors', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(answer({ total: 5, date: '2026-10-01', merchant: 'Tesco', category: 'adminCosts' }))); };
  const out = await extractReceipt({ apiKey: 'k', model: 'm-1', buffer: new TextEncoder().encode('img').buffer, mimeType: 'image/png', fetchImpl: ok, today: '2026-10-28' });
  assert.equal(out.draft.gross, 500);
  assert.match(seen.url, /\/models\/m-1:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k');
  assert.equal(JSON.parse(seen.init.body).contents[0].parts[0].inline_data.data, toBase64(new TextEncoder().encode('img').buffer));

  const fail = (status) => async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status });
  await assert.rejects(extractReceipt({ apiKey: 'k', model: 'old', buffer: new ArrayBuffer(1), mimeType: 'image/png', fetchImpl: fail(404) }), /"old" was not found.*nope/);
  await assert.rejects(extractReceipt({ apiKey: 'k', buffer: new ArrayBuffer(1), mimeType: 'image/png', fetchImpl: fail(429) }), /quota/);
});

test('base64 handles large buffers', () => {
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.equal(toBase64(big.buffer), Buffer.from(big).toString('base64'));
});
