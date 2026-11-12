/**
 * How the voice copilot names a session out loud.
 *
 * User report: a session working in ~/Projects on «Videos del curso de ecografía» was called
 * «Projects», which says nothing about the work. The rule:
 *  1. the title the user gave the session;
 *  2. when its folder says nothing (the home folder, ~/Projects, ~/Desktop, src…), a short spoken
 *     form of the agent's title (Claude, Codex or Gemini): «ecografía»;
 *  3. otherwise the folder's name.
 * The generated session name ("claude (~/Projects)") is never used. Names stay unique among the
 * sessions shown together, and short enough to say.
 */
import * as os from 'os';
import * as path from 'path';

/** The session fields the name comes from. */
export interface NameableSession {
  id: string;
  workingDir?: string;
  userTitle?: string;
  claudeTitle?: string;
  claudeStatus?: { title?: string } | null;
  codexTitle?: string;
  geminiTitle?: string;
}

const GENERIC_DIR =
  /^(home|users?|projects?|proyectos?|desktop|escritorio|documents?|documentos|downloads|descargas|src|code|dev|repos?|tmp|temp|work|workspace|git|github)$/i;

const STOP = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'en',
  'y',
  'para',
  'con',
  'un',
  'una',
  'al',
  'por',
  'sobre',
  'the',
  'of',
  'and',
  'for',
  'to',
  'a',
  'an',
  'in',
  'on',
  'with',
]);

const ORDINALS_ES = ['dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const ORDINALS_EN = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** English function words: a title with them reads modifier-first («the payment module»). */
const ENGLISH =
  /^(the|of|and|for|to|in|on|with|from|fix|add|update|investigating|debugging|refactor\w*)$/i;

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const fold = (text: string) => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Words worth saying in a title: not articles or prepositions, more than three letters. */
function contentWords(title: string): string[] {
  return words(title.replace(/[^\p{L}\p{N}\s'-]/gu, ' ')).filter(
    (w) => !STOP.has(fold(w)) && w.length > 3
  );
}

/**
 * A short spoken form of an agent title. Symbols go first («✳ Ecografía» → «Ecografía»). Up to
 * three short words stay as they are («Fix UI bug»). Otherwise: in Spanish the last meaningful
 * word, where the topic goes («Videos del curso de ecografía» → «ecografía»); in English the last
 * two when they go together, where the head noun goes («… in the payment module» → «payment
 * module»). 2026-10-13 (review).
 */
export function spokenTitle(title: string): string {
  const clean = title.replace(/[^\p{L}\p{N}\s'-]/gu, ' ');
  const all = words(clean).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (all.length === 0) return '';
  if (
    all.length <= 2 ||
    (all.length === 3 && all.join(' ').length <= 16 && !all.some((w) => STOP.has(fold(w))))
  )
    return all.join(' ');
  const content = contentWords(all.join(' '));
  if (!content.length) return all.slice(0, 2).join(' ');
  const english = all.some((w) => ENGLISH.test(w));
  if (english && content.length >= 2) {
    const a = content[content.length - 2];
    const b = content[content.length - 1];
    const ia = all.lastIndexOf(a);
    if (ia >= 0 && all[ia + 1] === b) return `${a} ${b}`;
  }
  return content[content.length - 1];
}

/**
 * How a name is spoken: separators as spaces, "UNTETHER" → "Untether" (TTS would spell the
 * capitals out), "mediguiapp proyecto" / "web-project" → "mediguiapp" / "web".
 */
export function tidyName(name: string): string {
  const spaced = name.replace(/[\s_-]+/g, ' ').trim();
  let n = spaced.replace(/\s+(proyecto|project|repo)$/i, '').trim() || spaced;
  if (n.length > 3 && n === n.toUpperCase() && /\p{Lu}/u.test(n)) {
    n = n.charAt(0) + n.slice(1).toLowerCase();
  }
  return n;
}

/** The home folder itself, or a folder whose name says nothing about the work. */
export function isGenericFolder(dir: string | undefined, home = os.homedir()): boolean {
  if (!dir) return true;
  const resolved = path.resolve(dir.replace(/^~(?=\/|$)/, home));
  if (resolved === path.resolve(home) || resolved === '/') return true;
  return GENERIC_DIR.test(path.basename(resolved));
}

/** The agent's title: Claude's live one, then the saved one, then Codex's or Gemini's. */
export function agentTitle(session: NameableSession): string | undefined {
  for (const t of [
    session.claudeStatus?.title,
    session.claudeTitle,
    session.codexTitle,
    session.geminiTitle,
  ]) {
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return undefined;
}

/** One session's spoken name, before making names unique. */
export function baseName(session: NameableSession, home = os.homedir()): string {
  const user = session.userTitle?.trim();
  if (user) return tidyName(user);
  if (isGenericFolder(session.workingDir, home)) {
    const title = agentTitle(session);
    const spoken = title ? spokenTitle(title) : '';
    return spoken ? tidyName(spoken) : 'principal';
  }
  return tidyName(path.basename(path.resolve(session.workingDir as string)));
}

/** A word that tells this session apart from others with the same name, or undefined. */
function qualifier(session: NameableSession, base: string, home: string): string | undefined {
  const taken = new Set(words(fold(base)));
  const title = agentTitle(session);
  if (title) {
    const fromTitle = contentWords(title).filter((w) => !taken.has(fold(w)));
    if (fromTitle.length) return fromTitle[fromTitle.length - 1];
  }
  if (session.workingDir) {
    const parent = path.dirname(path.resolve(session.workingDir));
    if (!isGenericFolder(parent, home)) {
      const word = tidyName(path.basename(parent));
      if (word && !taken.has(fold(word)) && words(word).length === 1) return word;
    }
  }
  return undefined;
}

/**
 * Spoken names for sessions shown together, by session id: unique, two words at most when a
 * word had to be added («web login», «web tienda»), «web dos» when nothing else tells them apart.
 */
export function spokenNames(
  sessions: readonly NameableSession[],
  home = os.homedir(),
  lang = 'es'
): Map<string, string> {
  const ordinals = lang === 'en' ? ORDINALS_EN : ORDINALS_ES;
  const names = new Map<string, string>();
  for (const s of sessions) names.set(s.id, baseName(s, home));
  const groups = new Map<string, NameableSession[]>();
  for (const s of sessions) {
    const key = fold(names.get(s.id) as string);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const used = new Set(groups.keys());
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const head = words(names.get(group[0].id) as string)[0] ?? 'sesión';
    used.delete(key);
    const proposed = group.map((s) => {
      const q = qualifier(s, head, home);
      return q ? `${head} ${q.toLowerCase()}` : undefined;
    });
    const count = (p: string) => proposed.filter((x) => x && fold(x) === fold(p)).length;
    const rest: NameableSession[] = [];
    group.forEach((s, i) => {
      const p = proposed[i];
      if (p && count(p) === 1 && !used.has(fold(p))) {
        names.set(s.id, p);
        used.add(fold(p));
      } else rest.push(s);
    });
    // Nothing tells these apart: the first keeps the bare name, then «web dos», «web tres»…
    let n = 0;
    for (const s of rest) {
      let candidate = n === 0 ? head : `${head} ${ordinals[n - 1] ?? String(n + 1)}`;
      while (used.has(fold(candidate))) {
        n++;
        candidate = `${head} ${ordinals[n - 1] ?? String(n + 1)}`;
      }
      names.set(s.id, candidate);
      used.add(fold(candidate));
      n++;
    }
  }
  return names;
}
