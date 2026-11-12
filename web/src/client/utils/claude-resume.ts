/**
 * Continue a Claude Code conversation (`claude --resume <id>`) or a Codex thread
 * (`codex resume <id>`) in a new Untether session. Shared by the exited-session row, the
 * session view and the conversation history. A conversation running right now outside Untether
 * (a Terminal tab, a tmux pane) is never resumed: the server refuses it, which would make a
 * second writer of it.
 */
import type { MacLiveConversation } from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import { t } from '../i18n/index.js';
import { macAppName } from './mac-sessions.js';

export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
const APP_PREFERENCES_KEY = 'untether_app_preferences';
const PHONE_STARTS_KEY = 'ut-phone-recent-starts';

export function claudeResumeCommand(claudeSessionId: string, skipPermissions: boolean): string[] {
  return [
    'claude',
    '--resume',
    claudeSessionId,
    ...(skipPermissions ? [SKIP_PERMISSIONS_FLAG] : []),
  ];
}

/** Whether a session's own command ran Claude without permission prompts. */
export function commandSkipsPermissions(command: string[] | undefined): boolean {
  return Array.isArray(command) && command.join(' ').includes(SKIP_PERMISSIONS_FLAG);
}

/**
 * How you usually start Claude, for a conversation with no session of its own left: the newest
 * Claude session's command, else the tool the phone's "new session" flow last started.
 */
export function userSkipsPermissions(sessions: Session[]): boolean {
  const claude = sessions
    .filter((session) => session.command?.join(' ').includes('claude'))
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];
  if (claude) return commandSkipsPermissions(claude.command);
  try {
    const tool = JSON.parse(localStorage.getItem(PHONE_STARTS_KEY) || '{}')?.tool;
    return typeof tool === 'string' && tool.includes(SKIP_PERMISSIONS_FLAG);
  } catch {
    return false;
  }
}

/** A running session already showing this conversation: open it rather than a second claude. */
export function findLiveClaudeSession(
  sessions: Session[],
  claudeSessionId: string
): Session | undefined {
  return sessions.find(
    (session) => session.status !== 'exited' && session.claudeSessionId === claudeSessionId
  );
}

/** Open the next session in chat mode on phones (the session view restores this preference). */
export function preferChatMode() {
  try {
    const preferences = JSON.parse(localStorage.getItem(APP_PREFERENCES_KEY) || '{}');
    localStorage.setItem(APP_PREFERENCES_KEY, JSON.stringify({ ...preferences, chatMode: true }));
  } catch {
    // Blocked storage: the session opens in whatever view it would have anyway.
  }
}

/**
 * Where a conversation runs right now outside Untether (`live` in the history list, and in the
 * server's refusal to resume it), as the server sends it.
 */
export type ClaudeLiveOutside = MacLiveConversation;

/** Why it can't be continued here: where it runs, and what to do instead. */
export function liveOutsideText(live: ClaudeLiveOutside): string {
  if (live.where === 'tmux') return t('history.liveInTmux');
  return live.app
    ? t('history.liveElsewhere', { app: macAppName(live.app) })
    : t('history.liveOutside');
}

/** The server refused to resume: the conversation runs outside Untether right now. */
export class ClaudeLiveOutsideError extends Error {
  constructor(readonly live: ClaudeLiveOutside) {
    super(liveOutsideText(live));
    this.name = 'ClaudeLiveOutsideError';
  }
}

function liveOutsideOf(value: unknown): ClaudeLiveOutside | null {
  const live = value as Partial<ClaudeLiveOutside> | null | undefined;
  if (live?.where !== 'tmux' && live?.where !== 'terminal') return null;
  return live as ClaudeLiveOutside;
}

interface ResumeOptions {
  workingDir: string;
  name?: string;
  authHeader?: Record<string, string>;
  /** Run it in a shielded session (survives Untether restarts). */
  shielded?: boolean;
}

/**
 * Start `claude --resume` in the conversation's folder; resolves with the new session's id.
 * Throws a ClaudeLiveOutsideError when the conversation runs outside Untether right now.
 */
export function resumeClaudeConversation(
  options: ResumeOptions & { claudeSessionId: string; skipPermissions: boolean }
): Promise<{ sessionId: string }> {
  return startResume(
    claudeResumeCommand(options.claudeSessionId, options.skipPermissions),
    options
  );
}

/**
 * What an ended session goes on with: its Claude conversation, else its Codex thread, when the
 * server says it can be resumed (`claudeResumable`, `codexResumable`); null: nothing to resume.
 */
export function resumableAgent(
  session: Pick<
    Session,
    'status' | 'claudeSessionId' | 'claudeResumable' | 'codexThreadId' | 'codexResumable'
  >
): 'claude' | 'codex' | null {
  if (session.status !== 'exited') return null;
  if (session.claudeSessionId && session.claudeResumable === true) return 'claude';
  if (session.codexThreadId && session.codexResumable === true) return 'codex';
  return null;
}

/**
 * "Resume" on an ended session (resumableAgent): `claude --resume <id>` or `codex resume <id>`
 * in its folder, shielded again when it was. For Codex the server adds the options the ended
 * session had (model, sandbox…). Throws a ClaudeLiveOutsideError when the conversation is open
 * somewhere else right now.
 */
export function resumeSession(
  session: Session,
  authHeader?: Record<string, string>
): Promise<{ sessionId: string }> {
  const agent = resumableAgent(session);
  if (!agent) return Promise.reject(new Error('Nothing to resume'));
  const options: ResumeOptions = {
    workingDir: session.workingDir,
    name: session.name,
    authHeader,
    // A shielded session lost to a reboot comes back shielded.
    shielded: session.shielded,
  };
  if (agent === 'codex') {
    return startResume(['codex', 'resume', session.codexThreadId as string], options);
  }
  return resumeClaudeConversation({
    ...options,
    claudeSessionId: session.claudeSessionId as string,
    skipPermissions: commandSkipsPermissions(session.command),
  });
}

async function startResume(
  command: string[],
  options: ResumeOptions
): Promise<{ sessionId: string }> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.authHeader },
    body: JSON.stringify({
      command,
      workingDir: options.workingDir,
      name: options.name,
      spawn_terminal: false,
      ...(options.shielded ? { shielded: true } : {}),
    }),
  });
  const result = await response.json().catch(() => ({}));
  const live = response.status === 409 ? liveOutsideOf(result.live) : null;
  if (live) throw new ClaudeLiveOutsideError(live);
  if (!response.ok || !result.sessionId) {
    throw new Error(result.error || response.statusText || `HTTP ${response.status}`);
  }
  return result;
}
