import { describe, expect, it, vi } from 'vitest';
import { createTestSession } from '../../test/utils/test-factories';
import type { AuthClient } from '../services/auth-client';
import { isAIAssistantSession, sendAIPrompt } from './ai-sessions';

describe('isAIAssistantSession', () => {
  it('recognizes Auggie executables and wrappers', () => {
    expect(isAIAssistantSession(createTestSession({ command: ['auggie'] }))).toBe(true);
    expect(
      isAIAssistantSession(createTestSession({ command: ['/usr/local/bin/auggie-wrapper'] }))
    ).toBe(true);
    expect(
      isAIAssistantSession(createTestSession({ command: ['/bin/zsh', '-lc', 'auggie'] }))
    ).toBe(true);
  });

  it('does not match unrelated commands containing the name', () => {
    expect(isAIAssistantSession(createTestSession({ command: ['auggie-helper'] }))).toBe(false);
  });
});

describe('sendAIPrompt', () => {
  const authClient = { getAuthHeader: () => ({ Authorization: 'Bearer t' }) } as AuthClient;

  // The input route refuses anything but `text` or `key` (server/routes/sessions.ts).
  it('types the prompt as text and then presses Enter', async () => {
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/sessions/s1/input');
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true } as Response;
    }) as typeof fetch;
    try {
      await sendAIPrompt('s1', authClient);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[0] as object)).toEqual(['text']);
    expect((bodies[0] as { text: string }).text).toContain("'ut title'");
    expect((bodies[0] as { text: string }).text).not.toMatch(/[\r\n]/);
    expect(bodies[1]).toEqual({ key: 'enter' });
  });

  it('fails when the server refuses the prompt, without pressing Enter', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'no' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(sendAIPrompt('s1', authClient)).rejects.toThrow('400');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
