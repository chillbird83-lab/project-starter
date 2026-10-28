// Minimal Gemini REST helper, shared by the Worker and this-device mode.

export const DEFAULT_MODEL = 'gemini-flash-latest';

export const geminiURL = (model = DEFAULT_MODEL) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

/** Pulls the JSON object out of a generateContent response. Throws with a readable message. */
export function parseGeminiResponse(res) {
  const cand = res?.candidates?.[0];
  if (!cand) throw new Error(res?.promptFeedback?.blockReason ? `The AI refused this (${res.promptFeedback.blockReason}).` : 'The AI returned no answer.');
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  const json = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(json); } catch { throw new Error('The AI answer could not be read.'); }
}

/** Base64 of an ArrayBuffer, in chunks so large files don't overflow the call stack. */
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** POSTs a generateContent body and returns the parsed JSON answer. */
export async function generateJSON({ apiKey, model = DEFAULT_MODEL, body, fetchImpl = fetch }) {
  const res = await fetchImpl(geminiURL(model || DEFAULT_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
    const hint = res.status === 404 ? ` The model "${model}" was not found; set another Gemini model.`
      : res.status === 429 ? ' The free Gemini quota is used up for now; try again later.'
        : res.status === 400 || res.status === 403 ? ' Check the Gemini API key.' : '';
    throw new Error(`Gemini error ${res.status}.${hint}${detail ? ` (${detail.slice(0, 160)})` : ''}`);
  }
  return parseGeminiResponse(await res.json());
}
