import { describe, expect, it } from 'vitest';
import { formatDoctor, runDoctorCli } from './doctor-cli.js';
import type { TaskResponse } from './pty/socket-protocol.js';

describe('ut doctor', () => {
  const waiting =
    'the app is build aaa1111, its sources are at bbb2222: built bbb2222 3 h 0 min ago, waiting for a quiet moment (a check is running)';
  const report = {
    at: '2026-11-11T10:09:07.701Z',
    findings: [
      { key: 'a', check: 'app-build', severity: 'warning' as const, problem: 'the app is older' },
      { key: 'b', check: 'cli-build', severity: 'info' as const, problem: 'the ut is older' },
    ],
    failedChecks: ['resources'],
  };

  const run = async (argv: string[], response: TaskResponse) => {
    const out: string[] = [];
    const err: string[] = [];
    const asked: Array<[string, Record<string, unknown>]> = [];
    const code = await runDoctorCli(argv, {
      task: async (op, args) => {
        asked.push([op, args]);
        return response;
      },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n'), asked };
  };

  it("always shows the app's own update first, then what the doctor found", () => {
    expect(formatDoctor(report, waiting).split('\n')).toEqual([
      `App update: ${waiting}`,
      'Doctor (2026-11-11T10:09:07.701Z): 2 finding(s)',
      '  ! [app-build] the app is older',
      '  - [cli-build] the ut is older',
      '  !! check resources could not run',
    ]);
    expect(formatDoctor({ ...report, findings: [], failedChecks: [] }, 'up to date')).toBe(
      'App update: up to date\nDoctor (2026-11-11T10:09:07.701Z): nothing found'
    );
    expect(formatDoctor(null, null)).toContain('App update: not available on this server');
  });

  it('tells the last look, or makes one with --run', async () => {
    const response = { ok: true, status: 'done', data: { report, appUpdate: waiting } };
    const last = await run([], response as unknown as TaskResponse);
    expect(last.code).toBe(0);
    expect(last.asked).toEqual([['doctor', { run: false }]]);
    expect(last.out).toContain(`App update: ${waiting}`);
    const now = await run(['--run', '--json'], response as unknown as TaskResponse);
    expect(now.asked).toEqual([['doctor', { run: true }]]);
    expect(JSON.parse(now.out)).toEqual({ report, appUpdate: waiting });
  });

  it('refuses what it does not know and says a server that cannot answer', async () => {
    const bad = await run(['--fix'], { ok: true } as TaskResponse);
    expect(bad.code).toBe(2);
    expect(bad.asked).toEqual([]);
    const down = await run([], { ok: false, code: 'unavailable', message: 'no tasks here' });
    expect(down.code).toBe(1);
    expect(down.err).toBe('Error: no tasks here');
  });
});
