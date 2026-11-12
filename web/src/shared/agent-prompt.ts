/**
 * A prompt of the agent's own on a task's screen (2026-11-10, bakery 3dc243e4): Claude Code
 * asks before some commands even with --dangerously-skip-permissions (four `bash -c '…'` calls
 * of its background subagents that day), and the task sat hours on «needs you · permission
 * prompt» with no way out from its orchestrator: nobody could read what it asked, `ut task
 * send` waited behind the menu and `ut task retry` refused a task that is needs_you.
 *
 * Here (named apart from task-prompt.ts, the tasks' briefs): what such a prompt says (kept on the task's blocker, shown by `ut task status`), which
 * option an answer picks (`ut task answer`), and what an agent may never approve by itself: a
 * prompt that deletes, or one Untether cannot read.
 */

export interface TaskPrompt {
  /** The menu's question ("Do you want to proceed?"); empty when the screen could not be read. */
  question: string;
  /** Its options as shown, in order. */
  options: string[];
  /** What the dialog shows above the question ("Bash command", the command…). */
  detail?: string[];
  /** What the agent's own event says it asks for ("Permission for Bash: rm -rf dist"). */
  asks?: string;
  /** It asks to delete something: only the user approves it. */
  deletes?: boolean;
  /** The command it asks for is one Untether itself rewrote, and how (untetherWrapper). */
  wrapped?: string;
  /** When it was first seen (ISO). */
  since: string;
  /** When the user's phone was told nobody answered it (ISO). */
  toldUserAt?: string;
}

/** `ut task answer <id> approve | deny | <n> | --text "…"`. */
export type PromptAnswer =
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'option'; option: number }
  | { kind: 'text'; text: string };

/** Unanswered this long, the user's phone hears of it, whoever the task reports to. */
export const PROMPT_ESCALATE_MS = 10 * 60_000;

const NO = /^\s*no\b/i;
const YES = /^\s*(?:yes|allow|approve|proceed|continue|accept)\b/i;

