import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trustFolderOption } from './claude-initial-input.js';
import { createOrchestratorDelivery } from './orchestrator-delivery.js';

describe('orchestrator delivery (2026-10-20: no give-up after a minute)', () => {
  let status: string | undefined;
  let running: boolean;
  let sent: unknown[];
  let logged: string[];
  const deliver = () =>
    createOrchestratorDelivery({
      sessionStatus: () => (running ? 'running' : 'exited'),
      claudeStatus: async () => status,
      readChoices: async () => null,
      sendInput: (_id, input) => sent.push(input),
      log: (message) => logged.push(message),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    status = 'busy';
    running = true;
    sent = [];
    logged = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps waiting while Claude is busy, however long, then types and says so', async () => {
    const done = deliver()('s1', 'hola');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toEqual([]);
    status = 'idle';
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('answers false when the session ends or the text is no longer wanted', async () => {
    const ended = deliver()('s1', 'hola');
    await vi.advanceTimersByTimeAsync(5000);
    running = false;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(ended).resolves.toBe(false);

    running = true;
    let wanted = true;
    const dropped = deliver()('s1', 'hola', { keepWaiting: () => wanted });
    await vi.advanceTimersByTimeAsync(5000);
    wanted = false;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(dropped).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(logged.some((line) => line.includes('no longer wanted'))).toBe(true);
  });

  describe('trust dialog of a new orchestrator (2026-10-23: it sat on "Yes, I trust this folder")', () => {
    const trust = {
      question: 'Quick safety check: Is this a project you created or one you trust?',
      options: ['Yes, I trust this folder', 'No, exit'],
    };
    const permission = {
      question: 'Do you want to proceed?',
      options: ['Yes', "Yes, and don't ask again", 'No'],
    };
    let menu: typeof trust | null;
    let answered: string[];
    const withTrust = () =>
      createOrchestratorDelivery({
        sessionStatus: () => (running ? 'running' : 'exited'),
        claudeStatus: async () => status,
        readChoices: async () => (menu ? { ...menu, keys: ['1', '2', '3'] } : null),
        sendInput: (_id, input) => sent.push(input),
        // The tasks' answer: it trusts the folder only when that dialog is on screen.
        answerTrustDialog: async (sessionId) => {
          const option = trustFolderOption(menu);
          if (!option) return false;
          answered.push(`${sessionId}:${option}`);
          menu = null;
          status = 'idle';
          return true;
        },
        log: (message) => logged.push(message),
      });

    beforeEach(() => {
      answered = [];
    });

    it('answers it at the start, and the brief goes in', async () => {
      menu = trust;
      status = undefined;
      const done = withTrust()('s1', 'brief', { trustFolder: true });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(done).resolves.toBe(true);
      expect(answered).toEqual(['s1:1']);
      expect(sent).toEqual([{ text: 'brief' }, { key: 'enter' }]);
    });

    it('leaves any other menu to the user, and the trust dialog outside the start', async () => {
      menu = permission;
      status = 'waiting';
      const other = withTrust()('s1', 'brief', { trustFolder: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answered).toEqual([]);
      expect(sent).toEqual([]);
      running = false;
      await vi.advanceTimersByTimeAsync(5000);
      await expect(other).resolves.toBe(false);

      running = true;
      menu = trust;
      status = undefined;
      const later = withTrust()('s1', 'event');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answered).toEqual([]);
      expect(sent).toEqual([]);
      running = false;
      await vi.advanceTimersByTimeAsync(5000);
      await expect(later).resolves.toBe(false);
    });
  });
});
