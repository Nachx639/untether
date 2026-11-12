// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/index.js';
import type { BrowserSSHAgent } from '../services/ssh-agent.js';
import type { SSHKeyManager } from './ssh-key-manager.js';
import './ssh-key-manager.js';

const confirmDialog = vi.hoisted(() => vi.fn());
vi.mock('../utils/confirm-dialog.js', () => ({ confirmDialog }));

interface StoredKey {
  id: string;
  name: string;
  publicKey: string;
  algorithm: 'Ed25519';
  encrypted: boolean;
  fingerprint: string;
  createdAt: string;
}

const key = (id: string, name: string, encrypted = false): StoredKey => ({
  id,
  name,
  publicKey: `ssh-ed25519 AAAA${id} ${name}`,
  algorithm: 'Ed25519',
  encrypted,
  fingerprint: `SHA256:${id}`,
  createdAt: '2026-11-01T10:00:00.000Z',
});

/** The agent as the manager uses it: a list of keys in memory. */
function fakeAgent(initial: StoredKey[] = []) {
  const keys = [...initial];
  return {
    keys,
    listKeys: vi.fn(() => [...keys]),
    generateKeyPair: vi.fn(async (name: string, password?: string) => {
      keys.push(key('generated', name, !!password));
      return { keyId: 'generated', privateKeyPEM: 'PEM' };
    }),
    addKey: vi.fn(async (name: string, _pem: string) => {
      keys.push(key('imported', name));
      return 'imported';
    }),
    removeKey: vi.fn((id: string) => {
      keys.splice(
        keys.findIndex((stored) => stored.id === id),
        1
      );
    }),
    getPublicKey: vi.fn((id: string) => keys.find((stored) => stored.id === id)?.publicKey ?? null),
  };
}

/**
 * 2026-11-11: the manager's only tests were the Playwright spec ssh-key-manager.spec.ts, which
 * skipped itself on the test server (it runs with --no-auth, where the login page and its
 * "SSH keys" entry never show), so nothing ever ran. What that spec meant to cover is here,
 * against the component with an agent in memory.
 */
