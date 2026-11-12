import { authClient } from '../../services/auth-client.js';

/** Plain text to read aloud: markdown markers removed, code blocks replaced by a short note. */
export function speechText(markdown: string, codeNote: string): string {
  return (
    markdown
      .split(/```[^\n]*\n?/)
      .map((part, index) => (index % 2 === 1 ? ` (${codeNote}). ` : part))
      .join('')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
      .replace(/^#{1,6} /gm, '')
      // Tables: no delimiter rows, and each row read as a list of its cells. Flat patterns:
      // a nested quantifier here backtracked exponentially on a line of ~50 dashes followed
      // by text and froze the page (ReDoS found in review, 2026-10-03).
      .replace(/^[ \t|:-]*$/gm, (line) => (/-{3,}/.test(line) ? '' : line))
      .replace(
        /^[ \t]*\|(.*)\|[ \t]*$/gm,
        (_m, row: string) =>
          `${row
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(', ')}. `
      )
      .replace(/^(\s*)[-*•] /gm, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const SCRIPT_LANGS: Array<[RegExp, string]> = [
  [/[؀-ۿ]/g, 'ar'],
  [/[ঀ-৿]/g, 'bn'],
  [/[ऀ-ॿ]/g, 'hi'],
  [/[一-鿿]/g, 'zh-CN'],
];
const LATIN_WORDS: Array<[string, RegExp]> = [
  ['en', /\b(the|and|is|you|to|of|this|that|with|it)\b/gi],
  ['es', /\b(el|la|los|las|que|es|de|y|para|con|una|por|pero|como)\b/gi],
  ['fr', /\b(le|les|des|est|et|une|pour|avec|vous|pas|dans|qui)\b/gi],
  ['pt-BR', /\b(o|os|as|que|do|da|em|um|para|com|uma|mais|isso)\b/gi],
];

/**
 * Voice language for `text`: the app's language unless the text is clearly written in
 * another one (the app defaults to English while Claude may answer in Spanish).
 */
export function speechLang(text: string, locale: string): string {
  for (const [pattern, lang] of SCRIPT_LANGS) {
    if ((text.match(pattern)?.length ?? 0) > 3) return lang;
  }
  const scores = LATIN_WORDS.map(
    ([lang, pattern]) => [lang, text.match(pattern)?.length ?? 0] as const
  ).sort((a, b) => b[1] - a[1]);
  const [best, runnerUp] = scores;
  const localeScore = scores.find(([lang]) => lang === locale)?.[1] ?? 0;
  if (best[1] >= 3 && best[1] > runnerUp[1] && best[1] > localeScore * 1.5) return best[0];
  return locale;
}

export function canSpeak(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

/**
 * Whether the Mac reads aloud (GET /api/tts/status names an engine), asked once per page; a
 * failed check is asked again next time.
 */
let macVoiceCheck: Promise<boolean> | null = null;
export function checkMacVoice(): Promise<boolean> {
  macVoiceCheck ??= fetch('/api/tts/status', { headers: authClient.getAuthHeader() })
    .then(async (response) => {
      // 2026-11-10: a 401/502 on the first load was cached for the whole page, so the
      // phone voice was used until reload. A non-OK answer is retried like a network error.
      if (!response.ok) throw new Error(`tts status ${response.status}`);
      const status = (await response.json()) as { engine?: unknown };
      return typeof status.engine === 'string' && status.engine !== '';
    })
    .catch(() => {
      macVoiceCheck = null;
      return false;
    });
  return macVoiceCheck;
}

/** For tests: ask the Mac again. */
export function resetMacVoiceCheck(): void {
  macVoiceCheck = null;
}

export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
