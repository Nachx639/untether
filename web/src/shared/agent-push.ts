/**
 * The agents' own pushes: "<agent>-waiting" (it needs you), "<agent>-finished" (its turn is
 * over) and "<agent>-replied" (Claude only: its reply is in, background agents go on). Sent by
 * the server (claude-status-notifier.ts), read by the service worker and the app. Codex has the
 * first two since 2026-11-10: every place that knew only Claude's asks here instead.
 */
import { AGENTS, type AgentId, isTaskAgent, TASK_AGENTS, type TaskAgent } from './agents.js';
/** The agents whose state Untether follows and pushes (Gemini's is not: no gemini-* push). */
export type PushAgent = TaskAgent;
export type AgentPushKind = 'waiting' | 'finished' | 'replied';

export const PUSH_AGENT_NAMES: Record<PushAgent, string> = Object.fromEntries(
  TASK_AGENTS.map((id) => [id, AGENTS[id].label])
) as Record<PushAgent, string>;

/** Whose push a type is and what it says, or undefined for any other push. */
export function agentPush(type: unknown): { agent: PushAgent; kind: AgentPushKind } | undefined {
  const match =
    typeof type === 'string' ? /^([a-z]+)-(waiting|finished|replied)$/.exec(type) : null;
  return match && isTaskAgent(match[1])
    ? { agent: match[1] as PushAgent, kind: match[2] as AgentPushKind }
    : undefined;
}

/** One notification per session and agent: a newer state replaces the older one. */
export function agentPushTag(agent: PushAgent, sessionId: string): string {
  return `untether-${agent}-${sessionId}`;
}

/** A notification of an agent's own status (not a task's, a bell's or a session's end). */
export function isAgentPushTag(tag: string | undefined): boolean {
  return !!tag && TASK_AGENTS.some((id) => tag.startsWith(`untether-${id}-`));
}

/**
 * A text written about Claude ("⏳ Claude te necesita · {where}") for another agent: the
 * translations name Claude, and the name is the only thing that differs. Only the first
 * mention is the agent ("No, and tell Claude…" further on is not ours to change).
 */
export function namedForAgent(text: string, agent: AgentId | undefined): string {
  return agent && agent !== 'claude' ? text.replace('Claude', AGENTS[agent].label) : text;
}
