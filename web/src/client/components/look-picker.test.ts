/**
 * @vitest-environment happy-dom
 */
import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { LOOKS } from '../../shared/looks.js';
import { renderLookPicker } from './look-picker.js';

describe('the style picker', () => {
  const host = () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    return div;
  };

  it('has one named, focusable card per style with a live miniature and the state of each', () => {
    const div = host();
    const onSelect = vi.fn();
    render(
      renderLookPicker({
        active: 'cyber-hacker',
        deviceChoice: null,
        serverLook: undefined,
        onSelect,
        onFollowServer: vi.fn(),
        ready: true,
      }),
      div
    );
    const cards = [...div.querySelectorAll<HTMLButtonElement>('.ut-look-card')];
    expect(cards.map((card) => card.tagName)).toEqual(LOOKS.map(() => 'BUTTON'));
    for (const card of cards) {
      expect(card.querySelector('.ut-look-name')?.textContent?.trim()).toBeTruthy();
      expect(card.querySelector('.ut-look-thumb.ut-look-scope')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
    }
    const pressed = cards.filter((card) => card.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((card) => card.dataset.testid)).toEqual(['settings-look-cyber-hacker']);
    cards[0].click();
    expect(onSelect).toHaveBeenCalledWith(LOOKS[0].id);
    expect(div.querySelector('[data-testid="settings-look-grid"]')?.getAttribute('role')).toBe(
      'group'
    );
  });

  it('forced-mode styles draw in their own mode, Original without a look attribute', () => {
    const div = host();
    render(
      renderLookPicker({
        active: 'original',
        deviceChoice: null,
        serverLook: undefined,
        onSelect: vi.fn(),
        onFollowServer: vi.fn(),
        ready: false,
      }),
      div
    );
    const thumb = (id: string) =>
      div.querySelector(`[data-testid="settings-look-${id}"] .ut-look-thumb`) as HTMLElement;
    expect(thumb('cyber-hacker').getAttribute('data-theme')).toBe('dark');
    expect(thumb('minimal-light').getAttribute('data-theme')).toBe('light');
    expect(thumb('original').hasAttribute('data-look')).toBe(false);
  });

  it('offers going back to the server default only when this device has its own choice', () => {
    const server = LOOKS[1];
    const div = host();
    const follow = vi.fn();
    const paint = (deviceChoice: string | null) =>
      render(
        renderLookPicker({
          active: deviceChoice ?? server.id,
          deviceChoice,
          serverLook: server,
          onSelect: vi.fn(),
          onFollowServer: follow,
          ready: true,
        }),
        div
      );
    paint(null);
    expect(div.querySelector('[data-testid="settings-look-follow-server"]')).toBeNull();
    paint('original');
    div.querySelector<HTMLButtonElement>('[data-testid="settings-look-follow-server"]')?.click();
    expect(follow).toHaveBeenCalled();
  });
});
