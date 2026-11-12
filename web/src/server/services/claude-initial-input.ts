/**
 * "Ask Claude" / "Ask Codex" from the phone home screen: the first message is typed into a new
 * agent session by the server once its TUI is ready, so it is not lost while the agent starts
 * up and still arrives if the phone sleeps or navigates away.
 *
 * The text goes to the PTY as keyboard input (never into a shell command line). Readiness is
 * per agent: Claude Code reports its status in a file, Codex is read off the screen.
 */

export const INITIAL_INPUT_MAX_LENGTH = 20000;

export type InitialInputAgent = 'claude' | 'codex';

export interface InitialInputDeps {
  /** Claude Code's status for the session ('idle', 'busy', 'waiting'), if Claude runs yet. */
  claudeStatus: () => Promise<string | undefined>;
  /** True while a numbered dialog (trust folder, bypass-permissions warning, …) is on screen. */
  dialogOnScreen: () => Promise<boolean>;
  /** False once the session exited or disappeared. */
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  /** Called when the text could not be delivered (logged by the caller). */
  onGiveUp?: (reason: string) => void;
  /** See AgentInputDeps.answerDialog. */
  answerDialog?: () => Promise<boolean>;
  /** See AgentInputDeps.userHold. */
  userHold?: () => Promise<string | null>;
  /** See AgentInputDeps.lockKey. */
  lockKey?: string;
  /** See AgentInputDeps.onHold. */
  onHold?: (why: string) => void;
}

export interface InitialInputOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Consecutive ready polls required (a screen-read agent may redraw between steps). */
  readyPolls?: number;
  /** Pause after Claude reports idle: its input box renders right after the status write. */
  settleMs?: number;
  /** Gap between the text and Enter, so Claude sees Enter as a key press of its own. */
  enterDelayMs?: number;
  /** Longest wait while a dialog keeps showing (the user may be answering it). */
  maxWaitMs?: number;
  /**
   * Wait with no time limit while this says yes and the session runs (an orchestrator's
   * events, its brief); false gives up at once. 2026-10-20: an orchestrator busy for over a
   * minute lost its brief and its task events ("not delivered: Claude never became ready").
   */
  keepWaiting?: () => boolean;
  /**
   * Claude only: typed while it works too (it reads the message within its current turn, as
   * one written on the phone mid-turn). A menu of its own still waits. 2026-10-23: a task's
   * follow-up sent 47 s after its start waited 30 min for the turn to end, and arrived after
   * the agent had found the fix on its own; it read it as new and investigated again.
   */
  whileBusy?: boolean;
  /**
   * Called once when a dialog stays on screen `dialogNoticeMs` without being answered (one the
   * caller may not answer for the user: an update menu, an unknown prompt). 2026-10-23: a
   * task's Codex sat on its update menu for 30 min while Untether waited in silence.
   */
  onDialogWaiting?: () => void;
  dialogNoticeMs?: number;
  /** The user's own input holds the typing back, and why (the caller says so to who waits). */
  onUserHold?: (why: string) => void;
}

/** What typing the first message needs from the session, whatever the agent. */
export interface AgentInputDeps {
  /** True when the agent waits at its prompt with nothing else on screen. */
  isReady: () => Promise<boolean>;
  /** False once the session exited or disappeared. */
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  /** Called when the text could not be delivered (logged by the caller). */
  onGiveUp?: (reason: string) => void;
  /** Agent name for the give-up reason ("Claude", "Codex"). */
  agentName?: string;
  /** Called when the user's own input starts to hold the typing back (once per reason). */
  onHold?: (why: string) => void;
  /**
   * True while a dialog the user has to answer is showing (update, trust folder). While it
   * is, the wait keeps extending (up to `maxWaitMs`): the user may be answering it.
   */
  dialogVisible?: () => Promise<boolean>;
  /** False while the typed text still sits in the agent's input, its Enter not taken. */
  submitted?: () => Promise<boolean>;
  /**
   * Called while a dialog shows: answers it when it is one the caller may answer for the
   * user (the trust dialog of a folder the task engine made), resolving to whether it did.
   */
  answerDialog?: () => Promise<boolean>;
  /**
   * Why the text must not be typed now because of the user's own input (user-input-guard.ts:
   * writing, a draft in the input box, a message just sent), or null. Asked when the agent is
   * ready and again right before the keys go in; while it holds, the wait goes on.
   */
  userHold?: () => Promise<string | null>;
  /**
   * One typing at a time per key (the session): 2026-11-10, a reply from the phone and another
   * agent's message both waited for the same idle prompt and went in as one turn.
   */
  lockKey?: string;
}

