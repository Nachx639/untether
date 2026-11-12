/**
 * Text helpers for spoken replies (voice mode "Conversar"), shared by the phone and the Mac:
 * split a reply into sentence chunks so the first one is synthesized and playing while the
 * rest are still being made, and guess its language so the right voice reads it.
 */

/** Longest text one /api/tts request may carry. */
export const MAX_TTS_CHARS = 600;
/** The first chunk is kept short: it decides how soon the phone starts talking. */
export const FIRST_CHUNK_CHARS = 160;
/** Later chunks gather several sentences (fewer requests, smoother prosody). */
export const CHUNK_CHARS = 320;

/** Sentences, keeping their final punctuation; very long ones are cut at commas or spaces. */
export function splitSentences(text: string, max = CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?。！？…]+(?:[.!?。！？…]+["'»”)\]]*|$)\s*/g) ?? [clean];
  const out: string[] = [];
  for (const raw of sentences) {
    let sentence = raw.trim();
    while (sentence.length > max) {
      const window = sentence.slice(0, max);
      const cut = Math.max(
        window.lastIndexOf(', '),
        window.lastIndexOf('; '),
        window.lastIndexOf(': ')
      );
      const at =
        cut > max * 0.4
          ? cut + 1
          : window.lastIndexOf(' ') > max * 0.4
            ? window.lastIndexOf(' ')
            : max;
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (sentence) out.push(sentence);
  }
  return out;
}

/**
 * Chunks to synthesize one after another: a short first one (fast first audio), then
 * groups of sentences up to `CHUNK_CHARS`. Never longer than `MAX_TTS_CHARS`.
 */
export function chunkForSpeech(
  text: string,
  first = FIRST_CHUNK_CHARS,
  rest = CHUNK_CHARS
): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const sentence of splitSentences(text, Math.min(rest, MAX_TTS_CHARS))) {
    const limit = chunks.length === 0 ? first : rest;
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= limit) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
    // Emit the first chunk as soon as it holds a sentence: waiting to fill it delays audio.
    if (chunks.length === 0 && current.length >= first * 0.5) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Languages the voices cover; anything else is read with the English voice. */
export type SpeechLanguage = 'es' | 'en' | 'fr' | 'pt' | 'it' | 'zh' | 'hi' | 'ar' | 'bn';

const SCRIPTS: Array<[RegExp, SpeechLanguage]> = [
  [/[؀-ۿ]/g, 'ar'],
  [/[ঀ-৿]/g, 'bn'],
  [/[ऀ-ॿ]/g, 'hi'],
  [/[一-鿿]/g, 'zh'],
];
const WORDS: Array<[SpeechLanguage, RegExp]> = [
  ['en', /(?<!\p{L})(the|and|is|are|you|to|of|this|that|with|it|i|for|have|was|what)(?!\p{L})/giu],
  [
    'es',
    /(?<!\p{L})(el|la|los|las|que|es|de|y|para|con|una|por|pero|como|está|he|lo|qué|sí|no|ya|vale|muy|hay|también)(?!\p{L})/giu,
  ],
  ['fr', /(?<!\p{L})(le|les|des|est|et|une|pour|avec|vous|pas|dans|qui|je|ce|sur)(?!\p{L})/giu],
  [
    'pt',
    /(?<!\p{L})(o|os|as|que|do|da|em|um|para|com|uma|mais|isso|não|você|está|eu|tudo|há)(?!\p{L})/giu,
  ],
  ['it', /(?<!\p{L})(il|gli|che|di|è|per|con|una|non|sono|questo|della)(?!\p{L})/giu],
];
const ACCENTS: Array<[SpeechLanguage, RegExp]> = [
  ['es', /[ñ¿¡]/g],
  ['pt', /[ãõçêô]/g],
  ['fr', /[èêàùœç]/g],
];

/** "es-ES", "pt_BR", "zh-CN" → the voice language, or null when it isn't one we have. */
export function normalizeSpeechLanguage(lang: unknown): SpeechLanguage | null {
  if (typeof lang !== 'string') return null;
  const base = lang.toLowerCase().split(/[-_]/)[0];
  const known: SpeechLanguage[] = ['es', 'en', 'fr', 'pt', 'it', 'zh', 'hi', 'ar', 'bn'];
  return (known as string[]).includes(base) ? (base as SpeechLanguage) : null;
}

/**
 * The language `text` is written in, by script and common words; `fallback` (the language
 * the user spoke, or the phone's) when it isn't clear.
 */
export function detectSpeechLanguage(
  text: string,
  fallback: SpeechLanguage = 'en'
): SpeechLanguage {
  for (const [pattern, lang] of SCRIPTS) {
    if ((text.match(pattern)?.length ?? 0) > 2) return lang;
  }
  const scores = WORDS.map(([lang, pattern]) => {
    const accents = ACCENTS.find(([l]) => l === lang)?.[1];
    return [
      lang,
      (text.match(pattern)?.length ?? 0) + 2 * (accents ? (text.match(accents)?.length ?? 0) : 0),
    ] as const;
  }).sort((a, b) => b[1] - a[1]);
  const [best, runnerUp] = scores;
  if (best[1] >= 2 && best[1] > runnerUp[1]) return best[0];
  return fallback;
}
