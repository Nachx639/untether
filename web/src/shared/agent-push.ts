/**
 * The agents' own pushes: "<agent>-waiting" (it needs you), "<agent>-finished" (its turn is
 * over) and "<agent>-replied" (Claude only: its reply is in, background agents go on). Sent by
 * the server (claude-status-notifier.ts), read by the service worker and the app. Codex has the
 * first two since 2026-11-10: every place that knew only Claude's asks here instead.
 */
export type PushAgent = 'claude' | 'codex';
export type AgentPushKind = 'waiting' | 'finished' | 'replied';

export const PUSH_AGENT_NAMES: Record<PushAgent, string> = { claude: 'Claude', codex: 'Codex' };

/** Whose push a type is and what it says, or undefined for any other push. */
export function agentPush(type: unknown): { agent: PushAgent; kind: AgentPushKind } | undefined {
  const match =
    typeof type === 'string' ? /^(claude|codex)-(waiting|finished|replied)$/.exec(type) : null;
  return match ? { agent: match[1] as PushAgent, kind: match[2] as AgentPushKind } : undefined;
}

/** One notification per session and agent: a newer state replaces the older one. */
export function agentPushTag(agent: PushAgent, sessionId: string): string {
  return `untether-${agent}-${sessionId}`;
}

/** A notification of an agent's own status (not a task's, a bell's or a session's end). */
export function isAgentPushTag(tag: string | undefined): boolean {
  return !!tag && /^untether-(claude|codex)-/.test(tag);
}

/**
 * A text written about Claude ("⏳ Claude te necesita · {where}") for another agent: the
 * translations name Claude, and the name is the only thing that differs. Only the first
 * mention is the agent ("No, and tell Claude…" further on is not ours to change).
 */
export function namedForAgent(text: string, agent: PushAgent | undefined): string {
  return agent && agent !== 'claude' ? text.replace('Claude', PUSH_AGENT_NAMES[agent]) : text;
}
