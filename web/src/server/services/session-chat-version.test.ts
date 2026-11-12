import { describe, expect, it } from 'vitest';
import { chatAnswer, chatMessagesVersion } from './session-chat';

/** The list an answer carries; the test fails when the answer left it out. */
function sentMessages(answer: { messages: readonly unknown[] } | { messagesUnchanged: true }) {
  if (!('messages' in answer)) throw new Error('the answer left the messages out');
  return answer.messages;
}

describe('chat answers for a phone that already has the messages', () => {
  const chat = {
    available: true,
    status: 'busy',
    activity: { verb: 'Pondering' },
    messages: [
      { id: '1', role: 'user', text: 'hola' },
      { id: '2', role: 'assistant', text: 'hey' },
    ],
  };

  it('sends the messages and their fingerprint to a client that has none', () => {
    const answer = chatAnswer(chat, undefined);
    expect(sentMessages(answer)).toEqual(chat.messages);
    expect(answer.messagesVersion).toBe(chatMessagesVersion(chat.messages));
    expect('messagesUnchanged' in answer).toBe(false);
  });

  it('leaves out an unchanged list but keeps the live status', () => {
    const answer = chatAnswer(chat, chatMessagesVersion(chat.messages));
    expect('messages' in answer).toBe(false);
    expect(answer).toMatchObject({ status: 'busy', activity: { verb: 'Pondering' } });
    expect(answer).toMatchObject({ messagesUnchanged: true });
  });

  it('sends the list again when anything in it changed, an edit or a tool result too', () => {
    const have = chatMessagesVersion(chat.messages);
    const edited = { ...chat, messages: [chat.messages[0], { ...chat.messages[1], text: 'hey!' }] };
    expect(sentMessages(chatAnswer(edited, have))).toEqual(edited.messages);
    const withResult = {
      ...chat,
      messages: [...chat.messages, { id: '3', role: 'tool', tool: 'Bash', result: 'ok' }],
    };
    expect(sentMessages(chatAnswer(withResult, have))).toHaveLength(3);
  });

  it('ignores a malformed fingerprint (?have=a&have=b gives an array)', () => {
    const version = chatMessagesVersion(chat.messages);
    expect(sentMessages(chatAnswer(chat, [version, version]))).toEqual(chat.messages);
  });
});
