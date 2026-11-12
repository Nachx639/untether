/**
 * The JSON object in an AI agent's reply, read one way for every caller (2026-10-25).
 *
 * Symptom: a task review came back 'unavailable — the answer was not the JSON asked for:
 * {"verdict":"ok","summary":"El arreglo …' although the reply started as valid JSON. Each
 * caller cut from the first `{` to the last `}` and ran JSON.parse, so any text or second
 * object after the answer, a `}` in trailing prose, a raw line break or an unescaped quote in a
 * string, or a reply cut short lost the whole review; only 200 characters were kept, so the
 * cause could not be told. Now:
 *  - extractJsonObject scans for balanced objects (aware of strings), tolerates prose and code
 *    fences around them, mends raw control characters and stray quotes inside strings, and
 *    says why it found nothing (no object, cut short, invalid, not the shape asked for);
 *  - askForJson asks again once, saying what was wrong (and to be shorter when it was cut),
 *    before giving up; every reply that could not be read is kept whole in
 *    `<untether dir>/ai-replies/` (the newest AI_REPLY_KEEP), and the reason names the file.
 * A reply cut short is never mended into an answer: a review missing its last findings must
 * not pass as one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type JsonReplyProblem = 'no-json' | 'truncated' | 'invalid' | 'wrong-shape' | 'ambiguous';

export type JsonExtraction<T> =
  | { ok: true; value: T }
  | { ok: false; problem: JsonReplyProblem; detail: string };

export interface ExtractOptions {
  /**
   * Every object of the right shape must say the same (a gate must not pick "ok" out of an
   * "ok" and a "concerns"). Default: the first one is the answer.
   */
  unique?: boolean;
}

/** The end (index after the closing brace) of the object opening at `start`, or -1 if cut. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** An object at the top level of the reply opens and never closes: the reply was cut short. */
function cutAtTopLevel(text: string): boolean {
  for (let start = text.indexOf('{'); start >= 0; ) {
    const end = balancedEnd(text, start);
    if (end < 0) return true;
    start = text.indexOf('{', end);
  }
  return false;
}

/**
 * The common ways a model breaks JSON strings, mended: raw line breaks and tabs, and a `"`
 * inside a string that is not followed by what may come after a closing quote.
 */
export function mendJsonStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i++;
    } else if (ch === '"') {
      const next = /^\s*(.?)/.exec(text.slice(i + 1, i + 40))?.[1] ?? '';
      if (next === '' || ',:}]'.includes(next)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
    } else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

function parseCandidate(slice: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(slice) };
  } catch (error) {
    try {
      return { value: JSON.parse(mendJsonStrings(slice)) };
    } catch {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * The object of the shape `accept` wants (it returns null for any other) in a model's reply,
 * wherever it is in the text; or why there is none.
 */
export function extractJsonObject<T>(
  reply: string,
  accept: (value: unknown) => T | null,
  options: ExtractOptions = {}
): JsonExtraction<T> {
  const found: Array<{ value: T; key: string }> = [];
  let invalid: string | undefined;
  let parsedAny = false;
  for (let start = reply.indexOf('{'); start >= 0; ) {
    const end = balancedEnd(reply, start);
    if (end < 0) {
      start = reply.indexOf('{', start + 1);
      continue;
    }
    const parsed = parseCandidate(reply.slice(start, end));
    if ('value' in parsed && parsed.value && typeof parsed.value === 'object') {
      parsedAny = true;
      const value = accept(parsed.value);
      if (value !== null) {
        if (!options.unique) return { ok: true, value };
        found.push({ value, key: JSON.stringify(value) });
        start = reply.indexOf('{', end);
        continue;
      }
    } else if ('error' in parsed) {
      invalid ??= parsed.error;
    }
    start = reply.indexOf('{', start + 1);
  }
  if (found.length) {
    const [answer] = found;
    if (found.every((item) => item.key === answer.key)) return { ok: true, value: answer.value };
    return {
      ok: false,
      problem: 'ambiguous',
      detail: `${found.length} different answers in one reply`,
    };
  }
  // The old reading (first `{` to last `}`), mended: an unescaped quote can unbalance the scan.
  const first = reply.indexOf('{');
  const last = reply.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = parseCandidate(reply.slice(first, last + 1));
    if ('value' in parsed && parsed.value && typeof parsed.value === 'object') {
      const value = accept(parsed.value);
      if (value !== null) return { ok: true, value };
    }
  }
  if (first < 0) return { ok: false, problem: 'no-json', detail: 'no JSON object in the reply' };
  if (cutAtTopLevel(reply)) {
    return { ok: false, problem: 'truncated', detail: 'the JSON object was cut short' };
  }
  if (parsedAny) {
    return { ok: false, problem: 'wrong-shape', detail: 'the JSON was not the object asked for' };
  }
  return { ok: false, problem: 'invalid', detail: `invalid JSON (${invalid ?? 'unreadable'})` };
}

/** How many unreadable replies are kept on disk. */
export const AI_REPLY_KEEP = 50;

/** Where unreadable replies go: next to the control dir (~/.untether/ai-replies). */
export function defaultAiReplyDir(): string {
  const control = process.env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether/control');
  return path.join(path.dirname(control), 'ai-replies');
}

/** Keep a reply that could not be read, whole; the file's path, or undefined if not written. */
export function saveUnreadableReply(
  dir: string,
  label: string,
  attempt: number,
  problem: string,
  reply: string,
  now = new Date()
): string | undefined {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const safeLabel = label.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 60);
    const file = path.join(dir, `${stamp}-${safeLabel}-${attempt}.txt`);
    const header = `${label} attempt ${attempt}: ${problem}\n${reply.length} characters\n---\n`;
    fs.writeFileSync(file, header + reply, { mode: 0o600 });
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.txt'))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - AI_REPLY_KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    return file;
  } catch {
    return undefined;
  }
}

