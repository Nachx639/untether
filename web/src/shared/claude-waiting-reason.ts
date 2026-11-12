/**
 * What Claude Code says it waits for (its session file's `waitingFor`, in English) as one of
 * the reasons the UI translates. Dependency-free: the service worker uses it to translate a
 * push's body, the app to label rows, cards, headers and the answer sheet.
 *
 * Claude Code 2.1 writes "permission prompt", "input needed" (MCP elicitations included),
 * "dialog open", "goal proposal", "sandbox request" and "worker request"; its notification
 * hook names some of them "permission_prompt", "idle_prompt" or "elicitation_dialog". Anything
 * else is shown as Claude wrote it.
 */
export type ClaudeWaitingReason =
  | 'permission'
  | 'plan'
  | 'input'
  | 'dialog'
  | 'goal'
  | 'sandbox'
  | 'worker';

export const CLAUDE_WAITING_REASONS: ReadonlyMap<string, ClaudeWaitingReason> = new Map<
  string,
  ClaudeWaitingReason
>([
  ['permission prompt', 'permission'],
  ['plan approval', 'plan'],
  ['approve plan', 'plan'],
  ['user input', 'input'],
  ['input needed', 'input'],
  ['idle prompt', 'input'],
  ['elicitation dialog', 'input'],
  ['elicitation url dialog', 'input'],
  ['dialog open', 'dialog'],
  ['goal proposal', 'goal'],
  ['sandbox request', 'sandbox'],
  ['worker request', 'worker'],
]);

export function claudeWaitingReason(
  raw: string | null | undefined
): ClaudeWaitingReason | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return CLAUDE_WAITING_REASONS.get(key);
}
