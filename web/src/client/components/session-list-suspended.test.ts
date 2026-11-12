// @vitest-environment happy-dom
// 2026-10-31 (user request: a section of their own for suspended sessions, apart from the rest):
// suspended sessions leave the live lists for their own "Suspended (n)" section, on
// the phone, in the sidebar and on the desktop home, grouped by project.
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionSuspension } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { SessionList } from './session-list.js';

const now = new Date().toISOString();
const live = (id: string, title: string): Session =>
  ({
    id,
    name: title,
    userTitle: title,
    command: ['claude'],
    workingDir: '/tmp/live',
    status: 'running',
    shielded: true,
    startedAt: now,
    lastModified: now,
  }) as unknown as Session;
const record = (minutesAgo: number, extra: Partial<SessionSuspension> = {}): SessionSuspension => ({
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  claudeSessionId: 'conv',
  command: ['claude'],
  workingDir: '/tmp/x',
  shielded: true,
  idleMinutes: 130,
  ...extra,
});
const paused = (id: string, title: string, minutesAgo: number, extra = {}): Session =>
  ({
    ...live(id, title),
    status: 'exited',
    suspended: record(minutesAgo, extra),
  }) as unknown as Session;

const SESSIONS = [
  live('l1', 'Live one'),
  paused('p1', 'Paused orchestrator', 30, { orchestratorOf: '/Users/x/Projects/alpha' }),
  paused('p2', 'Paused loose', 180),
];

async function mount(compact = false) {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${SESSIONS}
      .compactMode=${compact}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('the "Suspended" section', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  for (const layout of ['phone', 'sidebar', 'desktop'] as const) {
    it(`${layout}: the live list leaves them out; their section counts them, opens, groups them by project`, async () => {
      vi.spyOn(
        SessionList.prototype as unknown as { usePhoneRows: () => boolean },
        'usePhoneRows'
      ).mockReturnValue(layout === 'phone');
      const list = await mount(layout === 'sidebar');
      const section = list.querySelector('[data-testid="suspended-section"]');
      expect(section).not.toBeNull();
      const toggle = list.querySelector<HTMLButtonElement>(
        '[data-testid="suspended-section-toggle"]'
      );
      expect(text(toggle)).toContain('Suspended (2)');
      // Closed by default: only the live one shows.
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(text(list)).toContain('Live one');
      expect(text(list)).not.toContain('Paused orchestrator');
      expect(text(list)).not.toContain('Paused loose');

      toggle?.click();
      await list.updateComplete;
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(store.get('ut-list-suspended')).toBe('open');
      const rows = list.querySelector('[data-testid="suspended-rows"]');
      expect(text(rows)).not.toContain('Live one');
      // Its project first (the latest pause), "No repository" last.
      const groups = [...(rows?.querySelectorAll('[data-testid="suspended-group"]') ?? [])].map(
        text
      );
      expect(groups).toEqual(['alpha', 'No repository']);
      const order = text(rows);
      expect(order.indexOf('Paused orchestrator')).toBeGreaterThan(-1);
      expect(order.indexOf('Paused orchestrator')).toBeLessThan(order.indexOf('Paused loose'));
    });
  }

  it('with only suspended sessions the phone list still shows their section', async () => {
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${[paused('p2', 'Paused loose', 5)]}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await list.updateComplete;
    expect(text(list.querySelector('[data-testid="suspended-section-toggle"]'))).toContain(
      'Suspended (1)'
    );
  });
});
