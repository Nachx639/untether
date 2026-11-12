import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { DEFAULT_VAPID_CONTACT, VapidManager, vapidSubject } from './vapid-manager.js';

describe('vapidSubject', () => {
  const fallback = DEFAULT_VAPID_CONTACT;

  it.each([
    // Apple answers 403 BadJwtToken for these (2026-10-02).
    ['noreply@untether.local', fallback],
    ['mailto:me@my-mac.local', fallback],
    ['me@localhost.localdomain', fallback],
    ['me@localhost', fallback],
    ['me@192.168.1.10', fallback],
    ['https://localhost:4020', fallback],
    ['https://my-mac.local', fallback],
    ['not-an-email', fallback],
    ['', fallback],
    [undefined, fallback],
    ['user@example.com', 'mailto:user@example.com'],
    ['mailto:ops@example.org', 'mailto:ops@example.org'],
    ['https://github.com/Nachx639/untether', 'https://github.com/Nachx639/untether'],
  ])('%s → %s', (contact, expected) => {
    expect(vapidSubject(contact)).toBe(expected);
  });

  it('never defaults to a reserved domain', () => {
    expect(vapidSubject(DEFAULT_VAPID_CONTACT)).toBe(DEFAULT_VAPID_CONTACT);
  });
});

describe('VapidManager', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, RM_TEST_DIR);
    dir = undefined;
  });

  it('signs with a subject Apple accepts even when the stored contact is .local', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-vapid-'));
    const setVapidDetails = vi.spyOn(webpush, 'setVapidDetails');
    const manager = new VapidManager(dir);
    await manager.initialize({ contactEmail: 'noreply@untether.local' });
    expect(setVapidDetails).toHaveBeenCalled();
    expect(setVapidDetails.mock.calls.at(-1)?.[0]).toBe(DEFAULT_VAPID_CONTACT);
  });
});
