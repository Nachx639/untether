/**
 * The command guard's PreToolUse hook (task-guard.ts says what it blocks). Run by Claude Code or
 * Codex before each tool call of a task's agent, as `untether guard-hook <policy.json>` (the app's
 * binary) or `node --import tsx task-guard-hook.ts <policy.json>` (a dev server): the tool call's
 * JSON on stdin; exit 2 with the reason on stderr blocks it and tells the agent why (both agents
 * read it so), exit 0 lets it run.
 *
 * A net against the agent's mistakes, not a sandbox (task-guard.ts). Only node built-ins and
 * task-guard.ts are imported: it starts on every tool call. In doubt it lets the call run and
 * writes why to the task's log: unreadable input or an error of its own as `guard-error`, a
 * command it cannot judge as `uncertain` (a guard that broke must not stop every task). No policy
 * file: not a guarded session.
 *
 * The shells of a task's Bash calls record their group in the task's folder (task-processes.ts,
 * recordShellGroup): what later proves a platform binary one starts, reparented, is the task's.
 * Never by a line in the agent's command (2026-11-11: its `rm` made Claude Code ask permission
 * for commands it could not analyse whole, with --dangerously-skip-permissions too): run as
 * `--shell-env <policy.json>` from Claude's SessionStart hook, this writes the line into
 * Claude's env file, which each Bash shell runs before its command.
 *
 * Only these rewrite a command (Claude's `updatedInput` on stdout, without a permission
 * decision: Claude's permissions stay as they are), and only a recognised test/check one: with
 * the project's `summarizeOutput` on it runs with its output in a log and a summary printed
 * (task-output.ts; `--summarize` runs that summary), and a heavy check run (the project's
 * check, a whole test suite) takes one of the Mac's check slots first (check-slot-wrap.ts).
 * Neither brings a command Claude Code's own checks look at (no `rm`, no `sh -c`, no `eval`:
 * task-guard-setup.test.ts), and a prompt on a command that carries one is told to the user at
 * once (shared/agent-prompt.ts, untetherWrapper).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { heavyCheck, onlyCheck, slotAskText, slotCommand } from './check-slot-wrap.js';
import {
  decide,
  describeCall,
  type GuardBlockEntry,
  type GuardInput,
  type GuardPolicy,
  type ProcessEntry,
  TOOL_HOLD_MAX_MS,
  toolHoldUntil,
} from './task-guard.js';
import { rewriteForSummary, summarizeMain } from './task-output.js';
import {
  lstartMs,
  readProcessMarks,
  readShellGroups,
  SHELL_GROUPS_DIR,
  shellGroupsTrouble,
  writeShellGroupEnv,
} from './task-processes.js';

const STDIN_MAX = 4 * 1024 * 1024;

function readStdin(): string {
  const chunks: Buffer[] = [];
  let size = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let read = 0;
    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((error as NodeJS.ErrnoException).code === 'EOF') break;
      throw error;
    }
    if (read === 0) break;
    if (size < STDIN_MAX) chunks.push(Buffer.from(buffer.subarray(0, read)));
    size += read;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `ps` once, only when a kill is judged. */
function processTable(): ProcessEntry[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,tty=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const table: ProcessEntry[] = [];
    for (const line of out.split('\n')) {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}) (.*)$/.exec(
          line
        );
      if (match) {
        const start = lstartMs(match[5]);
        table.push({
          pid: Number(match[1]),
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          tty: match[4],
          ...(start !== undefined ? { start } : {}),
          command: match[6],
        });
      }
    }
    return table;
  } catch {
    return [];
  }
}

/**
 * The pids `pkill` / `killall` would signal, asked with the same matching: pgrep with pkill's
 * arguments, `killall -s` (shows, signals nothing). Exit 1 is "none"; anything else: unknown.
 */
