// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showActionToast, toast } from './action-toast';

const reduceMotion = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));

describe('toast', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.querySelector('.ut-toast-stack')?.remove();
  });

  it('stacks toasts in one container, the icon carrying the kind', () => {
    reduceMotion();
    toast({ kind: 'success', text: 'Saved' });
    toast({ kind: 'error', text: 'Failed' });
    const stacks = document.querySelectorAll('.ut-toast-stack');
    expect(stacks).toHaveLength(1);
    const toasts = [...document.querySelectorAll<HTMLElement>('.ut-toast')];
    expect(toasts.map((el) => el.dataset.kind)).toEqual(['success', 'error']);
    expect(toasts.map((el) => el.getAttribute('role'))).toEqual(['status', 'alert']);
    expect(toasts[0].querySelector('.ut-toast-icon svg')).not.toBeNull();
    expect(toasts[0].querySelector('.ut-toast-close')?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('times out after 4 s (errors 6 s), and the same text replaces the old one', () => {
    reduceMotion();
    vi.useFakeTimers();
    toast({ text: 'Hello' });
    toast({ text: 'Hello' });
    toast({ kind: 'error', text: 'Oops' });
    expect(document.querySelectorAll('.ut-toast')).toHaveLength(2);
    vi.advanceTimersByTime(4_001);
    expect([...document.querySelectorAll('.ut-toast')].map((el) => el.textContent)).toEqual([
      'Oops',
    ]);
    vi.advanceTimersByTime(2_000);
    expect(document.querySelector('.ut-toast-stack')).toBeNull();
  });

  it('dismisses with its close button and returns a dismiss function', () => {
    reduceMotion();
    const dismiss = toast({ text: 'A', timeoutMs: 0 });
    toast({ text: 'B', timeoutMs: 0 });
    (document.querySelector('.ut-toast .ut-toast-close') as HTMLButtonElement).click();
    expect(document.querySelectorAll('.ut-toast')).toHaveLength(1);
    dismiss(); // already gone: no-op
    expect(document.querySelector('.ut-toast')?.textContent).toBe('B');
  });
});

describe('showActionToast', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector('.ut-toast-stack')?.remove();
  });

  it('acts on a tap, not at the end of a drag that started on its button', () => {
    reduceMotion();
    const onAction = vi.fn();
    showActionToast({ text: 'New version', action: 'Reload', onAction, timeoutMs: 0 });
    const button = document.querySelector('.ut-toast-action') as HTMLButtonElement;
    expect(button.textContent).toBe('Reload');
    // iOS ends a drag that began on a button with a pointerup on it.
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 300,
        clientY: y,
        bubbles: true,
      });
      button.dispatchEvent(new PointerEvent('pointerdown', at(700)));
      button.dispatchEvent(new PointerEvent('pointerup', at(700 + dy)));
    };
    touch(-100);
    expect(onAction).not.toHaveBeenCalled();
    expect(document.querySelector('.ut-toast')).not.toBeNull();
    touch(2);
    document.body.click(); // the click after the tap lands where the toast was: swallowed
    expect(onAction).toHaveBeenCalledOnce();
    expect(document.querySelector('.ut-toast')).toBeNull();
  });
});

describe('toast on a phone (phone-spec §3.10, 2026-10-12)', () => {
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;
  const asPhone = (viewport?: { height: number; offsetTop: number }) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce') || query.includes('coarse'),
    }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 393 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 852 });
    vi.stubGlobal('visualViewport', {
      height: viewport?.height ?? 852,
      offsetTop: viewport?.offsetTop ?? 0,
      addEventListener() {},
      removeEventListener() {},
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
    document.querySelector('.ut-toast-stack')?.remove();
  });

  const swipe = (el: HTMLElement, dx: number) => {
    const ev = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: 600,
      });
    el.dispatchEvent(ev('pointerdown', 100));
    el.dispatchEvent(ev('pointermove', 100 + dx / 2));
    el.dispatchEvent(ev('pointermove', 100 + dx));
    el.dispatchEvent(ev('pointerup', 100 + dx));
  };

  it('a sideways swipe past 60 px dismisses; a short one springs back', () => {
    asPhone();
    toast({ text: 'Swipe me', timeoutMs: 0 });
    const el = document.querySelector('.ut-toast') as HTMLElement;
    swipe(el, 40);
    expect(document.querySelector('.ut-toast')).toBe(el);
    expect(el.style.transform).toBe('');
    swipe(el, -90);
    expect(document.querySelector('.ut-toast')).toBeNull();
  });

  it('lifts the stack above the soft keyboard (visualViewport)', () => {
    asPhone({ height: 500, offsetTop: 0 });
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    toast({ text: 'Typed', timeoutMs: 0 });
    const stackEl = document.querySelector('.ut-toast-stack') as HTMLElement;
    expect(stackEl.style.bottom).toBe(`${852 - 500 + 12}px`);
    field.remove();
  });

  it('a short viewport with no field focused is not a keyboard (2026-11-11)', () => {
    asPhone({ height: 500, offsetTop: 0 });
    toast({ text: 'Stale', timeoutMs: 0 });
    expect((document.querySelector('.ut-toast-stack') as HTMLElement).style.bottom).toBe('');
  });

  it('without a keyboard leaves the bottom to the CSS (bar + safe area)', () => {
    asPhone();
    toast({ text: 'Rest', timeoutMs: 0 });
    expect((document.querySelector('.ut-toast-stack') as HTMLElement).style.bottom).toBe('');
  });
});
