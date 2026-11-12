/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import {
  formatActivity,
  formatElapsed,
  formatElapsedMinutes,
  sessionActivity,
} from './claude-activity.js';

describe('claude activity', () => {
  afterEach(() => {
    setLocale('en');
    vi.useRealTimers();
  });

  it('words each step in the app language', async () => {
    expect(formatActivity({ kind: 'tool', tool: 'Bash', target: 'pnpm test' })).toBe(
      'Running: pnpm test'
    );
    expect(formatActivity({ kind: 'tool', tool: 'Edit', target: 'app.ts' })).toBe('Editing app.ts');
    expect(formatActivity({ kind: 'tool', tool: 'Read' })).toBe('Reading a file');
    expect(formatActivity({ kind: 'tool', tool: 'Glob', target: '*.ts' })).toBe('Searching *.ts');
    expect(formatActivity({ kind: 'tool', tool: 'WebFetch', target: 'lit.dev' })).toBe(
      'Browsing lit.dev'
    );
    expect(formatActivity({ kind: 'tool', tool: 'Task', target: 'Explore' })).toBe(
      'Agent: Explore'
    );
    expect(formatActivity({ kind: 'tool', tool: 'TodoWrite' })).toBe('Updating todo list');
    expect(formatActivity({ kind: 'tool', tool: 'mcp__github__get_issue' })).toBe(
      'Using get_issue'
    );
    expect(formatActivity({ kind: 'thinking' })).toBe('Thinking…');
    expect(formatActivity({ kind: 'writing' })).toBe('Writing…');
    await setLocale('es');
    expect(formatActivity({ kind: 'tool', tool: 'Edit', target: 'app.ts' })).toBe(
      'Editando app.ts'
    );
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(80_000)).toBe('1m 20s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('reads at minute resolution after the first minute, for lists', () => {
    expect(formatElapsedMinutes(45_000)).toBe('45s');
    expect(formatElapsedMinutes(80_000)).toBe('1 min');
    expect(formatElapsedMinutes(14 * 60_000 + 59_000)).toBe('14 min');
    expect(formatElapsedMinutes(3_900_000)).toBe('1h 5m');
  });

  it('only shows activity while Claude is working in a running session', () => {
    const activity = { kind: 'thinking' as const };
    const session = (status: string, claude: string) =>
      ({ status, claudeStatus: { status: claude, activity } }) as Session;
    expect(sessionActivity(session('running', 'busy'))).toBe(activity);
    expect(sessionActivity(session('running', 'idle'))).toBeUndefined();
    expect(sessionActivity(session('exited', 'busy'))).toBeUndefined();
  });

  it('ticks the elapsed element by itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const element = document.createElement('claude-activity-elapsed');
    element.setAttribute('since', String(100_000 - 59_000));
    document.body.append(element);
    expect(element.textContent).toBe('59s');
    vi.advanceTimersByTime(1000);
    expect(element.textContent).toBe('1m 0s');
    element.remove();
  });

  it('with `minutes`, stops changing every second once a minute old', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const element = document.createElement('claude-activity-elapsed');
    element.setAttribute('minutes', '');
    element.setAttribute('since', String(200_000 - 59_000));
    document.body.append(element);
    expect(element.textContent).toBe('59s');
    vi.advanceTimersByTime(1000);
    expect(element.textContent).toBe('1 min');
    vi.advanceTimersByTime(30_000);
    expect(element.textContent).toBe('1 min');
    element.remove();
  });
});
