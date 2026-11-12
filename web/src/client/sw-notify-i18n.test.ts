import { describe, expect, it, vi } from 'vitest';
import { TASK_PUSH_TYPES } from '../shared/tasks.js';
import { SUPPORTED_LOCALES, setLocale } from './i18n/index.js';
import {
  coercePushPayload,
  defaultNotificationActions,
  fallbackPushNotification,
  isNotifyStrings,
  localizeActionTitles,
  localizeClaudeNotification,
  type NotifyStrings,
  notificationOptionsFor,
  vibrationPattern,
} from './sw-notify-i18n.js';
import { buildNotifyStrings } from './utils/offline-page.js';

/** This app's whole set (English), with the six base texts in Spanish; tests add theirs over it. */
const es: NotifyStrings = {
  ...buildNotifyStrings(),
  needsYou: '⏳ Claude te necesita · {where}',
  finished: '✅ Claude ha terminado · {where}',
  waiting: 'Esperando tu respuesta',
  yourTurn: 'Tu turno',
  open: 'Abrir',
  dismiss: 'Descartar',
};

const payload = (type: string, detail = '') => ({
  title: `English ${type}`,
  body: 'English body',
  actions: [
    { action: 'view-session', title: 'Open' },
    { action: 'dismiss', title: 'Dismiss' },
  ],
  data: { type, where: 'Nombre para perro', detail },
});

