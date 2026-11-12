// @vitest-environment happy-dom

import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestTask } from '@/test/utils/test-factories';
import type { PreviewItem, Session } from '../../shared/types.js';
import { readFoundation } from '../../test/utils/stylesheets.js';
import type { AuthClient } from '../services/auth-client.js';
import { taskStore } from '../services/task-store.js';
import { SessionList } from './session-list.js';

// 2026-10-04: on an iPhone Pro Max in landscape (956×440 pt, about 300 pt under Safari's bars)
// the list showed no session at all. On its side the phone list has two columns; happy-dom has
// no layout, so the classes and where each part goes are checked here, the fit on the
// simulator.
const session = {
  id: 's1',
  name: 'landscape',
  command: ['zsh'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as unknown as Session;

const preview: PreviewItem = {
  id: 'pvite123',
  port: 5173,
  path: '/',
  createdAt: 1,
  lastOpenedAt: 1,
  sessionAlive: false,
  pinned: false,
  source: 'ut-open',
  state: 'live',
  title: 'QA Vite',
};

function setDevice(screen: [number, number], window_: [number, number]) {
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => screen[0] });
  Object.defineProperty(window.screen, 'height', { configurable: true, get: () => screen[1] });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
}

const PRO_MAX: [number, number] = [440, 956];
const SE: [number, number] = [375, 667];

const mount = async (sessions: Session[] = [session]) => {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${sessions}
      .previews=${[preview]}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
};

const content = (list: SessionList) =>
  list.querySelector<HTMLElement>('.phone-list') as HTMLElement;

async function rotate(list: SessionList, window_: [number, number]) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
  window.dispatchEvent(new Event('resize'));
  await list.updateComplete;
}

describe('phone list on its side', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
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
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
    setDevice([1024, 768], [1024, 768]);
  });

  it.each([
    ['iPhone Pro Max', PRO_MAX, [956, 330]],
    ['iPhone SE', SE, [667, 323]],
  ] as const)(
    '%s in landscape: two columns, controls left and rows right',
    async (_name, screen, window_) => {
      setDevice(screen, [...window_]);
      const list = await mount();
      const classes = content(list).classList;
      expect(classes).toContain('phone-landscape');
      expect(classes).toContain('phone-list-tight');

      const controls = list.querySelector('[data-testid="phone-list-controls"]');
      const rows = list.querySelector('[data-testid="phone-list-rows"]');
      expect(controls?.querySelector('ask-claude-box')).not.toBeNull();
      expect(rows?.querySelector('[data-testid="preview-rows-heading"]')).not.toBeNull();
      // The banner went below the sessions (2026-10-12).
      expect(rows?.querySelector('notifications-banner')).not.toBeNull();
      expect(rows?.querySelector('[data-testid="phone-session-list"]')).not.toBeNull();
      expect(controls?.querySelector('phone-session-row')).toBeNull();
      // The tab bar is the list's, outside both columns (list.css puts it under the left one).
      expect(
        list.querySelector('[data-testid="session-list-footer"] [data-testid="agents-tabs"]')
      ).not.toBeNull();
      expect(
        list.querySelector('[data-testid="session-list-footer"]')?.closest('.pl-side, .pl-main')
      ).toBeNull();
    }
  );

  it('on its side, tasks sit with the rows and the strip pointing at them with the controls', async () => {
    setDevice(PRO_MAX, [956, 330]);
    taskStore.set([
      createTestTask({ id: 't1', state: 'needs_you', blocker: { kind: 'risk', message: 'r' } }),
    ]);
    try {
      const list = await mount();
      const controls = list.querySelector('[data-testid="phone-list-controls"]');
      const rows = list.querySelector('[data-testid="phone-list-rows"]');
      expect(rows?.querySelector('[data-testid="project-group"] task-row')).not.toBeNull();
      expect(controls?.querySelector('task-row')).toBeNull();
      expect(controls?.querySelector('[data-testid="needs-you-task-pill"]')).not.toBeNull();
    } finally {
      taskStore.reset();
    }
  });

  it.each([
    ['iPhone Pro Max', PRO_MAX, [440, 830]],
    ['iPhone SE', SE, [375, 548]],
  ] as const)('%s in portrait keeps one column', async (_name, screen, window_) => {
    setDevice(screen, [...window_]);
    const list = await mount();
    expect(content(list).classList).not.toContain('phone-landscape');
  });

  it('the Pro Max in portrait keeps its classic spacing', async () => {
    setDevice(PRO_MAX, [440, 830]);
    const list = await mount();
    expect(content(list).classList).not.toContain('phone-list-tight');
    expect(content(list).classList).toContain('pt-4');
  });

  it('switches on every rotation, keeping the same Ask box', async () => {
    setDevice(PRO_MAX, [440, 830]);
    const list = await mount();
    const ask = list.querySelector('ask-claude-box');

    await rotate(list, [956, 330]);
    expect(content(list).classList).toContain('phone-landscape');
    expect(content(list).classList).toContain('phone-list-tight');

    await rotate(list, [440, 830]);
    expect(content(list).classList).not.toContain('phone-landscape');
    expect(content(list).classList).not.toContain('phone-list-tight');

    // Same element throughout: what was typed in it, and its focus, survive the rotation.
    expect(list.querySelector('ask-claude-box')).toBe(ask);
  });

  it('with nothing running it keeps one column', async () => {
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount([]);
    expect(list.querySelector('[data-testid="phone-empty"]')).not.toBeNull();
    expect(list.querySelector('.phone-landscape')).toBeNull();
  });

  it('the sidebar opened from a session never splits', async () => {
    setDevice(PRO_MAX, [956, 330]);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${[session]}
        .compactMode=${true}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    expect(list.querySelector('.phone-landscape, .pl-side, .pl-main')).toBeNull();
  });

  it('logs once whether the columns got their styles, for the server log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setDevice(PRO_MAX, [956, 330]);
    const list = await mount();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    list.requestUpdate();
    await list.updateComplete;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const lines = log.mock.calls
      .map((call) => call.join(' '))
      .filter((line) => line.includes('landscape columns'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/class set, list display .+ \(grid expected\)/);
  });
});

