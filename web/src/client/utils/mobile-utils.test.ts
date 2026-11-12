// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachSheetDrag, isPhoneScreen } from './mobile-utils';

const realWidth = window.innerWidth;
const realHeight = window.innerHeight;

function screen(coarse: boolean, width: number, height: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query.includes('coarse'),
    media: query,
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
  document.body.replaceChildren();
});

describe('isPhoneScreen', () => {
  it('is a touch screen whose short side is under 600 px, either orientation', () => {
    screen(true, 393, 852);
    expect(isPhoneScreen()).toBe(true);
    screen(true, 852, 393);
    expect(isPhoneScreen()).toBe(true);
    screen(true, 820, 1180);
    expect(isPhoneScreen()).toBe(false);
    screen(false, 393, 852);
    expect(isPhoneScreen()).toBe(false);
  });
});

describe('attachSheetDrag (phone-spec §3.2, 2026-10-12)', () => {
  function sheet() {
    const el = document.createElement('div');
    el.innerHTML = `<div data-sheet-handle class="grab"></div><div class="body"><input /></div>`;
    document.body.append(el);
    return el;
  }
  const pointer = (type: string, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      clientY: y,
      clientX: 0,
      button: 0,
      pointerType: 'mouse',
    });

  it('a drag from the handle past 30% dismisses; a short one springs back', () => {
    const el = sheet();
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect);
    // A slow drag (100 ms between moves): distance decides, not a flick.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 100));
    const onDismiss = vi.fn();
    const detach = attachSheetDrag(el, { onDismiss });
    const handle = el.querySelector('.grab') as HTMLElement;

    handle.dispatchEvent(pointer('pointerdown', 100));
    window.dispatchEvent(pointer('pointermove', 120));
    window.dispatchEvent(pointer('pointermove', 150));
    expect(el.style.transform).toBe('translateY(50px)');
    window.dispatchEvent(pointer('pointerup', 150));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');

    handle.dispatchEvent(pointer('pointerdown', 100));
    window.dispatchEvent(pointer('pointermove', 120));
    window.dispatchEvent(pointer('pointermove', 260));
    window.dispatchEvent(pointer('pointerup', 260));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    detach();
  });

  it('never starts on a field, nor with the mouse outside a handle', () => {
    const el = sheet();
    const onDismiss = vi.fn();
    attachSheetDrag(el, { onDismiss });
    const input = el.querySelector('input') as HTMLElement;
    input.dispatchEvent(pointer('pointerdown', 100));
    window.dispatchEvent(pointer('pointermove', 400));
    window.dispatchEvent(pointer('pointerup', 400));
    (el.querySelector('.body') as HTMLElement).dispatchEvent(pointer('pointerdown', 100));
    window.dispatchEvent(pointer('pointermove', 400));
    window.dispatchEvent(pointer('pointerup', 400));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('an upward drag is a scroll, not a dismiss', () => {
    const el = sheet();
    const onDismiss = vi.fn();
    attachSheetDrag(el, { onDismiss });
    const handle = el.querySelector('.grab') as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 300));
    window.dispatchEvent(pointer('pointermove', 280));
    window.dispatchEvent(pointer('pointermove', 600));
    window.dispatchEvent(pointer('pointerup', 600));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');
  });
});
