import { describe, expect, it } from 'vitest';
import {
  decideRoute,
  fileHits,
  type RoutableTask,
  route,
  routeTokens,
  scoreTasks,
  toRoutable,
} from './task-router';

const login: RoutableTask = {
  id: 'login',
  title: 'Login con Google',
  prompt: 'Añade inicio de sesión con Google usando OAuth en la pantalla de acceso',
  followUps: [{ text: 'que recuerde la sesión 30 días' }],
  branch: 'ut/login-google',
  files: ['web/src/server/routes/auth.ts', 'web/src/client/components/login-form.ts'],
  state: 'working',
  lastActivityAt: 1_000,
};
const darkMode: RoutableTask = {
  id: 'dark',
  title: 'Dark mode for settings',
  prompt: 'Add a dark theme toggle to the settings page and persist the preference',
  branch: 'ut/dark-mode-settings',
  files: ['web/src/client/components/settings-view.ts', 'web/src/client/styles/theme.css'],
  state: 'needs_you',
  lastActivityAt: 3_000,
};
const exportCsv: RoutableTask = {
  id: 'csv',
  title: 'Exportar facturas a CSV',
  prompt: 'Botón para exportar las facturas del mes a un fichero CSV',
  branch: 'ut/exportar-facturas-csv',
  files: ['src/billing/export.ts'],
  state: 'ready',
  lastActivityAt: 2_000,
};
const merged: RoutableTask = {
  id: 'merged',
  title: 'Notificaciones push',
  prompt: 'Enviar notificaciones push cuando termina una tarea',
  branch: 'ut/notificaciones-push',
  files: ['src/push.ts'],
  state: 'merged',
  lastActivityAt: 9_000,
};
const tasks = [login, darkMode, exportCsv, merged];

describe('route (es/en prompts)', () => {
  it.each([
    // [prompt, expected kind, expected task]
    ['en ut/login-google cambia el texto del botón', 'match', 'login'],
    ['lo de login-google: muestra un error si falla', 'match', 'login'],
    ['la tarea de login con google necesita un logout', 'match', 'login'],
    ['arregla el login con Google en Safari', 'match', 'login'],
    ['el acceso con Google falla en la pantalla de login', 'match', 'login'],
    // Shares «botón» with the CSV task and only part of the login prompt: in the ask band.
    ['el botón de Google no aparece en la pantalla de acceso', 'ask', undefined],
    ['make the dark theme default on settings', 'match', 'dark'],
    ['in settings-view.ts the toggle is misaligned', 'match', 'dark'],
    ['also persist the theme in localStorage', 'match', 'dark'],
    ['exportar también las facturas del año pasado a csv', 'match', 'csv'],
    ['add a footer with the copyright', 'new', undefined],
    ['actualiza el README con las instrucciones de instalación', 'new', undefined],
    ['nueva tarea: login con Google en la app de iOS', 'new', undefined],
    ['something else: dark theme for the docs site, separately', 'new', undefined],
    // Merged tasks never count, even when mentioned explicitly.
    ['notificaciones push cuando termina', 'new', undefined],
    ['ut/notificaciones-push: cambia el sonido', 'new', undefined],
  ] as const)('%s → %s %s', (prompt, kind, taskId) => {
    const decision = route(prompt, tasks);
    expect(decision.kind).toBe(kind);
    if (decision.kind === 'match') expect(decision.taskId).toBe(taskId);
  });

  it('asks when two tasks fit about equally', () => {
    const a: RoutableTask = { ...darkMode, id: 'a', title: 'Settings page layout', branch: 'ut/a' };
    const b: RoutableTask = { ...darkMode, id: 'b', title: 'Settings page icons', branch: 'ut/b' };
    const decision = route('settings page', [a, b]);
    expect(decision.kind).toBe('ask');
    if (decision.kind === 'ask') expect(decision.candidates.sort()).toEqual(['a', 'b']);
  });

  it('no open tasks → new (merged/discarded/scheduled/missed excluded)', () => {
    const closed = ['merged', 'discarded', 'scheduled', 'missed'].map((state, i) => ({
      ...login,
      id: `t${i}`,
      state,
    }));
    expect(route('login con google', closed)).toEqual({
      kind: 'new',
      reason: 'no-open-tasks',
      scores: [],
    });
    expect(route('login con google', [])).toMatchObject({ kind: 'new', reason: 'no-open-tasks' });
  });

  it('explicit mention scores 1 and is reported as explicit', () => {
    const decision = route('ut/dark-mode-settings: rename the toggle', tasks);
    expect(decision).toMatchObject({ kind: 'match', taskId: 'dark', reason: 'explicit' });
    expect(decision.scores[0]).toEqual({ taskId: 'dark', score: 1 });
  });

  it('parallel siblings share a base slug → ask between them', () => {
    const a = { ...login, id: 'la', branch: 'ut/login-google-a' };
    const b = { ...login, id: 'lb', branch: 'ut/login-google-b' };
    const decision = route('en login-google el botón es feo', [a, b]);
    expect(decision.kind).toBe('ask');
    expect(route('ut/login-google-b es mejor, sigue ahí', [a, b])).toMatchObject({
      kind: 'match',
      taskId: 'lb',
    });
  });

  it('continuation words boost only the most recently active task', () => {
    const base = scoreTasks('the settings toggle', [darkMode])[0]?.score ?? 0;
    const boosted = scoreTasks('also the settings toggle', [darkMode])[0]?.score ?? 0;
    expect(boosted - base).toBeCloseTo(0.1, 5);
    const older = { ...darkMode, id: 'old', lastActivityAt: 1 };
    const newer = { ...exportCsv, id: 'new', lastActivityAt: 99 };
    const withOlder = scoreTasks('also the settings toggle', [older, newer]);
    const plain = scoreTasks('the settings toggle', [older, newer]);
    expect(withOlder.find((s) => s.taskId === 'old')?.score).toBeCloseTo(
      plain.find((s) => s.taskId === 'old')?.score ?? -1,
      5
    );
  });

  it('file hits add 0.4 each, capped at 0.6', () => {
    const t: RoutableTask = {
      id: 'f',
      title: 'zzz',
      prompt: 'zzz',
      files: ['a/alpha.ts', 'b/bravo.ts', 'c/charlie.ts'],
      state: 'working',
    };
    expect(fileHits(t, 'mira a/alpha.ts')).toBe(1);
    expect(fileHits(t, 'alpha.ts, bravo y el charlie')).toBe(3);
    expect(fileHits(t, 'index.ts y src/')).toBe(0);
    expect(scoreTasks('alpha.ts', [t])[0].score).toBeGreaterThanOrEqual(0.4);
    // Same words without files: only the 0.6-capped file bonus separates them.
    const noFiles = { ...t, title: 'alpha bravo charlie', files: [] };
    const withFiles = { ...t, title: 'alpha bravo charlie' };
    const q = 'el ambiente alpha bravo charlie delta echo foxtrot golf hotel';
    const diff = scoreTasks(q, [withFiles])[0].score - scoreTasks(q, [noFiles])[0].score;
    expect(diff).toBeCloseTo(0.6, 5);
  });
});

