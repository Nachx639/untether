import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ICON_MAX,
  type PublicModelProvider,
  parseProviderIcon,
  providerBadgeInfo,
  sessionProviderMarker,
} from './model-providers.js';

const provider = (over: Partial<PublicModelProvider> = {}): PublicModelProvider => ({
  id: 'acme',
  label: 'Acme',
  models: [],
  priced: false,
  ...over,
});

describe('parseProviderIcon', () => {
  it.each(['🦊', '❤️', '👍🏽', '👩‍💻', '🇪🇸', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'])('takes the emoji %s', (value) => {
    expect(parseProviderIcon(value)).toEqual({ kind: 'emoji', emoji: value });
  });

  it('takes an icon name', () => {
    expect(parseProviderIcon('zap')).toEqual({ kind: 'named', name: 'zap' });
  });

  it.each(['', 'a b', '<img>', '🦊🦊', '🦊x', '-', 'x'.repeat(PROVIDER_ICON_MAX + 1)])(
    'refuses %j',
    (value) => {
      expect(parseProviderIcon(value)).toBeUndefined();
    }
  );
});

describe('parseProviderIcon: image files', () => {
  it.each(['acme.png', 'proveedor-abliteration.png', 'a_b.2.WEBP', 'x.svg'])(
    'accepts %s',
    (name) => {
      expect(parseProviderIcon(name)).toEqual({ kind: 'file', file: name });
    }
  );

  it.each([
    '../acme.png',
    'a/acme.png',
    '/etc/acme.png',
    '.acme.png',
    'a..png',
    'acme.jpg',
    'acme.png.txt',
    'a\\b.png',
    `${'a'.repeat(70)}.png`,
  ])('refuses %s', (name) => {
    expect(parseProviderIcon(name)).toBeUndefined();
  });
});

describe('providerBadgeInfo', () => {
  it('uses the icon and label of a provider that has one', () => {
    expect(providerBadgeInfo([provider({ icon: '🦊' })], 'acme')).toEqual({
      icon: { kind: 'emoji', emoji: '🦊' },
      name: 'Acme',
    });
  });

  it('falls back on the generic mark without icon', () => {
    expect(providerBadgeInfo([provider()], 'acme')).toEqual({
      icon: { kind: 'generic' },
      name: 'Acme',
    });
  });

  it('keeps a generic mark and the id for a provider no longer configured', () => {
    expect(providerBadgeInfo([provider({ icon: '🦊' })], 'gone')).toEqual({
      icon: { kind: 'generic' },
      name: 'gone',
    });
  });
});

describe('sessionProviderMarker', () => {
  const launched = { id: 'launched', model: 'm1' };
  const detected = { id: 'detected', model: '' };

  it('shows the provider Untether launched the session on', () => {
    expect(sessionProviderMarker({ modelProvider: launched })).toEqual(launched);
  });

  it('shows the provider detected in a terminal, though a restore could not reproduce it', () => {
    expect(sessionProviderMarker({ terminalClaude: { detectedProvider: detected } })).toEqual(
      detected
    );
  });

  it('prefers the launch over what was detected', () => {
    expect(
      sessionProviderMarker({
        modelProvider: launched,
        terminalClaude: { detectedProvider: detected },
      })
    ).toEqual(launched);
  });

  it('shows nothing for a terminal without Claude or without a known provider', () => {
    expect(sessionProviderMarker({})).toBeUndefined();
    expect(sessionProviderMarker({ terminalClaude: {} })).toBeUndefined();
  });
});
