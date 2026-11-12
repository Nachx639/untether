import type { Session } from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { createLogger } from './logger.js';

const logger = createLogger('ai-sessions');

const AI_ASSISTANTS = ['claude', 'gemini', 'openhands', 'aider', 'codex', 'auggie'];

/**
 * Check if a session is an AI assistant based on command
 * Uses precise matching to avoid false positives
 */
export function isAIAssistantSession(session: Session): boolean {
  const commands = Array.isArray(session.command) ? session.command : [session.command];
  return commands.some((cmd) => {
    const executableName = cmd?.split('/').pop()?.toLowerCase() || '';
    // Match exact executable names or at word boundaries
    return AI_ASSISTANTS.some(
      (ai) =>
        executableName === ai ||
        executableName.startsWith(`${ai}.`) || // e.g., claude.exe
        executableName.startsWith(`${ai}-wrapper`) // e.g., claude-wrapper
    );
  });
}

/**
 * Send a prompt to an AI assistant session to update terminal title
 */
export async function sendAIPrompt(sessionId: string, authClient: AuthClient): Promise<void> {
  const prompt =
    'IMPORTANT: You MUST use the \'ut title\' command to update the terminal title. DO NOT use terminal escape sequences. Run: ut title "Brief description of current task"';
  // The route takes `text` or `key`, never both (2026-11-10: this sent `{ data }`, the server
  // answered 400 and the button never typed anything). Enter goes a moment later, like the
  // chat composer, so it isn't taken as part of a paste.
  const post = async (body: { text: string } | { key: string }) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: HttpMethod.POST,
      headers: {
        'Content-Type': 'application/json',
        ...authClient.getAuthHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorData = await response.text();
      logger.error('Failed to send AI prompt', { sessionId, status: response.status, errorData });
      throw new Error(`Failed to send prompt: ${response.status} - ${errorData}`);
    }
  };
  await post({ text: prompt });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await post({ key: 'enter' });

  logger.log(`AI prompt sent to session ${sessionId}`);
}