/** "Yes" itself, not "Yes, and don't ask again for …" (that widens what was asked). */
const WIDENS = /don['’]t ask|always|for this session|for the rest|auto-?accept|all edits/i;

/** The option (1-based) that approves this one call and nothing more; 0 when there is none. */
export function approveOption(options: readonly string[]): number {
  const index = options.findIndex((option) => YES.test(option) && !WIDENS.test(option));
  return index + 1;
}

/** The option (1-based) that refuses; 0 when there is none. */
export function denyOption(options: readonly string[]): number {
  return options.findIndex((option) => NO.test(option)) + 1;
}

/** Anything but a "No" lets the call run. */
export function optionApproves(option: string): boolean {
  return !NO.test(option);
}

/**
 * Commands that remove things: files, git work, data. Broad on purpose: a false "deletes" only
 * means the user answers instead of an agent.
 */
const DELETES: RegExp[] = [
  /(?:^|[\s;&|(`'"])(?:sudo\s+)?(?:rm|rmdir|unlink|shred|srm|trash|rimraf|del)(?:\s|$)/m,
  /\bgit\s+(?:clean|rm)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+(?:--\s|\.)/,
  /\bgit\s+restore\b/,
  /\bgit\s+branch\s+(?:-D|--delete|-d)\b/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  /\bgit\s+push\b[^\n]*(?:--force|-f\b|--delete|\s:)/,
  /\bgit\s+worktree\s+remove\b/,
  /\bfind\b[^\n]*\s-(?:delete|exec\s+rm)\b/,
  /\bxargs\b[^\n]*\brm\b/,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\b(?:mkfs|diskutil\s+erase\w*|dd\s+[^\n]*\bof=)/,
  /\btruncate\s+-s\b/,
  /\bdocker\s+(?:\w+\s+)?(?:rm|prune)\b|\bdocker\s+compose\s+down\b[^\n]*-v\b/,
  /\b(?:fs\.)?(?:rmSync|unlinkSync|rmdirSync|rm|unlink)\s*\(/,
  /\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b/,
  /\bkubectl\s+delete\b/,
];

/**
 * Untether's own wrappers around an agent's command (the guard's hook rewrites a recognised
 * check command: check-slot-wrap.ts slotCommand, task-output.ts summarizedCommand), by the
 * shell variable each starts with.
 */
const WRAPPERS: Array<[RegExp, string]> = [
  [/(?:^|\n|[\s:{;])__ut_slot=\$\(/, 'check slot'],
  [/(?:^|\n|[\s:{;])__ut_log=/, 'output summary'],
];

/** How long a command Untether rewrote is told whole. */
export const WRAPPED_ASKS_MAX = 4000;

/**
 * Which of Untether's own wrappers the command a prompt asks for carries ("check slot, output
 * summary"), or null. 2026-11-11: three tasks under --dangerously-skip-permissions stopped on a
 * permission prompt only because of what Untether had put in front of their command (one sat
 * 4 h). That line is gone (task-processes.ts) and the wrappers left bring nothing Claude Code
 * checks; if one ever does again, the prompt is known as Untether's doing and told at once.
 */
export function untetherWrapper(asks: string | undefined): string | null {
  if (!asks) return null;
  const found = WRAPPERS.filter(([pattern]) => pattern.test(asks)).map(([, name]) => name);
  return found.length ? found.join(', ') : null;
}

/** Whether what the prompt asks for removes something. */
export function textDeletes(text: string): boolean {
  return DELETES.some((pattern) => pattern.test(text));
}

export function promptDeletes(prompt: Pick<TaskPrompt, 'detail' | 'asks' | 'question'>): boolean {
  return textDeletes([prompt.asks ?? '', ...(prompt.detail ?? []), prompt.question].join('\n'));
}

/**
 * What it asks is not known whole: only the agent's own event carries the whole command
 * (`asks`). The screen alone may show it cut ("bash -c … +12 lines"), with an `rm` in the part
 * nobody sees, so without that event nobody but the user, at the screen, approves it.
 */
export function promptUnread(prompt: Pick<TaskPrompt, 'detail' | 'asks'>): boolean {
  return !prompt.asks?.trim();
}

/**
 * Why an agent (an orchestrator) may not give this answer by itself, or null. The user may
 * give any. Never approved by an agent: a prompt that deletes, one not known whole,
 * and an option that widens the permission beyond this call.
 */
export function agentMayNotAnswer(prompt: TaskPrompt, option: string): string | null {
  if (!optionApproves(option)) return null;
  if (prompt.deletes ?? promptDeletes(prompt)) {
    return 'it asks to delete something: only the user approves that';
  }
  if (promptUnread(prompt)) {
    return 'what it asks for is not known whole (its screen may show the command cut): only the user, on its screen, approves it';
  }
  if (WIDENS.test(option)) {
    return 'that option allows more than this one call: only the user gives it';
  }
  return null;
}

/** The prompt as `ut task status` prints it. */
export function promptLines(prompt: TaskPrompt, ref: string): string[] {
  const lines: string[] = [];
  if (prompt.asks) lines.push(`asks: ${prompt.asks}`);
  for (const line of prompt.detail ?? []) lines.push(`  │ ${line}`);
  if (prompt.question) lines.push(prompt.question);
  lines.push(...prompt.options.map((option, index) => `  ${index + 1}. ${option}`));
  if (!prompt.options.length) {
    lines.push('(its options could not be read from the screen: open the task to answer)');
  } else {
    lines.push(
      `answer: ut task answer ${ref} approve | deny | <number> | --text "what to do instead"`
    );
  }
  if (prompt.deletes) lines.push('it deletes: only the user approves it (an agent may deny)');
  if (prompt.wrapped) lines.push(wrappedNote(prompt.wrapped));
  return lines;
}

/** What is said of a prompt on a command Untether itself rewrote. */
export function wrappedNote(wrapped: string): string {
  return `Untether itself rewrote this command (${wrapped}): its agent wrote only the part inside, and the prompt may come from Untether's wrapper alone (a bug of Untether's to report, with this command)`;
}

/** The command a prompt asks for, whole (bounded): for a prompt Untether's wrapper is in. */
export function promptWhole(prompt: TaskPrompt): string {
  const what = prompt.asks ?? (prompt.detail ?? []).join('\n').trim();
  return what.length > WRAPPED_ASKS_MAX ? `${what.slice(0, WRAPPED_ASKS_MAX - 1)}…` : what;
}

/** One line for a push or an orchestrator's event. */
export function promptSummary(prompt: TaskPrompt): string {
  const what = prompt.asks ?? (prompt.detail ?? []).join(' ').trim();
  const said = [what, prompt.question].filter(Boolean).join(' · ');
  return said.length > 300 ? `${said.slice(0, 299)}…` : said;
}
