// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followKeyboard } from './follow-keyboard.js';
import { KEYBOARD_BLUR_RECHECK_MS } from './soft-keyboard.js';

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

describe('followKeyboard', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  afterEach(() => {
    if (original) Object.defineProperty(window, 'visualViewport', original);
  });

  it('lifts the sheet above the keyboard and drops it back when it closes', () => {
    const vv = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const sheet = document.createElement('div');
    const field = document.createElement('input');
    sheet.append(field);
    document.body.append(sheet);
    const stop = followKeyboard(sheet);
    expect(sheet.style.bottom).toBe('');
    field.focus();
    vv.height = 450;
    vv.dispatchEvent(new Event('resize'));
    expect(sheet.style.bottom).toBe('350px');
    expect(sheet.style.maxHeight).toBe('442px');
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    expect(sheet.style.bottom).toBe('');
    stop();
    vv.height = 400;
    vv.dispatchEvent(new Event('resize'));
    expect(sheet.style.bottom).toBe('');
    sheet.remove();
  });

  // 2026-11-11: the keyboard's gap with no keyboard. iOS can leave the visual viewport at its
  // keyboard-up size with no resize once the keyboard has gone.
  it('drops the sheet back when the field loses the focus and the viewport says nothing', () => {
    vi.useFakeTimers();
    const vv = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const sheet = document.createElement('div');
    const field = document.createElement('input');
    sheet.append(field);
    document.body.append(sheet);
    const stop = followKeyboard(sheet);
    field.focus();
    vv.height = 450;
    vv.dispatchEvent(new Event('resize'));
    expect(sheet.style.bottom).toBe('350px');

    field.blur(); // the keyboard goes; the viewport keeps 450 and fires nothing
    vi.advanceTimersByTime(KEYBOARD_BLUR_RECHECK_MS[0]);
    expect(sheet.style.bottom).toBe('');
    expect(sheet.style.maxHeight).toBe('');
    stop();
    sheet.remove();
    vi.useRealTimers();
  });

  it('a stale viewport with nothing focused never lifts the sheet', () => {
    const vv = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const sheet = document.createElement('div');
    document.body.append(sheet);
    vv.height = 450;
    const stop = followKeyboard(sheet);
    vv.dispatchEvent(new Event('resize'));
    expect(sheet.style.bottom).toBe('');
    stop();
    sheet.remove();
  });
});
