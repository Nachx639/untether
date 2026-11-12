// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { createTestTask } from '@/test/utils/test-factories';
import type { PublicModelProvider } from '../../shared/model-providers.js';
import type { AuthClient } from '../services/auth-client';
import type { TaskStore } from '../services/task-store.js';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig },
}));

import './phone-session-row.js';
import './provider-badge.js';
import './session-card.js';
import './session-list/compact-session-card.js';
import './task-row.js';
import './agent-mission.js';
import './session-view/session-header.js';
import type { ProviderBadge } from './provider-badge.js';
import { closeSessionSwitcher } from './session-view/session-switcher-sheet.js';

const provider = (icon?: string): PublicModelProvider => ({
  id: 'acme',
  label: 'Acme',
  models: [],
  priced: false,
  ...(icon ? { icon } : {}),
});

const auth = { getAuthHeader: () => ({}) } as unknown as AuthClient;
const onProvider = { modelProvider: { id: 'acme', model: 'large' } };

/** A tick for the config promise, then for the render it causes. */
async function settled(element: Element) {
  await new Promise((resolve) => setTimeout(resolve));
  await (element as ProviderBadge).updateComplete;
}

async function badgeWith(providers: PublicModelProvider[], providerId = 'acme') {
  // A new list each time: the shared list only tells its badges about a change.
  loadConfig.mockResolvedValue({ modelProviders: [...providers] });
  const badge = await fixture<ProviderBadge>(
    html`<ut-provider-badge .providerId=${providerId} .model=${'large'}></ut-provider-badge>`
  );
  await settled(badge);
  return badge;
}

const drawing = (badge: Element) => badge.querySelector('svg')?.innerHTML ?? '';

