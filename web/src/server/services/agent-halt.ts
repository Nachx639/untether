/**
 * An agent cut short by something outside its task (2026-11-01, bakery 0cbedf19 and
 * ce86f31b: two Codex tasks hit the account's usage limit 4 minutes in; Untether took the end
 * of the turn for the end of the work, one went ready with nothing done, the other through the
 * pipeline and an automatic fix that hit the limit again).
 *
 * Read from the session's screen (TerminalManager.getRecentText), the same for Claude and
 * Codex, never from the agent's summary: the last thing on it, below the agent's last output,
 * is the agent's own error line.
 *
 *   Codex   "■ You've hit your usage limit. Upgrade to Pro (…) or try again at 4:25 AM."
 *           "■ stream disconnected before completion: …", "■ unexpected status 401 …"
 *   Claude  "  ⎿  You've hit your session limit · resets 4:25am (Europe/Madrid)"
 *           "  ⎿  API Error: 529 {…overloaded_error…}", "  ⎿  Failed to authenticate: …"
 *
 * Only a line that starts with one of these right after the agent's error marker counts, and only
 * when no output of the agent follows it: an agent quoting such a text in its work, or a turn
 * that went on after a retry, is no halt. Codex's "Heads up, you have less than 5% of your 5h
 * limit left" is a warning, not a halt.
 */

export type AgentHaltKind = 'usage-limit' | 'api-error' | 'auth' | 'model';

export interface AgentHalt {
  kind: AgentHaltKind;
  /** The agent's error, on one line (its wrapped rows joined). */
  message: string;
  /** When the agent said it can go on (epoch ms), when it said. */
  resumeAt?: number;
}

/** Rows read from the bottom of the screen. */
export const HALT_READ_LINES = 60;

/**
 * An error line's marker, required: Codex ■ at the left edge, Claude ⎿ indented. Prose of the
 * agent's (a ⏺ message, its indented continuation rows) never counts, whatever it starts with
 * (review of 2026-11-01: a final reply row "API error handling now retries" paused a task).
 */
const MARKER = /^(?:■|\s{0,6}⎿)\s*/u;

/**
 * Agent output (a message, a tool call, a spinner) at the left edge: after it, an error above
 * is history. Claude's ⎿ tool results are indented and are not this.
 */
const AGENT_OUTPUT = /^\s{0,2}[•⏺●✻✶✳✢◦]\s/u;

/** Rows that end an error's wrapped text: the composer, boxes, warnings, another marker. */
const NOT_CONTINUATION = /^\s*(?:[›❯>│╭╰─━■⎿⏺●•⚠✻✶✳✢?]|$)/u;

