/**
 * Typing text into an orchestrator's Claude (2026-10-20). The orchestrator's brief, goals and
 * task events used to go through the "Ask Claude" first-message path, which gives up after a
 * minute of Claude not being idle and reports nothing back: briefs of adopted sessions that
 * were busy never arrived, and events were dropped as if typed ("not delivered: Claude never
 * became ready", eleven times in a day). Here the wait has no time limit while the session runs
 * and the caller still wants the text, and the result says whether it was typed.
 */
import type { ScreenChoices } from '../../shared/claude-screen.js';
import type { SessionInput } from '../../shared/types.js';
import { typeWhenClaudeReady } from './claude-initial-input.js';

export interface OrchestratorDeliveryDeps {
  /** 'running' while the session lives. */
  sessionStatus(sessionId: string): string | undefined;
  /** Claude Code's status in the session ('idle', 'busy', 'waiting'), if Claude runs. */
  claudeStatus(sessionId: string): Promise<string | undefined>;
  /** The menu or dialog on the session's screen, null when none. */
  readChoices(sessionId: string): Promise<ScreenChoices | null>;
  sendInput(sessionId: string, input: SessionInput): void;
  /**
   * Answers Claude Code's trust dialog when it is the one on screen (the tasks' own,
   * sessions.ts answerTrustDialog); true when it did.
   */
  answerTrustDialog?(sessionId: string): Promise<boolean>;
  /**
   * Why nothing may be typed now because of the user's own input in the session
   * (user-input-guard.ts: writing, a draft, a message just sent), or null.
   */
  userHold?(sessionId: string): Promise<string | null>;
  log?: (message: string) => void;
}

export type OrchestratorDeliver = (
  sessionId: string,
  text: string,
  options?: {
    keepWaiting?: () => boolean;
    /** Untether started the session in the project's folder: its trust dialog is answered. */
    trustFolder?: boolean;
  }
) => Promise<boolean>;

/** Polls every 2 s (each poll reads the process table): an orchestrator may stay busy long. */
const POLL_MS = 2000;

export function createOrchestratorDelivery(deps: OrchestratorDeliveryDeps): OrchestratorDeliver {
  return (sessionId, text, options = {}) => {
    const running = () => deps.sessionStatus(sessionId) === 'running';
    // Only the trust dialog, and only at the start: any other menu waits for the user.
    const answerDialog =
      options.trustFolder && deps.answerTrustDialog
        ? () => deps.answerTrustDialog?.(sessionId) ?? Promise.resolve(false)
        : undefined;
    return typeWhenClaudeReady(
      text,
      {
        isRunning: running,
        claudeStatus: () => deps.claudeStatus(sessionId),
        dialogOnScreen: async () => (await deps.readChoices(sessionId)) !== null,
        answerDialog,
        // 2026-11-10: another agent's reply was typed onto a message of the user's. One
        // typing at a time per session, and never while the user's own input is in the way.
        lockKey: sessionId,
        ...(deps.userHold
          ? {
              userHold: () => (deps.userHold as NonNullable<typeof deps.userHold>)(sessionId),
              onHold: (why: string) =>
                deps.log?.(`orchestrator input for session ${sessionId} waits: ${why}`),
            }
          : {}),
        send: (input) => {
          if (running()) deps.sendInput(sessionId, input);
        },
        onGiveUp: (reason) =>
          deps.log?.(`orchestrator input for session ${sessionId} not typed: ${reason}`),
      },
      {
        pollMs: POLL_MS,
        keepWaiting: options.keepWaiting ?? (() => true),
      }
    ).catch((error) => {
      deps.log?.(`orchestrator input for session ${sessionId} failed: ${error}`);
      return false;
    });
  };
}
