/**
 * Which Claude Code conversation a session runs, so an exited session can offer "Resume Claude".
 *
 * The list poll (GET /sessions) records it from Claude's own `sessions/<pid>.json` while
 * somebody looks at the list. A session started in a Mac Terminal window (`ut claude ...`, a
 * `fwd_` session) or one nobody looked at while it ran could exit without it (user report:
 * a forwarded `claude --resume <id>` showed no resume button once it exited). Two fallbacks:
 * the command's own `--resume <id>`, read whenever a session is read, and a background look at
 * running sessions that still miss it.
 */
import * as path from 'path';
import type { Session } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import { readClaudeSessionIds } from './claude-chat.js';

const logger = createLogger('claude-session-id');

/** The conversation `claude --resume <id>` (`-r <id>`, `--resume=<id>`) continues, if any. */
export function claudeResumeTarget(command: readonly unknown[] | undefined): string | null {
  if (!Array.isArray(command)) return null;
  if (typeof command[0] !== 'string' || path.basename(command[0]) !== 'claude') return null;
  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    if (typeof arg !== 'string') return null;
    if (arg.startsWith('--resume=')) return arg.slice('--resume='.length) || null;
    const next = command[i + 1];
    if ((arg === '--resume' || arg === '-r') && typeof next === 'string' && next) {
      return next.startsWith('-') ? null : next;
    }
  }
  return null;
}

/**
 * The conversation id a session lacks but its command names (`claude --resume <id>`), or null
 * when it has one already or its command names none.
 */
export function missingClaudeSessionId(
  session: Pick<Session, 'command' | 'claudeSessionId'>
): string | null {
  if (session.claudeSessionId) return null;
  return claudeResumeTarget(session.command);
}

export interface ClaudeSessionIdRecorderOptions {
  listSessions: () => Session[];
  /** The pid under which Claude runs (a shielded session's program inside tmux). */
  rootPid: (session: Session) => number | undefined;
  save: (sessionId: string, claudeSessionId: string) => void;
  readIds?: (rootPids: number[]) => Promise<Map<number, string>>;
  intervalMs?: number;
}

/**
 * One look: running sessions get the conversation Claude reports when it differs from the
 * recorded one (none yet, or a `/clear` or `/resume` inside Claude since), like the list poll.
 */
export async function recordMissingClaudeSessionIds(
  options: ClaudeSessionIdRecorderOptions
): Promise<number> {
  const readIds = options.readIds ?? ((pids: number[]) => readClaudeSessionIds(pids));
  const targets = new Map<number, Session>();
  for (const session of options.listSessions()) {
    if (session.status !== 'running') continue;
    const pid = options.rootPid(session);
    if (pid) targets.set(pid, session);
  }
  if (targets.size === 0) return 0;
  const ids = await readIds([...targets.keys()]);
  let saved = 0;
  for (const [pid, claudeSessionId] of ids) {
    const session = targets.get(pid);
    if (!session || session.claudeSessionId === claudeSessionId) continue;
    try {
      options.save(session.id, claudeSessionId);
      saved++;
    } catch (error) {
      logger.debug(`could not save the Claude conversation of ${session.id}: ${error}`);
    }
  }
  return saved;
}

/** Looks every `intervalMs` (default 20 s); returns the stop function. */
export function startClaudeSessionIdRecorder(options: ClaudeSessionIdRecorderOptions): () => void {
  let running = false;
  const timer = every(
    'claude session id',
    () => {
      if (running) return;
      running = true;
      recordMissingClaudeSessionIds(options)
        .catch((error) => logger.debug(`Claude conversation look failed: ${error}`))
        .finally(() => {
          running = false;
        });
    },
    options.intervalMs ?? 20_000
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