describe('ssh-key-manager', () => {
  let downloads: string[];

  beforeEach(() => {
    confirmDialog.mockReset();
    downloads = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    fixtureCleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function open(agent: ReturnType<typeof fakeAgent>) {
    const el = await fixture<SSHKeyManager>(
      html`<ssh-key-manager
        visible
        .sshAgent=${agent as unknown as BrowserSSHAgent}
      ></ssh-key-manager>`
    );
    await el.updateComplete;
    return el;
  }

  const button = (el: Element, label: string) => {
    const found = [...el.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.trim().endsWith(label) ||
        candidate.getAttribute('aria-label') === label
    );
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  };

  const type = (input: Element | null, value: string) => {
    if (!input) throw new Error('no field');
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  async function openAddForm(el: SSHKeyManager) {
    button(el, t('ssh.addKey')).click();
    await el.updateComplete;
  }

  it('renders nothing until it is visible', async () => {
    const el = await fixture<SSHKeyManager>(
      html`<ssh-key-manager .sshAgent=${fakeAgent() as unknown as BrowserSSHAgent}></ssh-key-manager>`
    );
    expect(el.querySelector('modal-wrapper')).toBeNull();
  });

  it('says so when there are no keys', async () => {
    const el = await open(fakeAgent());
    expect(el.textContent).toContain(t('ssh.empty'));
  });

  it('lists each key with its fingerprint and marks the encrypted ones', async () => {
    const el = await open(fakeAgent([key('one', 'laptop'), key('two', 'phone', true)]));
    const text = el.textContent ?? '';
    expect(text).toContain('laptop');
    expect(text).toContain('phone');
    expect(text).toContain(t('ssh.fingerprint', { value: 'SHA256:one' }));
    expect(text).toContain(t('ssh.fingerprint', { value: 'SHA256:two' }));
    expect(text.split(t('ssh.encrypted'))).toHaveLength(2);
    expect(text).not.toContain(t('ssh.empty'));
  });

  it('does not generate a key without a name', async () => {
    const agent = fakeAgent();
    const el = await open(agent);
    await openAddForm(el);
    expect(button(el, t('ssh.generate')).disabled).toBe(true);
    button(el, t('ssh.generate')).click();
    await el.updateComplete;
    expect(agent.generateKeyPair).not.toHaveBeenCalled();

    type(el.querySelector('input[type="text"]'), '   ');
    await el.updateComplete;
    expect(button(el, t('ssh.generate')).disabled).toBe(true);
    type(el.querySelector('input[type="text"]'), 'laptop');
    await el.updateComplete;
    expect(button(el, t('ssh.generate')).disabled).toBe(false);
  });

  it('generates a key, downloads its private half, lists it and shows how to install it', async () => {
    const agent = fakeAgent();
    const el = await open(agent);
    await openAddForm(el);
    type(el.querySelector('input[type="text"]'), 'my laptop');
    type(el.querySelector('input[type="password"]'), 'secret');
    await el.updateComplete;
    button(el, t('ssh.generate')).click();
    await vi.waitFor(() =>
      expect(el.querySelector('[role="status"]')?.textContent).toContain(
        t('ssh.generated', { name: 'my laptop' })
      )
    );

    expect(agent.generateKeyPair).toHaveBeenCalledWith('my laptop', 'secret');
    expect(downloads).toEqual(['my_laptop_private.pem']);
    const text = el.textContent ?? '';
    expect(text).toContain(t('ssh.setupTitle'));
    expect(text).toContain('ssh-ed25519 AAAAgenerated my laptop');
    expect(text).toContain(t('ssh.fingerprint', { value: 'SHA256:generated' }));
    // The form closed: its button is "Add key" again.
    expect(() => button(el, t('ssh.addKey'))).not.toThrow();
  });

  it('does not import without a name and a key', async () => {
    const agent = fakeAgent();
    const el = await open(agent);
    await openAddForm(el);
    expect(button(el, t('ssh.import')).disabled).toBe(true);
    type(el.querySelectorAll('input[type="text"]')[1], 'server key');
    await el.updateComplete;
    expect(button(el, t('ssh.import')).disabled).toBe(true);
    button(el, t('ssh.import')).click();
    await el.updateComplete;
    expect(agent.addKey).not.toHaveBeenCalled();

    type(el.querySelector('textarea'), 'key');
    await el.updateComplete;
    expect(button(el, t('ssh.import')).disabled).toBe(false);
  });

  it('imports a private key and lists it', async () => {
    const agent = fakeAgent();
    const el = await open(agent);
    await openAddForm(el);
    type(el.querySelectorAll('input[type="text"]')[1], 'server key');
    type(
      el.querySelector('textarea'),
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    );
    await el.updateComplete;
    button(el, t('ssh.import')).click();
    await vi.waitFor(() =>
      expect(el.querySelector('[role="status"]')?.textContent).toContain(
        t('ssh.imported', { name: 'server key' })
      )
    );

    expect(agent.addKey).toHaveBeenCalledWith(
      'server key',
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    );
    expect(el.textContent).toContain(t('ssh.fingerprint', { value: 'SHA256:imported' }));
  });

  it('shows why a key could not be imported and keeps the form open', async () => {
    const agent = fakeAgent();
    agent.addKey.mockRejectedValueOnce(new Error('Unsupported key format'));
    const el = await open(agent);
    await openAddForm(el);
    type(el.querySelectorAll('input[type="text"]')[1], 'bad');
    type(el.querySelector('textarea'), 'not a key');
    await el.updateComplete;
    button(el, t('ssh.import')).click();
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Unsupported key format')
    );

    expect(el.querySelector('textarea')).not.toBeNull();
    expect(el.textContent).toContain(t('ssh.empty'));
  });

  it('removes a key only after the confirmation', async () => {
    const agent = fakeAgent([key('one', 'laptop')]);
    const el = await open(agent);

    confirmDialog.mockResolvedValueOnce(false);
    button(el, t('ssh.removeKey')).click();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    await el.updateComplete;
    expect(agent.removeKey).not.toHaveBeenCalled();
    expect(el.textContent).toContain('laptop');

    confirmDialog.mockResolvedValueOnce(true);
    button(el, t('ssh.removeKey')).click();
    await vi.waitFor(() => expect(agent.removeKey).toHaveBeenCalledWith('one'));
    await vi.waitFor(() => expect(el.textContent).toContain(t('ssh.empty')));
    expect(confirmDialog.mock.calls[1][0]).toMatchObject({ tone: 'danger' });
  });

  it('downloads the public half of a key', async () => {
    const el = await open(fakeAgent([key('one', 'my laptop')]));
    button(el, t('ssh.public')).click();
    expect(downloads).toEqual(['my_laptop_public.pub']);
  });

  it('closes with its button and with Escape, and stops listening once hidden', async () => {
    const el = await open(fakeAgent());
    const closed = vi.fn();
    el.addEventListener('close', closed);

    (el.querySelector('[data-modal-close]') as HTMLButtonElement).click();
    expect(closed).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledTimes(2);

    el.visible = false;
    await el.updateComplete;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledTimes(2);
  });
});
