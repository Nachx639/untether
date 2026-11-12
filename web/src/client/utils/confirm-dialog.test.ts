// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDialog } from './confirm-dialog.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

async function open(options: Parameters<typeof confirmDialog>[0]) {
  const answer = confirmDialog(options);
  const host = document.querySelector('ut-confirm-dialog');
  await (host as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  const wrapper = host?.querySelector('modal-wrapper') as unknown as {
    updateComplete: Promise<unknown>;
  };
  await wrapper.updateComplete;
  await frame();
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  return { answer, dialog };
}

const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('confirmDialog', () => {
  afterEach(async () => {
    await frame();
    for (const el of document.querySelectorAll('ut-confirm-dialog')) el.remove();
  });

  it('renders title, body and details in a small dialog; ↵ confirms', async () => {
    const { answer, dialog } = await open({
      title: 'Close 8 sessions?',
      body: 'The processes will be stopped.',
      confirmLabel: 'Close 8 sessions',
      details: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    expect(dialog.classList.contains('ut-dialog--sm')).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Close 8 sessions?');
    expect(dialog.textContent).toContain('The processes will be stopped.');
    expect(dialog.querySelectorAll('li')).toHaveLength(7);
    expect(dialog.textContent).toContain('and 2 more');
    // Default tone: focus on the confirm button, styled primary.
    const ok = dialog.querySelector('[data-confirm-ok]') as HTMLElement;
    expect(document.activeElement).toBe(ok);
    expect(ok.classList.contains('ut-btn--primary')).toBe(true);
    key(ok, 'Enter');
    await expect(answer).resolves.toBe(true);
  });

  it('danger: starts on Cancel, red confirm button, ↵ on Cancel cancels', async () => {
    const { answer, dialog } = await open({
      title: 'Kill?',
      confirmLabel: 'Kill',
      tone: 'danger',
    });
    const cancel = dialog.querySelector('[data-confirm-cancel]') as HTMLButtonElement;
    expect(document.activeElement).toBe(cancel);
    expect(cancel.textContent?.trim()).toBe('Cancel');
    expect(dialog.querySelector('[data-confirm-ok]')?.classList.contains('ut-btn--danger')).toBe(
      true
    );
    key(cancel, 'Enter');
    cancel.click();
    await expect(answer).resolves.toBe(false);
  });

  it('Esc and a backdrop click resolve false and remove the dialog', async () => {
    const first = await open({ title: 'A', confirmLabel: 'OK' });
    key(document, 'Escape');
    await expect(first.answer).resolves.toBe(false);
    await frame();
    expect(document.querySelector('ut-confirm-dialog')).toBeNull();

    const second = await open({ title: 'B', confirmLabel: 'OK' });
    (document.querySelector('[data-testid="modal-backdrop"]') as HTMLElement).click();
    await expect(second.answer).resolves.toBe(false);
  });

  describe('on a phone: action sheet (phone-spec §4.4, 2026-10-12)', () => {
    const realMatchMedia = window.matchMedia;
    const realWidth = window.innerWidth;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
      vi.useRealTimers();
    });
    const asPhone = () => {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
    };
    async function openSheet(options: Parameters<typeof confirmDialog>[0]) {
      const answer = confirmDialog(options);
      const host = document.querySelector('ut-confirm-dialog') as unknown as {
        updateComplete: Promise<unknown>;
      };
      await host.updateComplete;
      await frame();
      await host.updateComplete;
      return { answer, sheet: document.querySelector('.ut-confirm-sheet') as HTMLElement };
    }

    it('groups the question with the confirm, Cancel apart; no modal-wrapper', async () => {
      asPhone();
      const { answer, sheet } = await openSheet({
        title: 'Close 2 sessions?',
        body: 'The processes will be stopped.',
        confirmLabel: 'Close 2 sessions',
        tone: 'danger',
        details: ['a', 'b'],
      });
      expect(document.querySelector('ut-confirm-dialog modal-wrapper')).toBeNull();
      expect(sheet.getAttribute('role')).toBe('dialog');
      expect(sheet.classList.contains('open')).toBe(true);
      const group = sheet.querySelector('.psr-sheet-group') as HTMLElement;
      expect(group.textContent).toContain('Close 2 sessions?');
      expect(group.textContent).toContain('The processes will be stopped.');
      expect(group.querySelectorAll('li')).toHaveLength(2);
      const ok = group.querySelector('[data-confirm-ok]') as HTMLElement;
      expect(ok.classList.contains('destructive')).toBe(true);
      expect(group.querySelector('[data-confirm-cancel]')).toBeNull();
      expect(sheet.querySelector(':scope > .psr-sheet-cancel')).not.toBeNull();
      expect(sheet.querySelector('.ut-grabber')).not.toBeNull();
      // The sheet itself has focus (no ring on a button after a tap, no keyboard).
      expect(document.activeElement).toBe(sheet);
      ok.click();
      await expect(answer).resolves.toBe(true);
    });

    it('a stray ↵ on a danger sheet does not confirm', async () => {
      asPhone();
      const { answer, sheet } = await openSheet({
        title: 'Kill?',
        confirmLabel: 'Kill',
        tone: 'danger',
      });
      let settled = false;
      void answer.then(() => {
        settled = true;
      });
      key(sheet, 'Enter');
      await frame();
      expect(settled).toBe(false);
      (document.querySelector('.psr-sheet-backdrop') as HTMLElement).click();
      await expect(answer).resolves.toBe(false);
    });

    it('a backdrop tap cancels; the default tone confirm is neutral', async () => {
      asPhone();
      const { answer, sheet } = await openSheet({ title: 'Reset?', confirmLabel: 'Reset' });
      expect(sheet.querySelector('[data-confirm-ok]')?.classList.contains('destructive')).toBe(
        false
      );
      (document.querySelector('.psr-sheet-backdrop') as HTMLElement).click();
      await expect(answer).resolves.toBe(false);
    });

    it('a swipe down from the grabber cancels', async () => {
      asPhone();
      const { answer, sheet } = await openSheet({ title: 'Kill?', confirmLabel: 'Kill' });
      const grabber = sheet.querySelector('.ut-grabber') as HTMLElement;
      const ev = (type: string, y: number) =>
        new PointerEvent(type, { bubbles: true, clientY: y, button: 0, pointerType: 'mouse' });
      grabber.dispatchEvent(ev('pointerdown', 500));
      window.dispatchEvent(ev('pointermove', 520));
      window.dispatchEvent(ev('pointermove', 800));
      window.dispatchEvent(ev('pointerup', 800));
      await expect(answer).resolves.toBe(false);
    });
  });
});
