/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import { AWAY_SEEN_STORAGE_KEY, lastSeen, markSeen, shouldShowAway } from '../utils/away-seen.js';
import { type AwaySummaryCard, type AwaySummaryData, awayCounts } from './away-summary-card.js';
import './away-summary-card.js';

const changes = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./session-view/changes-sheet.js', () => ({ openChangesSheet: changes.open }));

const NOW = Date.parse('2026-10-02T10:30:00.000Z');

const SUMMARY: AwaySummaryData = {
  available: true,
  agent: 'claude',
  lastActivityAt: '2026-10-02T10:20:00.000Z',
  toolCalls: 11,
  messages: 3,
  files: [
    { path: '/repo/src/auth.ts', edits: 3 },
    { path: '/repo/src/auth.test.ts', edits: 1 },
    { path: '/repo/a.ts', edits: 1 },
    { path: '/repo/b.ts', edits: 1 },
  ],
  commands: [
    { command: 'pnpm test auth', isError: true, exitCode: 1 },
    { command: 'pnpm test auth' },
  ],
  errors: [{ tool: 'Bash', target: 'pnpm test auth', text: 'Exit code 1 FAIL' }],
  lastMessage: 'All green. Want me to commit?',
  status: 'waiting',
};

const SESSION = {
  id: 's1',
  name: 'claude',
  command: ['claude'],
  workingDir: '/repo',
  status: 'running',
  startedAt: '2026-10-02T09:00:00.000Z',
} as unknown as Session;

describe('away summary card', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // The shared test setup replaces localStorage with no-op mocks: use a real store here.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    await setLocale('es');
    fetchMock = vi.fn(async () => new Response(JSON.stringify(SUMMARY), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    changes.open.mockClear();
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await setLocale('en');
  });

  const mount = async () => {
    const card = document.createElement('away-summary-card') as AwaySummaryCard;
    document.body.appendChild(card);
    card.session = SESSION;
    await card.updateComplete;
    // Let the fetch and the re-render settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await card.updateComplete;
    return card;
  };
  const q = (card: AwaySummaryCard, id: string) =>
    card.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

  it('shows what the agent did since the session was last on screen', async () => {
    markSeen('s1', NOW - 25 * 60_000);
    const card = await mount();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/away-summary?since=2026-10-02T10%3A05%3A00.000Z',
      expect.anything()
    );
    const text = q(card, 'away-card')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('Mientras no estabas (hace 25 min)');
    expect(text).toContain('editó 4 archivos · ejecutó 2 comandos · 1 error · 3 mensajes');
    expect(text).toContain('Ahora: esperando tu respuesta');
    // Opening the session moves "last seen" to now.
    expect(lastSeen('s1')).toBe(NOW);

    q(card, 'away-toggle')?.click();
    await card.updateComplete;
    const details = q(card, 'away-details')?.textContent ?? '';
    expect(details).toContain('pnpm test auth');
    expect(details).toContain('salida 1');
    expect(details).toContain('All green. Want me to commit?');
    q(card, 'away-file')?.click();
    expect(changes.open).toHaveBeenCalledWith('/repo', {
      file: '/repo/src/auth.ts',
      sessionId: 's1',
    });
  });

  it('stays hidden on a first visit or a short absence', async () => {
    let card = await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q(card, 'away-card')).toBeNull();
    card.remove();

    markSeen('s1', NOW - 60_000);
    card = await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q(card, 'away-card')).toBeNull();
  });

  it('stays hidden without activity', async () => {
    markSeen('s1', NOW - 25 * 60_000);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ ...SUMMARY, toolCalls: 0, messages: 0, files: [], commands: [] }),
          { status: 200 }
        )
    );
    const card = await mount();
    expect(fetchMock).toHaveBeenCalled();
    expect(q(card, 'away-card')).toBeNull();
  });

  it('stays dismissed until there is new activity', async () => {
    markSeen('s1', NOW - 25 * 60_000);
    let card = await mount();
    q(card, 'away-dismiss')?.click();
    await card.updateComplete;
    expect(q(card, 'away-card')).toBeNull();
    expect(localStorage.getItem(AWAY_SEEN_STORAGE_KEY)).toContain(SUMMARY.lastActivityAt);
    card.remove();

    // Away again, but the server reports the same work: still dismissed.
    markSeen('s1', NOW - 10 * 60_000);
    card = await mount();
    expect(q(card, 'away-card')).toBeNull();
    card.remove();

    // New activity after the dismissed summary: the card is back.
    markSeen('s1', NOW - 10 * 60_000);
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...SUMMARY, lastActivityAt: '2026-10-02T10:28:00.000Z' }), {
          status: 200,
        })
    );
    card = await mount();
    expect(q(card, 'away-card')).not.toBeNull();
  });

  it('ignores sessions that run no agent', async () => {
    markSeen('s2', NOW - 25 * 60_000);
    const card = document.createElement('away-summary-card') as AwaySummaryCard;
    document.body.appendChild(card);
    card.session = { ...SESSION, id: 's2', command: ['zsh'] } as Session;
    await card.updateComplete;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('away helpers', () => {
  it('counts only what happened, with singulars', async () => {
    await setLocale('es');
    expect(
      awayCounts({ ...SUMMARY, files: [SUMMARY.files[0]], commands: [], errors: [], messages: 1 })
    ).toBe('editó 1 archivo · 1 mensaje');
    await setLocale('en');
  });

  it('needs activity, a two-minute absence and an undismissed summary', () => {
    const base = {
      available: true,
      toolCalls: 1,
      messages: 0,
      lastActivityAt: '2026-10-02T10:00:00Z',
    };
    expect(shouldShowAway(base, { since: 0, now: 3 * 60_000 })).toBe(true);
    expect(shouldShowAway(base, { since: 0, now: 60_000 })).toBe(false);
    expect(shouldShowAway({ ...base, toolCalls: 0 }, { since: 0, now: 3 * 60_000 })).toBe(false);
    expect(
      shouldShowAway(base, { since: 0, now: 3 * 60_000, dismissed: '2026-10-02T10:00:00Z' })
    ).toBe(false);
  });
});
