/**
 * Mac Sessions: what agents' tools make for their own tests is never listed.
 *
 * 2026-11-09: a task's Codex opened a test tmux on its own socket from its scratchpad, and the
 * phone showed it under "On this Mac" as a read-only session called "scratchpad". The list took
 * any tmux server of the user that was not a shield.
 *
 * The rule is about where a session came from, never what it is called:
 * - a tmux server on its own socket that was started by an agent's tool, a task or a test run:
 *   its starting environment carries one of AGENT_TOOL_ENV_MARKS, and all its sessions go. Not
 *   the default socket: whoever starts that server first marks it, and the user's later sessions
 *   live on it too;
 * - a session whose panes all run in an agent's temporary folder (<tmp>/claude-<uid>/…), on any
 *   server, and an agent running there on its own: there the folder is the only sign, because a
 *   new session on a running server does not carry its client's environment.
 *
 * A session or agent in an app's terminal (Terminal, iTerm, SSH…) is the user's whatever it
 * looks like: they are in front of it. UNTETHER_MAC_SESSIONS_ONLY_IN turns this off, as it does
 * the hidden folders: a QA server limited to a folder asked for what runs there.
 */
import { pathForms, TEST_RUN_ENV } from '../stray-tmux.js';
import { TASK_MARKER_VAR } from '../task-processes.js';

/**
 * What agents' shells carry and a user's terminal does not (Untether's own shells have
 * CLAUDECODE and the task marker removed: terminalSessionEnv). UNTETHER_SESSION_ID is not one:
 * a tmux typed in an Untether shell is the user's.
 */
export const AGENT_TOOL_ENV_MARKS = [
  TASK_MARKER_VAR,
  TEST_RUN_ENV,
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
];

export function hasAgentToolMark(env: ReadonlyMap<string, string>): boolean {
  return AGENT_TOOL_ENV_MARKS.some((name) => !!env.get(name));
}

/** Where agents keep temporary folders for this user, in every spelling (/tmp, /private/tmp). */
export function agentScratchRoots(
  uid: number,
  env: Record<string, string | undefined> = process.env
): string[] {
  const temporary = ['/tmp', env.TMPDIR, env.CLAUDE_CODE_TMPDIR].filter(
    (folder): folder is string => !!folder
  );
  return [
    ...new Set(
      temporary.flatMap((folder) => pathForms(`${folder.replace(/\/+$/, '')}/claude-${uid}`))
    ),
  ];
}

export function isAgentScratchFolder(folder: string | undefined, roots: string[]): boolean {
  return !!folder && roots.some((root) => folder === root || folder.startsWith(`${root}/`));
}

/** What the scan knows about a tmux session or an agent on its own. */
export interface AgentMadeFacts {
  /** An app's terminal shows it: a client of the session, or the agent's own terminal. */
  inAppTerminal: boolean;
  /** Its tmux server carries a mark in its starting environment. */
  serverMarked: boolean;
  /** That server is on the default socket. */
  defaultServer: boolean;
  /** Where each of its panes runs, or where the agent runs. */
  folders: Array<string | undefined>;
}

/** The one rule (see the top of this file). */
export function isAgentMade(facts: AgentMadeFacts, scratchRoots: string[]): boolean {
  if (facts.inAppTerminal) return false;
  if (facts.serverMarked && !facts.defaultServer) return true;
  return (
    facts.folders.length > 0 &&
    facts.folders.every((folder) => isAgentScratchFolder(folder, scratchRoots))
  );
}
