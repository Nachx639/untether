/**
 * Qoder CLI's hooks (2026-11-12). qodercli 1.1.87 takes `--settings` with the hook envelope
 * Claude Code has (checked with a real `qodercli -p`: SessionStart, UserPromptSubmit, Stop and
 * SessionEnd arrived with session_id and transcript_path); its StopFailure names its kind in
 * error_type. Its state comes only from these events: no screen or process is read for it.
 *
 *   ensureQoderHookFiles   its own script and settings beside Claude's, same mailboxes.
 *   qoderHookEvent         one hook input as an agent event.
 *   qoderAgentStatus       its state in the session list's words (Session.agentStatus).
 *   qoderSightings         the same for the status notifier: its pushes, and the transitions
 *                          a Qoder task follows like a Claude one (server-core.ts).
 */
import * as path from 'node:path';
import type { SessionAgentStatus } from '../../shared/types.js';
import { type AgentEvent, type AgentSnapshot, claudeHookEvent } from './agent-events.js';
import { claudeHookFiles, ensureClaudeHookFiles } from './claude-hooks.js';
import type { AgentSighting } from './claude-status-notifier.js';
import { sessionStateOf } from './session-state-events.js';

export function ensureQoderHookFiles(untetherDir: string, log?: (message: string) => void) {
  const files = claudeHookFiles(untetherDir);
  return ensureClaudeHookFiles(
    {
      ...files,
      script: path.join(path.dirname(files.script), 'qoder-event.sh'),
      settings: path.join(path.dirname(files.settings), 'qoder-settings.json'),
    },
    log,
    'qoder'
  );
}

export function qoderHookEvent(input: Record<string, unknown>, at: number): AgentEvent | null {
  const adapted =
    input.hook_event_name === 'StopFailure'
      ? {
          ...input,
          error: input.error_type ?? 'unknown',
          error_details: input.error_details ?? input.error,
        }
      : input;
  const event = claudeHookEvent(adapted, at);
  return event ? { ...event, source: 'qoder-hook' } : null;
}

/** Undefined when the session's events say nothing, or are another agent's. */
export function qoderAgentStatus(
  snapshot: AgentSnapshot | undefined
): SessionAgentStatus | undefined {
  if (!snapshot || snapshot.source !== 'qoder-hook') return undefined;
  const seen = sessionStateOf(snapshot.state);
  if (!seen) return undefined;
  return {
    agent: 'qoder',
    status: seen.state,
    since: snapshot.since,
    ...(seen.state === 'waiting' && snapshot.asking ? { waitingFor: snapshot.asking } : {}),
    ...(snapshot.state === 'halted' && snapshot.halt ? { halted: snapshot.halt.kind } : {}),
  };
}

/** A reply or an error as one line of a push (Web Push payloads are small). */
const pushLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The Qoder sessions for the status notifier (ClaudeStatusNotifier `readAgents`): each one's
 * state in Claude's words, its last message as the "finished" push's text. A Qoder whose hooks
 * have said nothing yet is not seen at all: its SessionStart is its first look.
 */
export function qoderSightings(
  sessions: ReadonlyArray<{ id: string }>,
  deps: {
    /** AgentEventService.snapshot. */
    snapshot: (sessionId: string) => AgentSnapshot | undefined;
    /** The conversation's title, for the push's "where". */
    title?: (sessionId: string) => string | undefined;
  }
): Map<string, AgentSighting> {
  const seen = new Map<string, AgentSighting>();
  for (const { id } of sessions) {
    const snapshot = deps.snapshot(id);
    const status = qoderAgentStatus(snapshot);
    if (!snapshot || !status) continue;
    const said = snapshot.finalMessage ?? snapshot.halt?.message;
    let title: string | undefined;
    try {
      title = deps.title?.(id);
    } catch {
      // The push names the session instead.
    }
    seen.set(id, {
      agent: 'qoder',
      program: snapshot.conversationId ?? 'qoder',
      status: {
        status: status.status,
        ...(status.since !== undefined ? { since: status.since } : {}),
        ...(status.waitingFor ? { waitingFor: status.waitingFor.slice(0, 200) } : {}),
        ...(title ? { title } : {}),
        ...(said ? { preview: { role: 'assistant' as const, text: pushLine(said) } } : {}),
        ...(snapshot.conversationId ? { sessionId: snapshot.conversationId } : {}),
      },
    });
  }
  return seen;
}
