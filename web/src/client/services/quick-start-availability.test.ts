// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quickStartProgram } from '../../shared/quick-start';
import { parseCommand } from '../utils/command-utils';
import { fetchQuickStartAvailability, isQuickStartAvailable } from './quick-start-availability';

describe('quick-start availability (client)', () => {
  afterEach(() => {
    vi.mocked(global.fetch).mockReset();
  });

  it('keys a quick start by the program its session runs (what parseCommand sends first)', () => {
    for (const command of [
      'claude --dangerously-skip-permissions',
      '  opencode 4',
      'gemini3',
      '"my tool" --flag',
      "'/opt/my tools/run' x",
      'a"b c"d e',
      '"" zsh -l',
    ]) {
      expect(quickStartProgram(command)).toBe(parseCommand(command)[0] ?? '');
    }
  });

  it('counts only an explicit "not on the Mac" as unavailable', () => {
    const availability = { gemini: false, claude: true };
    expect(isQuickStartAvailable(availability, 'gemini')).toBe(false);
    expect(isQuickStartAvailable(availability, 'gemini --yolo')).toBe(false);
    expect(isQuickStartAvailable(availability, 'claude --dangerously-skip-permissions')).toBe(true);
    expect(isQuickStartAvailable(availability, 'crush')).toBe(true);
    expect(isQuickStartAvailable({}, 'gemini')).toBe(true);
  });

  it('asks the server with the auth header and keeps only true/false answers', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ gemini: false, codex: true, odd: 'no' }), { status: 200 })
    );

    expect(await fetchQuickStartAvailability({ Authorization: 'Bearer t' })).toEqual({
      gemini: false,
      codex: true,
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/quick-start/availability', {
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('offers everything when the server cannot answer', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await fetchQuickStartAvailability({})).toEqual({});

    vi.mocked(global.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchQuickStartAvailability({})).toEqual({});

    vi.mocked(global.fetch).mockResolvedValueOnce(new Response('[false]', { status: 200 }));
    expect(await fetchQuickStartAvailability({})).toEqual({});
  });
});