/**
 * Claude Code is ready when it reports idle (or busy, with `whileBusy`) and no numbered
 * dialog is on screen.
 */
export function claudeReadiness(
  deps: Pick<InitialInputDeps, 'claudeStatus' | 'dialogOnScreen'>,
  whileBusy = false
): () => Promise<boolean> {
  return async () => {
    let status: string | undefined;
    try {
      status = await deps.claudeStatus();
    } catch {
      return false;
    }
    // 'waiting' is a menu of its own (a question, a permission): never typed into.
    if (status !== 'idle' && !(whileBusy && status === 'busy')) return false;
    try {
      return !(await deps.dialogOnScreen());
    } catch {
      // A screen we can't read might be hiding a dialog: treat it as one.
      return false;
    }
  };
}

const NUMBERED = /^\s*(?:[›❯>▶]\s*)?(\d+)\.\s+\S/;

/**
 * The option that trusts the folder in Claude Code's trust dialog ("Yes, I trust this
 * folder", "Yes, proceed") or Codex's ("Trust and continue", 0.163, 2026-10-23: not starting
 * with "Yes", it was never answered), 1-based, or 0 when the menu is not that dialog.
 */
export function trustFolderOption(menu: { question: string; options: string[] } | null): number {
  if (!menu) return 0;
  const text = `${menu.question}\n${menu.options.join('\n')}`;
  if (!/trust/i.test(text)) return 0;
  const index = menu.options.findIndex((option) =>
    /^\s*(?:yes\b.*\b(trust|proceed|continue)|trust\b.*\b(continue|proceed)\b)/i.test(option)
  );
  return index + 1;
}

/**
 * Whether a Codex screen shows a choice the user must make: a numbered list ("› 1. Update
 * now / 2. Skip / 3. Skip until next version", "1. Yes, continue / 2. No, quit" when trusting
 * a folder, sign-in choices) or "Press enter to continue". Never answered for the user.
 */