export function namedMatches(tool: 'pkill' | 'killall', args: string[]): number[] | null {
  const [command, argv] = tool === 'pkill' ? ['pgrep', args] : ['killall', ['-s', ...args]];
  let out: string;
  try {
    out = execFileSync(command, argv, {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    return null;
  }
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    // pgrep: "123" or "123 name" (-l); killall -s: "kill -TERM 123".
    const match =
      tool === 'pkill' ? /^\s*(\d+)\b/.exec(line) : /^kill\s+-\S+\s+(\d+)\s*$/.exec(line);
    if (match) pids.push(Number(match[1]));
    else if (line.trim()) return null;
  }
  return pids;
}

function append(file: string | undefined, entry: GuardBlockEntry): void {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // The block itself still holds; only the record is lost.
  }
}

/**
 * A Bash call let run: for a recognised test/check command of a project that asked for it, the
 * same input with the command rewritten to print a summary (task-output.ts) and, for a heavy
 * check run, to take a check slot, as Claude reads it from a PreToolUse hook's stdout. Null
 * when there is nothing to change: every other command runs exactly as the agent wrote it.
 */
export function rewrittenBashInput(
  input: GuardInput,
  summarize?: GuardPolicy['summarize'],
  checkSlot?: GuardPolicy['checkSlot']
): string | null {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || !command.trim()) return null;
  let body = command;
  if (summarize) {
    try {
      body = rewriteForSummary(command, summarize) ?? command;
    } catch {
      body = command; // a summary that can't be set up never stops the command
    }
  }
  // A heavy check run takes a check slot first, around whatever it became above.
  if (checkSlot?.mode === 'wrap' && checkSlot.cli.length) {
    try {
      if (heavyCheck(command, checkSlot)) {
        body = slotCommand(body, command, checkSlot.cli, onlyCheck(command, checkSlot));
      }
    } catch {
      // a slot that can't be set up never stops the command
    }
  }
  if (body === command) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      // Only the input: no permission decision, so Claude's own permission rules still apply.
      updatedInput: { ...input.tool_input, command: body },
    },
  });
}

/**
 * Untether holds the agent's tool calls for a moment (task-guard.ts TOOL_HOLD_FILE: it is
 * merging the base into the task's branch): this call starts once the hold is lifted or over.
 */
function waitForToolHold(dir: string): void {
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const started = Date.now();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const now = Date.now();
    const until = toolHoldUntil(dir, read);
    // A clock set back, a file from another day: never longer than a hold can last.
    if (until <= now || now - started >= TOOL_HOLD_MAX_MS) return;
    Atomics.wait(nap, 0, 0, 50);
  }
}

/** Decides one hook call; returns the process exit code (2 = blocked). */
export function runGuardHook(
  policyPath: string | undefined,
  stdin: string,
  stderr: (text: string) => void = (text) => process.stderr.write(text),
  stdout: (text: string) => void = (text) => process.stdout.write(text)
): number {
  let policy: GuardPolicy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath ?? '', 'utf8')) as GuardPolicy;
  } catch {
    return 0; // no policy: not a guarded session
  }
  waitForToolHold(path.dirname(policyPath ?? ''));
  let input: GuardInput;
  try {
    input = JSON.parse(stdin) as GuardInput;
  } catch (error) {
    append(policy.blockedLog, {
      at: new Date().toISOString(),
      rule: 'guard-error',
      tool: '?',
      what: '',
      reason: `unreadable hook input: ${String(error).slice(0, 200)}`,
    });
    return 0;
  }
  const groupsDir = path.join(path.dirname(policyPath ?? ''), SHELL_GROUPS_DIR);
  const letRun = (): number => {
    // Codex does not read a rewritten input: its heavy check is refused once, with the
    // command that takes a slot (not a block of the guard's: nothing goes to its log).
    const slot = policy.checkSlot;
    const command = input.tool_input?.command;
    if (slot?.mode === 'ask' && slot.cli.length && typeof command === 'string') {
      let heavy = false;
      try {
        heavy = heavyCheck(command, slot);
      } catch {
        heavy = false;
      }
      if (heavy) {
        stderr(slotAskText(command, slot.cli));
        return 2;
      }
    }
    if (policy.recordShellGroups && input.tool_name === 'Bash') {
      let trouble: string | null = null;
      try {
        trouble = shellGroupsTrouble(groupsDir);
      } catch {
        trouble = null;
      }
      if (trouble) {
        append(policy.blockedLog, {
          at: new Date().toISOString(),
          rule: 'guard-error',
          tool: 'Bash',
          what: '',
          reason: trouble,
        });
      }
    }
    const updated =
      policy.summarize || policy.checkSlot
        ? rewrittenBashInput(input, policy.summarize, policy.checkSlot)
        : null;
    if (updated) stdout(`${updated}\n`);
    return 0;
  };
  try {
    const decision = decide(input, policy, {
      processes: processTable,
      selfPid: process.pid,
      marks: readProcessMarks,
      shellGroups: () => readShellGroups(groupsDir),
      matches: namedMatches,
      exists: (file) => fs.existsSync(file),
      realpath: (file) => fs.realpathSync(file),
    });
    if (!decision) return letRun();
    if (decision.uncertain) {
      append(policy.blockedLog, {
        at: new Date().toISOString(),
        rule: 'uncertain',
        tool: input.tool_name ?? '?',
        what: describeCall(input),
        reason: `${decision.rule}: ${decision.reason}`,
      });
      return letRun();
    }
    append(policy.blockedLog, {
      at: new Date().toISOString(),
      rule: decision.rule,
      tool: input.tool_name ?? '?',
      what: describeCall(input),
      reason: decision.reason,
    });
    stderr(
      `Blocked by Untether's task guard (${decision.rule}): ${decision.reason}\nDo not try to get around it another way; if the task really needs it, ask with \`ut task ask\`.\n`
    );
    return 2;
  } catch (error) {
    append(policy.blockedLog, {
      at: new Date().toISOString(),
      rule: 'guard-error',
      tool: input.tool_name ?? '?',
      what: describeCall(input),
      reason: `the guard failed and let the call run: ${String(error).slice(0, 200)}`,
    });
    return letRun();
  }
}

