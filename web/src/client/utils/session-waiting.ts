/**
 * What a session's agent waits on, whoever the agent is (2026-11-10). Claude says it in
 * `claudeStatus`; Codex in `agentStatus`, its menu read off the screen (approval, trust this
 * folder, update). The list's quick answers, «Te necesita» and the answer sheet read it here.
 */
import type { Session } from '../../shared/types.js';

type WaitingSession = Pick<Session, 'claudeStatus' | 'agentStatus'>;

export type WaitingChoices = NonNullable<NonNullable<Session['claudeStatus']>['choices']>;

/** The agent's status that says it waits, or undefined while it does not. */
function waitingStatus(session: WaitingSession) {
  const claude = session.claudeStatus;
  if (claude) return claude.status === 'waiting' ? claude : undefined;
  return session.agentStatus?.status === 'waiting' ? session.agentStatus : undefined;
}

/** The menu a waiting session shows, with its options. */
export function waitingChoices(session: WaitingSession): WaitingChoices | undefined {
  return waitingStatus(session)?.choices;
}

/** What it says it waits for ("permission prompt"), when it says. */
export function waitingFor(session: WaitingSession): string | undefined {
  return waitingStatus(session)?.waitingFor;
}

/** Since when it waits (epoch ms). */
export function waitingSince(session: WaitingSession): number | undefined {
  return waitingStatus(session)?.since;
}

/** The agent that waits there, for texts that name it. */
export function waitingAgent(session: WaitingSession): 'claude' | 'codex' | undefined {
  return session.claudeStatus ? 'claude' : session.agentStatus?.agent;
}
