// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  canMoveToUntether,
  canShield,
  moveToUntether,
  shieldConfirmText,
  shieldContinuesCodex,
} from './shield.js';

// Llevar a Untether (2026-10-25): a Claude session opened with `ut` in a Mac window.
const utClaude = {
  id: 'fwd_1761400000000_4242',
  command: ['claude'],
  claudeSessionId: 'conv-1',
  status: 'running',
  workingDir: '/repo',
  name: 'claude',
} as unknown as Session;

describe('canMoveToUntether', () => {
  it('offers the move for a ut Claude session, never Blindar', () => {
    expect(canMoveToUntether(utClaude)).toBe(true);
    expect(canShield(utClaude)).toBe(false);
    expect(canMoveToUntether({ ...utClaude, command: ['htop'] })).toBe(false);
    expect(canMoveToUntether({ ...utClaude, status: 'exited' })).toBe(false);
    expect(canMoveToUntether({ ...utClaude, id: 'abc' })).toBe(false);
    expect(canMoveToUntether({ ...utClaude, source: 'remote' } as Session)).toBe(false);
  });
});

// 2026-11-10: Blindar on a Codex session goes on with its thread (the server's shieldReopenPlan).
describe('shielding a Codex session', () => {
  const codex = {
    id: 'c-1',
    command: ['/opt/homebrew/bin/codex', '--no-alt-screen'],
    codexThreadId: '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28',
    status: 'running',
    workingDir: '/repo',
    name: 'codex',
  } as unknown as Session;

  it('says its conversation goes on, only when it will', () => {
    expect(shieldContinuesCodex(codex)).toBe(true);
    expect(shieldConfirmText(codex, 'Estilos')).toBe(
      'Shield “Estilos”? Codex restarts in a shielded session and continues this conversation.'
    );
    // No thread yet, or `codex` typed in a shell: a new one starts, the old stays.
    const fresh = { ...codex, codexThreadId: undefined } as Session;
    const typed = { ...codex, command: ['zsh', '-l'] } as Session;
    expect(shieldContinuesCodex(fresh)).toBe(false);
    expect(shieldContinuesCodex(typed)).toBe(false);
    expect(shieldConfirmText(fresh, 'Estilos')).toBe(shieldConfirmText(typed, 'Estilos'));
    expect(shieldConfirmText(fresh, 'Estilos')).not.toContain('continues this conversation');
  });

  it('a running Codex opened with ut in a terminal window is not moved to Untether', () => {
    expect(canMoveToUntether({ ...codex, id: 'fwd_1761400000000_4242' } as Session)).toBe(false);
  });
});

describe('moveToUntether', () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, body: unknown) =>
    ({ ok: status < 400, status, statusText: '', json: async () => body }) as Response;

  it('asks again while Claude works, and moves it only once confirmed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(409, { error: 'claude-busy', status: 'busy' }))
      .mockResolvedValueOnce(answer(200, { sessionId: 'new-1', replaced: true }));
    vi.stubGlobal('fetch', fetchMock);
    const confirmBusy = vi.fn(async () => true);
    expect(await moveToUntether(utClaude.id, 'bakery', {}, confirmBusy)).toEqual({
      sessionId: 'new-1',
      replaced: true,
    });
    expect(confirmBusy).toHaveBeenCalledTimes(1);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).not.toHaveProperty('force');
    expect(bodies[0].windowNotice).toContain('bakery');
    expect(bodies[1]).toMatchObject({ force: true, windowNotice: bodies[0].windowNotice });
  });

  it('keeps it in its window when the user says no', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(409, { error: 'claude-busy' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await moveToUntether(utClaude.id, 'x', {}, async () => false)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports any other failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          answer(409, { error: 'Failed', details: 'Its program is still running' })
        )
    );
    await expect(moveToUntether(utClaude.id, 'x', {}, async () => true)).rejects.toThrow(
      'Its program is still running'
    );
  });
});
