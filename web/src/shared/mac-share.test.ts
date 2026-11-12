import { describe, expect, it } from 'vitest';
import {
  isMacShareConversationId,
  isMacShareJobId,
  isMacShareToken,
  macShareDisplayCommand,
} from './mac-share.js';

describe('Share with phone ids', () => {
  it('accepts a lowercase UUID as the conversation typed after --resume', () => {
    expect(isMacShareConversationId('0b402254-352f-4532-b05e-1186d66e984a')).toBe(true);
  });

  it('refuses anything else as a conversation id: it is typed into a shell', () => {
    for (const value of [
      '',
      '0B402254-352F-4532-B05E-1186D66E984A',
      '0b402254-352f-4532-b05e-1186d66e984a ',
      '0b402254-352f-4532-b05e-1186d66e984a\n',
      '0b402254352f4532b05e1186d66e984a',
      "0b402254-352f-4532-b05e-1186d66e984'",
      '0b402254-352f-4532-b05e-1186d66e984a; rm -rf ~',
      '--fork-session',
      42,
      undefined,
    ]) {
      expect(isMacShareConversationId(value), String(value)).toBe(false);
    }
  });

  it('tokens and job ids are 128 bits in base64url, nothing else', () => {
    const id = 'AbCdEfGhIjKlMnOpQrSt_-';
    expect(isMacShareToken(id)).toBe(true);
    expect(isMacShareJobId(id)).toBe(true);
    for (const value of ['', `${id}x`, id.slice(1), 'AbCdEfGhIjKlMnOpQrSt+/', `${id.slice(1)}=`]) {
      expect(isMacShareToken(value), value).toBe(false);
      expect(isMacShareJobId(value), value).toBe(false);
    }
  });

  it('shows bidi controls and invisible characters escaped, everything else as typed', () => {
    expect(macShareDisplayCommand("cd '/x/\u202Etxt.sh' && ut claude")).toBe(
      "cd '/x/\\u{202E}txt.sh' && ut claude"
    );
    expect(macShareDisplayCommand('a\u200Bb\u2066c\uFEFF')).toBe('a\\u{200B}b\\u{2066}c\\u{FEFF}');
    expect(macShareDisplayCommand("cd '/café/عربى/😀' && ut claude")).toBe(
      "cd '/café/عربى/😀' && ut claude"
    );
  });
});