describe('the left column on a Pro Max on its side', () => {
  // QA 2026-10-04: at 40% (382 pt) the Ask row left the picker under 236 px and it showed the
  // agents' marks; the names must fit.
  it("leaves the Ask row room for the agents' names and the folder", () => {
    const css = readFoundation();
    const match = css.match(
      /grid-template-columns: minmax\(0, clamp\((\d+)px, (\d+)%, (\d+)px\)\) minmax\(0, 1fr\);/
    );
    expect(match).not.toBeNull();
    const [min, percent, max] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
    const column = Math.min(Math.max((956 * percent) / 100, min), max);
    // Side padding (safe area ~62 + 16), the box's padding and border (22), mic + send (88);
    // Tareas sits in the box's top corner (2026-10-12). Claude | Codex take ~120 px and the
    // folder chip at least its icon (34).
    const room = column - 62 - 16 - 22 - 88;
    expect(room).toBeGreaterThanOrEqual(120 + 6 + 34);
    // The rows keep more than half of the width.
    expect(956 - column).toBeGreaterThan(956 / 2);
  });
});

describe('the rows column on a phone on its side', () => {
  // 2026-11-11 (client audit): it still ended with 88 px for the floating "+", gone since
  // 2026-10-12 (the "+" lives in the tab bar): an empty band under the last row.
  it('ends with its own padding, no room for a floating button', () => {
    const rule = /\.phone-landscape \.pl-main \{[^}]*grid-column: 2;[^}]*\}/.exec(readFoundation());
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain(
      'padding: 12px max(1rem, env(safe-area-inset-right, 0px)) 16px 1rem;'
    );
    expect(rule?.[0]).not.toMatch(/58px|88px/);
  });
});
