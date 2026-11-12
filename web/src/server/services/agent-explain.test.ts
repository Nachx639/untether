import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  cleanExplanation,
  createAgentExplainer,
  EXPLAIN_MAX_CHARS,
  explainFingerprint,
  explainMaterial,
} from './agent-explain.js';

type ListSession = Pick<
  Session,
  'id' | 'status' | 'claudeStatus' | 'codexActive' | 'geminiActive' | 'lastLine'
>;

const busy = (target: string, extra: Partial<NonNullable<Session['claudeStatus']>> = {}) =>
  ({
    id: 's1',
    status: 'running',
    claudeStatus: {
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target, since: Date.now() },
      ...extra,
    },
  }) as ListSession;

// Built at run time: no credential-shaped literal in the source (security sweeps).
const FAKE_TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('');

function setup(reply: (question: string) => string | null = () => 'Ejecuta los tests de login') {
  let now = 1_000_000;
  const ask = vi.fn(async (_system: string, question: string) => reply(question));
  const readChat = vi.fn(async () => ({
    available: true,
    messages: [
      { id: 'm1', role: 'user' as const, text: `use the token ${FAKE_TOKEN} to push` },
      { id: 'm2', role: 'assistant' as const, text: 'Running the login tests now.' },
    ],
  }));
  const explainer = createAgentExplainer({
    ask,
    readChat,
    now: () => now,
    minIntervalMs: 120_000,
    statusIntervalMs: 15_000,
    maxPerHour: 5,
  });
  return {
    explainer,
    ask,
    readChat,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('agent-explain', () => {
  it('answers from the cache and asks the model only when the session changed', async () => {
    const { explainer, ask, advance } = setup();
    // First look: nothing yet, one call in the background (the list never waits).
    expect(explainer.explain(busy('pnpm test'), 'es')).toBeUndefined();
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toContain('Language: Spanish');

    // Every poll after it: the cached line, no new call while nothing changed.
    for (let i = 0; i < 20; i++) {
      advance(5_000);
      expect(explainer.explain(busy('pnpm test'), 'es')?.text).toBe('Ejecuta los tests de login');
    }
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(1);

    // A new step while it works: asked again once minIntervalMs passed since the last call…
    advance(20_000);
    explainer.explain(busy('pnpm lint'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(2);
    // …and not sooner: the next step waits its turn.
    advance(1_000);
    explainer.explain(busy('pnpm build'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(2);
    advance(120_000);
    explainer.explain(busy('pnpm build'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('a line made for another status is not shown; a status change is asked soon', async () => {
    const { explainer, ask, advance } = setup((question) =>
      question.includes('Status: waiting') ? 'Pide permiso para hacer push' : 'Ejecuta los tests'
    );
    explainer.explain(busy('pnpm test'), 'es');
    await explainer.idle();
    advance(16_000);
    const waiting: ListSession = {
      id: 's1',
      status: 'running',
      claudeStatus: { status: 'waiting', waitingFor: 'permission' },
    };
    // "Ejecuta los tests" no longer fits: the card shows its own status meanwhile.
    expect(explainer.explain(waiting, 'es')).toBeUndefined();
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(explainer.explain(waiting, 'es')?.text).toBe('Pide permiso para hacer push');
  });

  it('keeps every session together under its hourly budget', async () => {
    const { explainer, ask, advance } = setup();
    for (let i = 0; i < 12; i++) {
      explainer.explain({ ...busy(`step ${i}`), id: `s${i}` }, 'en');
      await explainer.idle();
      advance(1_000);
    }
    expect(ask).toHaveBeenCalledTimes(5);
    advance(3_600_000);
    explainer.explain({ ...busy('again'), id: 's0' }, 'en');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(6);
  });

  it('never sends secrets and never shows more than one short line', async () => {
    const { explainer, ask } = setup(
      () =>
        `"**Pushing** with ${FAKE_TOKEN} after fixing the flaky login test and then rebuilding everything twice"\nsecond line`
    );
    explainer.explain(busy(`git push https://x:${FAKE_TOKEN}@github.com/a/b`), 'en');
    await explainer.idle();
    expect(ask.mock.calls[0][1]).not.toContain(FAKE_TOKEN);
    expect(ask.mock.calls[0][1]).toContain('Running the login tests now.');
    const line = explainer.explain(busy(`git push https://x:${FAKE_TOKEN}@github.com/a/b`), 'en');
    expect(line?.text).not.toContain(FAKE_TOKEN);
    expect(line?.text).not.toContain('\n');
    expect(line?.text).not.toContain('**');
    expect([...(line?.text ?? '')].length).toBeLessThanOrEqual(EXPLAIN_MAX_CHARS);
    expect(line?.text.endsWith('…')).toBe(true);
  });

  it('off, or a session with no agent: no line and no call', async () => {
    const ask = vi.fn(async () => 'x');
    let on = false;
    const explainer = createAgentExplainer({
      ask,
      readChat: async () => null,
      enabled: () => on,
    });
    expect(explainer.explain(busy('pnpm test'), 'es')).toBeUndefined();
    on = true;
    expect(
      explainer.explain({ id: 'sh', status: 'running', lastLine: '$ ls' }, 'es')
    ).toBeUndefined();
    expect(
      explainer.explain({ ...busy('pnpm test'), status: 'exited' } as ListSession, 'es')
    ).toBeUndefined();
    await explainer.idle();
    expect(ask).not.toHaveBeenCalled();
  });

  it('no answer (no claude, no login, timed out): its own status, and asked again a few times', async () => {
    let answer: string | null = null;
    const { explainer, ask, advance } = setup(() => answer);
    explainer.explain(busy('pnpm test'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(explainer.explain(busy('pnpm test'), 'es')).toBeUndefined();
    // Nothing changed, yet it is tried again after the usual wait (not on every poll)…
    advance(60_000);
    explainer.explain(busy('pnpm test'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(1);
    advance(60_000);
    answer = 'Ejecuta los tests';
    explainer.explain(busy('pnpm test'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(explainer.explain(busy('pnpm test'), 'es')?.text).toBe('Ejecuta los tests');
    // …and, once answered, not again while nothing changes.
    advance(600_000);
    explainer.explain(busy('pnpm test'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('a model that never answers is tried at most three times for the same session state', async () => {
    const { explainer, ask, advance } = setup(() => {
      throw new Error('spawn failed');
    });
    for (let i = 0; i < 10; i++) {
      explainer.explain(busy('pnpm test'), 'es');
      await explainer.idle();
      advance(120_000);
    }
    expect(ask).toHaveBeenCalledTimes(3);
    // A new state starts over.
    explainer.explain(busy('pnpm lint'), 'es');
    await explainer.idle();
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('a fingerprint ignores when a step began, not what it is', () => {
    const a = busy('pnpm test');
    const b = busy('pnpm test');
    (b.claudeStatus as { activity: { since: number } }).activity.since = 1;
    expect(explainFingerprint(a)).toBe(explainFingerprint(b));
    expect(explainFingerprint(busy('pnpm lint'))).not.toBe(explainFingerprint(a));
  });

  it('reads the end of the conversation, newest last, bounded', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      role: 'assistant' as const,
      text: `message ${i} ${'x'.repeat(900)}`,
    }));
    const material = explainMaterial(busy('pnpm test'), { available: true, messages });
    expect(material.length).toBeLessThanOrEqual(3600);
    expect(material).toContain('message 29');
    expect(material).not.toContain('message 0 ');
    // The status goes whole, ahead of the conversation, however long the messages.
    const waiting = explainMaterial(
      {
        id: 's1',
        status: 'running',
        claudeStatus: {
          status: 'waiting',
          waitingFor: 'permission',
          choices: { question: 'Proceed?', options: ['Yes', 'No'], detail: ['git push -f'] },
        },
      },
      { available: true, messages }
    );
    expect(waiting.length).toBeLessThanOrEqual(3600);
    expect(
      waiting.startsWith('Status: waiting\nWaiting for: permission\nOn screen: Proceed?')
    ).toBe(true);
    expect(waiting).toContain('git push -f');
    expect(waiting).toContain('message 29');
  });

  it('cleans a reply to one bare line', () => {
    expect(cleanExplanation('  - «Ejecuta los tests»  \n más')).toBe('Ejecuta los tests');
    expect(cleanExplanation('')).toBe('');
    expect(cleanExplanation(null)).toBe('');
  });
});
