/** `ut project tell` and `messages`: messages between the orchestrators of projects. */

import { type AgentMessage, messageLine } from '../../shared/agent-messages.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project tell <project> "text" | - [--reply-to ID] [--no-reply] [--user-decision "words"]
                 (an orchestrator asks another project's orchestrator; it prints the
                  message's id. --reply-to answers a message it got, which closes it;
                  --no-reply is a notice that needs no answer; --user-decision has Untether
                  attach, word for word, the turn of the user in the sender's conversation
                  that holds those words, with its time)
  ut project messages [--all] [--repo DIR] [--json]
                 (messages between agents and how far each got: queued, delivered, read,
                  answered; open ones only unless --all. An orchestrator sees its project's)`;

/** `ut project tell`: the message's id and how its answer comes back. */
function formatTold(data: Record<string, unknown>): string {
  const to = String(data.to);
  const id = String(data.id);
  const lines = [
    data.replyTo
      ? `→ message ${id} to the orchestrator of ${to}, in reply to ${String(data.replyTo)} (answered now)`
      : `→ message ${id} to the orchestrator of ${to}`,
  ];
  const decision = data.userDecision as { quote?: string; at?: string } | undefined;
  if (decision?.quote) {
    lines.push(`Untether attached the user's own words (${decision.at}): ${decision.quote}`);
  }
  lines.push(
    data.expectsReply === false
      ? 'It asks for no answer; `ut project messages --all` shows when it was read.'
      : `Its answer comes as a message "in reply to ${id}"; \`ut project messages\` shows how far it got.`
  );
  return lines.join('\n');
}

/** `ut project messages`: one line per message, oldest first. */
function formatMessages(data: Record<string, unknown>): string {
  const messages = (data.messages ?? []) as AgentMessage[];
  const now = typeof data.now === 'number' ? data.now : Date.now();
  if (!messages.length)
    return 'No messages between agents here (open ones; --all shows closed ones too).';
  return messages.map((message) => messageLine(message, now)).join('\n');
}

export const projectMessages: CommandFamily = {
  usage: USAGE,
  commands: {
    'project tell': {
      options: { value: ['reply-to', 'user-decision'], switches: ['no-reply'] },
      build: async ({ flags, positional, json, text }) => {
        const [to, ...words] = positional;
        if (!to) throw new UsageError('ut project tell needs a project (its folder name)');
        return {
          op: 'project-tell',
          args: {
            to,
            text: await text(words, 'what to tell'),
            ...(typeof flags['reply-to'] === 'string' ? { replyTo: flags['reply-to'] } : {}),
            ...(flags['no-reply'] === true ? { noReply: true } : {}),
            ...(typeof flags['user-decision'] === 'string'
              ? { userDecision: flags['user-decision'] }
              : {}),
          },
          json,
        };
      },
    },
    'project messages': {
      options: { value: ['repo'], switches: ['all'] },
      build: ({ flags, json, repo }) => {
        return {
          op: 'project-messages',
          args: { repo, ...(flags.all === true ? { all: true } : {}) },
          json,
        };
      },
    },
  },
  print: {
    'project-tell': ({ data, deps }) => {
      deps.out(formatTold(data));
      return undefined;
    },
    'project-messages': ({ data, deps }) => {
      deps.out(formatMessages(data));
      return undefined;
    },
  },
};
