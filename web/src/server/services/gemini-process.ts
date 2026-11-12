/**
 * Gemini CLI started inside a shell session: `gemini` typed at a zsh prompt is not the
 * session's command, so it is found in the session's process tree (like Codex). Its working
 * directory and start time then pick its chat file.
 *
 * The npm package runs as `node …/bin/gemini`, which relaunches itself as
 * `node --max-old-space-size=… …/@google/gemini-cli/dist/index.js`; either one is enough
 * (from the package layout of @google/gemini-cli, 2026-10-02).
 */

import type { ProcessTable } from './claude-chat.js';
import {
  type CodexProcessDeps,
  findAgentPid,
  findAgentProcess,
  processClaimId,
  type SessionLike,
} from './codex-process.js';
import { forgetGeminiSession, type GeminiSessionRef, isGeminiCommand } from './gemini-chat.js';

/** Gemini subcommands and flags that don't open the TUI (no chat to show for them). */
const NON_INTERACTIVE = new Set([
  'mcp',
  'extensions',
  'extension',
  'skills',
  'skill',
  'hooks',
  'hook',
  '-p',
  '--prompt',
  '-v',
  '--version',
  '-h',
  '--help',
  '--list-extensions',
  '-l',
  '--list-sessions',
  '--delete-session',
]);

/** Gemini options that take a separate value (`-m gemini-2.5-pro`). */
const OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--model',
  '-i',
  '--prompt-interactive',
  '-e',
  '--extensions',
  '-r',
  '--resume',
  '-o',
  '--output-format',
  '--approval-mode',
  '--include-directories',
  '--allowed-tools',
  '--allowed-mcp-server-names',
  '--policy',
  '--proxy',
]);

const base = (word: string | undefined) => (word ?? '').split('/').pop()?.toLowerCase() ?? '';

/** Whether Gemini's arguments open the interactive TUI. */
function isInteractive(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const flag = word.split('=')[0];
    if (NON_INTERACTIVE.has(flag)) return false;
    if (OPTIONS_WITH_VALUE.has(word)) {
      i++;
      continue;
    }
    // The first plain word is a subcommand or the prompt; nothing after it matters.
    if (!word.startsWith('-')) return true;
  }
  return true;
}

/** Whether a `ps` command line is an interactive Gemini CLI. */
export function isGeminiProcessArgs(args: string): boolean {
  const words = args.trim().split(/\s+/);
  let rest: string[];
  if (base(words[0]) === 'gemini') {
    rest = words.slice(1);
  } else if (/^(node\d*|bun)$/.test(base(words[0]))) {
    const scriptIndex = words.findIndex((word, i) => i > 0 && !word.startsWith('-'));
    if (scriptIndex < 0) return false;
    const script = words[scriptIndex];
    const isGemini =
      base(script) === 'gemini' ||
      (/\.m?js$/.test(script) && script.includes('/@google/gemini-cli/'));
    if (!isGemini) return false;
    rest = words.slice(scriptIndex + 1);
  } else {
    return false;
  }
  return isInteractive(rest);
}

/** The first Gemini process under `rootPid` (breadth first: the launcher before its child). */
export function findGeminiPid(table: ProcessTable, rootPid: number): number | undefined {
  return findAgentPid(table, rootPid, isGeminiProcessArgs);
}

/**
 * What to match a session's Gemini chat with: the session itself when it was started with
 * `gemini`, else the Gemini process running inside it (a shell where `gemini` was typed, or the
 * pane of an attached tmux session).
 */
export async function geminiSessionRef(
  session: SessionLike,
  deps?: CodexProcessDeps
): Promise<GeminiSessionRef | null> {
  if (!session.multiplexer && isGeminiCommand(session.command)) return session;
  if (!session.pid || session.status !== 'running') return null;
  const gemini = await findAgentProcess(session.pid, isGeminiProcessArgs, deps);
  if (!gemini) return null;
  return {
    id: processClaimId(gemini, forgetGeminiSession),
    workingDir: gemini.cwd,
    startedAt: new Date(gemini.startedAt).toISOString(),
  };
}