const USAGE_LIMIT: RegExp[] = [
  /^(?:you['’]ve|you have) (?:hit|reached) your\b[^\n]*?\b(?:limit|budget)\b/i,
  /^(?:claude(?: ai)?\s+|codex\s+)?usage limit reached\b/i,
  /^(?:\d+-?h(?:our)?|session|weekly|daily|opus|sonnet|fable)\b[^\n]{0,40}\blimit reached\b/i,
  /^you['’]re out of (?:usage )?credits\b/i,
  /^your org is out of usage\b/i,
  /^credit balance is too low\b/i,
  // An external provider out of money or quota (model-providers.ts): pause, no retry loop.
  /^insufficient (?:balance|credits?|funds|quota)\b/i,
  /^(?:your )?(?:account )?balance is (?:insufficient|too low|negative)\b/i,
  /^quota (?:exceeded|exhausted)\b/i,
  /^payment required\b/i,
  // A bare 402 is not one (2026-11-08, second review): a tool's output such as `wc -l`'s
  // "402 src/a.ts" starts that way; "API Error: 402 …" is read in classify().
  /^unexpected status 402\b/i,
];

const AUTH: RegExp[] = [
  /^failed to authenticate\b/i,
  /^(?:invalid api key|invalid bearer token)\b/i,
  /^login expired\b/i,
  /^not logged in\b/i,
  /^please run \/login\b/i,
  /^oauth (?:session|token|access token) (?:has )?(?:expired|revoked)\b/i,
  // A bare 401 is not one, as with 402 above (2026-11-10): "API Error: 401 …" is read in
  // classify().
  /^unexpected status 401\b/i,
  /^your (?:access|refresh) token (?:could not be refreshed|has expired|was revoked)\b/i,
  /^authentication (?:failed|required)\b/i,
];

/**
 * The selected model cannot be used: a provider task whose environment never reached it talked
 * to the default API and was told its model is unknown (2026-11-08). Going on would fail the
 * same way; the task pauses for the user, it never finishes as if done.
 */
const MODEL: RegExp[] = [
  /^(?:the )?model\b[^\n]*?\b(?:isn['’]t|is not|was not|wasn['’]t) recognized\b/i,
  /^there['’]s an issue with the selected model\b/i,
  /^(?:the )?(?:selected |requested |configured )?model\b[^\n]*?\b(?:may not exist|does not exist|doesn['’]t exist|is (?:unknown|invalid|not available|unavailable))\b/i,
  /\bmay not exist or you may not have access\b/i,
];

const API_ERROR: RegExp[] = [
  /^api error\b/i,
  /^stream (?:disconnected|error)\b/i,
  /^unexpected status (?:429|5\d\d)\b/i,
  /^exceeded retry limit\b/i,
  /^we['’]re currently experiencing high demand\b/i,
  /^(?:overloaded|service unavailable|internal server error|bad gateway)\b/i,
  /^(?:request timed out|connection (?:error|lost|reset|refused)|network error)\b/i,
  /^error sending request\b/i,
  /^(?:rate limit(?:ed)?|too many requests)\b/i,
];

/**
 * Errors that say something about the work, not the account or the service: going on would
 * fail again the same way (a refused prompt, a context too long to send).
 */
const NOT_A_HALT =
  /safeguards flagged|usage policy|prompt is too long(?!.*(?:can't reach|connection))/i;

function classify(content: string): AgentHaltKind | undefined {
  if (NOT_A_HALT.test(content)) return undefined;
  if (USAGE_LIMIT.some((pattern) => pattern.test(content))) return 'usage-limit';
  // An API error that is really the account's limit or login says so in its text.
  if (/^api error/i.test(content)) {
    if (/\b401\b|authentication_error|please run \/login|oauth token/i.test(content)) {
      return 'auth';
    }
    if (/usage limit|rate_limit_error|\b429\b/i.test(content) && /limit/i.test(content)) {
      return /usage limit/i.test(content) ? 'usage-limit' : 'api-error';
    }
    // A provider out of money (402 / insufficient balance) is the account's, not the service's.
    if (/\b402\b|insufficient (?:balance|credits?|funds|quota)|payment required/i.test(content)) {
      return 'usage-limit';
    }
  }
  if (AUTH.some((pattern) => pattern.test(content))) return 'auth';
  if (MODEL.some((pattern) => pattern.test(content))) return 'model';
  if (API_ERROR.some((pattern) => pattern.test(content))) return 'api-error';
  return undefined;
}

/** The halt on a session's screen, when the agent's last word there is one; else null. */
export function detectAgentHalt(screen: string, now: number): AgentHalt | null {
  const lines = screen.split('\n').map((line) => line.trimEnd());
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.trim()) continue;
    const marked = MARKER.exec(line);
    const content = marked ? line.slice(marked[0].length).trim() : '';
    const kind = marked ? classify(content) : undefined;
    if (kind) {
      const parts = [content];
      for (let next = index + 1; next < lines.length && parts.length < 4; next++) {
        if (NOT_CONTINUATION.test(lines[next])) break;
        parts.push(lines[next].trim());
      }
      const message = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      const resumeAt = kind === 'usage-limit' ? parseResumeAt(message, now) : undefined;
      return { kind, message, ...(resumeAt !== undefined ? { resumeAt } : {}) };
    }
    // The agent said or did something after any error above: it went on.
    if (AGENT_OUTPUT.test(line)) return null;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The wall clock of `at` in `timeZone` (undefined: this machine's). */
function wallClock(at: number, timeZone?: string) {
  if (!timeZone) {
    const date = new Date(at);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The instant whose wall clock in `timeZone` (undefined: this machine's) is the one given. */
function instantOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone?: string
): number {
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
  const wanted = Date.UTC(year, month, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const seen = wallClock(guess, timeZone);
    guess += wanted - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
  }
  return guess;
}

function validZone(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

/**
 * When an agent's usage limit message says it resets (epoch ms), or undefined:
 *   "try again at 4:25 AM", "try again at Nov 2nd, 2026 4:25 AM", "resets 4am (Europe/Madrid)",
 *   "resets Nov 2, 10am", "resets in 2h 13m", "will reset at 5pm", "…|1730430000".
 * A time of day without a date is its next occurrence.
 */
export function parseResumeAt(text: string, now: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;

  const relative =
    /\b(?:resets?|try again|available again)\s+in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)\b[\s,]*(?:and\s+)?)+)/i.exec(
      text
    );
  if (relative) {
    let ms = 0;
    for (const [, amount, unit] of relative[1].matchAll(/(\d+)\s*([dhm])/gi)) {
      const factor =
        unit.toLowerCase() === 'd' ? 86_400_000 : unit.toLowerCase() === 'h' ? 3_600_000 : 60_000;
      ms += Number(amount) * factor;
    }
    if (ms > 0) return now + ms;
  }

  const anchor =
    /\b(?:resets?|reset at|resets at|try again at|try again after|available again at)\b\s*(?:on\s+)?(.{0,60})/i.exec(
      text
    );
  if (!anchor) return undefined;
  const rest = anchor[1];
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?|\b(\d{1,2}):(\d{2})\b/i.exec(rest);
  if (!time) return undefined;
  let hour = Number(time[1] ?? time[4]);
  const minute = Number(time[2] ?? time[5] ?? 0);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  const zone = validZone(/\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\)/.exec(rest)?.[1]);
  const date =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/i.exec(
      rest
    );
  const today = wallClock(now, zone);
  if (date) {
    const month = MONTHS.indexOf(date[1].toLowerCase());
    const day = Number(date[2]);
    let year = date[3] ? Number(date[3]) : today.year;
    let at = instantOf(year, month, day, hour, minute, zone);
    // "Jan 2" read on Dec 31 is next year's.
    if (!date[3] && at < now - 86_400_000) {
      year += 1;
      at = instantOf(year, month, day, hour, minute, zone);
    }
    return at;
  }
  let at = instantOf(today.year, today.month, today.day, hour, minute, zone);
  // Already past today (by more than a minute): tomorrow's.
  if (at < now - 60_000) at = instantOf(today.year, today.month, today.day + 1, hour, minute, zone);
  return at;
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

/** "Codex hit its usage limit", "Claude lost its login", "Claude got an API error". */
export function haltHeadline(kind: AgentHaltKind, agent: 'claude' | 'codex'): string {
  const name = AGENT_NAMES[agent];
  switch (kind) {
    case 'usage-limit':
      return `${name} hit its usage limit`;
    case 'auth':
      return `${name} lost its login`;
    case 'api-error':
      return `${name} stopped on an API error`;
    case 'model':
      return `${name} could not use the selected model`;
  }
}

/** What a paused task's agent is told when it is sent on (the same session, or reopened). */
export function haltContinuePrompt(kind: AgentHaltKind): string {
  const why =
    kind === 'usage-limit'
      ? 'your usage limit'
      : kind === 'auth'
        ? 'a login problem'
        : kind === 'model'
          ? 'a problem with the selected model'
          : 'an API error';
  return `[untether] Your last turn was cut short by ${why} before you finished; that is over now. Continue the task exactly where you left off (look at what you already changed first). When the task is complete, finish as your instructions say (\`ut task done\`).`;
}
