import { describe, expect, it } from 'vitest';
import { type BufferCell, CELL_ATTR } from '../../shared/terminal-text-formatter.js';
import {
  createUserHold,
  draftOnScreen,
  USER_QUEUED_FALLBACK_MS,
  USER_TYPING_QUIET_MS,
  userInputHold,
} from './user-input-guard.js';

const GREY = 0x999999;
const row = (text: string, style: Partial<BufferCell> = {}): BufferCell[] =>
  [...text].map((char) => ({ char, width: 1, ...style }));
/** A prompt line: the mark, then `text` with `style`. */
const prompt = (mark: string, text: string, style: Partial<BufferCell> = {}): BufferCell[] => [
  ...row(`${mark} `),
  ...row(text, style),
];
const rule = row('────────────', { fg: 0x888888 });
const footer = row('  bypass permissions on (shift+tab to cycle)', { fg: GREY });

describe('draftOnScreen (the user has unsent text in the agent input)', () => {
  it('Claude Code: an empty prompt and a greyed placeholder are no draft; typed text is', () => {
    // As captured from Claude Code 2.1.321: "❯ " alone, and "❯ hola" in the default colour.
    expect(draftOnScreen([rule, prompt('❯', ''), rule, footer])).toBe(false);
    expect(
      draftOnScreen([rule, prompt('❯', 'Try "edit app.ts"', { fg: GREY }), rule, footer])
    ).toBe(false);
    expect(draftOnScreen([rule, prompt('❯', 'hola'), rule, footer])).toBe(true);
    // A dimmed placeholder with the cursor drawn (inverted) on its first character.
    const withCursor = [
      ...row('❯ '),
      ...row('T', { attributes: 0x10 }),
      ...row('ry "fix the tests"', { attributes: CELL_ATTR.DIM }),
    ];
    expect(draftOnScreen([rule, withCursor, rule, footer])).toBe(false);
  });

  it('Codex: its placeholder is greyed, a draft is not', () => {
    expect(
      draftOnScreen([
        prompt('›', 'Ask Codex to do anything', { attributes: CELL_ATTR.DIM }),
        footer,
      ])
    ).toBe(false);
    expect(draftOnScreen([prompt('›', 'arregla el test'), footer])).toBe(true);
    // A draft in italics is a draft (italic was once read as dim).
    expect(
      draftOnScreen([prompt('›', 'arregla el test', { attributes: CELL_ATTR.ITALIC }), footer])
    ).toBe(true);
  });

  it('only the input box counts: an older turn far up the screen is no draft', () => {
    const old = prompt('❯', 'un mensaje ya enviado');
    const filler = Array.from({ length: 20 }, () => row('salida'));
    expect(draftOnScreen([old, ...filler, rule, prompt('❯', ''), rule, footer])).toBe(false);
    // No prompt at all (a menu, a shell): nothing to protect here.
    expect(draftOnScreen([row('1. Yes'), row('2. No')])).toBe(false);
  });
});

describe('userInputHold', () => {
  const now = 10_000_000;
  const clear = { now, busy: false, draft: false };

  it('holds while the user types or has just sent, and lets go after a quiet moment', () => {
    expect(userInputHold({ ...clear, lastUserKeyAt: now - 1000 })).toMatch(
      /typing or has just sent/
    );
    expect(
      userInputHold({
        ...clear,
        lastUserKeyAt: now - USER_TYPING_QUIET_MS - 1,
        lastTurnAt: now - 1000,
      })
    ).toBeNull();
    expect(userInputHold(clear)).toBeNull();
  });

  it('holds for a draft however old (the user may come back to it tomorrow)', () => {
    expect(userInputHold({ ...clear, draft: true, lastUserKeyAt: now - 24 * 60 * 60_000 })).toMatch(
      /unsent text/
    );
    // Seen on the screen even when no key was seen (typed before a server restart).
    expect(userInputHold({ ...clear, draft: true })).toMatch(/unsent text/);
  });

  it("at work: the user's keys since the turn began are a message in the agent's queue", () => {
    const busy = { now, busy: true, draft: false };
    expect(
      userInputHold({ ...busy, lastUserKeyAt: now - 60_000, lastTurnAt: now - 120_000 })
    ).toMatch(/waits in its queue/);
    // The turn that took the user's message has started: the way is clear.
    expect(
      userInputHold({ ...busy, lastUserKeyAt: now - 120_000, lastTurnAt: now - 119_000 })
    ).toBeNull();
    // Without the agent's events, the keys count for a while.
    expect(userInputHold({ ...busy, lastUserKeyAt: now - 60_000 })).toMatch(/waits in its queue/);
    expect(userInputHold({ ...busy, lastUserKeyAt: now - USER_QUEUED_FALLBACK_MS - 1 })).toBeNull();
  });

  it('a screen that cannot be read holds only when the user typed since the last turn', () => {
    const blind = { now, busy: false, draft: undefined };
    expect(
      userInputHold({ ...blind, lastUserKeyAt: now - 60_000, lastTurnAt: now - 120_000 })
    ).toMatch(/cannot be read/);
    expect(
      userInputHold({ ...blind, lastUserKeyAt: now - 120_000, lastTurnAt: now - 60_000 })
    ).toBeNull();
    expect(userInputHold(blind)).toBeNull();
  });
});

describe('createUserHold', () => {
  it("reads the session: its keys, its agent's turn, Claude's status and its screen", async () => {
    const now = 5_000_000;
    let screen: BufferCell[][] = [rule, prompt('❯', ''), rule];
    let keyAt: number | undefined;
    let events: { turnStartedAt?: number; turnEndedAt?: number } | undefined;
    let claudeBusy = false;
    const hold = createUserHold({
      now: () => now,
      lastUserKeyAt: () => keyAt,
      agentState: () => events,
      claudeBusy: async () => claudeBusy,
      cells: async () => screen,
    });
    expect(await hold('s1')).toBeNull();
    screen = [rule, prompt('❯', 'a medio escribir'), rule];
    expect(await hold('s1')).toMatch(/unsent text/);

    // Sent a minute ago while Claude worked on something else: it waits in Claude's queue.
    screen = [rule, prompt('❯', ''), rule];
    keyAt = now - 60_000;
    events = { turnStartedAt: now - 300_000 };
    expect(await hold('s1')).toMatch(/waits in its queue/);
    // Claude's status alone says "busy" when it sends no events.
    events = undefined;
    claudeBusy = true;
    expect(await hold('s1')).toMatch(/waits in its queue/);
    // Its turn ended and a new one took the message.
    claudeBusy = false;
    events = { turnStartedAt: now - 30_000, turnEndedAt: now - 10_000 };
    expect(await hold('s1')).toBeNull();
  });
});