export interface AskForJsonOptions<T> {
  /** One question to the model; null = no answer at all (that is not retried here). */
  ask: (question: string) => Promise<string | null>;
  question: string;
  accept: (value: unknown) => T | null;
  /** Names the caller in the kept files (e.g. 'task-review'). */
  label: string;
  unique?: boolean;
  /** Said on the retry when the reply was cut short (how to keep it smaller). */
  shorterHint?: string;
  /** Where unreadable replies are kept (default defaultAiReplyDir()). */
  replyDir?: string;
}

export type AskForJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; noAnswer: true; reason: string }
  | { ok: false; noAnswer: false; reason: string };

/** The note added to the question when the first reply could not be read. */
export function retryNote(problem: JsonReplyProblem, detail: string, shorterHint?: string): string {
  return [
    '',
    `YOUR PREVIOUS REPLY COULD NOT BE READ (${detail}).`,
    'Reply again with ONLY the one JSON object asked for: no prose, no code fence, nothing',
    'before or after it. Inside strings escape every double quote as \\" and write line breaks',
    'as \\n.',
    ...(problem === 'truncated' && shorterHint ? [`It was cut off: ${shorterHint}`] : []),
  ].join('\n');
}

/**
 * Ask, read the JSON object; when it cannot be read, keep the reply on disk and ask once more
 * saying what was wrong. The reason (when it still fails) says why and where the replies are.
 */
export async function askForJson<T>(options: AskForJsonOptions<T>): Promise<AskForJsonResult<T>> {
  const dir = options.replyDir ?? defaultAiReplyDir();
  const kept: string[] = [];
  let question = options.question;
  let last: { problem: JsonReplyProblem; detail: string; reply: string } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await options.ask(question);
    if (reply === null) {
      if (!last) return { ok: false, noAnswer: true, reason: 'no answer' };
      break;
    }
    const read = extractJsonObject(reply, options.accept, { unique: options.unique });
    if (read.ok) return read;
    last = { problem: read.problem, detail: read.detail, reply };
    const file = saveUnreadableReply(dir, options.label, attempt, read.detail, reply);
    if (file) kept.push(file);
    question = options.question + retryNote(read.problem, read.detail, options.shorterHint);
  }
  // `last` is set: the first reply was there and could not be read.
  const failed = last as { detail: string; reply: string };
  const where = kept.length ? `; full replies in ${kept.join(', ')}` : '';
  const snippet = failed.reply.trim().slice(0, 160);
  return {
    ok: false,
    noAnswer: false,
    reason: `the answer was not the JSON asked for (${failed.detail}, asked twice${where}): ${snippet}`,
  };
}
