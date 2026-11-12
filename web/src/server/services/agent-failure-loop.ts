/**
 * Failure loops of an agent (2026-11-03): the same command failing the same way again and
 * again. The stall watch (task-scheduler-stall.ts) sees an agent that makes no progress while
 * it waits on one thing; an agent that keeps running `pnpm test` into the same error, or keeps
 * editing and re-running a test that fails identically, makes "progress" on every call and is
 * never called stalled. Its own events say it: a tool call that ended in failure (Claude's
 * PostToolUseFailure, a Codex command's non-zero exit code) carries the error.
 *
 * A failure's signature is its tool, its command normalised (whitespace, `cd … &&` prefixes,
 * output plumbing such as `2>&1 | tail -n 40`) and its error line normalised (numbers, hex ids,
 * temp paths and colours out, so the same error on another run is the same). Failures are
 * counted per signature in the session and in its current turn; a success of that same command
 * clears its run (it works now), and so does a failure of it with another error (it moved).
 * Edits in between do not: the edit/test cycle that fails identically counts like a retry.
 *
 * Pure: events in, runs out. The tracker (agent-events.ts) keeps one per session; the
 * scheduler (task-scheduler-loops.ts) reads the runs and nudges.
 */

/** Identical failures in one turn before the agent is nudged, and again after the nudge before its orchestrator is told. */
export const FAILURE_LOOP_REPEATS = 3;
/** Runs kept per session (the oldest go first). */
const MAX_RUNS = 50;
const COMMAND_MAX = 160;
const ERROR_LINE_MAX = 200;

