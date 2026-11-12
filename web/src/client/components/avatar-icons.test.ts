// @vitest-environment happy-dom
import { nothing, render, type TemplateResult } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvatarIcons, PublicModelProvider } from '../../shared/model-providers.js';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig },
}));

import { agentAvatar, agentLogo } from './agent-avatar.js';

const onAcme = { id: 'acme', model: 'large' };
const acme = (over: Partial<PublicModelProvider> = {}): PublicModelProvider => ({
  id: 'acme',
  label: 'Acme',
  models: [],
  priced: false,
  ...over,
});

const hosts: HTMLElement[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve));

/** Draws `what` under this config; the event is how mounted avatars look at a new config. */
async function show(
  what: () => unknown,
  avatarIcons?: AvatarIcons,
  providers: PublicModelProvider[] = []
) {
  loadConfig.mockResolvedValue({ modelProviders: [...providers], avatarIcons });
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  render(what() as TemplateResult, host);
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  await tick();
  return host;
}

const logo = (host: HTMLElement) => host.querySelector('[data-testid="avatar-logo"]');
const emoji = (host: HTMLElement) => host.querySelector('.ut-provider-emoji')?.textContent;

describe('avatarIcons', () => {
  beforeEach(() => {
    loadConfig.mockReset();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('missing')
          ? new Response('', { status: 404 })
          : new Response(new Blob(['png']), { status: 200 })
      )
    );
  });

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      render(nothing, host);
      host.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const tiles = {
    row: (kind: 'claude' | 'codex' | 'terminal') =>
      agentAvatar({ variant: 'row', kind, state: 'idle' }),
    side: (kind: 'claude' | 'codex' | 'terminal') =>
      agentAvatar({ variant: 'side', kind, status: 'running' }),
    card: (kind: 'claude' | 'codex' | 'terminal') => agentAvatar({ variant: 'card', kind }),
    inline: (kind: 'claude' | 'codex' | 'terminal') => agentAvatar({ variant: 'inline', kind }),
    logo: (kind: 'claude' | 'codex' | 'terminal') => agentLogo(kind, undefined, 20),
  };
  const agents = [
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['terminal', 'shell'],
  ] as const;

  for (const name of Object.keys(tiles) as Array<keyof typeof tiles>) {
    for (const [kind, key] of agents) {
      it(`${name}: ${key} replaces the ${kind} mark`, async () => {
        const host = await show(() => tiles[name](kind), { [key]: '🦊' });
        expect(logo(host)?.getAttribute('data-avatar')).toBe(key);
        expect(emoji(host)).toBe('🦊');
        expect(host.querySelector('.ut-agent-glyph:not(.ut-provider-logo)')).toBeNull();
      });
    }
  }

  it.each([
    [false, 'preview'],
    [true, 'previewPaused'],
  ] as const)('a preview paused=%s uses %s', async (paused, key) => {
    const host = await show(() => agentAvatar({ variant: 'preview', paused, compact: false }), {
      preview: paused ? undefined : '🦊',
      previewPaused: paused ? '🦊' : undefined,
    });
    expect(logo(host)?.getAttribute('data-avatar')).toBe(key);
    expect(emoji(host)).toBe('🦊');
    expect(host.querySelector('.psr-avatar.pvr-avatar svg')).toBeNull();
  });

  it('an unset key keeps the current glyph', async () => {
    const host = await show(() => agentAvatar({ variant: 'card', kind: 'codex' }), {
      claude: '🦊',
    });
    expect(logo(host)).toBeNull();
    expect(host.querySelector('.ut-agent-glyph--codex')?.textContent).toBe('Cx');
  });

  it('a paused preview with only the open eye set keeps the current glyph', async () => {
    const host = await show(
      () => agentAvatar({ variant: 'preview', paused: true, compact: true }),
      {
        preview: '🦊',
      }
    );
    expect(logo(host)).toBeNull();
    expect(host.querySelector('.pvr-avatar svg')).not.toBeNull();
  });

  it('with no avatarIcons nothing changes', async () => {
    const host = await show(() => agentAvatar({ variant: 'row', kind: 'claude', state: 'idle' }));
    expect(logo(host)).toBeNull();
    expect(host.querySelector('.psr-avatar svg')).not.toBeNull();
  });

  // Not lazily (2026-11-09): the image is a blob already in memory, and on a real iPhone the
  // avatars of a long scrolled list were left empty or painted out of their rows.
  it('draws an image file through the icons route, at once', async () => {
    const host = await show(
      () => agentAvatar({ variant: 'side', kind: 'claude', status: 'running' }),
      {
        claude: 'agent-one.png',
      }
    );
    const img = host.querySelector('img.ut-provider-img');
    expect(img?.getAttribute('src')).toBe('blob:avatar');
    expect(img?.hasAttribute('loading')).toBe(false);
    expect(img?.hasAttribute('decoding')).toBe(false);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      '/api/model-providers/icon/agent-one.png'
    );
  });

  it('a missing file keeps the current glyph', async () => {
    const host = await show(() => agentAvatar({ variant: 'card', kind: 'codex' }), {
      codex: 'missing-one.png',
    });
    expect(logo(host)).toBeNull();
    expect(host.querySelector('.ut-agent-glyph--codex')).not.toBeNull();
  });

  it('an image that can not be drawn goes back to the glyph', async () => {
    const host = await show(() => agentAvatar({ variant: 'card', kind: 'codex' }), {
      codex: 'broken-one.png',
    });
    host.querySelector('img.ut-provider-img')?.dispatchEvent(new Event('error'));
    await tick();
    expect(logo(host)).toBeNull();
    expect(host.querySelector('.ut-agent-glyph--codex')).not.toBeNull();
  });

  it.each(['../../etc/passwd.png', '/etc/passwd.png', '..%2Fsecret.png', 'a/b.png', '.hidden.png'])(
    'a malicious value %s fetches nothing and keeps the glyph',
    async (value) => {
      const host = await show(() => agentAvatar({ variant: 'card', kind: 'claude' }), {
        claude: value,
      });
      expect(logo(host)).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("a provider's icon wins over avatarIcons", async () => {
    const host = await show(
      () => agentAvatar({ variant: 'side', kind: 'claude', status: 'running', provider: onAcme }),
      { claude: '🐙' },
      [acme({ icon: '🦊' })]
    );
    expect(logo(host)).toBeNull();
    expect(host.querySelector('[data-testid="provider-logo"]')).not.toBeNull();
    expect(emoji(host)).toBe('🦊');
  });

  it('a session on a provider without icon does not use avatarIcons either', async () => {
    const host = await show(
      () => agentAvatar({ variant: 'row', kind: 'claude', state: 'idle', provider: onAcme }),
      { claude: '🐙' },
      [acme()]
    );
    expect(logo(host)).toBeNull();
    expect(emoji(host)).toBeUndefined();
  });

  it("Gemini never wears the shell's icon", async () => {
    const host = await show(() => agentAvatar({ variant: 'row', kind: 'gemini', state: 'idle' }), {
      shell: '🐙',
    });
    expect(logo(host)).toBeNull();
    expect(emoji(host)).toBeUndefined();
  });

  it('on a project logo the icon stays the small corner mark', async () => {
    const host = await show(
      () =>
        agentAvatar({
          variant: 'side',
          kind: 'claude',
          status: 'running',
          projectIcon: '/logo.png',
        }),
      { claude: '🐙' }
    );
    expect(host.querySelector('.ut-side-avatar')?.getAttribute('data-icon')).toBe('project');
    expect(logo(host)).not.toBeNull();
  });

  it('an image or emoji fills the avatar; a line icon keeps its tile', async () => {
    const draw = () => agentAvatar({ variant: 'card', kind: 'claude' });
    expect(logo(await show(draw, { claude: '🐙' }))?.classList.contains('ut-logo-full')).toBe(true);
    expect(logo(await show(draw, { claude: 'one.png' }))?.classList.contains('ut-logo-full')).toBe(
      true
    );
    expect(logo(await show(draw, { claude: 'zap' }))?.classList.contains('ut-logo-full')).toBe(
      false
    );
  });

  it('a provider emoji fills the avatar too', async () => {
    const host = await show(
      () => agentAvatar({ variant: 'row', kind: 'claude', state: 'idle', provider: onAcme }),
      undefined,
      [acme({ icon: '🦊' })]
    );
    expect(
      host.querySelector('[data-testid="provider-logo"]')?.classList.contains('ut-logo-full')
    ).toBe(true);
  });

  it('a provider emoji fallback fills the avatar too', async () => {
    const host = await show(
      () => agentAvatar({ variant: 'row', kind: 'claude', state: 'idle', provider: onAcme }),
      undefined,
      [acme({ icon: 'missing-two.png', iconFallback: '🦊' })]
    );
    await tick();
    expect(
      host.querySelector('[data-testid="provider-logo"]')?.classList.contains('ut-logo-full')
    ).toBe(true);
    expect(emoji(host)).toBe('🦊');
  });
});