export function codexDialogOnScreen(screenText: string): boolean {
  const lines = screenText.split('\n');
  if (lines.some((line) => /press enter to (continue|confirm)/i.test(line))) return true;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].match(NUMBERED);
    if (first?.[1] !== '1') continue;
    // Option 2 follows within a few lines (wrapped labels and descriptions in between).
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const next = lines[j].match(NUMBERED);
      if (next) {
        if (next[1] === '2') return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Whether Codex waits at its input prompt: its composer line ("› Ask Codex to do anything",
 * the placeholder shows as text) near the bottom of the screen, under which only the footer
 * ("100% context left · ? for shortcuts", the model…) follows, and no dialog anywhere.
 */
export function codexReadyOnScreen(screenText: string): boolean {
  if (codexDialogOnScreen(screenText)) return false;
  const lines = screenText.split('\n').filter((line) => line.trim());
  const tail = lines.slice(-8);
  return tail.some((line) => /^\s*[›▌](?:\s|$)/.test(line) && !NUMBERED.test(line));
}

/** Codex is ready when its screen shows the prompt and no dialog. */
export function codexReadiness(screenText: () => Promise<string>): () => Promise<boolean> {
  return async () => {
    try {
      return codexReadyOnScreen(await screenText());
    } catch {
      return false;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What sanitizeTypedText removes, in this order (stripping control characters is the point). */
const TERMINAL_CONTROLS = [
  // OSC / DCS / SOS / PM / APC strings, up to BEL or ST.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls
  /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g,
  // CSI sequences (7-bit ESC [ and 8-bit 0x9b).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/g,
  // SS2/SS3 (function keys such as ESC O P): ESC, N or O, and the key.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls
  /\x1b[NO][\s\S]?/g,
  // Any other escape: ESC plus its next character (charset selects, Alt+key…).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls
  /\x1b[\s\S]?/g,
  // Remaining C0 controls except \t and \n, DEL, and C1 controls.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls
  /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
];

/**
 * `text` with nothing a terminal would act on: line endings become \n, escape sequences
 * (CSI, OSC, DCS…) and other C0/C1 controls are dropped, tabs and newlines stay.
 * 2026-10-20 (security audit): a prompt holding `\x1b[201~` ended the bracketed paste early
 * (the rest was typed as keys), `\r` submitted it half-way and `\x1b[Z` (Shift+Tab) switched
 * Claude's permission mode.
 */
export function sanitizeTypedText(text: string): string {
  return TERMINAL_CONTROLS.reduce(
    (out, pattern) => out.replace(pattern, ''),
    text.replace(/\r\n?/g, '\n')
  );
}

/** After something was typed for a session, nothing else is typed into it this long. */
export const TYPED_GAP_MS = 3000;

/** Typings under way and the last one done, per AgentInputDeps.lockKey. */
const typingLocks = new Map<string, Promise<void>>();
const lastTyped = new Map<string, number>();

/** A session ended: its typing bookkeeping goes (lockKey is the session id). */
export function forgetTyping(key: string): void {
  lastTyped.delete(key);
  typingLocks.delete(key);
}

async function typingLock(key: string | undefined): Promise<() => void> {
  if (!key) return () => {};
  const before = typingLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = before.then(() => new Promise<void>((resolve) => (release = resolve)));
  typingLocks.set(key, mine);
  await before;
  return () => {
    release();
    if (typingLocks.get(key) === mine) typingLocks.delete(key);
  };
}

/**
 * Wait until the agent is ready at its prompt, then type `text` and press Enter.
 * Never types blind: an Enter landing on a dialog drawn late (trust this folder, bypass
 * warning, Codex's update prompt) would pick its default answer for the user, so when the
 * agent is not ready by the timeout the text is dropped and the user answers the dialog.
 * With `userHold` / `lockKey` it also never types onto the user's own input, nor two texts into
 * one prompt at once (2026-11-10). Resolves to true when the text was sent.
 */
export async function typeWhenAgentReady(
  text: string,
  deps: AgentInputDeps,
  {
    timeoutMs = 60000,
    pollMs = 500,
    settleMs = 400,
    enterDelayMs = 80,
    readyPolls = 1,
    maxWaitMs = 10 * 60_000,
    keepWaiting,
    onDialogWaiting,
    dialogNoticeMs = 20_000,
  }: InitialInputOptions = {}
): Promise<boolean> {
  text = sanitizeTypedText(text);
  // 2026-10-02: a user who took over a minute to answer Codex's update prompt lost the
  // question. The timeout only runs while no dialog is showing; a dialog keeps it waiting.
  const hardDeadline = Date.now() + maxWaitMs;
  let deadline = Date.now() + timeoutMs;
  // 2026-10-18: the trust dialog was answered twice in a row because the screen still showed
  // it right after the first answer; the second answer moved the cursor back to "No, exit"
  // and Claude quit (exit 1), failing the task. One answer, then give the screen time.
  let answerAgainAt = 0;
  let seenRunning = false;
  let dialogSince: number | undefined;
  let dialogTold = false;
  // The user's own input in the way (user-input-guard.ts), logged once per reason.
  let heldWhy: string | null = null;
  const guarded = !!deps.userHold || !!deps.lockKey;
  const held = async (): Promise<boolean> => {
    const typedAt = deps.lockKey ? lastTyped.get(deps.lockKey) : undefined;
    let why: string | null =
      typedAt !== undefined && Date.now() >= typedAt && Date.now() - typedAt < TYPED_GAP_MS
        ? 'something else was just typed into it'
        : null;
    // A guard that fails tells nothing: never typed over what it could not rule out.
    why ??= deps.userHold
      ? await deps.userHold().catch(() => 'its input could not be checked')
      : null;
    if (why && why !== heldWhy) deps.onHold?.(why);
    heldWhy = why;
    return why !== null;
  };
  for (;;) {
    let ready = false;
    let streak = 0;
    while (keepWaiting || Date.now() < deadline) {
      if (keepWaiting && !keepWaiting()) {
        deps.onGiveUp?.('no longer wanted');
        return false;
      }
      const running = deps.isRunning();
      if (running) seenRunning = true;
      if (!running) {
        // Not registered yet right after spawn is fine; keep waiting until the deadline. With
        // keepWaiting, a session seen running that ended is not coming back.
        if (keepWaiting && (seenRunning || Date.now() >= deadline)) break;
        streak = 0;
      } else if (await deps.isReady().catch(() => false)) {
        dialogSince = undefined;
        if (await held()) {
          streak = 0;
          // The user writing is no reason to give up: the timeout starts over once they stop.
          deadline = Math.min(hardDeadline, Date.now() + timeoutMs);
        } else if (++streak >= readyPolls) {
          ready = true;
          break;
        }
      } else {
        streak = 0;
        if (await (deps.dialogVisible?.() ?? Promise.resolve(false)).catch(() => false)) {
          deadline = Math.min(hardDeadline, Date.now() + timeoutMs);
          let answered = false;
          if (deps.answerDialog && Date.now() >= answerAgainAt) {
            answered = await deps.answerDialog().catch(() => false);
            if (answered) answerAgainAt = Date.now() + 5000;
          }
          // A dialog that stays (answered ones go within a few seconds) is the user's to answer.
          if (answered) dialogSince = undefined;
          else dialogSince ??= Date.now();
          if (
            onDialogWaiting &&
            !dialogTold &&
            dialogSince !== undefined &&
            Date.now() - dialogSince >= dialogNoticeMs
          ) {
            dialogTold = true;
            onDialogWaiting();
          }
        } else {
          dialogSince = undefined;
        }
      }
      await sleep(pollMs);
    }
    if (!deps.isRunning()) {
      deps.onGiveUp?.('session is not running');
      return false;
    }
    if (!ready) {
      deps.onGiveUp?.(
        heldWhy
          ? `${heldWhy} (never typed over it)`
          : `${deps.agentName ?? 'Claude'} never became ready`
      );
      return false;
    }
    await sleep(settleMs);
    const release = await typingLock(deps.lockKey);
    try {
      // Looked at once more with the lock held: the user may have started to write, or
      // another message may have gone in, while this one settled or waited its turn.
      if (guarded) {
        const still =
          deps.isRunning() && (await deps.isReady().catch(() => false)) && !(await held());
        if (!still) continue;
      }
      // Multi-line text as a bracketed paste, so its newlines don't submit the first line early.
      deps.send({ text: text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text });
      await sleep(enterDelayMs);
      deps.send({ key: 'enter' });
      if (deps.lockKey) lastTyped.set(deps.lockKey, Date.now());
      // An Enter the agent did not take (Codex read it as part of the typed burst, 2026-10-03:
      // the question stayed in its input, unsent) is pressed once more.
      if (deps.submitted) {
        for (let waited = 0; waited < 1500; waited += pollMs) {
          await sleep(pollMs);
          if (await deps.submitted().catch(() => true)) return true;
        }
        if (deps.isRunning()) deps.send({ key: 'enter' });
      }
      return true;
    } finally {
      release();
    }
  }
}

/**
 * Claude Code: wait until it is idle at its prompt (or working, with `whileBusy`), then type
 * `text` and press Enter.
 */
export function typeWhenClaudeReady(
  text: string,
  deps: InitialInputDeps & { screenText?: () => Promise<string> },
  options: InitialInputOptions = {}
): Promise<boolean> {
  const screenText = deps.screenText;
  return typeWhenAgentReady(
    text,
    {
      isReady: claudeReadiness(deps, options.whileBusy === true),
      isRunning: deps.isRunning,
      send: deps.send,
      onGiveUp: deps.onGiveUp,
      agentName: 'Claude',
      dialogVisible: deps.dialogOnScreen,
      answerDialog: deps.answerDialog,
      userHold: deps.userHold,
      lockKey: deps.lockKey,
      onHold: deps.onHold,
      // 2026-10-20 review: an Enter Claude did not take left the text unsent while Untether
      // said "typed". Pressed once more only when the text still sits in its input and no
      // menu of its own is up (an Enter there would pick an option).
      ...(screenText
        ? {
            submitted: async () => {
              if (await deps.dialogOnScreen().catch(() => true)) return true;
              return !claudeInputHolds(await screenText(), text);
            },
          }
        : {}),
    },
    options
  );
}

/**
 * Whether Claude Code's input box still holds `text` (its `❯` line shows its start, or the
 * "[Pasted text …]" a multi-line paste becomes), i.e. its Enter was not taken.
 */
export function claudeInputHolds(screenText: string, text: string): boolean {
  const start = text.trim().split('\n')[0].slice(0, 20).trim();
  if (!start) return false;
  const input = screenText
    .split('\n')
    .filter((line) => /^\s*❯\s/.test(line))
    .pop();
  if (!input) return false;
  const typed = input.replace(/^\s*❯\s*/, '');
  return typed.startsWith(start) || (text.includes('\n') && typed.startsWith('[Pasted text'));
}

export interface CodexInitialInputDeps {
  /** The session's screen as plain text. */
  screenText: () => Promise<string>;
  isRunning: () => boolean;
  send: (input: { text: string } | { key: 'enter' }) => void;
  onGiveUp?: (reason: string) => void;
  /** See AgentInputDeps.answerDialog. */
  answerDialog?: () => Promise<boolean>;
  /** See AgentInputDeps.userHold, lockKey and onHold. */
  userHold?: () => Promise<string | null>;
  lockKey?: string;
  onHold?: (why: string) => void;
}

/** Codex: wait until its prompt shows with no dialog (twice in a row), then type `text`. */
export function typeWhenCodexReady(
  text: string,
  deps: CodexInitialInputDeps,
  options: InitialInputOptions = {}
): Promise<boolean> {
  // Each poll asks isReady first and, when not ready, dialogVisible: both look at the same
  // screen read, so a dialog that stays up costs one read per poll instead of two.
  let pollScreen: Promise<string> | null = null;
  const readForPoll = () => {
    pollScreen = deps.screenText();
    return pollScreen;
  };
  return typeWhenAgentReady(
    text,
    {
      isReady: codexReadiness(readForPoll),
      isRunning: deps.isRunning,
      send: deps.send,
      onGiveUp: deps.onGiveUp,
      agentName: 'Codex',
      dialogVisible: async () => {
        const screen = pollScreen ?? deps.screenText();
        pollScreen = null;
        return codexDialogOnScreen(await screen);
      },
      submitted: async () => !codexInputHolds(await deps.screenText(), sanitizeTypedText(text)),
      answerDialog: deps.answerDialog,
      userHold: deps.userHold,
      lockKey: deps.lockKey,
      onHold: deps.onHold,
    },
    // Its Enter after a moment: Codex takes keys typed in a burst for a paste, and an Enter
    // 80 ms after the text did not send it (2026-10-03).
    { readyPolls: 2, enterDelayMs: 300, ...options }
  );
}

/** Whether Codex's input line (its last "›" line) starts with the text typed into it. */
export function codexInputHolds(screenText: string, text: string): boolean {
  const start = text.trim().slice(0, 20);
  const input = screenText
    .split('\n')
    .filter((line) => /^\s*[›▌]\s/.test(line))
    .pop();
  return !!start && !!input && input.replace(/^\s*[›▌]\s*/, '').startsWith(start);
}
