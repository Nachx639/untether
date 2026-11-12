// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import type { RenameField, SaveName } from './rename-field.js';
import './rename-field.js';

async function mount(save: SaveName, value = 'Fix login', allowEmpty = false) {
  const done = vi.fn();
  const cancelled = vi.fn();
  const el = await fixture<RenameField>(
    html`<ut-rename-field
      .value=${value}
      .save=${save}
      ?allowEmpty=${allowEmpty}
      @rename-done=${(e: CustomEvent) => done(e.detail)}
      @rename-cancel=${cancelled}
    ></ut-rename-field>`
  );
  const input = el.querySelector<HTMLInputElement>(
    '[data-testid="rename-input"]'
  ) as HTMLInputElement;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const key = (k: string) =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const button = (id: string) => el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  const error = () => el.querySelector('[data-testid="rename-error"]')?.textContent?.trim();
  return { el, input, type, key, button, error, done, cancelled };
}

describe('ut-rename-field', () => {
  afterEach(() => fixtureCleanup());

  it('starts with the current name, focused and selected', async () => {
    const { input } = await mount(vi.fn());
    expect(input.value).toBe('Fix login');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Fix login'.length);
  });

  it('leaves the case alone: session names are often lowercase like create-diez-txt-file', async () => {
    const { input } = await mount(vi.fn());
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
  });

  it('saves the trimmed name with OK or Enter, then says it is done', async () => {
    const save = vi.fn(async () => undefined);
    const field = await mount(save);
    field.type('  Mi tarea ');
    field.button('rename-ok')?.click();
    await vi.waitFor(() => expect(field.done).toHaveBeenCalledWith({ name: 'Mi tarea' }));
    expect(save).toHaveBeenCalledWith('Mi tarea');

    const enter = await mount(save);
    enter.type('Otra');
    enter.key('Enter');
    await vi.waitFor(() => expect(enter.done).toHaveBeenCalledWith({ name: 'Otra' }));
    expect(save).toHaveBeenLastCalledWith('Otra');
  });

  it('cancels with Cancel, Escape, or the same name, without saving', async () => {
    const save = vi.fn(async () => undefined);
    const field = await mount(save);
    field.type('Changed');
    field.button('rename-cancel')?.click();
    expect(field.cancelled).toHaveBeenCalledTimes(1);

    field.key('Escape');
    expect(field.cancelled).toHaveBeenCalledTimes(2);

    field.type(' Fix login ');
    field.key('Enter');
    await vi.waitFor(() => expect(field.cancelled).toHaveBeenCalledTimes(3));
    expect(save).not.toHaveBeenCalled();
    expect(field.done).not.toHaveBeenCalled();
  });

  it('Escape cancels the rename only, not the sheet around it', async () => {
    const field = await mount(vi.fn());
    const sheet = document.createElement('div');
    sheet.append(field.el);
    document.body.append(sheet);
    const closeSheet = vi.fn();
    const release = holdSheetFocus(sheet, closeSheet);
    field.input.focus();
    field.key('Escape');
    expect(field.cancelled).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
    release();
    sheet.remove();
  });

  it('rejects an empty name and keeps the field open', async () => {
    const save = vi.fn(async () => undefined);
    const field = await mount(save);
    field.type('   ');
    field.button('rename-ok')?.click();
    await field.el.updateComplete;
    expect(field.error()).toBe('The name can’t be empty');
    expect(field.input.getAttribute('aria-invalid')).toBe('true');
    expect(save).not.toHaveBeenCalled();
    expect(field.done).not.toHaveBeenCalled();
    // Typing clears the message.
    field.type('M');
    await field.el.updateComplete;
    expect(field.error()).toBe('');
  });

  it('allows an empty name where it means something (allowEmpty)', async () => {
    const save = vi.fn(async () => undefined);
    const field = await mount(save, 'Mi tienda', true);
    field.type('');
    field.key('Enter');
    await vi.waitFor(() => expect(field.done).toHaveBeenCalledWith({ name: '' }));
    expect(save).toHaveBeenCalledWith('');
  });

  it('shows a failed save and stays open with the name typed, to retry', async () => {
    const save = vi
      .fn<SaveName>()
      .mockResolvedValueOnce('Failed to rename session: Rename failed: 500')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const field = await mount(save);
    field.type('Mi tarea');
    field.button('rename-ok')?.click();
    await vi.waitFor(() =>
      expect(field.error()).toBe('Failed to rename session: Rename failed: 500')
    );
    expect(field.done).not.toHaveBeenCalled();
    expect(field.input.value).toBe('Mi tarea');
    expect(field.input.readOnly).toBe(false);

    field.button('rename-ok')?.click();
    await vi.waitFor(() => expect(field.error()).toBe('offline'));

    field.button('rename-ok')?.click();
    await vi.waitFor(() => expect(field.done).toHaveBeenCalledWith({ name: 'Mi tarea' }));
    expect(save).toHaveBeenCalledTimes(3);
  });
});