describe('localizeClaudeNotification', () => {
  it('rebuilds queued and started pushes from their numbers (project task limit)', () => {
    const strings = {
      ...es,
      taskQueued: '🕒 Tarea en cola: {where}',
      taskQueuedBody: '{position}.ª de {of} en cola: hay {active} de {limit} tareas en marcha.',
      taskStarted: '▶️ Tarea empezada: {where}',
      taskStartedBody: 'Esperaba en la cola y ya ha empezado.',
    };
    const base = payload('task-queued', 'Queued 2 of 3: 2 of 2 tasks of the project run.');
    const queued = localizeClaudeNotification(
      { ...base, data: { ...base.data, position: 2, of: 3, active: 2, limit: 2 } },
      strings
    );
    expect(queued.title).toBe('🕒 Tarea en cola: Nombre para perro');
    expect(queued.body).toBe('2.ª de 3 en cola: hay 2 de 2 tareas en marcha.');
    const started = localizeClaudeNotification(payload('task-started', 'Started'), strings);
    expect(started.title).toBe('▶️ Tarea empezada: Nombre para perro');
    expect(started.body).toBe('Esperaba en la cola y ya ha empezado.');
  });

  it('another agent took over a task (2026-11-01): who stopped and who carries on', () => {
    const strings = {
      ...es,
      taskAgentChanged: '🔀 Otro agente: {where}',
      taskAgentChangedBody: '{from} agotó su cupo: {to} sigue en el mismo worktree.',
    };
    const base = payload('task-agent-changed', 'Codex hit its usage limit: …');
    const changed = localizeClaudeNotification(
      { ...base, data: { ...base.data, fromAgent: 'codex', toAgent: 'claude', toModel: 'opus' } },
      strings
    );
    expect(changed.title).toBe('🔀 Otro agente: Nombre para perro');
    expect(changed.body).toBe('Codex agotó su cupo: Claude (opus) sigue en el mismo worktree.');
  });

  it('rebuilds a push of a task waiting for room on the Mac from what it waits for', () => {
    const strings = {
      ...es,
      taskQueued: '🕒 Tarea en cola: {where}',
      taskQueuedRoomBody: '{position}.ª de {of} en cola: esperando {what} en el Mac.',
      taskRoomWords: { memory: 'memoria', swap: 'swap', cpu: 'CPU' },
    };
    const base = payload('task-queued', 'Queued 1 of 1: the Mac is short of memory');
    const queued = localizeClaudeNotification(
      {
        ...base,
        data: { ...base.data, position: 1, of: 1, active: 0, waitingFor: ['memory', 'swap'] },
      },
      strings
    );
    expect(queued.body).toBe('1.ª de 1 en cola: esperando memoria, swap en el Mac.');
    // An unknown word: the server's own sentence, never a hole.
    const odd = localizeClaudeNotification(
      { ...base, data: { ...base.data, position: 1, of: 1, waitingFor: ['disk'] } },
      strings
    );
    expect(odd.body).toBe('English body');
  });

  it('a task that waits for others (--after, its zone): which ones, and when one of them stopped', () => {
    const strings = {
      ...es,
      taskQueued: '🕒 Tarea en cola: {where}',
      taskQueuedBody: '{position}.ª de {of} en cola: hay {active} de {limit} tareas en marcha.',
      taskWaitsBody: 'Espera a {ids}: arranca sola cuando se fusione o se cierre.',
      taskWaitsStoppedBody: '{ids} se descartó o falló: no arranca sola.',
    };
    const base = payload('task-queued', 'Waits for 1a2b3c4d «Una» (working): …');
    const place = { position: 1, of: 1, active: 1, limit: 2 };
    const waits = localizeClaudeNotification(
      { ...base, data: { ...base.data, ...place, waitsOn: ['1a2b3c4d', '5e6f7a8b'] } },
      strings
    );
    expect(waits.title).toBe('🕒 Tarea en cola: Nombre para perro');
    expect(waits.body).toBe(
      'Espera a 1a2b3c4d, 5e6f7a8b: arranca sola cuando se fusione o se cierre.'
    );
    const stopped = localizeClaudeNotification(
      { ...base, data: { ...base.data, ...place, waitsOn: ['1a2b3c4d'], waitStopped: true } },
      strings
    );
    expect(stopped.body).toBe('1a2b3c4d se descartó o falló: no arranca sola.');
  });

  it('rebuilds task pushes in the stored language', () => {
    const strings = {
      ...es,
      taskMissed: '⚠️ Tarea no ejecutada: {where}',
      taskMissedBody: 'El servidor estaba apagado a esa hora',
      taskReady: '✅ Tarea lista: {where}',
      taskReadyBody: 'Ábrela para ver el resultado',
      taskNeedsYou: '⏳ Una tarea te necesita: {where}',
      taskNeedsYouBody: 'Ábrela para responder',
      taskFailed: '❌ Tarea fallida: {where}',
      taskFailedBody: 'Ábrela para ver por qué',
      taskMerged: '✅ {where} fusionada',
      taskMergedBody: 'Ya está en {branch}',
      taskDone: '✅ Tarea hecha: {where}',
      taskBlockers: {
        conflict: 'Choca con cambios de la rama base',
        verify: 'La comprobación ha fallado',
        'no-check': 'No hay comprobación para este proyecto',
        permission: 'Espera un permiso',
      },
    };
    const withData = (type: string, detail: string, extra: Record<string, string>) => {
      const base = payload(type, detail);
      return { ...base, data: { ...base.data, ...extra } };
    };

    const ready = localizeClaudeNotification(payload('task-ready', '3 tests arreglados'), strings);
    expect(ready.title).toBe('✅ Tarea lista: Nombre para perro');
    expect(ready.body).toBe('3 tests arreglados');
    expect(ready.actions?.[0].title).toBe('Abrir');
    expect(localizeClaudeNotification(payload('task-ready'), strings).body).toBe(
      'Ábrela para ver el resultado'
    );
    // Ready for a reason (nothing to check): the reason, translated.
    expect(
      localizeClaudeNotification(
        withData('task-ready', 'No check found', { blocker: 'no-check' }),
        strings
      ).body
    ).toBe('No hay comprobación para este proyecto');

    const conflict = localizeClaudeNotification(
      withData('task-needs-you', 'Conflicts with main in 2 files', { blocker: 'conflict' }),
      strings
    );
    expect(conflict.title).toBe('⏳ Una tarea te necesita: Nombre para perro');
    expect(conflict.body).toBe('Choca con cambios de la rama base');
    // A question: the agent's own words.
    expect(
      localizeClaudeNotification(
        withData('task-needs-you', '¿OAuth o email?', { blocker: 'question' }),
        strings
      ).body
    ).toBe('¿OAuth o email?');
    expect(
      localizeClaudeNotification(withData('task-needs-you', '', { blocker: 'permission' }), strings)
        .body
    ).toBe('Espera un permiso');

    const failed = localizeClaudeNotification(
      withData('task-failed', 'The check failed', { blocker: 'verify' }),
      strings
    );
    expect(failed.title).toBe('❌ Tarea fallida: Nombre para perro');
    expect(failed.body).toBe('La comprobación ha fallado');
    expect(
      localizeClaudeNotification(withData('task-failed', '', { blocker: 'setup' }), strings).body
    ).toBe('Ábrela para ver por qué');

    const merged = localizeClaudeNotification(
      withData('task-merged', '', { branch: 'main' }),
      strings
    );
    expect(merged.title).toBe('✅ Nombre para perro fusionada');
    expect(merged.body).toBe('Ya está en main');
    expect(
      localizeClaudeNotification(
        withData('task-merged', 'Login con Google', { branch: 'main' }),
        strings
      ).body
    ).toBe('Login con Google');

    // A task without a worktree finished (2026-10-24): its report, else the generic body.
    const done = localizeClaudeNotification(payload('task-done', 'Logs rotados'), strings);
    expect(done.title).toBe('✅ Tarea hecha: Nombre para perro');
    expect(done.body).toBe('Logs rotados');
    expect(localizeClaudeNotification(payload('task-done'), strings).body).toBe(
      'Ábrela para ver el resultado'
    );

    const missed = localizeClaudeNotification(payload('task-missed'), strings);
    expect(missed.title).toBe('⚠️ Tarea no ejecutada: Nombre para perro');
    expect(missed.body).toBe('El servidor estaba apagado a esa hora');
  });

  it('rebuilds AI review pushes: its own summary, and "not available" on a merge', () => {
    const strings = {
      ...es,
      taskNeedsYou: '⏳ Una tarea te necesita: {where}',
      taskMerged: '✅ {where} fusionada',
      taskMergedBody: 'Ya está en {branch}',
      taskReview: '🔎 Revisión: {where}',
      taskReviewUnavailable: 'revisión no disponible',
      taskBlockers: { review: 'La revisión IA ve problemas' },
    };
    const base = payload('task-needs-you', 'Divide entre n-1');
    const review = localizeClaudeNotification(
      { ...base, data: { ...base.data, blocker: 'review' } },
      strings
    );
    expect(review.title).toBe('🔎 Revisión: Nombre para perro');
    expect(review.body).toBe('Divide entre n-1');

    const merged = payload('task-merged', 'Hecho · AI review unavailable');
    expect(
      localizeClaudeNotification(
        { ...merged, data: { ...merged.data, review: 'unavailable', branch: 'main' } },
        strings
      ).body
    ).toBe('Hecho · revisión no disponible');
    const bare = payload('task-merged', 'AI review unavailable');
    expect(
      localizeClaudeNotification(
        { ...bare, data: { ...bare.data, review: 'unavailable', branch: 'main' } },
        strings
      ).body
    ).toBe('Ya está en main · revisión no disponible');
  });

  it("a confirmed security fix's push keeps its headline: how serious, what, the fix (2026-10-23)", () => {
    const strings = {
      ...es,
      taskNeedsYou: '⏳ Una tarea te necesita: {where}',
      taskBlockers: { security: 'arreglo de seguridad listo' },
    };
    const base = payload('task-needs-you', '🔴 SQL armado a mano → Usar parámetros');
    const pushed = localizeClaudeNotification(
      { ...base, data: { ...base.data, blocker: 'security' } },
      strings
    );
    expect(pushed.body).toBe('🔴 SQL armado a mano → Usar parámetros');
  });

  it("a security fix about to merge on its own says when in the phone's clock, and what (2026-10-23)", () => {
    const strings = {
      ...es,
      taskReady: '✅ Tarea lista: {where}',
      taskAutoMerge: 'Se fusiona a las {time}: {headline}',
    };
    const at = '2026-10-23T14:32:00.000Z';
    const base = payload('task-ready', 'Merges on its own at 14:32: 🔴 SQL → parámetros');
    const pushed = localizeClaudeNotification(
      { ...base, data: { ...base.data, autoMergeAt: at, headline: '🔴 SQL → parámetros' } },
      strings
    );
    const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(pushed.body).toBe(`Se fusiona a las ${time}: 🔴 SQL → parámetros`);
  });

  it('a task still waiting for a dirty base says so, nothing to answer (2026-10-24)', () => {
    const strings = {
      ...es,
      taskReady: '✅ Tarea lista: {where}',
      taskBaseWait: '⏳ Esperando para fusionar: {where}',
      taskBaseWaitBody: '{base} lleva {hours} h con cambios sin guardar. No tienes que hacer nada.',
      taskBlockers: { 'dirty-base': 'Tu copia principal tiene cambios sin guardar' },
    };
    const base = payload('task-ready', 'main has had uncommitted changes for 3 hours');
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const pushed = localizeClaudeNotification(
      {
        ...base,
        data: { ...base.data, blocker: 'dirty-base', baseWaitSince: since, base: 'develop' },
      },
      strings
    );
    expect(pushed.title).toBe('⏳ Esperando para fusionar: Nombre para perro');
    expect(pushed.body).toBe(
      'develop lleva 3 h con cambios sin guardar. No tienes que hacer nada.'
    );
  });

  it('a risky task: its countdown names the flagged files, a rejection the reason (2026-10-24)', () => {
    const strings = {
      ...es,
      taskReady: '✅ Tarea lista: {where}',
      taskNeedsYou: '⏳ Una tarea te necesita: {where}',
      taskAutoMerge: 'Se fusiona a las {time}: {headline}',
      taskRiskAutoMerge: 'Se fusiona a las {time}: {headline}. Delicado ({files})',
      taskRiskRejected: 'Sin fusionar. Segunda revisión: {reason}',
      taskRiskReviewUnavailable: 'Sin fusionar: la segunda revisión no pudo hacerse',
      taskBlockers: { risk: 'cambio delicado' },
    };
    const at = '2026-10-24T14:32:00.000Z';
    const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const ready = payload('task-ready', 'Merges on its own at 14:32: Renombrar. Flagged as risky');
    expect(
      localizeClaudeNotification(
        {
          ...ready,
          data: {
            ...ready.data,
            autoMergeAt: at,
            headline: 'Renombrar',
            riskFiles: 'a/sessions.ts',
          },
        },
        strings
      ).body
    ).toBe(`Se fusiona a las ${time}: Renombrar. Delicado (a/sessions.ts)`);
    const held = payload('task-needs-you', 'A risky change: auth in a · Second review: quita algo');
    const data = {
      ...held.data,
      blocker: 'risk',
      riskReview: 'dismissed',
      riskReason: 'quita algo',
    };
    expect(localizeClaudeNotification({ ...held, data }, strings).body).toBe(
      'Sin fusionar. Segunda revisión: quita algo'
    );
    expect(
      localizeClaudeNotification(
        { ...held, data: { ...held.data, blocker: 'risk', riskReview: 'unavailable' } },
        strings
      ).body
    ).toBe('Sin fusionar: la segunda revisión no pudo hacerse');
  });

  it('rebuilds a confirmation push: what it does, in the stored language', () => {
    const strings = {
      ...es,
      taskConfirm: '🔐 Confirma · {where}',
      taskConfirmBody: 'Un agente te pide permiso',
      taskConfirmKinds: { 'merge-risk': 'Fusionarla con sus cambios delicados' },
    };
    const confirm = (kind: string, detail = '') => {
      const base = payload('task-confirm', detail);
      return { ...base, data: { ...base.data, kind, confirmId: 'c1' } };
    };
    const risky = localizeClaudeNotification(confirm('merge-risk', 'secrets: .env'), strings);
    expect(risky.title).toBe('🔐 Confirma · Nombre para perro');
    expect(risky.body).toBe('Fusionarla con sus cambios delicados');
    expect(localizeClaudeNotification(confirm('discard', 'ut/x → main'), strings).body).toBe(
      'ut/x → main'
    );
    expect(localizeClaudeNotification(confirm('discard'), strings).body).toBe(
      'Un agente te pide permiso'
    );
  });

  it('words what the user’s autoApprove did, and when it failed (2026-10-24)', () => {
    const strings = {
      ...es,
      taskAutoApproved: '✅ Hecho sin preguntar · {where}',
      taskAutoApprovedFailed: '⚠️ Aprobado sin preguntar, pero ha fallado · {where}',
      taskConfirmKinds: { 'merge-risk': 'Fusionarla con sus cambios delicados' },
    };
    const done = (extra: Record<string, unknown> = {}) => {
      const base = payload('task-auto-approved', 'ut/x → main');
      return { ...base, data: { ...base.data, kind: 'merge-risk', ...extra } };
    };
    const ok = localizeClaudeNotification(done(), strings);
    expect(ok.title).toBe('✅ Hecho sin preguntar · Nombre para perro');
    expect(ok.body).toBe('Fusionarla con sus cambios delicados');
    const failed = localizeClaudeNotification(done({ failed: 'conflict' }), strings);
    expect(failed.title).toBe('⚠️ Aprobado sin preguntar, pero ha fallado · Nombre para perro');
    expect(failed.body).toBe('Fusionarla con sus cambios delicados: conflict');
  });

  it('says a countdown comes from autoApprove', () => {
    const strings = {
      ...es,
      taskReady: '✅ Tarea lista: {where}',
      taskAutoMerge: 'Se fusiona a las {time}: {headline}',
      taskAutoApproveMerge: 'Se fusiona a las {time} sin preguntarte: {headline}',
    };
    const base = payload('task-ready', 'x');
    const push = {
      ...base,
      data: {
        ...base.data,
        autoMergeAt: '2026-10-24T10:10:00Z',
        headline: 'Login',
        autoApproved: true,
      },
    };
    expect(localizeClaudeNotification(push, strings).body).toMatch(
      /^Se fusiona a las .+ sin preguntarte: Login$/
    );
  });

  it('a security notice: the project in the title, what was seen and what to do (2026-10-26)', () => {
    const strings = { ...es, securityNotice: '🛡️ Seguridad · {where}' };
    const base = payload('security-notice', 'El bucket es público');
    const notice = localizeClaudeNotification(
      {
        ...base,
        title: '🛡️ app: El bucket es público',
        data: { ...base.data, where: 'app', fix: 'Hacerlo privado' },
      },
      strings
    );
    expect(notice.title).toBe('🛡️ Seguridad · app');
    expect(notice.body).toBe('El bucket es público. Hacerlo privado');
  });

  it('the installed app updated itself, or could not: one line in the phone language (2026-11-11)', () => {
    const strings = {
      ...es,
      appUpdated: 'Untether se actualizó a {commit}',
      appUpdateFailed: 'Untether no pudo actualizarse',
      appUpdateReasons: { keychain: 'El llavero no dejó firmar la compilación' },
    };
    const updated = payload('app-updated', 'bbb2222');
    expect(
      localizeClaudeNotification(
        { ...updated, title: 'Untether updated itself to bbb2222', body: '' },
        strings
      )
    ).toMatchObject({ title: 'Untether se actualizó a bbb2222', body: '' });

    const failed = payload('app-update-failed', 'bbb2222');
    const english =
      'Untether could not update itself: the keychain did not let the build be signed';
    expect(
      localizeClaudeNotification(
        { ...failed, body: english, data: { ...failed.data, reason: 'keychain' } },
        strings
      )
    ).toMatchObject({
      title: 'Untether no pudo actualizarse',
      body: 'El llavero no dejó firmar la compilación',
    });

    // A build ready that waits too long: what holds it names a session, so the server's
    // sentence stays as the body.
    const waiting = payload('app-update-waiting', 'bbb2222');
    const held = "Untether's update to bbb2222 has been ready for 2 h 1 min: a check is running";
    expect(
      localizeClaudeNotification(
        { ...waiting, body: held },
        { ...strings, appUpdateWaiting: 'La actualización de Untether sigue esperando' }
      )
    ).toMatchObject({ title: 'La actualización de Untether sigue esperando', body: held });
    // A reason these strings do not have: the server's own words.
    expect(
      localizeClaudeNotification(
        { ...failed, body: english, data: { ...failed.data, reason: 'new-reason' } },
        strings
      ).body
    ).toBe(english);
  });

  it('the old tmux can leave Full Disk Access: once, in the phone language (2026-10-31)', () => {
    const strings = {
      ...es,
      tmuxOldPermission: '🧹 Ya puedes quitar el tmux antiguo',
      tmuxOldPermissionBody: 'Quita el tmux antiguo ({old}) de Acceso total al disco.',
    };
    const base = payload('tmux-old-permission', '/opt/homebrew/bin/tmux');
    const notice = localizeClaudeNotification(
      { ...base, title: '🧹 You can remove the old tmux', data: { ...base.data, where: 'tmux' } },
      strings
    );
    expect(notice.title).toBe('🧹 Ya puedes quitar el tmux antiguo');
    expect(notice.body).toBe(
      'Quita el tmux antiguo (/opt/homebrew/bin/tmux) de Acceso total al disco.'
    );
  });

  it('rebuilds the auto-merge pause from its code and count, never the English reason', () => {
    const strings = {
      ...es,
      projectPaused: '⏸️ Fusión automática en pausa · {where}',
      projectPausedBody: '{reason}. Durante las próximas 24 horas sus tareas te esperarán.',
      projectPausedBodyGeneric: 'Durante las próximas 24 horas sus tareas te esperarán.',
      projectPausedReasons: {
        reverts: 'se deshicieron {n} tareas que se habían fusionado solas',
        failures: '{n} tareas siguieron fallando',
      },
    };
    const paused = (extra: Record<string, unknown>) => {
      const base = payload('project-paused', '2 of its tasks that merged on their own were undone');
      return {
        ...base,
        title: '⏸️ Auto-merge paused: app',
        data: { ...base.data, where: 'app', ...extra },
      };
    };
    const reverts = localizeClaudeNotification(paused({ code: 'reverts', count: 2 }), strings);
    expect(reverts.title).toBe('⏸️ Fusión automática en pausa · app');
    expect(reverts.body).toBe(
      'Se deshicieron 2 tareas que se habían fusionado solas. Durante las próximas 24 horas sus tareas te esperarán.'
    );
    expect(localizeClaudeNotification(paused({ code: 'failures', count: 3 }), strings).body).toBe(
      '3 tareas siguieron fallando. Durante las próximas 24 horas sus tareas te esperarán.'
    );
    // No code (or an unknown one): the generic sentence, not the English detail.
    for (const extra of [{}, { code: 'other', count: 4 }, { code: 'reverts' }]) {
      const body = localizeClaudeNotification(paused(extra), strings).body;
      expect(body).toBe('Durante las próximas 24 horas sus tareas te esperarán.');
    }
  });

  it('translates Untether’s own English when its automatic fixes ran out', () => {
    const strings = {
      ...es,
      taskReview: '🔎 Revisión: {where}',
      taskNeedsYou: '⏳ Una tarea te necesita: {where}',
      taskFailed: '❌ Tarea fallida: {where}',
      taskGaveUp:
        'Untether pidió a su agente que la arreglara {n} veces y sigue sin poder fusionarse',
      taskBlockers: { verify: 'La comprobación ha fallado' },
    };
    const gaveUp = (type: string, blocker: string, rest: string) => {
      const base = payload(
        type,
        `Untether had its agent fix it 2 times and it still does not merge: ${rest}`
      );
      return { ...base, data: { ...base.data, blocker } };
    };
    // A review: the reviewer's own words follow.
    expect(
      localizeClaudeNotification(gaveUp('task-needs-you', 'review', 'Divide entre n-1'), strings)
        .body
    ).toBe(
      'Untether pidió a su agente que la arreglara 2 veces y sigue sin poder fusionarse: Divide entre n-1'
    );
    // Anything else: the translated kind, not the English blocker message.
    expect(
      localizeClaudeNotification(gaveUp('task-failed', 'verify', 'The check failed'), strings).body
    ).toBe(
      'Untether pidió a su agente que la arreglara 2 veces y sigue sin poder fusionarse: La comprobación ha fallado'
    );
    // The reviewer's own summary alone stays as it is.
    const plain = payload('task-needs-you', 'Divide entre n-1');
    expect(
      localizeClaudeNotification({ ...plain, data: { ...plain.data, blocker: 'review' } }, strings)
        .body
    ).toBe('Divide entre n-1');
  });

  it('names an undo task in the stored language', () => {
    const strings = { ...es, taskReady: '✅ Tarea lista: {where}', undoName: 'Deshacer: {name}' };
    const base = payload('task-ready', 'hecho');
    const push = { ...base, data: { ...base.data, where: 'Undo: Login con Google' } };
    expect(localizeClaudeNotification(push, strings).title).toBe(
      '✅ Tarea lista: Deshacer: Login con Google'
    );
  });

  it('rebuilds a failed-command notification with its exit code and duration', () => {
    const strings = {
      ...es,
      commandFailed: '❌ Ha fallado: {where}',
      commandFailedBody: 'Código de salida {code} · {duration}',
    };
    const failed = {
      ...payload('command-error', '12s'),
      data: { type: 'command-error', where: 'npm test', detail: '12s', exitCode: 1 },
    };
    const out = localizeClaudeNotification(failed, strings);
    expect(out.title).toBe('❌ Ha fallado: npm test');
    expect(out.body).toBe('Código de salida 1 · 12s');
  });

  it('rebuilds a bell notification', () => {
    const withBell = { ...es, attention: '🔔 {where} necesita atención', bellBody: 'Campana' };
    const out = localizeClaudeNotification(payload('bell'), withBell);
    expect(out.title).toBe('🔔 Nombre para perro necesita atención');
    expect(out.body).toBe('Campana');
  });

  it('names Codex in its own "needs you" and "finished", in the stored language', () => {
    const waiting = localizeClaudeNotification(payload('codex-waiting'), es);
    expect(waiting.title).toBe('⏳ Codex te necesita · Nombre para perro');
    expect(waiting.body).toBe('Esperando tu respuesta');
    const finished = localizeClaudeNotification(payload('codex-finished', 'Hecho.'), es);
    expect(finished.title).toBe('✅ Codex ha terminado · Nombre para perro');
    expect(finished.body).toBe('Hecho.');
    // A session named after Claude keeps its name.
    const named = {
      ...payload('codex-finished'),
      data: { type: 'codex-finished', where: 'Claude vs Codex', detail: '' },
    };
    expect(localizeClaudeNotification(named, es).title).toBe(
      '✅ Codex ha terminado · Claude vs Codex'
    );
  });

  it('rebuilds a "needs you" notification in the stored language', () => {
    const out = localizeClaudeNotification(payload('claude-waiting'), es);
    expect(out.title).toBe('⏳ Claude te necesita · Nombre para perro');
    expect(out.body).toBe('Esperando tu respuesta');
    expect(out.actions?.map((a) => a.title)).toEqual(['Abrir', 'Descartar']);
  });

  it('translates what Claude waits for, and keeps a reason it does not know as written', () => {
    const strings = { ...es, reasons: { permission: 'Petición de permiso' } };
    expect(
      localizeClaudeNotification(payload('claude-waiting', 'permission prompt'), strings).body
    ).toBe('Petición de permiso');
    expect(
      localizeClaudeNotification(payload('claude-waiting', 'Bash permission'), strings).body
    ).toBe('Bash permission');
  });

  it("keeps Claude's own words as the body", () => {
    const out = localizeClaudeNotification(payload('claude-finished', 'Canelo'), es);
    expect(out.title).toBe('✅ Claude ha terminado · Nombre para perro');
    expect(out.body).toBe('Canelo');
  });

  it('rebuilds "replied" (background agents still running)', () => {
    const strings = {
      ...es,
      replied: '💬 Claude ha respondido · {where}',
      repliedBody: 'Los agentes en segundo plano siguen en marcha',
    };
    const out = localizeClaudeNotification(payload('claude-replied', 'Lanzado.'), strings);
    expect(out.title).toBe('💬 Claude ha respondido · Nombre para perro');
    expect(out.body).toBe('Lanzado.');
    expect(localizeClaudeNotification(payload('claude-replied'), strings).body).toBe(
      'Los agentes en segundo plano siguen en marcha'
    );
  });

  it('keeps a "$" in the session name literally', () => {
    const named = {
      ...payload('claude-waiting'),
      data: { type: 'claude-waiting', where: "cost $' fix $$", detail: '' },
    };
    expect(localizeClaudeNotification(named, es).title).toBe(
      "⏳ Claude te necesita · cost $' fix $$"
    );
  });

  // 2026-11-11: no half sets. The worker and the app ship together, so strings stored by
  // another build (a text or a word list missing) are not used at all: the push shows the
  // server's own words until the app stores its set again, on its next load.
  it('only uses a stored string set that is whole: every text and every word list', () => {
    expect(isNotifyStrings(es)).toBe(true);
    expect(isNotifyStrings(JSON.parse(JSON.stringify(buildNotifyStrings())))).toBe(true);
    expect(isNotifyStrings({ ...es, finished: undefined })).toBe(false);
    const { taskReady: _taskReady, ...withoutALaterText } = es;
    expect(isNotifyStrings(withoutALaterText)).toBe(false);
    const { taskConfirmKinds: _kinds, ...withoutAWordList } = es;
    expect(isNotifyStrings(withoutAWordList)).toBe(false);
    expect(isNotifyStrings({ ...es, reasons: 'permission' })).toBe(false);
    expect(isNotifyStrings({ ...es, taskBlockers: { review: 3 } })).toBe(false);
    expect(
      isNotifyStrings({
        needsYou: 'a',
        finished: 'b',
        waiting: 'c',
        yourTurn: 'd',
        open: 'e',
        dismiss: 'f',
      })
    ).toBe(false);
    expect(isNotifyStrings(null)).toBe(false);
  });

  it('leaves other notifications and missing strings alone', () => {
    const other = payload('session-exit');
    expect(localizeClaudeNotification(other, es)).toBe(other);
    const waiting = payload('claude-waiting');
    expect(localizeClaudeNotification(waiting, null)).toBe(waiting);
  });
});