describe('ut-provider-badge', () => {
  beforeEach(() => loadConfig.mockReset());
  afterEach(() => fixtureCleanup());

  it('shows the configured emoji and names the provider and model', async () => {
    const badge = await badgeWith([provider('🦊')]);
    expect(badge.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    expect(badge.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'External model provider: Acme · large'
    );
  });

  it('draws a named icon of the app set', async () => {
    // Read at once: every badge follows the shared list, so an earlier one changes later.
    const zap = drawing(await badgeWith([provider('zap')]));
    const plug = drawing(await badgeWith([provider()]));
    expect(zap).toContain('<path');
    expect(zap).not.toBe(plug);
  });

  it.each(['constructor', 'noSuchIcon'])('falls back on the plug for the name %s', async (name) => {
    const unknown = drawing(await badgeWith([provider(name)]));
    const plug = drawing(await badgeWith([provider()]));
    expect(unknown).toContain('<path');
    expect(unknown).toBe(plug);
  });

  it('marks a provider no longer configured, by its id', async () => {
    const badge = await badgeWith([provider('🦊')], 'gone');
    expect(badge.querySelector('.ut-provider-emoji')).toBeNull();
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('gone');
  });

  it('keeps what it knew when the config cannot be read', async () => {
    const badge = await badgeWith([provider('🦊')]);
    // What loadConfig answers on a failed request: no modelProviders key.
    loadConfig.mockResolvedValue({ serverConfigured: false, quickStartCommands: [] });
    const again = await fixture<ProviderBadge>(
      html`<ut-provider-badge .providerId=${'acme'}></ut-provider-badge>`
    );
    await settled(again);
    expect(again.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    expect(badge.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
  });

  it('asks the server once for rows that appear together', async () => {
    let answer: (value: unknown) => void = () => {};
    loadConfig.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const list = await fixture<HTMLElement>(html`<div>
      <ut-provider-badge .providerId=${'acme'}></ut-provider-badge>
      <ut-provider-badge .providerId=${'acme'}></ut-provider-badge>
      <ut-provider-badge .providerId=${'acme'}></ut-provider-badge>
    </div>`);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    answer({ modelProviders: [provider('🐙')] });
    const badge = list.querySelector('ut-provider-badge') as ProviderBadge;
    await settled(badge);
    expect(badge.querySelector('.ut-provider-emoji')?.textContent).toBe('🐙');
  });
});

describe('rows of a session or task on a provider', () => {
  /** What the server answers from now on; a new list, so the shared one tells its rows. */
  const configured = (...providers: PublicModelProvider[]) =>
    loadConfig.mockResolvedValue({ modelProviders: providers });

  beforeEach(() => {
    loadConfig.mockReset();
    configured(provider('🦊'));
  });
  afterEach(() => fixtureCleanup());

  const session = (over = {}) => ({ ...createMockSession({ status: 'running' }), ...over });
  const CLAUDE_LOGO = '.ut-agent-glyph:not(.ut-provider-logo), .psr-avatar > svg';

  const views = {
    'phone-row': {
      mount: (value: ReturnType<typeof session>) =>
        fixture<HTMLElement>(html`<phone-session-row .session=${value}></phone-session-row>`),
      tile: '.psr-avatar',
      dot: '.psr-dot',
      badge: 'psr-provider-badge',
    },
    'compact-sidebar': {
      mount: (value: ReturnType<typeof session>) =>
        fixture<HTMLElement>(
          html`<compact-session-card .session=${value} .authClient=${auth}></compact-session-card>`
        ),
      tile: '.ut-side-avatar',
      dot: '.ut-side-dot',
      badge: 'compact-provider-badge',
    },
    'desktop-card': {
      mount: (value: ReturnType<typeof session>) =>
        fixture<HTMLElement>(
          html`<session-card .session=${value} .authClient=${auth}></session-card>`
        ),
      tile: '.ut-card-avatar',
      dot: '.ut-card-dot',
      badge: 'card-provider-badge',
    },
  };

  async function mounted(view: (typeof views)[keyof typeof views], value: object) {
    const row = await view.mount(session(value));
    await settled(row);
    const tile = row.querySelector(view.tile) as HTMLElement;
    return { row, tile, badge: row.querySelector<ProviderBadge>(`[data-testid="${view.badge}"]`) };
  }

  for (const name of Object.keys(views) as Array<keyof typeof views>) {
    const view = views[name];

    it(`${name}: the provider's icon takes the logo's place, the state dot stays`, async () => {
      const { tile, badge } = await mounted(view, onProvider);
      expect(tile.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
      expect(tile.querySelector(CLAUDE_LOGO)).toBeNull();
      expect(tile.querySelector(view.dot)).not.toBeNull();
      expect(tile.querySelector('[data-testid="provider-logo"]')?.getAttribute('title')).toBe(
        'External model provider: Acme · large'
      );
      // Not repeated in the small badge.
      expect(badge?.querySelector('.ut-provider-emoji')).toBeNull();
      expect(badge?.childElementCount).toBe(0);
    });

    it(`${name}: a provider without icon keeps the logo and the discreet plug`, async () => {
      configured(provider());
      const { tile, badge } = await mounted(view, onProvider);
      expect(tile.querySelector(CLAUDE_LOGO)).not.toBeNull();
      expect(tile.querySelector('[data-testid="provider-logo"]')).toBeNull();
      expect(tile.querySelector(view.dot)).not.toBeNull();
      expect(badge?.providerId).toBe('acme');
      expect(badge?.model).toBe('large');
      expect(badge?.querySelector('svg')).not.toBeNull();
      expect(badge?.querySelector('[role="img"]')?.getAttribute('title')).toContain('large');
    });

    it(`${name}: without a provider nothing changes`, async () => {
      const { row, tile } = await mounted(view, {});
      expect(tile.querySelector(CLAUDE_LOGO)).not.toBeNull();
      expect(tile.getAttribute('aria-hidden') ?? 'true').toBe('true');
      expect(tile.querySelector(view.dot)).not.toBeNull();
      expect(row.querySelector('[data-testid="provider-logo"]')).toBeNull();
      expect(row.querySelector('ut-provider-badge')).toBeNull();
    });
  }

  it('a named icon of the app set takes the logo place, drawn in the tile tint', async () => {
    configured(provider('zap'));
    const { tile } = await mounted(views['phone-row'], onProvider);
    expect(tile.querySelector('[data-testid="provider-logo"] svg')).not.toBeNull();
    expect(tile.querySelector(CLAUDE_LOGO)).toBeNull();
  });

  it('a name outside the app set counts as no icon: logo and plug', async () => {
    configured(provider('noSuchIcon'));
    const { tile, badge } = await mounted(views['compact-sidebar'], onProvider);
    expect(tile.querySelector(CLAUDE_LOGO)).not.toBeNull();
    expect(badge?.querySelector('svg')).not.toBeNull();
  });

  it('a Claude detected on a provider in a terminal shows its icon too', async () => {
    const detected = { terminalClaude: { detectedProvider: { id: 'acme', model: 'large' } } };
    const { tile } = await mounted(views['desktop-card'], detected);
    expect(tile.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
  });

  it('the desktop card in row layout swaps its logo too', async () => {
    const row = await fixture<HTMLElement>(
      html`<session-card .session=${session(onProvider)} .authClient=${auth} layout="row"></session-card>`
    );
    await settled(row);
    expect(row.querySelector('.ut-card-glyph .ut-provider-emoji')?.textContent).toBe('🦊');
  });

  const corner = (row: Element) => row.querySelector('[data-testid="provider-corner"]');

  it("phone project tile: its logo stays, the provider is a corner badge, the agent's mark too", async () => {
    const row = await fixture<HTMLElement>(html`<phone-session-row
      .session=${session(onProvider)}
      .projectIcon=${'/icon.png'}
    ></phone-session-row>`);
    await settled(row);
    expect(row.querySelector('.psr-avatar-icon')?.getAttribute('src')).toBe('/icon.png');
    expect(corner(row)?.textContent?.trim()).toBe('🦊');
    expect(row.querySelector('.psr-avatar-glyph svg')).not.toBeNull();
    expect(row.querySelector('.psr-dot')).not.toBeNull();
    expect(row.querySelector('[data-testid="provider-logo"]')).toBeNull();
  });

  it("desktop project tile: its logo stays, the provider is a corner badge, the agent's mark too", async () => {
    const row = await fixture<HTMLElement>(html`<session-card
      .session=${session(onProvider)}
      .authClient=${auth}
      .orchestrator=${true}
      .projectIcon=${'/icon.png'}
    ></session-card>`);
    await settled(row);
    const tile = row.querySelector('.ut-card-avatar') as HTMLElement;
    expect(tile.dataset.icon).toBe('project');
    expect(tile.querySelector('.ut-tile-icon')).not.toBeNull();
    expect(tile.querySelector('.ut-agent-glyph:not(.ut-provider-logo)')).not.toBeNull();
    expect(corner(tile)?.textContent?.trim()).toBe('🦊');
    expect(tile.querySelector('.ut-card-dot')).not.toBeNull();
  });

  it('desktop row layout on a project logo: the logo stays, with the corner badge', async () => {
    const row = await fixture<HTMLElement>(html`<session-card
      .session=${session(onProvider)}
      .authClient=${auth}
      .orchestrator=${true}
      .projectIcon=${'/icon.png'}
      layout="row"
    ></session-card>`);
    await settled(row);
    expect(row.querySelector('.ut-repo-icon')?.getAttribute('src')).toBe('/icon.png');
    expect(corner(row)?.textContent?.trim()).toBe('🦊');
  });

  for (const [label, projectIcon] of [
    ['with a project logo', '/icon.png'],
    ['with its sparkles alone', null],
  ] as const) {
    it(`sidebar orchestrator ${label}: stays, corner badge, nothing small repeated`, async () => {
      const row = await fixture<HTMLElement>(html`<compact-session-card
        .session=${session(onProvider)}
        .authClient=${auth}
        .orchestrator=${true}
        .projectIcon=${projectIcon}
      ></compact-session-card>`);
      await settled(row);
      const tile = row.querySelector('.ut-side-avatar') as HTMLElement;
      expect(tile.querySelector('.ut-tile-icon') !== null).toBe(projectIcon !== null);
      expect(tile.querySelector(':scope > svg')).not.toBeNull();
      expect(corner(tile)?.textContent?.trim()).toBe('🦊');
      expect(tile.querySelector('[data-testid="provider-logo"]')).toBeNull();
      expect(
        row.querySelector('[data-testid="compact-provider-badge"] .ut-provider-emoji')
      ).toBeNull();
    });
  }

  it('a project tile on a provider without icon: no corner, the small plug stays', async () => {
    configured(provider());
    const row = await fixture<HTMLElement>(html`<compact-session-card
      .session=${session(onProvider)}
      .authClient=${auth}
      .orchestrator=${true}
      .projectIcon=${'/icon.png'}
    ></compact-session-card>`);
    await settled(row);
    expect(corner(row)).toBeNull();
    expect(row.querySelector('[data-testid="compact-provider-badge"] svg')).not.toBeNull();
  });

  it('a row that leaves and comes back follows the list again', async () => {
    const holder = await fixture<HTMLElement>(html`<div></div>`);
    const row = document.createElement('phone-session-row') as HTMLElement & {
      session: ReturnType<typeof session>;
    };
    row.session = session(onProvider);
    holder.append(row);
    await settled(row);
    expect(row.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    row.remove();
    configured(provider('🐙'));
    holder.append(row);
    await settled(row);
    expect(row.querySelector('.ut-provider-emoji')?.textContent).toBe('🐙');
  });

  const taskRow = (task: ReturnType<typeof createTestTask>, variant = 'row') =>
    fixture<HTMLElement>(
      html`<task-row .task=${task} .store=${{} as TaskStore} .variant=${variant}></task-row>`
    );
  const onProviderTask = { modelProvider: 'acme', model: 'large' };

  for (const [variant, tile, dot, badgeId] of [
    ['row', '.psr-avatar', '.psr-dot', 'task-provider-badge'],
    ['card', '.psr-avatar', '.psr-dot', 'task-provider-badge'],
    ['done', '.psr-avatar', '.psr-dot', 'task-provider-badge'],
    ['side', '.ut-side-avatar', '.ut-side-dot', 'compact-task-provider-badge'],
  ] as const) {
    it(`task ${variant}: the provider's icon replaces the logo, the dot stays`, async () => {
      const row = await taskRow(createTestTask(onProviderTask), variant);
      await settled(row);
      const avatar = row.querySelector(tile) as HTMLElement;
      expect(avatar.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
      expect(avatar.querySelector(CLAUDE_LOGO)).toBeNull();
      expect(avatar.querySelector(dot)).not.toBeNull();
      const badge = row.querySelector<ProviderBadge>(`[data-testid="${badgeId}"]`);
      expect(badge?.childElementCount).toBe(0);
    });

    it(`task ${variant}: no icon keeps the logo and the plug, no provider just the logo`, async () => {
      configured(provider());
      const onPlug = await taskRow(createTestTask(onProviderTask), variant);
      await settled(onPlug);
      expect(onPlug.querySelector(tile)?.querySelector(CLAUDE_LOGO)).not.toBeNull();
      expect(onPlug.querySelector(`[data-testid="${badgeId}"] svg`)).not.toBeNull();

      const plain = await taskRow(createTestTask({ model: 'opus' }), variant);
      await settled(plain);
      expect(plain.querySelector(tile)?.querySelector(CLAUDE_LOGO)).not.toBeNull();
      expect(plain.querySelector('ut-provider-badge')).toBeNull();
    });
  }

  it('agents tab: the provider icon replaces the logo', async () => {
    const value = { ...session(onProvider), claudeStatus: { status: 'working' } };
    const mission = await fixture<HTMLElement>(html`<agent-mission
      .sessions=${[value]}
      .io=${{}}
    ></agent-mission>`);
    await settled(mission);
    const tile = mission.querySelector('.psr-avatar') as HTMLElement;
    expect(tile.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    expect(tile.querySelector('.psr-dot')).not.toBeNull();
  });

  it('session switcher: the provider icon replaces the logo', async () => {
    const current = session({ id: 'current' });
    const other = session({ id: 'other', ...onProvider });
    const header = await fixture<HTMLElement & { updateComplete: Promise<boolean> }>(html`
      <session-header .session=${current} .sessions=${[current, other]} .isMobile=${true}></session-header>
    `);
    header.querySelector<HTMLButtonElement>('[data-testid="header-phone-title"]')?.click();
    await new Promise((resolve) => setTimeout(resolve));
    const item = document.body.querySelector(
      '[data-testid="switcher-item"][data-session-id="other"]'
    );
    expect(item?.querySelector('.ut-switch-avatar .ut-provider-emoji')?.textContent).toBe('🦊');
    closeSessionSwitcher();
  });

  it('task detail sheet (no tile): the mark sits by its name, with the model', async () => {
    const task = createTestTask({
      ...onProviderTask,
      state: 'failed',
      sessionId: undefined,
      blocker: { kind: 'verify', message: 'x' },
    });
    const row = await taskRow(task);
    await settled(row);
    (row.querySelector('.tsk-main') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="task-detail-provider-badge"]')).not.toBeNull()
    );
    const badge = document.querySelector<ProviderBadge>(
      '[data-testid="task-detail-provider-badge"]'
    ) as ProviderBadge;
    await settled(badge);
    expect(badge.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    expect(badge.querySelector('[role="img"]')?.getAttribute('title')).toContain('large');
    document.querySelector('[data-testid="task-detail-sheet"]')?.parentElement?.remove();
  });

  describe('an image in the icons folder', () => {
    /** Each test its own name: the app keeps a loaded or failed image for the session. */
    const stubFetch = (ok: boolean) => {
      const fetchFn = vi.fn(async () =>
        ok
          ? new Response(new Blob(['png'], { type: 'image/png' }))
          : new Response('', { status: 404 })
      );
      vi.stubGlobal('fetch', fetchFn);
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:provider-icon');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      return fetchFn;
    };
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const onFile = (file: string, iconFallback?: string) =>
      configured({ ...provider(file), ...(iconFallback ? { iconFallback } : {}) });

    it('loads with the login header, once, and shows in the logo place', async () => {
      const fetchFn = stubFetch(true);
      onFile('loaded-one.png');
      const { tile } = await mounted(views['phone-row'], onProvider);
      await settled(tile);
      expect(tile.querySelector('img.ut-provider-img')?.getAttribute('src')).toBe(
        'blob:provider-icon'
      );
      expect(tile.querySelector('.psr-dot')).not.toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(
        '/api/model-providers/icon/loaded-one.png'
      );
      await mounted(views['phone-row'], onProvider);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('keeps the small size of a badge outside a tile, however big the file', async () => {
      stubFetch(true);
      onFile('in-a-sheet.png');
      const badge = await fixture<ProviderBadge>(
        html`<ut-provider-badge .providerId=${'acme'}></ut-provider-badge>`
      );
      await settled(badge);
      await settled(badge);
      const img = badge.querySelector('img.ut-provider-img');
      expect(img?.getAttribute('width')).toBe('12');
      expect(img?.getAttribute('height')).toBe('12');
    });

    it('the plug beside a tile goes away once the image has loaded', async () => {
      stubFetch(true);
      onFile('then-loaded.png');
      const { tile, badge } = await mounted(views['compact-sidebar'], onProvider);
      await settled(tile);
      await settled(badge as Element);
      expect(tile.querySelector('img.ut-provider-img')).not.toBeNull();
      expect(badge?.childElementCount).toBe(0);
    });

    it('sits in the corner of a project logo', async () => {
      stubFetch(true);
      onFile('corner-one.webp');
      const row = await fixture<HTMLElement>(html`<phone-session-row
        .session=${session(onProvider)}
        .projectIcon=${'/icon.png'}
      ></phone-session-row>`);
      await settled(row);
      await settled(row);
      expect(corner(row)?.querySelector('img')?.getAttribute('src')).toBe('blob:provider-icon');
    });

    it('a missing file falls back on iconFallback', async () => {
      stubFetch(false);
      onFile('missing-with-emoji.png', '🦊');
      const { tile } = await mounted(views['compact-sidebar'], onProvider);
      await settled(tile);
      expect(tile.querySelector('img.ut-provider-img')).toBeNull();
      expect(tile.querySelector('.ut-provider-emoji')?.textContent).toBe('🦊');
    });

    it('a missing file without fallback leaves the logo and the plug', async () => {
      stubFetch(false);
      onFile('missing-alone.png');
      const { tile, badge } = await mounted(views['compact-sidebar'], onProvider);
      await settled(tile);
      await settled(badge as Element);
      expect(tile.querySelector(CLAUDE_LOGO)).not.toBeNull();
      expect(badge?.querySelector('svg')).not.toBeNull();
    });

    it('a file that loads but cannot be drawn falls back too', async () => {
      stubFetch(true);
      onFile('corrupt.png', '🐙');
      const { tile } = await mounted(views['desktop-card'], onProvider);
      await settled(tile);
      tile.querySelector('img.ut-provider-img')?.dispatchEvent(new Event('error'));
      await settled(tile);
      expect(tile.querySelector('img.ut-provider-img')).toBeNull();
      expect(tile.querySelector('.ut-provider-emoji')?.textContent).toBe('🐙');
    });
  });
});
