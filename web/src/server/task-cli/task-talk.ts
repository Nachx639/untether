/** `ut task send` and `answer`: words for a task's agent. */

import { printTask } from './print.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut task send <id> "text" | - [--reply-to ID]    (prints the message id; the task's next
                                                report answers it)
  ut task answer <id> approve | deny | <number> | --text "what to do instead"
                                               (a task stopped on a prompt of its agent's own,
                                                a permission or a question: 'ut task status'
                                                shows what it asks and its options; --text
                                                refuses it and tells the agent what to do. An
                                                orchestrator never approves a prompt that
                                                deletes or is not known whole: the user does)`;

export const taskTalk: CommandFamily = {
  usage: USAGE,
  commands: {
    'task send': {
      options: { value: ['reply-to'] },
      build: async ({ flags, positional, json, ref, text }) => {
        return {
          op: 'send',
          json,
          args: {
            ref: ref(true),
            text: await text(positional.slice(1), 'A message'),
            ...(typeof flags['reply-to'] === 'string' ? { replyTo: flags['reply-to'] } : {}),
          },
        };
      },
    },
    'task answer': {
      options: { value: ['text'] },
      build: ({ flags, positional, json, ref }) => {
        const word = positional[1];
        const said = typeof flags.text === 'string' ? flags.text : undefined;
        const choice =
          word === 'approve' || word === 'deny'
            ? word
            : word !== undefined && /^[1-9]$/.test(word)
              ? Number(word)
              : undefined;
        if (word !== undefined && choice === undefined) {
          throw new UsageError(
            `"${word}" is no answer: approve, deny, an option number, or --text "what to do instead"`
          );
        }
        return {
          op: 'answer',
          json,
          args: {
            ref: ref(true),
            ...(choice !== undefined ? { choice } : {}),
            ...(said !== undefined ? { text: said } : {}),
          },
        };
      },
    },
  },
  print: {
    send: (input) =>
      printTask(input, (task) => {
        const { data, deps } = input;
        const sent = (data.message as { id?: string } | undefined)?.id;
        if (sent) deps.out(`Message ${sent}: its next report answers it.`);
        deps.out(
          task.agent === 'codex'
            ? 'Typed into Codex at its prompt.'
            : 'Typed into its Claude: if it is working it reads it within its current turn.'
        );
      }),
    answer: (input) => printTask(input, () => input.deps.out('Answered: its agent goes on.')),
  },
};