// Audit 2026-10-20: every push shows something (iOS revokes silent subscriptions), and the
// worker's own buttons follow the stored language.
describe('push payload handling', () => {
  it('rejects payloads that cannot be shown as sent', () => {
    expect(coercePushPayload(null)).toBeNull();
    expect(coercePushPayload('text')).toBeNull();
    expect(coercePushPayload({ body: 'no title' })).toBeNull();
    expect(coercePushPayload({ title: '' })).toBeNull();
  });

  it('fills in a missing body and data so showing it cannot throw', () => {
    const shown = coercePushPayload({ title: 'Hi', actions: [{ action: 'x' }, 'bad'] });
    expect(shown).toMatchObject({ title: 'Hi', body: '', data: {} });
    expect(shown?.actions).toEqual([]);
  });

  it('builds a stand-in notification, translated when strings are stored', () => {
    expect(fallbackPushNotification(null)).toMatchObject({
      title: 'Untether',
      body: 'Something new in Untether',
    });
    expect(
      fallbackPushNotification({ ...es, fallbackBody: 'Hay novedades en Untether' }).body
    ).toBe('Hay novedades en Untether');
  });

  it('translates the default buttons', () => {
    expect(defaultNotificationActions('session-exit', es)).toEqual([
      { action: 'view-session', title: 'Abrir' },
      { action: 'dismiss', title: 'Descartar' },
    ]);
    expect(defaultNotificationActions(undefined, es)).toEqual([
      { action: 'dismiss', title: 'Descartar' },
    ]);
  });

  it('translates server-sent button titles of any push type', () => {
    expect(
      localizeActionTitles(
        [
          { action: 'view-session', title: 'View Session' },
          { action: 'dismiss', title: 'Dismiss' },
          { action: 'custom', title: 'Custom' },
        ],
        es
      )
    ).toEqual([
      { action: 'view-session', title: 'Abrir' },
      { action: 'dismiss', title: 'Descartar' },
      { action: 'custom', title: 'Custom' },
    ]);
    expect(localizeActionTitles(undefined, es)).toBeUndefined();
  });
});

