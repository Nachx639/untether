// Untether's doctor: its checks and /api/doctor.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { TASK_FINAL_STATES } from '../shared/tasks.js';
import type { Session, SessionSuspension } from '../shared/types.js';
import { currentBuild, installedCliBinaries, readBinaryBuild } from './build-info.js';
import type { AppContext } from './server-context.js';
import { BackupdWatch, untetherOwnedDirs } from './services/backup-exclusion.js';
import {
  claudeFormatSurprises,
  findClaudeTranscript,
  turnEndSeen,
  unknownClaudeStatuses,
} from './services/claude-chat.js';
import { ensureClaudeHookFiles } from './services/claude-hooks.js';
import { connectorCheck } from './services/connector/connector-health.js';
import { DiskGrowthWatch } from './services/disk-growth.js';
import {
  agentEventsCheck,
  appBuildRunning,
  backupdCpuCheck,
  backupExclusionCheck,
  bigCastsCheck,
  cachedBinaryBuild,
  claudeStatusCheck,
  claudeVersionCheck,
  cliBuildCheck,
  closeShieldServer,
  compactCastsWithForwarder,
  configValidCheck,
  configWritableCheck,
  controlDirCheck,
  dirInUse,
  diskCheck,
  findTestDirs,
  finishedTaskSessionsCheck,
  flakyUnderLoadCheck,
  forwarderBuildCheck,
  githubRepoOf,
  launchServices,
  logErrorsCheck,
  loopFailuresCheck,
  movedProjectsCheck,
  nativePtyCheck,
  orchestratorsCheck,
  probeClaudeCompat,
  processEnvNames,
  publishGuardCheck,
  rebuildNativeModules,
  recentTranscriptTails,
  registeredAppsCheck,
  replacedSessionsCheck,
  resourcesCheck,
  rustToolchainFound,
  scanShieldServers,
  securitySweepCheck,
  serverCrashesCheck,
  sessionEnvCheck,
  stableTmuxCheck,
  staleTestDirsCheck,
  strayShieldTmuxCheck,
  stuckTasksCheck,
  taskGuardCheck,
  taskNodeCheck,
  taskOrphansCheck,
  unansweredMessagesCheck,
  unshieldedCheck,
} from './services/doctor-checks.js';
import { appBuildCheck, loadsInChild, nativeModulesLoadCheck } from './services/installed-app.js';
import { unknownClaudeFlags } from './services/mac-sessions/relaunch-command.js';
import { mergeQueue, mergeQueueKey } from './services/merge-queue.js';
import { mergeTrainsFor } from './services/merge-train.js';
import {
  claudePidOfConversation,
  lastTranscriptModel,
  type ModelUse,
  modelFlag,
  modelObservations,
  processClaudeLaunch,
  recentTranscriptModels,
  sessionModelChanged,
  tailLines,
  unexpectedModelsCheck,
} from './services/model-observations.js';
import { providerModels } from './services/model-providers.js';
import { memoryHolders } from './services/resource-monitor.js';
import { controlWarnBytes, rotationLimits } from './services/session-recordings.js';
import { suspendedSessionsCheck } from './services/session-suspender.js';
import { oldTmuxPermissionPush } from './services/stable-tmux.js';
import { FINISHED_SESSION_LINGER_MS } from './services/task-scheduler.js';
import { checkAlive } from './services/task-verify.js';
import { ttsHome } from './services/tts.js';
import { UntetherDoctor } from './services/untether-doctor.js';
import { TASK_CLI_HELP } from './task-cli.js';
import { claudeConfigDir } from './utils/claude-dir.js';
import { crashMarksFile } from './utils/crash-marks.js';
import { createLogger, getLogFilePath } from './utils/logger.js';
import { resolveNodeRuntime } from './utils/node-runtime.js';
import { loopFailures } from './utils/periodic-loop.js';
import { VERSION } from './version.js';

const logger = createLogger('server');
/** When this server process started: a hook silence older than that counts from it. */
const SERVER_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

