/**
 * File-name matching shared by the file browser's folder filter and the server's
 * "search the whole Mac" route.
 *
 * User report (2026-10-14): typing «hoja de inscripcion …» found nothing although a PDF named
 * «Hoja de inscripción …» was on the Mac. The filter was a plain substring test,
 * so the missing accent and the word order both broke it. Names and queries are now compared
 * without case or diacritics, word by word, in any order.
 */

/** Lower case, diacritics stripped (NFD), so «Inscripción» and «inscripcion» compare equal. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** The query's words, normalised; separators (spaces, _, -, .) split words. */
export function queryTerms(query: string): string[] {
  return normalizeForMatch(query)
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

/** True when every query word appears somewhere in the name (any order). Empty query: true. */
export function nameMatches(name: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const normalized = normalizeForMatch(name);
  return terms.every((term) => normalized.includes(term));
}

function stripExtension(normalizedName: string): string {
  const dot = normalizedName.lastIndexOf('.');
  return dot > 0 ? normalizedName.slice(0, dot) : normalizedName;
}

/**
 * How well a name matches the query, 0 when it doesn't. Higher is better:
 * exact name > name starts with the query > the words in order > every word starts a word
 * in the name > the words only appear inside other words.
 */
export function nameMatchScore(name: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const normalized = normalizeForMatch(name);
  if (!terms.every((term) => normalized.includes(term))) return 0;
  const base = stripExtension(normalized);
  // Separators collapsed to single spaces, so "hoja_de-inscripcion" reads like the query.
  const spaced = base.replace(/[\s_\-.]+/g, ' ').trim();
  const phrase = terms.join(' ');
  if (spaced === phrase) return 100;
  if (spaced.startsWith(phrase)) return 85;
  if (spaced.includes(phrase)) return 70;
  const words = spaced.split(' ');
  const atWordStart = terms.filter((term) => words.some((word) => word.startsWith(term))).length;
  // 40..60 by the share of words that start a word in the name.
  return 40 + Math.round((20 * atWordStart) / terms.length);
}

/**
 * Bonus for recently modified files, up to 20 for today, halving about every month, so among
 * equally good name matches the one touched last comes first.
 */
export function recencyBonus(modifiedMs: number, now = Date.now()): number {
  if (!Number.isFinite(modifiedMs) || modifiedMs <= 0) return 0;
  const ageDays = Math.max(0, (now - modifiedMs) / 86_400_000);
  return 20 * 0.5 ** (ageDays / 30);
}
