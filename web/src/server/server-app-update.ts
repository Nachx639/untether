// The installed Mac app catches up by itself: its updater, and what the doctor asks of it.
import { execFileSync, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { TaskState } from '../shared/tasks.js';
import { currentBuild, readBinaryBuild, SOURCE_REPO } from './build-info.js';
import type { AppContext } from './server-context.js';
import { cachedBinaryBuild } from './services/doctor-checks.js';
import {
  appAbove,
  appLag,
  gitIn,
  isInstalledApp,
  type RunningApp,
  readAppBuild,
} from './services/installed-app.js';
import { APP_BUILD_WORKTREE, buildInstalledApp } from './services/installed-app-build.js';
import {
  type AppUpdateNotice,
  appUpdateFrom,
  InstalledAppUpdater,
} from './services/installed-app-updater.js';
import { checkLimiter, checkLoadGate, runCheck } from './services/task-verify.js';
import { defaultWorktreeRoot } from './services/task-worktree.js';
import { createLogger } from './utils/logger.js';
import { resolveNodeRuntime } from './utils/node-runtime.js';
import { every } from './utils/periodic-loop.js';

const logger = createLogger('server');

/**
 * A task being prepared, checked or merged holds the swap only this long after it got there:
 * those steps take seconds or minutes, and one stuck in them for hours is not work going on.
 * A check that really runs holds it by itself, for as long as it runs.
 */
export const ENGINE_STEP_MAX_MS = 15 * 60_000;
const ENGINE_STEPS: readonly TaskState[] = ['preparing', 'verifying', 'merging'];
/**
 * A tool call an agent started holds the swap this long at most, and only while the agent is
 * at work on it (not asking for permission, not at a question, its screen not at rest): no
 * command of a turn runs longer, and one left open by a turn that was cut is not work.
 */
export const TOOL_RUN_MAX_MS = 60 * 60_000;
const BUILD_TIMEOUT_SEC = 90 * 60;

/** The phone's line after an update, or after one that could not be made (sw-notify-i18n.ts). */
export function appUpdatePush(notice: AppUpdateNotice) {
  const type = notice.ok
    ? 'app-updated'
    : notice.waiting
      ? 'app-update-waiting'
      : 'app-update-failed';
  return {
    type,
    title: notice.ok
      ? notice.text
      : notice.waiting
        ? "Untether's update is waiting for a quiet moment"
        : 'Untether could not update itself',
    body: notice.ok ? '' : notice.text,
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    tag: 'untether-app-update',
    data: {
      type,
      where: 'Untether',
      detail: notice.commit,
      ...(notice.failure ? { reason: notice.failure } : {}),
    },
  };
}

/** What is going on in the server, as far as swapping the app under it goes. */
export interface QuietFacts {
  tasks: Array<{ name: string; state: TaskState; stateSince: number }>;
  /** Checks running now (not the ones waiting for a slot or for the load to drop). */
  checksRunning: number;
  /** The running sessions an agent was seen in. */
  sessions: Array<{
    id: string;
    name?: string;
    /** The agent's last event of any kind (a hook, a rollout line). */
    lastEventAt?: number;
    /** When its Claude was last seen starting to work (for one that sends no events). */
    busySeenAt?: number;
    /** Its screen reads as working right now (not waiting at a prompt, not idle). */
    screenBusy?: boolean;
    /** When its terminal last wrote; counted only while its screen reads as working. */
    lastOutputAt?: number;
    /** The agent's state by its events ('working', 'permission', 'question', 'halted'…). */
    agentState?: string;
    /** Its screen reads as at rest or waiting for the user. */
    screenResting?: boolean;
    /** Since when its oldest tool call still open has been open. */
    toolOpenSince?: number;
  }>;
}

/**
 * Why this is not a quiet moment for swapping the app, or null. Only activity that is really
 * going on counts: a check running, a task that just got to a step of the engine, an agent that
 * did something in the last `quietMs`. Never a state alone, nor a turn or a tool call left open:
 * 2026-11-11, a build stood ready for 5 h 20 min because a task waited four hours at a
 * permission prompt, its tool call open all that time ("an agent is in the middle of a turn"),
 * while every other task was paused at Claude's usage limit.
 *
 * A terminal writes all the time (a session at rest still redraws), so its output counts only
 * while the agent's screen reads as working: that is what tells a long silent command, whose
 * timer ticks, from a prompt nobody answers.
 */
export function quietBlocker(facts: QuietFacts, quietMs: number, now: number): string | null {
  if (facts.checksRunning > 0) return 'a check is running';
  for (const task of facts.tasks) {
    if (ENGINE_STEPS.includes(task.state) && now - task.stateSince < ENGINE_STEP_MAX_MS) {
      return `task "${task.name}" is ${task.state}`;
    }
  }
  for (const session of facts.sessions) {
    const last = Math.max(
      session.lastEventAt ?? 0,
      session.busySeenAt ?? 0,
      session.screenBusy ? (session.lastOutputAt ?? 0) : 0
    );
    const who = session.name ? `"${session.name}", ` : '';
    // A long command that says nothing: the call is open, the agent is at work on it (the
    // 2026-11-11 call was open too, but its agent was asking for permission).
    if (
      session.toolOpenSince !== undefined &&
      session.agentState === 'working' &&
      !session.screenResting &&
      now - session.toolOpenSince < TOOL_RUN_MAX_MS
    ) {
      return `an agent's command has been running for ${Math.max(0, Math.round((now - session.toolOpenSince) / 60_000))} min (${who}session ${session.id.slice(0, 8)})`;
    }
    if (last && now - last < quietMs) {
      return `an agent was at work ${Math.max(0, Math.round((now - last) / 1000))} s ago (${who}session ${session.id.slice(0, 8)})`;
    }
  }
  return null;
}

export function setupAppUpdate(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    agentEvents,
    claudeBusySeen,
    config,
    configService,
    ptyManager,
    pushNotificationService,
  } = ctx;
  const repo = SOURCE_REPO;
  const git = gitIn(repo);
  const worktree = path.join(defaultWorktreeRoot(repo), APP_BUILD_WORKTREE);
  const dir = path.join(path.dirname(CONTROL_DIR), 'app-update');

  // Only a development server (a checkout) that an installed app started has an app to keep
  // up: the app's own bundled server ships with it, and a server run from a terminal has none.
  let found: Promise<RunningApp | undefined> | undefined;
  let current: RunningApp | undefined;
  const app = () => {
    found ??= (
      currentBuild().dev
        ? appAbove(process.pid).then((running) =>
            running && isInstalledApp(running.appPath, os.homedir()) ? running : undefined
          )
        : Promise.resolve(undefined)
    ).then((running) => {
      current = running;
      return running;
    });
    return found;
  };
  void app();
  // The app's CLI (~80 MB) is read once per change of it; git is asked at most every 90 s.
  const readBinary = cachedBinaryBuild(readBinaryBuild);
  const appBuild = (appPath: string) => readAppBuild(appPath, readBinary);
  let lagSeen: { commit: string; at: number; lag: ReturnType<typeof appLag> } | undefined;
  const lag = (commit: string) => {
    if (!lagSeen || lagSeen.commit !== commit || Date.now() - lagSeen.at > 90_000) {
      lagSeen = { commit, at: Date.now(), lag: appLag(commit, git) };
    }
    return lagSeen.lag;
  };
  const settings = () => appUpdateFrom(configService.getConfig().appUpdate);
  const enabled = () => configService.getConfig().autoUpdateInstalledApp === true;

  const updater = new InstalledAppUpdater({
    enabled,
    settings,
    app,
    appBuild,
    lag,
    loadHigh: () => checkLoadGate.sample().high,
    buildRunning: () => {
      try {
        // Whatever still runs from the build's worktree (xcodebuild, pnpm, node-gyp).
        execFileSync('pgrep', ['-f', worktree], { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    },
    inCheckSlot: (task) => checkLimiter.run(task),
    build: async (commit) =>
      buildInstalledApp({
        repo,
        worktree,
        commit,
        logPath: path.join(dir, 'build.log'),
        run: async (cwd, logPath) =>
          runCheck({
            command: './scripts/build.sh --configuration Release',
            cwd,
            timeoutSec: BUILD_TIMEOUT_SEC,
            logPath,
            node: await resolveNodeRuntime(path.join(cwd, '..', 'web')),
          }),
      }),
    busy: () =>
      quietBlocker(
        {
          tasks: (ctx.taskScheduler?.list() ?? []).map((task) => ({
            name: task.name,
            state: task.state,
            stateSince: Date.parse(task.stateSince) || 0,
          })),
          checksRunning: checkLimiter.active,
          sessions: ptyManager
            .listSessions()
            .filter((session) => session.status === 'running')
            .map((session) => {
              const agent = agentEvents.snapshot(session.id);
              const seen = ctx.eventLog.latestSessionState(session.id);
              return {
                id: session.id,
                name: session.userTitle || session.name,
                lastEventAt: agent?.lastEventAt,
                busySeenAt: claudeBusySeen.get(session.id),
                screenBusy: seen?.state === 'busy' && seen.background !== true,
                agentState: agent?.state,
                screenResting: seen?.state === 'idle' || seen?.state === 'waiting',
                toolOpenSince: agent?.toolsOpen ? agent.waitingOn?.since : undefined,
                lastOutputAt: ctx.terminalManager.outputModifiedAt(session.id),
              };
            }),
        },
        settings().quietSec * 1000,
        Date.now()
      ),
    swapCommands: (running) => {
      let bundleId = 'com.nachx639.untether';
      let serverGroup: number | undefined;
      try {
        bundleId = execFileSync(
          '/usr/bin/plutil',
          [
            '-extract',
            'CFBundleIdentifier',
            'raw',
            path.join(running.appPath, 'Contents', 'Info.plist'),
          ],
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
      } catch {
        // The app's own identifier stands.
      }
      try {
        serverGroup = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
            encoding: 'utf8',
            timeout: 5000,
          }).trim()
        );
      } catch {
        // Unknown: the helper leaves the old server to its app.
      }
      return {
        quit: ['/usr/bin/osascript', '-e', `tell application id "${bundleId}" to quit`],
        open: ['/usr/bin/open', running.appPath],
        healthUrl: `http://127.0.0.1:${config.port}/api/health`,
        ...(serverGroup && serverGroup > 1 ? { serverGroup } : {}),
      };
    },
    // Detached, in a session of its own, nothing of this server's to hold: the app it closes
    // takes this server (its whole process group) down, and the helper must go on.
    startHelper: (planPath) => {
      const child = spawn(
        process.execPath,
        [path.join(repo, 'web', 'scripts', 'app-swap-helper.cjs'), planPath],
        {
          detached: true,
          stdio: 'ignore',
          cwd: os.homedir(),
          env: { ...process.env, NODE_OPTIONS: '' },
        }
      );
      child.unref();
    },
    notify: (notice) => {
      logger.log(`app update: ${notice.text}`);
      ctx.eventLog.record({
        type: 'doctor.finding',
        key: `app-update:${notice.commit}`,
        check: 'app-build',
        severity: notice.ok ? 'info' : 'warning',
        message: notice.text,
        ...(notice.ok ? { healed: notice.text } : {}),
      });
      pushNotificationService
        ?.sendNotification(appUpdatePush(notice))
        .catch((error) => logger.warn(`app update push failed: ${error}`));
    },
    dir,
    log: (message) => logger.log(message),
  });

  // What a swap the previous server started came to; a little after start, so the phone's
  // subscriptions are loaded.
  const first = setTimeout(() => updater.afterRestart(), 20_000);
  first.unref?.();
  const interval = every(
    'app update',
    () => {
      updater.tick().catch((error) => logger.warn(`app update look failed: ${error}`));
    },
    60_000
  );
  interval.unref?.();

  return {
    installedApp: {
      app,
      /** The same, once looked for (Settings shows the switch only when there is one). */
      current: () => current,
      appBuild,
      lag,
      enabled,
      heldBy: () => updater.heldBy(),
      schedule: () => updater.schedule(),
      /** What the updater is doing, in one line (`ut status`, `ut doctor`). */
      status: () => updater.status(),
    },
  };
}
