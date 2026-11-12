// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InlineEdit } from './inline-edit';

describe('InlineEdit', () => {
  beforeAll(async () => {
    await import('./inline-edit');
  });

  const edit = async (onSave: (value: string) => void) => {
    const el = await fixture<InlineEdit>(
      html`<inline-edit .value=${'old'} .onSave=${onSave}></inline-edit>`
    );
    const icon = el.shadowRoot?.querySelector('.edit-icon') as SVGElement;
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    const input = el.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'new';
    input.dispatchEvent(new Event('input'));
    return { el, input };
  };

  it('Enter saves the trimmed value and closes the editor', async () => {
    const onSave = vi.fn();
    const { el, input } = await edit(onSave);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await el.updateComplete;
    expect(onSave).toHaveBeenCalledWith('new');
    expect(el.shadowRoot?.querySelector('input')).toBeNull();
  });

  it('the Enter that confirms an IME candidate does not save a half-typed value', async () => {
    const onSave = vi.fn();
    const { el, input } = await edit(onSave);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true })
    );
    await el.updateComplete;
    expect(onSave).not.toHaveBeenCalled();
    expect(el.shadowRoot?.querySelector('input')).not.toBeNull();
  });

  it('the save and cancel hovers use a translucent mix, not the opaque icon color', () => {
    const css = (InlineEdit as unknown as { styles: Array<{ cssText?: string }> }).styles
      .map((style) => style.cssText ?? '')
      .join('\n');
    expect(css).not.toContain('background-opacity');
    expect(css).toMatch(/button\.save:hover\s*\{[^}]*color-mix\(/);
    expect(css).toMatch(/button\.cancel:hover\s*\{[^}]*color-mix\(/);
  });
});
