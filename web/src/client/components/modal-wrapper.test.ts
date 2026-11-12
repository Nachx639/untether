// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModalWrapper } from './modal-wrapper.js';
import './modal-wrapper.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const tab = (shiftKey = false) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));

describe('modal-wrapper', () => {
  afterEach(() => fixtureCleanup());

  // 2026-10-12: with a light-DOM <slot> the caller's children landed beside the backdrop and
  // the dialog was an empty 512×2 box (⌘K, tmux, clipboard).
  it('makes the caller’s single root the dialog, with the input inside it', async () => {
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper visible .ariaLabel=${'Switch'}
        ><div class="mine"><input id="q" /></div
      ></modal-wrapper>`
    );
    const dialog = wrapper.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.classList.contains('mine')).toBe(true);
    expect(dialog.querySelector('#q')).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Switch');
    expect(dialog.dataset.testid).toBe('modal-content');
    // The dialog look and the shrink fix; the host is the fixed frame.
    expect([...dialog.classList]).toEqual(
      expect.arrayContaining(['ut-dialog', 'ut-dialog--md', 'min-w-0'])
    );
    expect(dialog.classList.contains('font-mono')).toBe(false);
    expect(wrapper.classList.contains('ut-modal-host')).toBe(true);
    expect(wrapper.hidden).toBe(false);
    // Only the backdrop is rendered by the wrapper, next to the dialog.
    expect(wrapper.querySelector(':scope > [data-testid="modal-backdrop"]')).not.toBeNull();
  });

  it('swaps contentClass classes without touching the caller’s own', async () => {
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper visible contentClass="a b"><div class="b mine"></div></modal-wrapper>`
    );
    const dialog = wrapper.querySelector('[role="dialog"]') as HTMLElement;
    wrapper.contentClass = 'c';
    await wrapper.updateComplete;
    expect(dialog.classList.contains('a')).toBe(false);
    expect(dialog.classList.contains('b')).toBe(true); // the caller had it
    expect(dialog.classList.contains('c')).toBe(true);
    expect(dialog.classList.contains('mine')).toBe(true);
  });

  it('is hidden, without a backdrop, when not visible (also via .open)', async () => {
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper><div>content</div></modal-wrapper>`
    );
    expect(wrapper.hidden).toBe(true);
    expect(wrapper.classList.contains('ut-modal-host')).toBe(false);
    expect(wrapper.querySelector('[data-testid="modal-backdrop"]')).toBeNull();
    wrapper.open = true;
    await wrapper.updateComplete;
    expect(wrapper.hidden).toBe(false);
    expect(wrapper.querySelector('[role="dialog"]')?.textContent).toBe('content');
  });

  it('closes on Escape and on a backdrop click, not on a click inside', async () => {
    const onClose = vi.fn();
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper visible @close=${onClose}><div><button>x</button></div></modal-wrapper>`
    );
    wrapper.querySelector('button')?.click();
    expect(onClose).not.toHaveBeenCalled();
    (wrapper.querySelector('[data-testid="modal-backdrop"]') as HTMLElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('one Escape closes only the top dialog of a stack', async () => {
    const below = vi.fn();
    const top = vi.fn();
    const lower = await fixture<ModalWrapper>(
      html`<modal-wrapper visible @close=${below}><div>form</div></modal-wrapper>`
    );
    const upper = await fixture<ModalWrapper>(
      html`<modal-wrapper visible @close=${top}><div>picker</div></modal-wrapper>`
    );
    const later = vi.fn();
    document.addEventListener('keydown', later);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      document.removeEventListener('keydown', later);
    }
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    upper.visible = false;
    await upper.updateComplete;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(below).toHaveBeenCalledTimes(1);
    lower.visible = false;
  });

  it('focuses the field, traps Tab inside, and gives focus back on close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper
        ><div>
          <button aria-label="Close" id="close">×</button>
          <input id="field" />
          <button id="ok">OK</button>
        </div></modal-wrapper
      >`
    );
    opener.focus();
    wrapper.visible = true;
    await wrapper.updateComplete;
    await frame();
    expect(document.activeElement?.id).toBe('field');

    (wrapper.querySelector('#ok') as HTMLElement).focus();
    tab();
    expect(document.activeElement?.id).toBe('close');
    tab(true);
    expect(document.activeElement?.id).toBe('ok');

    wrapper.visible = false;
    await wrapper.updateComplete;
    (document.activeElement as HTMLElement | null)?.blur();
    await frame();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('honours initialFocus and placement="top"', async () => {
    const wrapper = await fixture<ModalWrapper>(
      html`<modal-wrapper visible initialFocus="#ok" placement="top"
        ><div><input /><button id="ok">OK</button></div></modal-wrapper
      >`
    );
    await frame();
    expect(document.activeElement?.id).toBe('ok');
    expect(wrapper.getAttribute('placement')).toBe('top');
  });

  describe('placement="sheet" (phone-spec §3.2, 2026-10-12)', () => {
    const realMatchMedia = window.matchMedia;
    const realWidth = window.innerWidth;
    const phone = (coarse: boolean, width = 393) => {
      window.matchMedia = ((query: string) => ({
        matches: coarse && query.includes('coarse'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      })) as unknown as typeof window.matchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    };
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    });

    it('on a phone focuses the sheet itself, not the field (no keyboard over the choices)', async () => {
      phone(true);
      const wrapper = await fixture<ModalWrapper>(
        html`<modal-wrapper visible placement="sheet"
          ><div data-testid="mine"><input id="field" /></div
        ></modal-wrapper>`
      );
      await frame();
      const dialog = wrapper.querySelector('[role="dialog"]') as HTMLElement;
      expect(wrapper.getAttribute('placement')).toBe('sheet');
      expect(document.activeElement).toBe(dialog);
      // A caller's own test id is kept; the frame CSS keys off data-modal-content.
      expect(dialog.dataset.testid).toBe('mine');
      expect(dialog.hasAttribute('data-modal-content')).toBe(true);
    });

    it('closes when dragged down from a handle', async () => {
      phone(true);
      const onClose = vi.fn();
      const wrapper = await fixture<ModalWrapper>(
        html`<modal-wrapper visible placement="sheet" @close=${onClose}
          ><div><header data-sheet-handle>Title</header><p>body</p></div></modal-wrapper
        >`
      );
      const handle = wrapper.querySelector('header') as HTMLElement;
      const pointer = (type: string, y: number) =>
        new PointerEvent(type, {
          bubbles: true,
          clientX: 10,
          clientY: y,
          button: 0,
          pointerType: 'mouse',
        });
      handle.dispatchEvent(pointer('pointerdown', 100));
      window.dispatchEvent(pointer('pointermove', 140));
      window.dispatchEvent(pointer('pointermove', 400));
      window.dispatchEvent(pointer('pointerup', 400));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('on a desktop stays the centred dialog: field focus, no drag', async () => {
      phone(false, 1440);
      const onClose = vi.fn();
      const wrapper = await fixture<ModalWrapper>(
        html`<modal-wrapper visible placement="sheet" @close=${onClose}
          ><div><header data-sheet-handle>Title</header><input id="field" /></div></modal-wrapper
        >`
      );
      await frame();
      expect(document.activeElement?.id).toBe('field');
      const handle = wrapper.querySelector('header') as HTMLElement;
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientY: 100,
          button: 0,
          pointerType: 'mouse',
        })
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 400, pointerType: 'mouse' }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 400, pointerType: 'mouse' }));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
