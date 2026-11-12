// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { computePopoverPosition, menuKeyboard, positionPopover } from './popover-position.js';
import { formatShortcut } from './shortcut-label.js';

const VIEW = { width: 1440, height: 900 };
const rect = (left: number, top: number, w = 28, h = 28) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe('computePopoverPosition', () => {
  it('opens below, aligned to the anchor start', () => {
    const p = computePopoverPosition(rect(100, 40), { width: 240, height: 200 }, VIEW);
    expect(p).toMatchObject({ top: 74, left: 100, side: 'bottom' });
  });

  it('aligns the end with bottom-end', () => {
    const p = computePopoverPosition(rect(1300, 40), { width: 240, height: 200 }, VIEW, {
      placement: 'bottom-end',
    });
    expect(p.left).toBe(1328 - 240);
  });

  it('flips above when less than 320 px are left below', () => {
    const p = computePopoverPosition(rect(100, 700), { width: 240, height: 300 }, VIEW);
    expect(p.side).toBe('top');
    expect(p.top).toBe(700 - 6 - 300);
  });

  it('stays below when a small popover fits even near the bottom', () => {
    const p = computePopoverPosition(rect(100, 700), { width: 240, height: 120 }, VIEW);
    expect(p.side).toBe('bottom');
  });

  it('clamps 8 px inside the viewport on both edges', () => {
    expect(computePopoverPosition(rect(1430, 40), { width: 240, height: 100 }, VIEW).left).toBe(
      1440 - 8 - 240
    );
    expect(
      computePopoverPosition(rect(2, 40), { width: 240, height: 100 }, VIEW, {
        placement: 'bottom-end',
      }).left
    ).toBe(8);
  });

  it('limits the height to the room it has', () => {
    const p = computePopoverPosition(rect(100, 100), { width: 240, height: 2000 }, VIEW);
    expect(p.side).toBe('bottom');
    expect(p.maxHeight).toBe(900 - 128 - 6 - 8);
  });
});

describe('positionPopover', () => {
  it('sets position: fixed and the computed top/left', () => {
    const anchor = document.createElement('button');
    const menu = document.createElement('div');
    document.body.append(anchor, menu);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 50, y: 20, width: 28, height: 28 })
    );
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 100 })
    );
    positionPopover(anchor, menu);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).toBe('54px');
    expect(menu.style.left).toBe('50px');
    expect(menu.dataset.side).toBe('bottom');
    anchor.remove();
    menu.remove();
  });
});

describe('menuKeyboard', () => {
  function menu() {
    const el = document.createElement('div');
    el.innerHTML = `<button role="menuitem">A</button><button role="menuitem" disabled>B</button>
      <button role="menuitem">C</button><button role="menuitem">D</button>`;
    document.body.append(el);
    return el;
  }
  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('moves with arrows (wrapping, skipping disabled), Home and End', () => {
    const el = menu();
    const stop = menuKeyboard(el, { focusFirst: true });
    const label = () => document.activeElement?.textContent;
    expect(label()).toBe('A');
    key(el, 'ArrowDown');
    expect(label()).toBe('C');
    key(el, 'End');
    expect(label()).toBe('D');
    key(el, 'ArrowDown');
    expect(label()).toBe('A');
    key(el, 'ArrowUp');
    expect(label()).toBe('D');
    key(el, 'Home');
    expect(label()).toBe('A');
    expect(el.querySelector('[data-active]')?.textContent).toBe('A');
    stop();
    el.remove();
  });

  it('activates with Enter and closes with Esc', () => {
    const el = menu();
    const onClose = vi.fn();
    const clicked = vi.fn();
    el.querySelectorAll('button')[2].addEventListener('click', clicked);
    menuKeyboard(el, { onClose, focusFirst: true });
    key(el, 'ArrowDown');
    key(el, 'Enter');
    expect(clicked).toHaveBeenCalledOnce();
    key(el, 'Escape');
    expect(onClose).toHaveBeenCalledOnce();
    el.remove();
  });
});

describe('formatShortcut', () => {
  it('uses Mac glyphs on a Mac and words elsewhere', () => {
    expect(formatShortcut('mod+k', true)).toBe('⌘K');
    expect(formatShortcut('mod+k', false)).toBe('Ctrl+K');
    expect(formatShortcut('mod+shift+n', true)).toBe('⇧⌘N');
    expect(formatShortcut('mod+shift+n', false)).toBe('Ctrl+Shift+N');
    expect(formatShortcut('mod+enter', true)).toBe('⌘↵');
    expect(formatShortcut('esc', true)).toBe('⎋');
    expect(formatShortcut('esc', false)).toBe('Esc');
    expect(formatShortcut('mod+,', true)).toBe('⌘,');
    expect(formatShortcut('mod+backspace', true)).toBe('⌘⌫');
    expect(formatShortcut('alt+ctrl+t', true)).toBe('⌃⌥T');
  });
});
