/**
 * Last line of output for the session list (shells, Codex, Gemini…): what the screen last said,
 * without the shell prompt that usually sits below it.
 */

export const LAST_LINE_MAX_LENGTH = 120;

// CSI / OSC / other escape sequences, then any remaining C0/C1 control characters.
const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes on purpose
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters on purpose
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A bare prompt: ends with a prompt character ($ % # > › ❯ ➜ λ), optionally followed by spaces
 * and a block/underline cursor (`42%` is progress, not a prompt). Covers bash (`user@host:~$`),
 * zsh (`host ~ %`), root (`#`), fish (`~/src>`), and powerline/starship (`❯`, `›`).
 */
const PROMPT_PATTERN = /(?:[$#>›❯➜λ]|(?<!\d)%)\s*[█▌▍▎▏▋▊▉▮_]?\s*$/u;

export function cleanTerminalLine(line: string): string {
  return line.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

export function looksLikePrompt(line: string): boolean {
  return PROMPT_PATTERN.test(line);
}

/**
 * The last meaningful line of a screen: trailing empty lines and bare prompts are skipped.
 * Returns undefined for an empty screen or one that only shows prompts.
 */
export function extractLastLine(screenText: string): string | undefined {
  const lines = screenText.split('\n').map(cleanTerminalLine);
  let index = lines.length - 1;
  while (index >= 0 && (!lines[index] || looksLikePrompt(lines[index]))) index--;
  if (index < 0) return undefined;
  const line = lines[index];
  return line.length > LAST_LINE_MAX_LENGTH
    ? `${line.slice(0, LAST_LINE_MAX_LENGTH - 1).trimEnd()}…`
    : line;
}

export interface LastLineSource {
  /** False when reading the screen would mean replaying a large output file. */
  canSnapshotCheaply(sessionId: string): boolean;
  /** Screen change counter, undefined when no terminal exists yet. */
  getChangeCount(sessionId: string): number | undefined;
  /** When the session's output last changed (ms), if known. */
  outputModifiedAt?(sessionId: string): number | undefined;
  readScreenText(sessionId: string): Promise<string>;
}

/**
 * Cached reader for the session list, which every client polls about once a second: a session
 * whose screen has not changed is never re-read, a changing one at most every `minIntervalMs`,
 * and concurrent polls share one read.
 */
export function createLastLineReader(
  source: LastLineSource,
  options: { minIntervalMs?: number; maxEntries?: number; now?: () => number } = {}
) {
  const minIntervalMs = options.minIntervalMs ?? 2000;
  const maxEntries = options.maxEntries ?? 200;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; count: number | undefined; value?: string }>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  function read(sessionId: string): Promise<string | undefined> {
    let pending = inFlight.get(sessionId);
    if (pending) return pending;
    pending = (async () => {
      const count = source.getChangeCount(sessionId);
      let value: string | undefined;
      try {
        value = extractLastLine(await source.readScreenText(sessionId));
      } catch {
        value = cache.get(sessionId)?.value;
      }
      // The counter may only exist once the read created the terminal.
      const countAfter = source.getChangeCount(sessionId);
      cache.delete(sessionId);
      cache.set(sessionId, { at: now(), count: count ?? countAfter, value });
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return value;
    })().finally(() => inFlight.delete(sessionId));
    inFlight.set(sessionId, pending);
    return pending;
  }

  return {
    async get(sessionId: string): Promise<string | undefined> {
      const cached = cache.get(sessionId);
      if (cached) {
        const count = source.getChangeCount(sessionId);
        if (count !== undefined && count === cached.count) return cached.value;
        // No terminal any more (closed when idle): don't rebuild one, replaying up to 2 MB,
        // just to find the same line; only re-read once the output file has moved on.
        if (count === undefined) {
          const modified = source.outputModifiedAt?.(sessionId);
          if (modified !== undefined && modified <= cached.at) return cached.value;
        }
        if (now() - cached.at < minIntervalMs) return cached.value;
      }
      if (!source.canSnapshotCheaply(sessionId)) return cached?.value;
      return read(sessionId);
    },
    forget(sessionId: string) {
      cache.delete(sessionId);
    },
  };
}