/**
 * Claude's SessionStart hook of a task (`--shell-env <policy.json>`): the shell-group record
 * goes into Claude's env file (CLAUDE_ENV_FILE). Always exit 0: a session starts without it,
 * and the task's log says so.
 */
export function runShellEnvHook(
  policyPath: string | undefined,
  envFile: string | undefined = process.env.CLAUDE_ENV_FILE
): number {
  let policy: GuardPolicy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath ?? '', 'utf8')) as GuardPolicy;
  } catch {
    return 0; // no policy: not a guarded session
  }
  if (!policy.recordShellGroups) return 0;
  const groupsDir = path.join(path.dirname(policyPath ?? ''), SHELL_GROUPS_DIR);
  let failure: string | undefined;
  if (!envFile) {
    failure = 'Claude gave its SessionStart hook no CLAUDE_ENV_FILE';
  } else {
    try {
      writeShellGroupEnv(envFile, groupsDir);
    } catch (error) {
      failure = `Claude's env file (${envFile}) could not be written: ${String(error).slice(0, 200)}`;
    }
  }
  if (failure) {
    append(policy.blockedLog, {
      at: new Date().toISOString(),
      rule: 'guard-error',
      tool: 'SessionStart',
      what: '',
      reason: `${failure}: what this task's shells start is not marked as its own`,
    });
  }
  return 0;
}

/**
 * The process: its arguments after the script (or after `guard-hook`): the policy file,
 * `--shell-env <policy file>` (Claude's SessionStart), or
 * `--summarize <log> <exit code> <kind> <label>` (task-output.ts).
 */
export function guardHookMain(args: string[]): never {
  if (args[0] === '--summarize') process.exit(summarizeMain(args.slice(1)));
  if (args[0] === '--shell-env') process.exit(runShellEnvHook(args[1]));
  const policyPath = args[0];
  let stdin = '';
  try {
    stdin = readStdin();
  } catch {
    // runGuardHook records unreadable input
  }
  process.exit(runGuardHook(policyPath, stdin));
}

// Run directly (a dev server's hook: node --import tsx task-guard-hook.ts <policy>). Not
// `require.main === module`: bundled into the app's binary, that is true for the whole server.
if (/[\\/]task-guard-hook\.ts$/.test(process.argv[1] ?? '')) guardHookMain(process.argv.slice(2));
