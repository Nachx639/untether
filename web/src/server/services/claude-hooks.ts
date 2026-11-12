/**
 * Claude Code hooks for the sessions Untether starts (agent-events.ts tells what they are for).
 *
 * Only those sessions get them, through `--settings <Untether's own settings file>` on the
 * command Untether spawns: the user's ~/.claude/settings.json, a project's .claude/settings*.json
 * and any other Claude run stay as they are (hooks of every source add up in Claude Code, so
 * the user's own hooks still run). A command that already names `--settings` is left alone
 * (a task's own settings, which carry these hooks too, count as hooked).
 *
 * Each hook runs a small POSIX sh script that drops the hook's input (the JSON Claude passes on
 * stdin, its first 64 KB) into the session's mailbox, `<events dir>/<UNTETHER_SESSION_ID>/`,
 * as one file per event, and always exits 0 with no output: it can never block, alter or slow
 * Claude beyond a few milliseconds, and an event written while the server restarts is read
 * when it is back (agent-event-service.ts). Nothing is sent anywhere else.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The hook events Untether listens to (Claude Code 2.1.316 names them so). */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;

/** Events whose matcher is a tool name: '*' takes every tool. */
const TOOL_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

/** Seconds Claude gives a hook; the script takes milliseconds. */
const HOOK_TIMEOUT_S = 5;

/** The hook input kept per event: tool inputs and outputs can be megabytes. */
export const HOOK_INPUT_MAX_BYTES = 64 * 1024;

export interface ClaudeHookFiles {
  /** The folder of per-session mailboxes. */
  eventsDir: string;
  script: string;
  settings: string;
}

/** Where they live: ~/.untether/agent-hooks (the script, the settings) and agent-events. */
export function claudeHookFiles(
  untetherDir = path.join(os.homedir(), '.untether')
): ClaudeHookFiles {
  const hooksDir = path.join(untetherDir, 'agent-hooks');
  return {
    eventsDir: path.join(untetherDir, 'agent-events'),
    script: path.join(hooksDir, 'claude-event.sh'),
    settings: path.join(hooksDir, 'claude-settings.json'),
  };
}

/** A word for sh, in single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The hook script: one event (named by $1) into the mailbox of $UNTETHER_SESSION_ID. */
export function hookScript(eventsDir: string): string {
  return `#!/bin/sh
# Untether: one Claude Code hook event into this session's mailbox (claude-hooks.ts).
# Never fails, never prints: Claude goes on exactly as without it.
id="\${UNTETHER_SESSION_ID:-}"
event="\${1:-}"
case "$id" in ''|*[!A-Za-z0-9_-]*) cat >/dev/null 2>&1; exit 0 ;; esac
case "$event" in ''|*[!A-Za-z]*) cat >/dev/null 2>&1; exit 0 ;; esac
dir=${shellQuote(eventsDir)}/"$id"
umask 077
if mkdir -p "$dir" 2>/dev/null; then
  tmp="$dir/.$$.tmp"
  { head -c ${HOOK_INPUT_MAX_BYTES} >"$tmp"; cat >/dev/null; } 2>/dev/null
  mv -f "$tmp" "$dir/$(date +%s)-$$-$event.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
  cat >/dev/null 2>&1
fi
exit 0
`;
}

/** The settings Claude is started with: only hooks, one per event, all to the script. */
export function hookSettings(script: string): object {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const command = {
      type: 'command',
      command: `${shellQuote(script)} ${event}`,
      timeout: HOOK_TIMEOUT_S,
    };
    hooks[event] = [
      TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [command] } : { hooks: [command] },
    ];
  }
  return { hooks };
}

function writeIfChanged(file: string, content: string, mode: number): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      fs.chmodSync(file, mode);
      return;
    }
  } catch {
    // missing: written below
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/**
 * Writes the script and the settings (again when they differ: an edit or a deleted file heals
 * on the next session start). Returns the files, or null when they can't be written: then no
 * session gets `--settings` (a missing settings file would stop Claude from starting).
 */
export function ensureClaudeHookFiles(
  files: ClaudeHookFiles = claudeHookFiles(),
  log?: (message: string) => void
): ClaudeHookFiles | null {
  try {
    fs.mkdirSync(path.dirname(files.script), { recursive: true, mode: 0o700 });
    fs.mkdirSync(files.eventsDir, { recursive: true, mode: 0o700 });
    writeIfChanged(files.script, hookScript(files.eventsDir), 0o700);
    writeIfChanged(
      files.settings,
      `${JSON.stringify(hookSettings(files.script), null, 2)}\n`,
      0o600
    );
    return files;
  } catch (error) {
    log?.(`[agent-state] Claude hooks could not be written, sessions start without them: ${error}`);
    return null;
  }
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const CLAUDE_WORD = /^(\s*(?:exec\s+)?(?:\S*\/)?claude)(?=\s|$)/;

function namesSettings(args: string[]): boolean {
  return args.some((arg) => arg === '--settings' || arg.startsWith('--settings='));
}

/**
 * The command with Untether's hook settings when it starts Claude Code: `claude …` (any path
 * to it), or a shell running `claude …` (`zsh -ilc 'claude …'`, how an alias resolves). Any
 * other command, or one naming its own `--settings`, comes back as it was.
 */
export function withClaudeHooks(command: string[], settingsPath: string): string[] {
  if (command.length === 0) return command;
  if (path.basename(command[0]) === 'claude') {
    const args = command.slice(1);
    const own = args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--'));
    if (namesSettings(own)) {
      // A task's settings (task-guard-setup.ts: these hooks plus its command guard) live under
      // the same folder: hooked all the same, so a copy (the session notes agentHooks).
      const value = own[own.indexOf('--settings') + 1] ?? '';
      return value.startsWith(`${path.dirname(settingsPath)}${path.sep}`) ? [...command] : command;
    }
    return [command[0], '--settings', settingsPath, ...args];
  }
  if (!SHELLS.has(path.basename(command[0]))) return command;
  // The script follows a flag cluster with c in it (-c, -lc, -ilc).
  const flag = command.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
  if (flag < 0 || flag + 1 >= command.length) return command;
  const script = command[flag + 1];
  const match = CLAUDE_WORD.exec(script);
  // Its own --settings in the script or in the words passed to it (`claude "$@"` -- …).
  if (!match || /(?:^|\s)--settings(?:[\s=]|$)/.test(script)) return command;
  if (namesSettings(command.slice(flag + 2))) return command;
  const injected = `${match[1]} --settings ${shellQuote(settingsPath)}${script.slice(match[1].length)}`;
  return [...command.slice(0, flag + 1), injected, ...command.slice(flag + 2)];
}