describe('review-unavailable pushes', () => {
  it('say the review is retried by itself, in the stored language', () => {
    const strings = {
      ...es,
      taskReady: '✅ Tarea lista: {where}',
      taskBlockers: { 'review-unavailable': 'Revisión pendiente: se reintenta sola' },
    };
    const base = payload('task-ready', 'claude timed out');
    const shown = localizeClaudeNotification(
      { ...base, data: { ...base.data, blocker: 'review-unavailable' } },
      strings
    );
    expect(shown.title).toBe('✅ Tarea lista: Nombre para perro');
    expect(shown.body).toBe('Revisión pendiente: se reintenta sola');
  });
});

describe('task-stalled and task-paused pushes (2026-11-02)', () => {
  const strings = {
    ...es,
    taskStalled: '🐢 Tarea atascada: {where}',
    taskStalledBody: 'Sin progreso: su agente espera algo.',
    taskStalledEscalatedBody: 'Sigue sin progreso tras el aviso.',
    taskPaused: '⏸ Tarea en pausa: {where}',
    taskPausedBody: 'Untether la retoma solo a las {time}',
  };

  it('a stalled task reads in Spanish, with the escalated sentence after the nudge', () => {
    const base = payload('task-stalled', 'No progress for 20 min: last Bash; it waits on …');
    const first = localizeClaudeNotification(base, strings);
    expect(first.title).toBe('🐢 Tarea atascada: Nombre para perro');
    expect(first.body).toBe('Sin progreso: su agente espera algo.');
    const again = localizeClaudeNotification(
      { ...base, data: { ...base.data, escalated: true } },
      strings
    );
    expect(again.body).toBe('Sigue sin progreso tras el aviso.');
  });

  it('a paused task names the time it goes on, or keeps the server sentence without one', () => {
    const base = payload('task-paused', 'Codex hit its usage limit');
    const resumeAt = new Date(2026, 10, 2, 4, 27).toISOString();
    const timed = localizeClaudeNotification(
      { ...base, data: { ...base.data, resumeAt } },
      strings
    );
    expect(timed.title).toBe('⏸ Tarea en pausa: Nombre para perro');
    expect(timed.body).toMatch(/^Untether la retoma solo a las .*4.*27/);
    expect(localizeClaudeNotification(base, strings).body).toBe('English body');
  });
});

