import { describe, expect, it } from 'vitest';
import { isMacSessionId, MAC_SESSION_ID_RE } from './mac-sessions.js';

describe('Mac session ids', () => {
  it('accepts the three kinds of id the server makes', () => {
    for (const id of [
      't-15674-1727426400-0',
      'p-15674-1727426400-12',
      'a-20085-1759500000',
      't-1-0-4294967295',
    ]) {
      expect(isMacSessionId(id), id).toBe(true);
    }
  });

  it('refuses tmux targets, paths and anything else a client could send', () => {
    for (const id of [
      '',
      't',
      't-1',
      'x-1-2',
      'T-1-2-3',
      '$0',
      '%3',
      't-1-2-$0',
      '/private/tmp/tmux-501/default',
      't-1-2-3/../x',
      ' t-1-2-3',
      't-1-2-3 ',
      't-1-2-3\n',
      't-1-2-3;kill-server',
      't-1-2-3-4',
      't-1--2',
      't-12345678901-2-3',
      'a-1-1234567890123',
      't-1-2-12345678901',
      'a-١-٢',
    ]) {
      expect(isMacSessionId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('refuses values that are not strings', () => {
    for (const value of [undefined, null, 7, ['t-1-2-3'], { id: 't-1-2-3' }]) {
      expect(isMacSessionId(value)).toBe(false);
    }
  });

  it('is safe to reuse: test() keeps no state (no g or y flag)', () => {
    expect(MAC_SESSION_ID_RE.flags).toBe('');
    expect(MAC_SESSION_ID_RE.test('a-1-2')).toBe(true);
    expect(MAC_SESSION_ID_RE.test('a-1-2')).toBe(true);
  });
});
