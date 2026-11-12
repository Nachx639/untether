/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availableModes,
  closeClaudeModePicker,
  cycleToMode,
  isClaudeModePickerOpen,
  openClaudeModePicker,
  recordModes,
  resetModeCacheForTests,
} from './claude-mode-picker.js';

const STATUS: Record<string, string> = {
  'Default mode': '  ? for shortcuts',
  'Accept edits': '  ⏵⏵ accept edits on (shift+tab to cycle)',
  'Plan mode': '  ⏸ plan mode on (shift+tab to cycle)',
  'Bypass permissions': '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
};

/** A terminal whose status line moves to the next mode ~100 ms after each Shift+Tab. */
function fakeClaude(cycle: string[], blocked = () => false) {
  let index = 0;
  const presses = vi.fn(() => {
    setTimeout(() => {
      index = (index + 1) % cycle.length;
    }, 100);
  });
  const screen = () => STATUS[cycle[index]];
  const readMode = () => {
    const line = screen();
    const match = Object.entries(STATUS).find(([, text]) => text === line);
    return match ? match[0] : null;
  };
  return { readMode, sendShiftTab: presses, isBlocked: blocked, presses };
}

const WITHOUT_BYPASS = ['Default mode', 'Accept edits', 'Plan mode'];

describe('cycleToMode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetModeCacheForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('presses Shift+Tab until the chosen mode shows, then stops', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS);
    const done = cycleToMode(claude, 'Plan mode');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await done;
    expect(result.outcome).toBe('reached');
    expect(claude.presses).toHaveBeenCalledTimes(2);
    expect(claude.readMode()).toBe('Plan mode');
  });

  it('stops after one full cycle when the mode is not on offer, and remembers that', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS);
    const done = cycleToMode(claude, 'Bypass permissions');
    await vi.advanceTimersByTimeAsync(3000);
    const result = await done;
    expect(result).toEqual({ outcome: 'unreachable', seen: WITHOUT_BYPASS, complete: true });
    expect(claude.presses).toHaveBeenCalledTimes(3);
    expect(claude.readMode()).toBe('Default mode');

    expect(availableModes('s1', 'Default mode')).toContain('Bypass permissions');
    recordModes('s1', result);
    expect(availableModes('s1', 'Default mode')).toEqual(WITHOUT_BYPASS);
    expect(availableModes('s2', 'Default mode')).toContain('Bypass permissions');
  });

  it('sends nothing while Claude waits on a dialog', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS, () => true);
    const result = await cycleToMode(claude, 'Plan mode');
    expect(result.outcome).toBe('blocked');
    expect(claude.presses).not.toHaveBeenCalled();
  });

  it('gives up when the status line never changes', async () => {
    const claude = { ...fakeClaude(WITHOUT_BYPASS), sendShiftTab: vi.fn() };
    const done = cycleToMode(claude, 'Plan mode');
    await vi.advanceTimersByTimeAsync(3500);
    expect((await done).outcome).toBe('timeout');
    expect(claude.sendShiftTab).toHaveBeenCalledTimes(1);
  });
});

describe('mode picker sheet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetModeCacheForTests();
  });
  afterEach(() => {
    closeClaudeModePicker();
    vi.useRealTimers();
  });

  const row = (mode: string) =>
    document.querySelector<HTMLButtonElement>(`[data-testid="mode-item"][data-mode="${mode}"]`);

  it('checks the current mode, switches on a tap and closes', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS);
    const onModeChange = vi.fn();
    openClaudeModePicker({ sessionId: 's1', ...claude, onModeChange });
    expect(row('Default mode')?.getAttribute('aria-pressed')).toBe('true');
    expect(row('Plan mode')?.textContent).toContain('Explores and plans');

    row('Plan mode')?.click();
    expect(claude.presses).not.toHaveBeenCalled(); // the tap that opened it

    await vi.advanceTimersByTimeAsync(600);
    row('Accept edits')?.click();
    expect(row('Accept edits')?.querySelector('.ut-mode-spinner')).not.toBeNull();
    row('Plan mode')?.click(); // ignored while switching
    await vi.advanceTimersByTimeAsync(3000);
    expect(claude.presses).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith('Accept edits');
    expect(isClaudeModePickerOpen()).toBe(false);
  });

  it('explains instead of switching while a dialog is up', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS, () => true);
    openClaudeModePicker({ sessionId: 's1', ...claude });
    await vi.advanceTimersByTimeAsync(600);
    row('Plan mode')?.click();
    expect(claude.presses).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="mode-message"]')?.textContent).toContain(
      'waiting for your answer'
    );
  });

  it('says when a mode is not available and drops it from the list', async () => {
    const claude = fakeClaude(WITHOUT_BYPASS);
    openClaudeModePicker({ sessionId: 's1', ...claude });
    await vi.advanceTimersByTimeAsync(600);
    row('Bypass permissions')?.click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(isClaudeModePickerOpen()).toBe(true);
    expect(document.querySelector('[data-testid="mode-message"]')?.textContent).toContain(
      "Bypass permissions isn't available"
    );
    expect(row('Bypass permissions')).toBeNull();
  });
});