export function setupDoctor(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    agentEvents,
    agentSignals,
    app,
    backupExclusion,
    claudeBusySeen,
    configService,
    connectorHealth,
    hookFiles,
    projectSettings,
    ptyManager,
    pushNotificationService,
    resourceMonitor,
    securitySweeper,
    sessionManager,
    sessionReplacements,
    stableTmux,
    statusSeenByRoles,
  } = ctx;
  // Untether's doctor (2026-10-20): checks Untether itself every few minutes, heals what is
  // safe, tells Untether's own orchestrator the rest (the phone when none runs and it matters).
  const webDir = path.resolve(__dirname, '..', '..');
  const untetherRepo = path.resolve(webDir, '..');
  // The bundled server sits next to the forwarder; a dev server uses the one the web build made,
  // cargo's, or the installed app's. The doctor's forwarder-build check follows the same order.
  const forwarderCandidates = () =>
    [
      process.env.UNTETHER_FWD_BIN,
      path.join(path.dirname(process.execPath), 'untether-fwd'),
      path.join(webDir, 'native', 'untether-fwd'),
      path.join(untetherRepo, 'native', 'ut-fwd', 'target', 'release', 'untether-fwd'),
      '/Applications/Untether.app/Contents/Resources/untether-fwd',
    ].filter((candidate): candidate is string => !!candidate);
  // Time Machine's backupd over the doctor's runs (2026-11-02: 14 h at ~100% CPU).
  const backupdWatch = new BackupdWatch();
  const untetherDoctor = new UntetherDoctor({
    statePath: path.join(CONTROL_DIR, 'doctor.json'),
    checks: [
      nativePtyCheck({
        helperPath: () => {
          try {
            return path.join(
              path.dirname(require.resolve('node-pty/package.json')),
              'build',
              'Release',
              'spawn-helper'
            );
          } catch {
            return null;
          }
        },
        rebuild: rebuildNativeModules(webDir),
        building: () => appBuildRunning(webDir),
      }),
      stuckTasksCheck({
        tasks: () => ctx.taskScheduler?.list() ?? [],
        batchOf: (task) =>
          task.repoPath && task.baseBranch
            ? mergeTrainsFor(mergeQueue).cars(mergeQueueKey(task.repoPath, task.baseBranch))
            : [],
        checkAlive,
        admission: () => resourceMonitor.admission(),
      }),
      resourcesCheck({
        monitor: resourceMonitor,
        tasks: () => ctx.taskScheduler?.list() ?? [],
        backupd: () => backupdWatch.busy(),
        memoryHolders: () => memoryHolders(),
      }),
      backupdCpuCheck({ watch: backupdWatch, tasks: () => ctx.taskScheduler?.list() ?? [] }),
      backupExclusionCheck({
        exclusion: backupExclusion,
        dirs: () =>
          untetherOwnedDirs({
            controlDir: CONTROL_DIR,
            taskLogDir: path.join(path.dirname(CONTROL_DIR), 'tasks'),
            ttsDir: ttsHome(),
            repoPaths: projectSettings.list().map(({ repoPath }) => repoPath),
            worktreePaths: (ctx.taskScheduler?.list() ?? []).flatMap(
              (task) => task.worktreePath ?? []
            ),
          }),
      }),
      flakyUnderLoadCheck({ list: () => ctx.flakyTests.list() }),
      finishedTaskSessionsCheck({
        lingering: () => ctx.taskScheduler?.lingeringSessions(FINISHED_SESSION_LINGER_MS) ?? [],
        stop: (taskId) =>
          ctx.taskScheduler?.stopLingeringSession(taskId) ?? Promise.resolve('not-needed' as const),
      }),
      taskOrphansCheck({
        reap: () => ctx.taskOrphanReaper?.reap() ?? Promise.resolve([]),
        recent: () => ctx.taskOrphanReaper?.recent() ?? [],
        suspects: () => ctx.taskOrphanReaper?.suspects() ?? [],
      }),
      securitySweepCheck({ stale: () => securitySweeper?.stale() ?? [] }),
      publishGuardCheck({
        repo: untetherRepo,
        publicRepo: () => {
          try {
            const { homepage } = JSON.parse(
              fs.readFileSync(path.join(webDir, 'package.json'), 'utf8')
            ) as { homepage?: string };
            return githubRepoOf(homepage ?? '');
          } catch {
            return undefined;
          }
        },
        exists: (file) => fs.existsSync(file),
        run: (command, args) =>
          new Promise((resolve) => {
            execFile(
              command,
              args,
              {
                cwd: untetherRepo,
                timeout: 60_000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              },
              (error, stdout, stderr) =>
                resolve({
                  code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
                  output: `${stdout}${stderr}`,
                })
            );
          }),
      }),
      connectorCheck(connectorHealth),
      orchestratorsCheck({
        registered: () =>
          projectSettings
            .list()
            .filter(({ settings }) => !!settings.orchestratorSessionId)
            .map(({ repoPath, settings }) => ({
              repoPath,
              sessionId: settings.orchestratorSessionId as string,
            })),
        running: () => ctx.orchestrator?.list() ?? [],
        sessionStatus: statusSeenByRoles,
      }),
      suspendedSessionsCheck({
        sessions: () =>
          ptyManager
            .listSessions()
            .filter((session) => !!session.suspended)
            .map((session) => ({
              id: session.id,
              title: session.userTitle || session.claudeTitle || session.name,
              status: session.status,
              suspended: session.suspended as SessionSuspension,
            })),
        enabled: () => configService.getConfig().suspendIdleClaude === true,
      }),
      claudeStatusCheck({ unknown: unknownClaudeStatuses, surprises: claudeFormatSurprises }),
      agentEventsCheck({
        ensureHookFiles: () => ensureClaudeHookFiles(hookFiles) !== null,
        sessions: () =>
          ptyManager
            .listSessions()
            .filter((session) => session.status === 'running' && session.agentHooks)
            .map((session) => {
              const agent = agentEvents.snapshot(session.id);
              return {
                sessionId: session.id,
                busySeenAt: claudeBusySeen.get(session.id),
                lastEventAt: agent?.lastEventAt,
                waitingSince: agent?.waitingOn?.since,
              };
            }),
        screenShare: () => agentSignals.screenShare(),
        serverStartedAt: SERVER_STARTED_AT,
      }),
      taskGuardCheck({
        tasks: () =>
          (ctx.taskScheduler?.list() ?? []).filter(
            (task) => !TASK_FINAL_STATES.includes(task.state)
          ),
      }),
      configWritableCheck({
        saveProblem: () => configService.getSaveProblem(),
        configPath: configService.getConfigPath(),
      }),
      configValidCheck({ loadProblem: () => configService.getLoadProblem() }),
      taskNodeCheck({
        tasks: () =>
          (ctx.taskScheduler?.list() ?? []).filter(
            (task) => !TASK_FINAL_STATES.includes(task.state)
          ),
        resolve: (dir) => resolveNodeRuntime(dir),
      }),
      // A request between projects nobody answered (agent-messages.ts).
      unansweredMessagesCheck({
        unanswered: (olderThanMs) => ctx.taskCommands?.messages.unanswered(olderThanMs) ?? [],
      }),
      // 2026-11-11: the installed app, nine days behind the development server it runs.
      appBuildCheck({
        app: () => ctx.installedApp?.app(),
        build: (appPath) => ctx.installedApp?.appBuild(appPath) ?? Promise.resolve(undefined),
        lag: (commit) => ctx.installedApp?.lag(commit) ?? Promise.resolve(undefined),
        autoUpdate: () => ctx.installedApp?.enabled() ?? false,
        held: () => ctx.installedApp?.heldBy(),
        schedule: () => ctx.installedApp?.schedule(),
      }),
      // 2026-11-11: the app's build, run in this checkout, left authenticate-pam built for
      // another Node. A bundled server carries its own next to it: nothing to look at there.
      nativeModulesLoadCheck({
        modules: () =>
          currentBuild().dev
            ? [
                ['authenticate-pam', 'authenticate_pam.node'],
                ['node-pty', 'pty.node'],
              ].map(([name, file]) => {
                try {
                  return {
                    name,
                    file: path.join(
                      fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`))),
                      'build',
                      'Release',
                      file
                    ),
                  };
                } catch {
                  return { name, file: null };
                }
              })
            : [],
        load: loadsInChild,
        building: () => appBuildRunning(webDir),
        rebuild: async (name) => {
          const build = name === 'node-pty' ? 'buildNodePty' : 'buildAuthenticatePam';
          await promisify(execFile)(
            process.execPath,
            ['-e', `require('./scripts/native-modules.js').${build}()`],
            { cwd: webDir, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }
          );
        },
      }),
      // 2026-11-12: macOS opened an unsigned build product in place of the installed app.
      registeredAppsCheck(launchServices()),
      cliBuildCheck({
        server: () => currentBuild({ help: TASK_CLI_HELP, version: VERSION }),
        installed: () => installedCliBinaries(),
        read: cachedBinaryBuild(readBinaryBuild),
      }),
      claudeVersionCheck({
        statePath: path.join(CONTROL_DIR, 'claude-version'),
        probe: () =>
          probeClaudeCompat({
            help: () =>
              new Promise((resolve) => {
                execFile('claude', ['--help'], { timeout: 10_000 }, (error, stdout) =>
                  resolve(error ? undefined : String(stdout))
                );
              }),
            unknownFlags: unknownClaudeFlags,
            recentTranscriptLines: () => recentTranscriptTails(claudeConfigDir()),
            turnEndSeen,
          }),
        version: () =>
          new Promise((resolve) => {
            execFile('claude', ['--version'], { timeout: 10_000 }, (error, stdout) =>
              resolve(error ? undefined : String(stdout))
            );
          }),
      }),
      forwarderBuildCheck({
        forwarders: forwarderCandidates,
        // A packaged app has none: the check stays quiet there.
        sourceDirs: () => [
          path.join(untetherRepo, 'native', 'ut-fwd'),
          path.join(webDir, 'native', 'ut-fwd'),
        ],
        rebuildCommand: `cd ${webDir} && node scripts/build-fwd-rust.js`,
        rebuildTarget: path.join(webDir, 'native', 'untether-fwd'),
        // build-fwd-rust.js writes this copy too, and `ut`'s forwarder lookup prefers it.
        mirrors: [path.join(webDir, 'bin', 'untether-fwd')],
        canRebuild: () =>
          fs.existsSync(path.join(webDir, 'scripts', 'build-fwd-rust.js')) && rustToolchainFound(),
        rebuild: async (output) => {
          await promisify(execFile)(
            process.execPath,
            [path.join(webDir, 'scripts', 'build-fwd-rust.js'), '--output', output],
            { cwd: webDir, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }
          );
        },
      }),
      bigCastsCheck({
        controlDir: CONTROL_DIR,
        compact: compactCastsWithForwarder(forwarderCandidates),
        limits: () => rotationLimits(configService.getConfig().recordings),
        log: (message) => logger.log(message),
      }),
      controlDirCheck({
        controlDir: CONTROL_DIR,
        warnBytes: () => controlWarnBytes(configService.getConfig().recordings),
        sessions: () => sessionManager.listSessions(),
      }),
      logErrorsCheck({ logPath: getLogFilePath }),
      loopFailuresCheck({ failures: loopFailures }),
      serverCrashesCheck({ file: () => crashMarksFile(getLogFilePath()) }),
      diskCheck({
        dir: CONTROL_DIR,
        growth: new DiskGrowthWatch({ statePath: path.join(CONTROL_DIR, 'disk-growth.json') }),
      }),
      movedProjectsCheck({ replay: () => projectSettings.replayMoves() }),
      replacedSessionsCheck({
        sessions: () => ptyManager.listSessions(),
        // What the stores themselves follow (2026-10-25: a list of its own counted merged tasks).
        referenced: () => sessionReplacements.references(),
        follow: (from, to) => sessionReplacements.replaced(from, to),
      }),
      sessionEnvCheck({
        cleanShieldEnvironment: () => ptyManager.cleanShieldEnvironment(),
        // Attached to the user's own tmux: that pane's environment is theirs.
        sessions: () =>
          ptyManager
            .listSessions()
            .filter((session) => session.status === 'running' && !session.multiplexer)
            .map((session) => ({
              id: session.id,
              name: session.name,
              pid: ptyManager.programRootPid(session),
            })),
        envNames: processEnvNames,
      }),
      ...(stableTmux
        ? [
            stableTmuxCheck({
              refresh: () => stableTmux.refresh(),
              serverBinaries: () => ptyManager.shieldServerBinaries(),
              fullDiskAccess: () => ptyManager.shieldFullDiskAccess(),
              oldTmux: {
                note: (binary) => stableTmux.noteOldTmux(binary),
                toTell: () => stableTmux.oldTmuxToTell(),
                told: () => stableTmux.markOldTmuxTold(),
              },
              // Once, to the phone (2026-10-31): Untether can't remove a macOS permission.
              tellOldTmux: async (binary) => {
                const result = await pushNotificationService
                  ?.sendNotification(oldTmuxPermissionPush(binary))
                  .catch((error) => {
                    logger.warn(`old tmux permission push failed: ${error}`);
                    return null;
                  });
                return (result?.sent ?? 0) > 0;
              },
            }),
          ]
        : []),
      // 2026-11-01: shield tmux servers and throwaway HOMEs that tests and QA starts left behind.
      strayShieldTmuxCheck({
        activeControlDir: CONTROL_DIR,
        servers: scanShieldServers,
        close: closeShieldServer,
      }),
      staleTestDirsCheck({
        dirs: () => findTestDirs(['/tmp', os.tmpdir()]),
        inUse: dirInUse,
        remove: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
      }),
      // 2026-11-08: tasks ran for days on claude-opus-4-8 (the account's default) unseen.
      unexpectedModelsCheck({
        uses: async () => {
          const claudeDir = claudeConfigDir();
          const tasks = ctx.taskScheduler?.list() ?? [];
          const sessions = ptyManager.listSessions();
          const changedInside = (session: Session) =>
            sessionModelChanged(session, (id) =>
              findClaudeTranscript(session.workingDir, id, claudeDir)
            );
          const uses: ModelUse[] = [];
          for (const task of tasks) {
            const last = task.metrics?.usage?.lastModel;
            if (!last || task.modelProvider || TASK_FINAL_STATES.includes(task.state)) continue;
            const session = sessions.find((candidate) => candidate.id === task.sessionId);
            // Changed by hand inside the task's session: not unexpected (2026-11-09).
            if (session && (await changedInside(session))) continue;
            const requested =
              task.model ??
              (task.agent === 'claude' ? session?.claudeStartSettings?.model : undefined);
            const tier = task.modelChoice?.tier;
            uses.push({
              label: `task "${task.name}" (${task.id})`,
              ...(requested ? { requested } : {}),
              requestedFrom: !task.model
                ? '"model" in ~/.claude/settings.json'
                : tier && task.modelChoice?.by !== 'user'
                  ? `taskModels.${task.agent}.${tier}`
                  : '--model',
              actual: last.model,
              at: last.at,
            });
          }
          // Sessions that are not a task's: their transcript's newest assistant message, and
          // what the session itself asked for and talked to (2026-11-08: a claude-ablit session
          // on abliteration.ai was flagged against settings.json's claude-opus-5-5).
          const providers = configService.getConfig().modelProviders ?? [];
          const taskSessions = new Set(tasks.map((task) => task.sessionId).filter(Boolean));
          for (const session of sessions) {
            if (session.status !== 'running' || !session.claudeSessionId) continue;
            if (taskSessions.has(session.id)) continue;
            const file = findClaudeTranscript(
              session.workingDir,
              session.claudeSessionId,
              claudeDir
            );
            const lines = file ? tailLines(file, 64 * 1024) : [];
            const last = lastTranscriptModel(lines);
            if (!last) continue;
            // Changed by hand inside the session: not unexpected (2026-11-09).
            if (await changedInside(session)) continue;
            const pid = claudePidOfConversation(claudeDir, session.claudeSessionId);
            const launch = pid ? await processClaudeLaunch(pid) : {};
            const marker = session.modelProvider;
            // A provider session: its base URL (a removed provider still is not Anthropic's).
            const endpoint =
              launch.baseUrl ??
              (marker
                ? (providers.find((provider) => provider.id === marker.id)?.baseUrl ??
                  `provider:${marker.id}`)
                : undefined);
            const asked: Array<[string | undefined, string]> = [
              // Its claude's own command line (a `claude --model x` typed in a shell session).
              [launch.flag ?? modelFlag(session.command), '--model'],
              [launch.model, 'ANTHROPIC_MODEL'],
              [marker?.model, `provider ${marker?.id}`],
              [session.claudeStartSettings?.model, '"model" in ~/.claude/settings.json'],
            ];
            const [requested, requestedFrom] = asked.find(([model]) => !!model) ?? [];
            uses.push({
              label: `session "${session.name}" (${session.id})`,
              ...(requested ? { requested, requestedFrom } : {}),
              actual: last.model,
              at: last.at ?? new Date().toISOString(),
              ...(endpoint ? { endpoint } : {}),
            });
          }
          return [...uses, ...modelObservations.list()];
        },
        seen: () => [
          ...(ctx.taskScheduler?.list() ?? []).flatMap((task) => {
            const last = task.metrics?.usage?.lastModel;
            return last ? [last] : [];
          }),
          ...recentTranscriptModels(claudeConfigDir()),
        ],
        // A configured provider's models (2026-11-08): never "unexpected" (model-observations.ts).
        // Its /v1/models list only when it lists none itself (cached an hour, ProviderPricing).
        providerModels: async () => {
          const ids: string[] = [];
          for (const provider of configService.getConfig().modelProviders ?? []) {
            ids.push(...providerModels(provider).map((model) => model.id));
            if (provider.defaultModel) ids.push(provider.defaultModel);
            ids.push(
              ...(await ctx.providerLauncher.pricing.discoverModels(provider).catch(() => []))
            );
          }
          return ids;
        },
      }),
      unshieldedCheck({
        shieldAvailable: () => ptyManager.isShieldAvailable(),
        sessions: () =>
          ptyManager.listSessions().map((session) => ({
            id: session.id,
            name: session.name,
            status: session.status,
            shielded: session.shielded,
            claude: !!session.claudeSessionId,
          })),
      }),
    ],
    tellOrchestrator: (text) => ctx.orchestrator?.notice(untetherRepo, text) ?? false,
    push: (title, body) => {
      pushNotificationService
        ?.sendNotification({ type: 'untether-doctor', title, body })
        .catch((error) => logger.warn(`Failed to send the doctor's push: ${error}`));
    },
    log: (message) => logger.warn(message),
    recordEvent: (event) => ctx.eventLog.record(event),
  });
  untetherDoctor.start();
  // `ut doctor --run` from any local caller: a look made less than a minute ago is told again
  // instead of running every check once more.
  ctx.doctorReport = async (run) => {
    const last = untetherDoctor.lastReport ?? undefined;
    const fresh = last && Date.now() - Date.parse(last.at) < 60_000;
    return run && !fresh ? untetherDoctor.runOnce() : last;
  };
  // What the doctor found last (?run=1 runs every check now), with its recent history.
  app.get('/api/doctor', async (req, res) => {
    const report =
      req.query?.run === '1' ? await untetherDoctor.runOnce() : untetherDoctor.lastReport;
    res.json({ report: report ?? null, history: untetherDoctor.history.slice(-50) });
  });
}
