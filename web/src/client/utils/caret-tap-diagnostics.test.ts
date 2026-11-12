// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caretTapDiagnostics, describeCaretTap } from './caret-tap-diagnostics';

const pointer = (type: string, init: PointerEventInit) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init });

describe('caret tap diagnostics', () => {
  let field: HTMLTextAreaElement;

  beforeEach(() => {
    vi.useFakeTimers();
    field = document.createElement('textarea');
    field.value = 'hola que tal estas hoy';
    document.body.append(field);
  });

  afterEach(() => {
    field.remove();
    vi.useRealTimers();
  });

  const wire = (log: (line: string) => void) => {
    const taps = caretTapDiagnostics(log);
    field.addEventListener('pointerdown', taps.pointerdown);
    field.addEventListener('pointerup', taps.pointerup);
  };

  it('logs where a touch tap left the caret, once iOS has placed it, and never cancels it', () => {
    const log = vi.fn();
    wire(log);
    field.focus();
    field.setSelectionRange(22, 22);
    const down = pointer('pointerdown', { pointerType: 'touch', clientX: 40, clientY: 10 });
    field.dispatchEvent(down);
    // iOS moves the caret to the tap after the finger lifts.
    field.setSelectionRange(5, 5);
    const up = pointer('pointerup', { pointerType: 'touch', clientX: 42, clientY: 11 });
    field.dispatchEvent(up);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(log).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('at 40,10');
    expect(line).toContain('caret 22 -> 5 of 22');
    expect(line).toContain('focus yes -> yes');
    // Never the text itself.
    expect(line).not.toContain('hola');
  });

  it('reads the field and the viewport when the finger lands too, not only once settled', () => {
    const log = vi.fn();
    wire(log);
    const rect = vi
      .spyOn(field, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(61, 852, 318, 42));
    field.dispatchEvent(
      pointer('pointerdown', { pointerType: 'touch', clientX: 228, clientY: 870 })
    );
    field.dispatchEvent(pointer('pointerup', { pointerType: 'touch', clientX: 228, clientY: 870 }));
    // The keyboard opened and the field moved up above it before the line is written.
    rect.mockReturnValue(new DOMRect(61, 490, 318, 42));
    vi.advanceTimersByTime(500);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('field at the tap [61,852 318x42] now [61,490 318x42]');
    expect(line).toContain('vv at the tap');
  });

  it('says so when the tap took the focus away (iOS closing the keyboard instead)', () => {
    const log = vi.fn();
    wire(log);
    field.focus();
    field.dispatchEvent(pointer('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 }));
    field.dispatchEvent(pointer('pointerup', { pointerType: 'touch', clientX: 5, clientY: 5 }));
    field.blur();
    vi.advanceTimersByTime(500);
    expect(log.mock.calls[0][0]).toContain('focus yes -> no (lost)');
  });

  it('leaves mouse clicks and drags (a scroll, a selection handle) out', () => {
    const log = vi.fn();
    wire(log);
    field.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', clientX: 5, clientY: 5 }));
    field.dispatchEvent(pointer('pointerup', { pointerType: 'mouse', clientX: 5, clientY: 5 }));
    field.dispatchEvent(pointer('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 }));
    field.dispatchEvent(pointer('pointerup', { pointerType: 'touch', clientX: 5, clientY: 60 }));
    vi.advanceTimersByTime(500);
    expect(log).not.toHaveBeenCalled();
  });

  it('describes a selection as a range', () => {
    field.focus();
    field.setSelectionRange(5, 8);
    const line = describeCaretTap(field, { x: 1, y: 2, focusedBefore: false, caretBefore: null });
    expect(line).toContain('caret - -> 5-8 of 22');
    expect(line).toContain('focus no -> yes');
  });
});