/** One signature's failures in a session. */
export interface FailureRun {
  signature: string;
  tool: string;
  /** The command (or file, pattern…) as the agent ran it, one line. */
  command: string;
  /** The error line, as the agent saw it the last time (not normalised). */
  errorLine: string;
  /** Failures since its command last worked (or failed another way). */
  count: number;
  /** Failures in the turn that started at `turnStartedAt`. */
  turnCount: number;
  /** The turn its turnCount belongs to (the turn's start, epoch ms; 0 before any turn). */
  turnStartedAt: number;
  firstAt: number;
  lastAt: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * A command as one comparable line: whitespace collapsed, a leading `cd <dir> &&` (or `;`) and
 * `export PATH=… &&` dropped, output plumbing at its end dropped (`2>&1`, `| tail -n 40`,
 * `| head`, `| grep …`), so `pnpm test 2>&1 | tail -20` and `cd web && pnpm test` are the same.
 */
export function normaliseCommand(command: string): string {
  let line = command.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = line
      .replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '')
      .replace(/^export\s+[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
    if (next === line) break;
    line = next;
  }
  for (;;) {
    const next = line
      .replace(/\s*\|\s*(tail|head|grep|less|cat|tee)\b[^|]*$/, '')
      .replace(/\s*[12]?>&[12]\s*$/, '')
      .replace(/\s*;?\s*echo\s+["']?(exit|EXIT)[^|;&]*\$\?["']?\s*$/, '')
      .trim();
    if (next === line) break;
    line = next;
  }
  return line.slice(0, COMMAND_MAX);
}

/** Lines that say the run ended, not why (Claude's "Exit code 1", a timer). */
const NOT_THE_ERROR =
  /^(exit code:? \d+|process exited with code \d+|wall time:.*|output:|command failed)$/i;
const SAYS_ERROR =
  /\b(error|errors|failed|failure|fail|exception|cannot|can't|could not|not found|no such|denied|refused|invalid|unexpected|missing|undefined|timed? ?out|panic|fatal|traceback|assert)/i;

/**
 * The line of a failure's output that says what went wrong: the first that reads like an
 * error (and is not just "Exit code 1"), else the last line with text.
 */
export function errorLineOf(output: string): string {
  const lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !NOT_THE_ERROR.test(line));
  const line = lines.find((entry) => SAYS_ERROR.test(entry)) ?? lines[lines.length - 1] ?? '';
  return line.slice(0, ERROR_LINE_MAX);
}

/** An error line made comparable across runs: numbers, hex ids, temp paths and quotes of times out. */
export function normaliseError(line: string): string {
  return line
    .toLowerCase()
    .replace(/\/(private\/)?(tmp|var\/folders)\/\S*/g, '<tmp>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function failureSignature(tool: string, command: string, errorLine: string): string {
  return `${tool}\u0000${normaliseCommand(command)}\u0000${normaliseError(errorLine)}`;
}

/** Where a signature's command part starts and ends: tool + normalised command. */
function commandKey(tool: string, command: string): string {
  return `${tool}\u0000${normaliseCommand(command)}\u0000`;
}

/** One session's failure runs. */
export class FailureLoops {
  private runs = new Map<string, FailureRun>();

  /** Runs a `list()` wrote to disk (agent-events.ts dump), checked field by field. */
  static from(value: unknown): FailureLoops {
    const loops = new FailureLoops();
    if (!Array.isArray(value)) return loops;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    for (const entry of value.slice(-MAX_RUNS)) {
      if (!entry || typeof entry !== 'object') continue;
      const run = entry as Record<string, unknown>;
      if (
        typeof run.signature !== 'string' ||
        typeof run.tool !== 'string' ||
        typeof run.command !== 'string' ||
        typeof run.errorLine !== 'string' ||
        !num(run.count) ||
        !num(run.turnCount) ||
        !num(run.turnStartedAt) ||
        !num(run.firstAt) ||
        !num(run.lastAt)
      ) {
        continue;
      }
      loops.runs.set(run.signature, {
        signature: run.signature,
        tool: run.tool,
        command: run.command,
        errorLine: run.errorLine,
        count: run.count,
        turnCount: run.turnCount,
        turnStartedAt: run.turnStartedAt,
        firstAt: run.firstAt,
        lastAt: run.lastAt,
      });
    }
    return loops;
  }

  /**
   * A tool call ended. `failure` is its error output when it failed. `turnStartedAt` is the
   * current turn's start (0 before any turn).
   */
  toolEnded(
    call: { tool: string; command?: string; failure?: string; at: number },
    turnStartedAt: number
  ): void {
    const command = call.command?.trim();
    // A call without a command, file or pattern cannot be told apart from another: not counted.
    if (!command) return;
    const key = commandKey(call.tool, command);
    if (call.failure === undefined) {
      // It works now: its runs are over.
      for (const signature of this.runs.keys()) {
        if (signature.startsWith(key)) this.runs.delete(signature);
      }
      return;
    }
    const errorLine = errorLineOf(call.failure) || 'failed (no output)';
    const signature = failureSignature(call.tool, command, errorLine);
    // The same command failing another way: it moved, the old error is no longer repeating.
    for (const other of this.runs.keys()) {
      if (other !== signature && other.startsWith(key)) this.runs.delete(other);
    }
    let run = this.runs.get(signature);
    if (!run) {
      run = {
        signature,
        tool: call.tool,
        command: command.replace(/\s+/g, ' ').slice(0, COMMAND_MAX),
        errorLine,
        count: 0,
        turnCount: 0,
        turnStartedAt,
        firstAt: call.at,
        lastAt: call.at,
      };
    } else {
      this.runs.delete(signature);
    }
    if (run.turnStartedAt !== turnStartedAt) {
      run.turnStartedAt = turnStartedAt;
      run.turnCount = 0;
    }
    run.count++;
    run.turnCount++;
    run.lastAt = call.at;
    run.errorLine = errorLine;
    // Kept in the order they last failed: the oldest go first.
    this.runs.set(signature, run);
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value as string);
  }

  /** The runs, the most recent failure last. */
  list(): FailureRun[] {
    return [...this.runs.values()].map((run) => ({ ...run }));
  }
}

/**
 * The run to nudge about in the turn that started at `turnStartedAt`: one that failed
 * identically FAILURE_LOOP_REPEATS times or more in it, the most repeated (then the latest).
 */
export function loopingRun(
  runs: readonly FailureRun[] | undefined,
  turnStartedAt: number,
  skip: ReadonlySet<string> = new Set()
): FailureRun | undefined {
  let best: FailureRun | undefined;
  for (const run of runs ?? []) {
    if (run.turnStartedAt !== turnStartedAt || run.turnCount < FAILURE_LOOP_REPEATS) continue;
    if (skip.has(run.signature)) continue;
    if (
      !best ||
      run.turnCount > best.turnCount ||
      (run.turnCount === best.turnCount && run.lastAt > best.lastAt)
    ) {
      best = run;
    }
  }
  return best;
}

/** Codex: whether a tool call's output says it failed, and its output. */
export function codexCallFailure(output: unknown): string | undefined {
  let text: string | undefined;
  let exitCode: number | undefined;
  let success: boolean | undefined;
  if (typeof output === 'string') {
    text = output;
    try {
      const parsed = JSON.parse(output) as {
        output?: unknown;
        metadata?: { exit_code?: unknown };
        success?: unknown;
      };
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.output === 'string') text = parsed.output;
        if (typeof parsed.metadata?.exit_code === 'number') exitCode = parsed.metadata.exit_code;
        if (typeof parsed.success === 'boolean') success = parsed.success;
      }
    } catch {
      // plain text
    }
  } else if (output && typeof output === 'object') {
    const fields = output as { content?: unknown; success?: unknown };
    if (typeof fields.content === 'string') text = fields.content;
    if (typeof fields.success === 'boolean') success = fields.success;
  }
  if (text === undefined) return undefined;
  if (exitCode === undefined) {
    const said = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m.exec(text);
    if (said) exitCode = Number(said[1]);
  }
  const failed = (exitCode !== undefined && exitCode !== 0) || success === false;
  return failed ? text : undefined;
}

/** Claude: a PostToolUse whose response still says it failed (a non-zero exit code). */
export function claudeResponseFailure(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const fields = response as Record<string, unknown>;
  const code = fields.exitCode ?? fields.exit_code ?? fields.returnCode;
  if (typeof code !== 'number' || code === 0) return undefined;
  const out = [fields.stderr, fields.stdout].filter((part) => typeof part === 'string').join('\n');
  return out || `exit code ${code}`;
}
