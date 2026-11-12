/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index.js';

const mocks = vi.hoisted(() => ({ copy: vi.fn(), toast: vi.fn() }));
vi.mock('../utils/path-utils.js', async (orig) => ({
  ...(await orig<typeof import('../utils/path-utils.js')>()),
  copyToClipboard: mocks.copy,
}));
vi.mock('../utils/action-toast.js', () => ({ toast: mocks.toast }));

import type { ClickablePath } from './clickable-path.js';
import './clickable-path.js';

async function mount(): Promise<ClickablePath> {
  const el = document.createElement('clickable-path') as ClickablePath;
  el.path = '/Users/me/Projects/web';
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('clickable-path', () => {
  afterEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    await setLocale('en');
  });

  it('shows an error toast when the copy fails (no silent failure)', async () => {
    await setLocale('es');
    mocks.copy.mockResolvedValue(false);
    const el = await mount();
    (el.firstElementChild as HTMLElement).click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', text: 'No se pudo copiar' });
  });

  it('shows no toast when the copy works', async () => {
    mocks.copy.mockResolvedValue(true);
    const el = await mount();
    (el.firstElementChild as HTMLElement).click();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
