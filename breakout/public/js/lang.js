// Video language: the creator's YouTube setting when there is one, otherwise a best guess from the title
// and description — the writing system for non-Latin scripts, common short words for Latin ones.

export const LANGUAGES = [
  ['any', 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ro', 'Romanian'], ['tr', 'Turkish'], ['ru', 'Russian'],
  ['uk', 'Ukrainian'], ['el', 'Greek'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['bn', 'Bengali'],
  ['id', 'Indonesian'], ['th', 'Thai'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
];
const CODES = new Set(LANGUAGES.map(([c]) => c));

export const languageName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code;

/** "en-GB" → "en", "zh-Hans" → "zh"; null for empty or "not a language" codes. */
export function normalizeLang(code) {
  const base = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'zxx' || base === 'und' || base === 'mul') return null;
  return base === 'iw' ? 'he' : base === 'in' ? 'id' : base;
}

/** The browser's language if we support it, else "any". */
export function defaultLanguage(locale = globalThis.navigator?.language) {
  const l = normalizeLang(locale);
  return l && CODES.has(l) ? l : 'any';
}

/** YouTube's relevanceLanguage wants "zh-Hans" rather than "zh". */
export const relevanceLanguage = (code) => (code === 'zh' ? 'zh-Hans' : code);

const SCRIPTS = [
  [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'], [/[฀-๿]/, 'th'],
  [/[ऀ-ॿ]/, 'hi'], [/[ঀ-৿]/, 'bn'], [/[֐-׿]/, 'he'], [/[؀-ۿ]/, 'ar'],
  [/[Ͱ-Ͽ]/, 'el'], [/[Ѐ-ӿ]/, 'ru'],
];

const WORDS = {
  en: 'the and of to in is you that it for with this how what my on are was your why from about',
  es: 'el la los las de que y en por para con una un es del se como lo más pero muy este esta',
  pt: 'o os de que e do da em um uma para com não é mais você no na dos das como isso',
  fr: 'le la les de des et est un une pour que en du dans pas sur vous qui ce avec plus',
  de: 'der die das und ist nicht ein eine ich zu mit den von auf für sie es wie auch dem',
  it: 'il la di che e un una per non sono con del della gli come più questo questa nel',
  nl: 'de het een en van is dat niet ik je op te met voor zijn wat hoe ook',
  pl: 'i w na nie się z jest to że do jak co ale tak czy jest już',
  ro: 'și în de la cu pe nu este un o din care să mai ce',
  tr: 've bir bu da de için ile çok ne ben gibi daha nasıl en',
  id: 'dan yang di ini itu dengan untuk tidak ada saya dari ke cara',
};
const STOP = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
/** Words shared by several languages ("de", "la") count less than ones only one language uses ("el", "você"). */
const WEIGHT = new Map();
for (const set of Object.values(STOP)) for (const w of set) WEIGHT.set(w, (WEIGHT.get(w) || 0) + 1);

/** Best guess at the language of a piece of text, or null when it can't tell. */
export function detectLanguage(text) {
  const s = String(text ?? '');
  // Count characters of each script; the dominant non-Latin one wins.
  let best = null, bestCount = 0;
  for (const [re, code] of SCRIPTS) {
    const n = (s.match(new RegExp(re.source, 'g')) || []).length;
    if (n > bestCount) { best = code; bestCount = n; }
  }
  const latin = (s.match(/[a-zà-ÿăâîșțşğışçąćęłńóśźż]/gi) || []).length;
  if (bestCount >= 3 && bestCount * 2 >= latin) {
    if (best === 'ru' && /[іїєґ]/i.test(s)) return 'uk'; // letters Russian doesn't use
    if (best === 'zh' && /[぀-ヿ]/.test(s)) return 'ja'; // kanji with any kana is Japanese
    return best;
  }

  const scores = Object.fromEntries(Object.keys(STOP).map((k) => [k, 0]));
  for (const w of s.toLowerCase().match(/\p{L}+/gu) || []) {
    if (!WEIGHT.has(w)) continue;
    for (const k in STOP) if (STOP[k].has(w)) scores[k] += 1 / WEIGHT.get(w);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[top, n1], [, n2]] = ranked;
  return n1 >= 1.5 && n1 >= n2 * 1.5 ? top : null;
}

/** A video's language: YouTube's own field first, then a guess from its text. */
export function videoLanguage(v) {
  return normalizeLang(v.lang) ?? detectLanguage(`${v.title ?? ''}\n${v.description ?? ''}`);
}

/** Feed filter: hide videos known to be in another language; keep ones we can't tell. */
export function matchesLanguage(v, lang) {
  if (!lang || lang === 'any') return true;
  const l = videoLanguage(v);
  return !l || l === lang;
}