describe('decideRoute band edges', () => {
  const s = (...scores: number[]) => scores.map((score, i) => ({ taskId: `t${i}`, score }));
  it.each([
    [[0.35], 'match'],
    [[0.3499], 'ask'],
    [[0.5, 0.35], 'match'],
    [[0.5, 0.36], 'ask'],
    [[0.12], 'ask'],
    [[0.1199], 'new'],
    [[0, 0], 'new'],
    [[1, 1], 'ask'],
    [[1, 0.85], 'match'],
  ] as const)('%j → %s', (scores, kind) => {
    expect(decideRoute(s(...scores)).kind).toBe(kind);
  });

  it('ask lists up to 3 candidates above the new threshold', () => {
    const d = decideRoute(s(0.3, 0.25, 0.2, 0.15, 0.05));
    expect(d).toMatchObject({ kind: 'ask', candidates: ['t0', 't1', 't2'] });
  });
});

describe('routeTokens', () => {
  it('drops accents, stopwords and plurals', () => {
    expect([...routeTokens('Añade los botones de exportación también')]).toEqual([
      'boton',
      'exportacion',
    ]);
  });

  it('reads a task record: its name, follow-ups, files and newest activity', () => {
    const routable = toRoutable({
      id: 't1',
      name: 'Login con Google',
      prompt: 'Añade login',
      workingDir: '/repo',
      command: ['claude'],
      agent: 'claude',
      shielded: false,
      notify: true,
      runAt: '2026-10-18T00:00:00.000Z',
      createdAt: '2026-10-18T00:00:00.000Z',
      state: 'working',
      stateSince: '2026-10-18T01:00:00.000Z',
      startedAt: '2026-10-18T00:30:00.000Z',
      isolation: 'worktree',
      origin: 'user',
      followUps: [{ at: '2026-10-18T02:00:00.000Z', text: 'y logout', via: 'route' }],
      files: ['src/auth.ts'],
      branch: 'ut/login-google',
    });
    expect(routable).toEqual({
      id: 't1',
      title: 'Login con Google',
      prompt: 'Añade login',
      followUps: [{ at: '2026-10-18T02:00:00.000Z', text: 'y logout', via: 'route' }],
      branch: 'ut/login-google',
      files: ['src/auth.ts'],
      state: 'working',
      lastActivityAt: Date.parse('2026-10-18T02:00:00.000Z'),
    });
    expect(route('ut/login-google: y el logout', [routable])).toMatchObject({ kind: 'match' });
  });
});