describe('every task push type is translated in every language', () => {
  it('lists the types the scheduler can send', () => {
    expect(TASK_PUSH_TYPES).toContain('task-stalled');
    expect(new Set(TASK_PUSH_TYPES).size).toBe(TASK_PUSH_TYPES.length);
  });

  it('has a title in each supported language that is not the English one', async () => {
    const titles = new Map<string, Map<string, string>>();
    for (const locale of SUPPORTED_LOCALES) {
      await setLocale(locale);
      const strings = buildNotifyStrings();
      const byType = new Map<string, string>();
      for (const type of TASK_PUSH_TYPES) {
        const shown = localizeClaudeNotification(payload(type, 'English detail'), strings);
        expect(shown.title, `${locale}: ${type} not localized`).not.toBe(`English ${type}`);
        expect(shown.title).toContain('Nombre para perro');
        byType.set(type, shown.title);
      }
      titles.set(locale, byType);
    }
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      for (const type of TASK_PUSH_TYPES) {
        // t() falls back to English for a missing key: the same title as English is untranslated.
        expect(titles.get(locale)?.get(type), `${locale}: ${type} is English`).not.toBe(
          titles.get('en')?.get(type)
        );
      }
    }
    await setLocale('en');
  });
});

// Decision 2026-11-11: every push vibrates by its type. Until then no push ever carried a
// pattern: the worker asked `'vibrate' in navigator`, which is false in every worker.
describe('vibration by push type', () => {
  it('the more a push needs the user, the longer it vibrates; an unknown type, briefly', () => {
    const total = (type: string) => vibrationPattern(type).reduce((sum, ms) => sum + ms, 0);
    expect(vibrationPattern('session-error')).toEqual([200, 100, 200, 100, 200]);
    expect(vibrationPattern('claude-waiting')).toEqual([120, 60, 120, 60, 120]);
    expect(vibrationPattern('codex-waiting')).toEqual(vibrationPattern('task-needs-you'));
    expect(total('task-failed')).toBeGreaterThan(total('task-needs-you'));
    expect(total('task-needs-you')).toBeGreaterThan(total('task-merged'));
    expect(vibrationPattern('something-new')).toEqual([100]);
  });

  it('the notification the worker shows carries the pattern, with no navigator to ask', () => {
    // A worker's global has no navigator.vibrate: the options must not depend on it.
    vi.stubGlobal('navigator', {});
    try {
      const shown = coercePushPayload({ title: 'T', data: { type: 'task-needs-you' } });
      if (!shown) throw new Error('payload refused');
      const options = notificationOptionsFor(shown, null, 1_700_000_000_000);
      expect(options.vibrate).toEqual([120, 60, 120, 60, 120]);
      expect(options.silent).toBe(false);
      expect(options.tag).toBe('untether-task-needs-you-1700000000000');
      const plain = coercePushPayload({ title: 'T' });
      if (!plain) throw new Error('payload refused');
      expect(notificationOptionsFor(plain, null, 1).vibrate).toEqual([100]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
