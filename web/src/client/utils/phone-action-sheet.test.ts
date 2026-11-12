// @vitest-environment happy-dom
import { html } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionItems, openActionSheet, PhoneActionSheet } from './phone-action-sheet.js';

describe('phone action sheet', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const later = (ms = 600) => vi.advanceTimersByTime(ms);

  it('renders into <body> with a grabber, the groups and a Cancel, and closes on Cancel', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const sheet = openActionSheet({
      label: 'More',
      title: 'alice · Tailscale',
      onClose,
      groups: [
        [{ label: 'Settings', icon: 'settings', run: () => {} }],
        [],
        [{ label: 'Close all', icon: 'x', destructive: true, testId: 'kill', run: () => {} }],
      ],
    });
    const root = document.body.querySelector('.psr-sheet') as HTMLElement;
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-label')).toBe('More');
    expect(root.querySelector('.ut-grabber[data-sheet-handle]')).not.toBeNull();
    // Empty groups are dropped; the title heads the first.
    expect(root.querySelectorAll('.psr-sheet-group')).toHaveLength(2);
    expect(root.querySelector('.psr-sheet-group .psr-sheet-title')?.textContent).toContain('alice');
    expect(root.querySelector('[data-testid="kill"]')?.classList.contains('destructive')).toBe(
      true
    );
    expect(root.querySelector('.psr-sheet-icon svg')).not.toBeNull();
    (root.querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
    expect(sheet.isOpen).toBe(false);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores the tap that opened it, then acts once on a touch (not on its trailing click)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    openActionSheet({ label: 'x', groups: [[{ label: 'Pin', testId: 'pin', run }]] });
    const pin = () => document.body.querySelector<HTMLButtonElement>('[data-testid="pin"]');
    pin()?.click();
    expect(run).not.toHaveBeenCalled();
    later();
    pin()?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(run).toHaveBeenCalledOnce();
    expect(pin()).toBeNull();
  });

  it('a step keeps it open and starts the guard again', () => {
    vi.useFakeTimers();
    const confirm = vi.fn();
    const sheet = new PhoneActionSheet({ label: 'Row' });
    const confirmStep = (s: PhoneActionSheet) =>
      html`<div class="psr-sheet-group">${actionItems(s, [{ label: 'Kill', testId: 'confirm', run: confirm }])}</div>`;
    sheet.open(
      (s) =>
        html`<div class="psr-sheet-group">${actionItems(s, [
          { label: 'Kill', testId: 'kill', keepOpen: true, run: () => s.step(confirmStep) },
        ])}</div>`
    );
    later();
    document.body.querySelector<HTMLButtonElement>('[data-testid="kill"]')?.click();
    expect(sheet.isOpen).toBe(true);
    // The second tap of a double tap lands on the confirm: ignored.
    document.body.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click();
    expect(confirm).not.toHaveBeenCalled();
    later();
    document.body.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(sheet.isOpen).toBe(false);
  });

  it('marks the chosen item of a choice', () => {
    openActionSheet({
      label: 'Appearance',
      groups: [
        [
          { label: 'Light', checked: false, run: () => {} },
          { label: 'Dark', checked: true, run: () => {} },
        ],
      ],
    });
    const items = [...document.body.querySelectorAll('.psr-sheet-item')];
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(items[1].querySelector('.psr-sheet-check')).not.toBeNull();
  });
});
