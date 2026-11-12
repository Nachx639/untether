// Tasks: project settings, scheduler, security sweeps, project connector, task commands and
// the projects' orchestrators.

import * as path from 'path';
import { partyLabel } from '../shared/agent-messages.js';
import { sumUsage } from '../shared/task-metrics.js';
import type { TaskRecord } from '../shared/tasks.js';
import { apiSocketServer } from './api-socket-server.js';
import { currentBuild } from './build-info.js';
import type { TaskResponse } from './pty/socket-protocol.js';
import { listenPortFor } from './server-config.js';
import type { AppContext } from './server-context.js';
import { HALT_READ_LINES } from './services/agent-halt.js';
import { MessageLedger } from './services/agent-messages.js';
import { createAgentUsageReader } from './services/agent-usage.js';
import { untetherOwnedDirs, worktreeExclusionTarget } from './services/backup-exclusion.js';
import {
  promptStatus,
  readClaudeStatuses,
  readClaudeTurnError,
  readLastReply,
} from './services/claude-chat.js';
import { forgetTyping } from './services/claude-initial-input.js';
import {
  type ConnectorHealthDeps,
  connectorExposure,
} from './services/connector/connector-health.js';
import {
  CONNECTOR_DEFAULT_BIND,
  ConnectorListener,
  createConnectorApp,
  resolveConnectorPort,
} from './services/connector/connector-http.js';
import { ConnectorService } from './services/connector/connector-service.js';
import { ConnectorTokens } from './services/connector/connector-tokens.js';
import { type EventLog, EventQueryError, parseEventQuery } from './services/event-log.js';
import { parseSince } from './services/input-diagnostics.js';
import { taskUsdCost } from './services/model-provider-pricing.js';
import { providerModels } from './services/model-providers.js';
import { Orchestrator } from './services/orchestrator.js';
import { createOrchestratorDelivery } from './services/orchestrator-delivery.js';
import { normalizeRepoPath, ProjectSettingsStore } from './services/project-settings.js';
import type { NotificationPayload } from './services/push-notification-service.js';
import { QuickStartAvailability } from './services/quick-start-availability.js';
import { createSecurityReviewer } from './services/security-review.js';
import { SecuritySweeper } from './services/security-sweep.js';
import { readSessionChat } from './services/session-chat.js';
import { quickStartArgv, resolveProjectRepo, TaskCommands } from './services/task-commands.js';
import { createTaskGuard, taskGuardFiles } from './services/task-guard-setup.js';
import {
  agentExecutable,
  createTaskLauncher,
  createTaskResumer,
  modelForLevel,
  type TaskProviderEnv,
  taskRunners,
} from './services/task-launcher.js';
import { TaskMetricsLedger } from './services/task-metrics-ledger.js';
import { pruneShellGroups, readShellGroups, TaskOrphanReaper } from './services/task-processes.js';
import { createLlmRouter, createTierClassifier } from './services/task-router-llm.js';
import { STALE_REMIND_MS, TaskScheduler } from './services/task-scheduler.js';
import { createToolPruner, type ToolPruner, ToolUsageStore } from './services/tool-pruning.js';
import { ttsHome } from './services/tts.js';
import { createUserHold } from './services/user-input-guard.js';
import { detectGitInfo } from './utils/git-info.js';
import { createLogger } from './utils/logger.js';
import { every } from './utils/periodic-loop.js';

const logger = createLogger('server');

const userHolds = new WeakMap<AppContext, (sessionId: string) => Promise<string | null>>();

/**
 * Why Untether must not type into a session now because of the user's own input there
 * (user-input-guard.ts): asked before anything that is not the user's is typed.
 */
export function userHoldOf(ctx: AppContext): (sessionId: string) => Promise<string | null> {
  let hold = userHolds.get(ctx);
  if (!hold) {
    const { agentEvents, ptyManager, terminalManager } = ctx;
    hold = createUserHold({
      lastUserKeyAt: (sessionId) => ptyManager.lastUserInputAt(sessionId),
      agentState: (sessionId) => agentEvents.snapshot(sessionId),
      claudeBusy: async (sessionId) => {
        const session = ptyManager.getSession(sessionId);
        const pid = session ? ptyManager.programRootPid(session) : undefined;
        if (!pid) return false;
        return promptStatus((await readClaudeStatuses([pid])).get(pid)) === 'busy';
      },
      cells: async (sessionId) => (await terminalManager.getBufferSnapshot(sessionId)).cells,
    });
    userHolds.set(ctx, hold);
  }
  return hold;
}

/**
 * The ledger of messages between agents (2026-11-10): ids, threads and how far each message
 * got. The queues that type them in (the orchestrators', the tasks' pending input) report to it.
 */
function createMessageLedger(
  ctx: AppContext,
  projectSettings: ProjectSettingsStore
): MessageLedger {
  const { agentEvents, controlDir } = ctx;
  const ledger: MessageLedger = new MessageLedger({
    statePath: path.join(controlDir, 'messages.json'),
    sessionOf: (party) =>
      party.kind === 'project'
        ? ctx.orchestrator?.sessionFor(party.repoPath)
        : party.kind === 'task'
          ? ctx.taskScheduler?.get(party.taskId)?.sessionId
          : party.kind === 'session'
            ? party.sessionId
            : undefined,
    // The agent's own events: a turn started, or a message taken into a turn already going.
    lastTurnAt: (sessionId) => {
      const events = agentEvents.snapshot(sessionId);
      const at = Math.max(events?.turnStartedAt ?? 0, events?.lastUserInputAt ?? 0);
      return at > 0 ? at : undefined;
    },
    // Its recipient went away before it was typed in: the orchestrator that sent it hears.
    undelivered: (message, why) => {
      if (message.from.kind !== 'project') return;
      ctx.orchestrator?.notice(
        message.from.repoPath,
        `Your message ${message.id} to ${partyLabel(message.to)} was not delivered: ${why}. ${message.to.kind === 'project' ? 'Send it again once it has an orchestrator, or tell the user' : 'Nothing of it reached its agent'}.`
      );
    },
    // 2026-11-10: a message that cannot be typed in yet says why to whoever sent it (an
    // orchestrator, in its session), and again once it went in.
    waitingTold: (message, why) => {
      const to = partyLabel(message.to);
      const text = why
        ? `Your message ${message.id} to ${to} is not typed in yet: ${why}. Nothing to do: it goes in on its own once it can (\`ut project messages\` shows it).`
        : `Your message ${message.id} to ${to} went in now.`;
      // The user's own messages to a task: the task tells them itself (inputNotTyped).
      if (message.from.kind === 'project') ctx.orchestrator?.notice(message.from.repoPath, text);
    },
    log: (message) => logger.log(message),
  });
  projectSettings.followedBy('messages', (moved) => ledger.projectsMoved(moved));
  return ledger;
}

export function setupTasks(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    agentEvents,
    agentSignals,
    config,
    configService,
    ptyManager,
    pushNotificationService,
    resourceMonitor,
    backupExclusion,
    sessionReplacements,
    statusSeenByRoles,
    terminalManager,
  } = ctx;
  // Per-project task settings (merge policy, check command …), outside every repository.
  const projectSettings = new ProjectSettingsStore(
    path.join(path.dirname(CONTROL_DIR), 'projects.json'),
    (message, error) => logger.warn(`${message}${error ? `: ${error}` : ''}`)
  );
  const messageLedger = createMessageLedger(ctx, projectSettings);
  // Task pushes held back until the orchestrators are restored (null: routed at once).
  let taskPushesBeforeOrchestrators: NotificationPayload[] | null = config.isHQMode ? null : [];
  /** A task push: to its orchestrator when one runs, else to the phone. */
  const sendTaskPush = (payload: NotificationPayload) => {
    // An orchestrator's task tells the orchestrator, not the phone (merged still does).
    const routed = ctx.orchestrator ? ctx.orchestrator.routeTaskPush(payload) : payload;
    // A quiet push (an automatic fix under way, a review being retried) is for an
    // orchestrator only, never the phone.
    if (!routed || routed.data?.quiet === true) {
      logger.log(`Task event to its orchestrator: ${payload.title}`);
      return;
    }
    logger.log(`Task push: ${routed.title}`);
    pushNotificationService?.sendNotification(routed).catch((error) => {
      logger.warn(`Failed to send task notification: ${error}`);
    });
  };
  /** The task pushes held back while restoring go now, routed. */
  const flushTaskPushes = () => {
    const held = taskPushesBeforeOrchestrators;
    taskPushesBeforeOrchestrators = null;
    for (const payload of held ?? []) sendTaskPush(payload);
  };
  // Tool pruning of task sessions (tool-pruning.ts, 2026-11-03): set up with the tasks.
  let toolPruner: ToolPruner | undefined;
  // Tasks: sessions start on this machine, so not on an HQ (it has no local sessions).
  if (!config.isHQMode) {
    const agentUsageReader = createAgentUsageReader({
      claudeConversation: (sessionId) => ptyManager.getSession(sessionId)?.claudeSessionId,
    });
    // What the projects' task sessions used (opt-in pruning of the rest, 2026-11-03).
    const toolUsage = new ToolUsageStore(path.join(path.dirname(CONTROL_DIR), 'tool-usage.json'));
    const pruner = createToolPruner({
      store: toolUsage,
      settings: (repo) => projectSettings.get(repo),
      tasks: () => ctx.taskScheduler?.list() ?? null,
      profileFile: (taskId) => taskGuardFiles(taskId, path.dirname(CONTROL_DIR)).toolProfile,
      log: (message) => logger.warn(message),
    });
    toolPruner = pruner;
    projectSettings.followedBy('tool usage', (moved) => toolUsage.projectsMoved(moved));
    // The transcripts of the opted-in projects' tasks are read every 10 minutes (only the
    // ones that grew): a new task's list is decided from the store, without waiting.
    every(
      'tool pruning scan',
      () => {
        pruner.scan().catch((error) => logger.warn(`[tool-pruning] scan failed: ${error}`));
      },
      10 * 60_000
    ).unref();
    // External model providers (model-providers.ts, 2026-11-08): the shared launcher
    // (created in setupCore, resolver already wired) drives a `--model <id>:<model>` task.
    const providerLauncher = ctx.providerLauncher;
    // The command guard of task agents (task-guard.ts, 2026-11-02): only their sessions.
    const taskGuard = createTaskGuard({
      untetherDir: path.dirname(CONTROL_DIR),
      settings: (task) => (task.repoPath ? projectSettings.get(task.repoPath) : undefined),
      log: (message) => logger.warn(message),
      toolProfile: (task) => pruner.profileFor(task),
      // This server's own CLI, for `check-slot` in the agents' heavy checks.
      cli: () => {
        const cli = currentBuild().cli;
        return cli ? [cli] : undefined;
      },
      // A provider task's `/model` shows only the provider's models (model-providers.ts).
      providerSettings: (task) =>
        task.modelProvider
          ? providerLauncher.modelPickerFor({ id: task.modelProvider, model: task.model ?? '' })
          : undefined,
    });
    // A provider task's launch (env, key, picker): throws when the provider is gone or its key
    // cannot be read, so the task fails loudly instead of running on the user's own login.
    const taskProviderEnv: TaskProviderEnv = async (task) => {
      const launch = await providerLauncher.resolve({
        id: task.modelProvider as string,
        model: task.model ?? '',
      });
      if (!launch) {
        throw new Error(
          `model provider "${task.modelProvider}" is not available (missing provider or key)`
        );
      }
      return launch;
    };
    // Finished tasks' metrics per project: the saving features' comparison and guard.
    const metricsLedger = new TaskMetricsLedger(path.join(CONTROL_DIR, 'task-metrics.json'));
    projectSettings.followedBy('task metrics', (moved) => metricsLedger.projectsMoved(moved));
    const scheduler = new TaskScheduler({
      // Messages between agents (agent-messages.ts): typed into a task's agent, or never.
      messageTyped: (id) => messageLedger.delivered(id),
      // Its sender hears (review 2026-11-10: it was forgotten in silence).
      messageDropped: (id, why) => messageLedger.undeliverable(id, why),
      // Not typed yet, and why (2026-11-10): on its record and to its sender.
      messageWaiting: (id, why) => messageLedger.waiting(id, why),
      // A task stopped on a prompt of its agent's: read off its screen, answered there
      // (`ut task status`, `ut task answer`).
      readPrompt: (sessionId) => ctx.shareMenu.read(sessionId),
      answerPrompt: async (sessionId, menu, option) =>
        (await ctx.answerScreenMenu?.(sessionId, menu, option)) ?? 'unavailable',
      settings: projectSettings,
      metricsLedger,
      guardLog: { stamp: taskGuard.blockedStamp, read: taskGuard.blocked },
      // An agent waiting for a check slot: not its work, not a stall (check-slots.ts).
      checkSlotWait: (taskId) => ctx.checkSlots.taskWait(taskId),
      admission: {
        check: (waitedMs) => resourceMonitor.admission({ waitedMs }),
        started: () => resourceMonitor.started(),
      },
      storePath: path.join(CONTROL_DIR, 'tasks.json'),
      launch: createTaskLauncher({
        ptyManager,
        deliverInitialInput: () => ctx.deliverTaskInput,
        guard: taskGuard,
        providerEnv: taskProviderEnv,
      }),
      resume: createTaskResumer({
        ptyManager,
        deliverInitialInput: () => ctx.deliverTaskInput,
        guard: taskGuard,
        providerEnv: taskProviderEnv,
      }),
      claudeConversation: (sessionId) => ptyManager.getSession(sessionId)?.claudeSessionId,
      finalReply: async (sessionId) => {
        const session = ptyManager.getSession(sessionId);
        const pid = session ? ptyManager.programRootPid(session) : undefined;
        return pid ? readLastReply(pid) : undefined;
      },
      withdrawPush: (matches) => pushNotificationService?.withdrawHeld(matches),
      notify: (payload) => {
        // 2026-10-20: the scheduler starts before the orchestrators are restored, so early
        // events of their tasks went to the phone; they wait until restore() is done.
        if (taskPushesBeforeOrchestrators) {
          taskPushesBeforeOrchestrators.push(payload);
          return;
        }
        sendTaskPush(payload);
      },
      sessionStatus: statusSeenByRoles,
      recordEvent: (event) => ctx.eventLog.record(event),
      // Resolves to whether the text was really typed; the scheduler keeps it queued if not.
      // A working Claude takes it into its turn at once; only a menu of its own makes it wait.
      deliver: async (sessionId, text, agent, options) => {
        if (!ctx.deliverTaskInput) return false;
        return ctx.deliverTaskInput(sessionId, text, agent, { ...options, whileBusy: true });
      },
      // What the task left running goes once it closed (task-processes.ts, 2026-11-02).
      stopSession: (sessionId) =>
        ptyManager.killSession(sessionId).finally(() => ctx.taskOrphanReaper?.afterStop()),
      // A finished task's session is stopped, never an orchestrator's.
      isOrchestratorSession: (sessionId) =>
        !!ctx.orchestrator?.list().some((entry) => entry.sessionId === sessionId) ||
        projectSettings.list().some(({ settings }) => settings.orchestratorSessionId === sessionId),
      lastOutputAt: (sessionId) => terminalManager.outputModifiedAt(sessionId),
      // What the agent itself records comes first; the screen and output time are fallbacks.
      agentState: (sessionId) => agentEvents.snapshot(sessionId),
      claudeTurnError: async (sessionId) => {
        const session = ptyManager.getSession(sessionId);
        const pid = session ? ptyManager.programRootPid(session) : undefined;
        return pid ? readClaudeTurnError(pid) : undefined;
      },
      signals: agentSignals,
      // Task budgets (2026-11-01): a task at its limit has its agent stopped (Escape), and its
      // agent's tokens are read from its own transcript or rollout.
      interrupt: (sessionId) => ptyManager.sendInput(sessionId, { key: 'escape' }),
      agentUsage: (task, known) => agentUsageReader.read(task, known),
      // A priced provider task's cost in $ from its tokens (model-providers.ts) for its `usd`
      // budget; undefined when the provider is gone or unpriced (tokens are counted as usual).
      // Each model's own tokens (Claude's message.model) are billed at that model's rate, and
      // every token NOT attributed to a model (a message/transcript without one) at the task's
      // model rate, so the whole total is always counted even with a mix.
      taskUsd: async (task) => {
        if (!task.modelProvider || !task.model) return undefined;
        const provider = providerLauncher.find(task.modelProvider);
        if (!provider) return undefined;
        const usage = sumUsage(Object.values(task.metrics?.usageBy ?? {}));
        return taskUsdCost(usage, task.model, (model) =>
          providerLauncher.pricing.ratesFor(provider, model)
        );
      },
      forgetAgentUsage: (taskId) => agentUsageReader.forget(taskId),
      // A turn that ended on the agent's usage limit, an API error or a lost login pauses its
      // task instead of finishing it (agent-halt.ts, 2026-11-01): the screen when no event
      // and no transcript tells.
      screenText: async (sessionId) =>
        (await terminalManager.getRecentText(sessionId, HALT_READ_LINES)).text,
      // Called later (a task held for its agent's limit): agentCommand is defined below.
      agentCommand: (agent) => agentCommand(agent),
      // Model by difficulty and fallbacks at a usage limit (2026-11-01): this installation's
      // models and runners (config.json taskModels, taskFallbacks).
      classifyTier: createTierClassifier(),
      modelFor: (agent, tier) => modelForLevel(configService.getConfig().taskModels, agent, tier),
      runners: async () => {
        const fallbacks = configService.getConfig().taskFallbacks;
        const candidates = taskRunners({
          fallbacks,
          agentCommand,
          argv: quickStartArgv,
          available: {},
        });
        const programs = candidates.map((runner) => agentExecutable(runner.command).name);
        const available = await sweepAgentsAvailability.check(programs);
        return taskRunners({ fallbacks, agentCommand, argv: quickStartArgv, available });
      },
      logDir: path.join(path.dirname(CONTROL_DIR), 'tasks'),
      // Each new worktree's folder out of Time Machine (2026-11-02: node_modules and builds of
      // every task were backed up).
      worktreeMade: (worktreePath) => {
        void backupExclusion.exclude(worktreeExclusionTarget(worktreePath));
      },
      onError: (message, error) => logger.warn(`${message}: ${error ?? ''}`),
      onFlakyUnderLoad: (task, verify) => {
        if (!task.repoPath) return;
        ctx.flakyTests.record(task.repoPath, verify.flakyUnderLoad ?? [], {
          taskId: task.id,
          load: verify.firstRunLoad,
          fallback: verify.flakyFirstRun,
        });
        logger.warn(
          `task ${task.id}: check passed on a rerun after failing under load (${verify.firstRunLoad}); flaky under load: ${(verify.flakyUnderLoad ?? []).join('; ') || 'no test named'}`
        );
      },
      // A confirmed security fix merges on its own only past the adversarial reviewer too.
      securityFixReview: async (task) =>
        securitySweeper
          ? securitySweeper.reviewFix(task)
          : { verdict: 'unavailable', reason: 'no security sweeper' },
      // A risky task merges on its own only past the same reviewer's second look (2026-10-24).
      riskReview: async (task) =>
        securitySweeper
          ? securitySweeper.reviewRisk(task)
          : { verdict: 'unavailable', reason: 'no security sweeper' },
      // The user's autoApprove: a task held only for a merge OK counts down instead.
      autoApprove: () => configService.getConfig().autoApprove === true,
      // A task left ready or needs_you with nobody acting reminds again (0 = never).
      staleRemindMs: () =>
        (configService.getConfig().staleTaskRemindMinutes ?? STALE_REMIND_MS / 60_000) * 60_000,
      projectNotice: (repoPath, text) => ctx.orchestrator?.notice(repoPath, text) ?? false,
      // A working task's base is merged only while its agent's tool calls are held.
      toolHold: (taskId) => taskGuard.holdTools(taskId),
    });
    ctx.taskScheduler = scheduler;
    // 2026-11-02 (bakery): 12 `yes` of a task, reparented to launchd, outlived it.
    const reaper = new TaskOrphanReaper({
      tasks: () => scheduler.list(),
      sessionStatus: statusSeenByRoles,
      log: (message) => logger.warn(message),
      shellGroups: (taskId) =>
        readShellGroups(taskGuardFiles(taskId, taskGuard.untetherDir).shellGroups),
      pruneShellGroups: (taskId, groups, inUse, before) =>
        pruneShellGroups(
          taskGuardFiles(taskId, taskGuard.untetherDir).shellGroups,
          groups,
          inUse,
          before
        ),
    });
    ctx.taskOrphanReaper = reaper;
    reaper.start();
    sessionReplacements.followedBy('tasks', scheduler.replacementFollower());
    const started = scheduler
      .start()
      .catch((error) => logger.error('Task scheduler failed to start:', error));
    // The tool usage of the opted-in projects' tasks, once they are loaded.
    void started.then(() =>
      pruner.scan().catch((error) => logger.warn(`[tool-pruning] scan failed: ${error}`))
    );
    // The disposable folders that already exist, once the tasks are loaded (2026-11-02).
    void started.then(async () => {
      const taken = await backupExclusion.excludeAll(
        untetherOwnedDirs({
          controlDir: CONTROL_DIR,
          taskLogDir: path.join(path.dirname(CONTROL_DIR), 'tasks'),
          ttsDir: ttsHome(),
          repoPaths: projectSettings.list().map(({ repoPath }) => repoPath),
          worktreePaths: scheduler.list().flatMap((task) => task.worktreePath ?? []),
        })
      );
      if (taken.length) logger.log(`kept out of Time Machine: ${taken.join(', ')}`);
    });
    // Open tasks follow a project folder that was renamed or moved (once they are loaded).
    projectSettings.followedBy('flaky tests', (moved) => ctx.flakyTests.projectsMoved(moved));
    projectSettings.followedBy('tasks', async (moved) => {
      await started;
      return scheduler.projectsMoved(moved);
    });
  }
  const sweepAgentsAvailability = new QuickStartAvailability();
  /** The user's quick start for an agent as argv (its flags included), else the bare agent. */
  const agentCommand = (agent: 'claude' | 'codex') => {
    const quickStart = configService
      .getConfig()
      .quickStartCommands.find((entry) =>
        new RegExp(`(^|/)${agent}$`).test(quickStartArgv(entry.command, agent)[0] ?? '')
      );
    return quickStartArgv(quickStart?.command, agent);
  };
  // Security sweeps per project (2026-10-23): off until the user turns one on in the gear.
  const securitySweeper: SecuritySweeper | null = config.isHQMode
    ? null
    : new SecuritySweeper({
        statePath: path.join(CONTROL_DIR, 'security-sweeps.json'),
        settings: projectSettings,
        tasks: () => ctx.taskScheduler,
        commandFor: agentCommand,
        agents: async () => {
          const found = await sweepAgentsAvailability.check(['claude', 'codex']);
          return (['claude', 'codex'] as const).filter((agent) => found[agent] !== false);
        },
        reviewer: createSecurityReviewer(),
        // The project's own connector channels are part of what it exposes (2026-10-31).
        exposure: {
          untetherConnector: (repoPath) => connectorExposure(connectorHealth, repoPath),
        },
        // What has no fix in the repository (a tailnet policy, a public bucket) is only told.
        notify: ({ repoPath, title, body }) => {
          logger.log(`Security notice for ${repoPath}: ${title}`);
          const where = path.basename(repoPath);
          pushNotificationService
            ?.sendNotification({
              type: 'security-notice',
              title: `🛡️ ${where}: ${title}`,
              body,
              icon: '/apple-touch-icon.png',
              badge: '/favicon-32.png',
              tag: `untether-security-notice-${where}`,
              data: { type: 'security-notice', repoPath, where, detail: title, fix: body },
            })
            .catch((error) => logger.warn(`Failed to send security notice: ${error}`));
        },
        log: (message) => logger.log(message),
      });
  securitySweeper?.start();
  if (securitySweeper) {
    projectSettings.followedBy('security sweeps', (moved) => securitySweeper.projectsMoved(moved));
  }
  // The project connector (2026-10-31): external apps' agents talk to one project's
  // orchestrator with a token of their own, on a listener of its own bound to 127.0.0.1 that is
  // open only while an active token exists (connector/*.ts). Never on the main server.
  const connectorDir = path.join(CONTROL_DIR, 'connector');
  const connectorTokens = new ConnectorTokens({
    storePath: path.join(connectorDir, 'tokens.json'),
    normalizeRepo: normalizeRepoPath,
  });
  const connectorTaskRepo = (task: TaskRecord) => {
    const repo = task.repoPath ?? (task.isolation === 'worktree' ? undefined : task.workingDir);
    return repo ? normalizeRepoPath(repo) : undefined;
  };
  const connectorService = config.isHQMode
    ? null
    : new ConnectorService({
        tokens: connectorTokens,
        dir: connectorDir,
        uploadsDir: path.join(CONTROL_DIR, 'uploads'),
        relay: (repoPath, text) => ctx.orchestrator?.external(repoPath, text) ?? false,
        orchestratorSession: (repoPath) => ctx.orchestrator?.sessionFor(repoPath),
        chat: async (sessionId) => {
          const session = ptyManager.getSession(sessionId);
          if (!session?.pid || session.status !== 'running') {
            return { available: false, messages: [] };
          }
          const programPid = ptyManager.programRootPid(session) ?? session.pid;
          return readSessionChat({ ...session, pid: session.pid }, programPid);
        },
        tasks: () => ctx.taskScheduler?.list() ?? null,
        taskRepo: connectorTaskRepo,
        log: (message) => logger.log(message),
      });
  const connectorPort = resolveConnectorPort(
    process.env.UNTETHER_CONNECTOR_PORT,
    listenPortFor(config)
  );
  if (connectorPort.error) logger.error(`Connector disabled: ${connectorPort.error}`);
  const connectorListener = connectorService
    ? new ConnectorListener({
        tokens: connectorTokens,
        app: createConnectorApp(connectorService),
        port: () => connectorPort.port,
        host: process.env.UNTETHER_CONNECTOR_BIND?.trim() || undefined,
        log: (message) => logger.log(message),
      })
    : null;
  if (connectorService) {
    projectSettings.followedBy('connector', (moved) => {
      const tokens = connectorTokens.projectsMoved(moved);
      const messages = connectorService.projectsMoved(
        moved.map(({ from, to }) => ({ from: normalizeRepoPath(from), to: normalizeRepoPath(to) }))
      );
      return tokens + messages;
    });
  }
  const connectorHealth: ConnectorHealthDeps = {
    channels: () => connectorTokens.list(),
    dir: connectorDir,
    address: () => connectorListener?.address() ?? null,
    bind: () => ({
      host: connectorListener?.host ?? CONNECTOR_DEFAULT_BIND,
      port: connectorService ? connectorPort.port : null,
    }),
  };
  const connectorUrl = async () => {
    await connectorListener?.sync();
    const address = connectorListener?.address();
    return address ? `http://${address.host}:${address.port}` : null;
  };

  // One implementation of every task command for the routes and `ut task …` / `ut project …`
  // over the API socket, with the caller's rights and the user's confirmations.
  const taskCommands = new TaskCommands({
    scheduler: () => ctx.taskScheduler,
    room: () => resourceMonitor.room()?.line,
    settings: projectSettings,
    ...(toolPruner ? { tools: toolPruner } : {}),
    ...(securitySweeper
      ? { securityStatus: (repoPath: string) => securitySweeper.status(repoPath) }
      : {}),
    confirmationsPath: path.join(CONTROL_DIR, 'confirmations.json'),
    withdrawPush: (matches) => pushNotificationService?.withdrawHeld(matches),
    notify: (payload) => {
      logger.log(`Task push: ${payload.title}`);
      pushNotificationService?.sendNotification(payload).catch((error) => {
        logger.warn(`Failed to send task notification: ${error}`);
      });
    },
    commandFor: agentCommand,
    // External model providers (model-providers.ts): `ut task new --model <id>:<model>`.
    providers: () => configService.getConfig().modelProviders,
    sessionName: (sessionId) => {
      const session = ptyManager.getSession(sessionId);
      return session ? session.userTitle || session.name || undefined : undefined;
    },
    // Routing's unsure cases ask Claude Haiku (4 s at most; no token → the user is asked).
    llmRoute: createLlmRouter(),
    // Orchestrators hear the user's answers and phone actions on their tasks.
    orchestrator: () => ctx.orchestrator,
    messages: messageLedger,
    // `ut project tell --user-decision`: the user's own turns, from the sender's transcript.
    conversation: async (sessionId) => {
      const session = ptyManager.getSession(sessionId);
      if (!session?.pid || session.status !== 'running') return [];
      const programPid = ptyManager.programRootPid(session) ?? session.pid;
      return (await readSessionChat({ ...session, pid: session.pid }, programPid)).messages;
    },
    // The user's autoApprove (config.json): nothing waits for an OK on the phone.
    autoApprove: {
      get: () => configService.getConfig().autoApprove === true,
      set: (on) => configService.updateConfig({ ...configService.getConfig(), autoApprove: on }),
    },
    log: (message) => logger.log(message),
    ...(connectorService
      ? {
          connector: {
            add: (input) => connectorTokens.add(input),
            activate: (id) => connectorTokens.activate(id),
            setConfirmation: (id, confirmationId) =>
              connectorTokens.setConfirmation(id, confirmationId),
            list: (repoPath) => connectorTokens.list(repoPath),
            revoke: (ref, repoPath) => {
              const channel = connectorTokens.revoke(ref, repoPath);
              void connectorListener?.sync();
              return channel;
            },
            url: connectorUrl,
          },
        }
      : {}),
  });
  sessionReplacements.followedBy('confirmations', taskCommands.replacementFollower());
  if (connectorService && connectorListener) {
    // Open at start when a token is active; every minute: tokens an agent made whose OK was
    // declined or expired go, replies are captured while the chat still has them, and the
    // listener follows tokens.json (a hand edit, another `ut`).
    void connectorListener.sync();
    const connectorTick = every(
      'connector tick',
      () => {
        const dropped = connectorTokens.dropWaiting((id) => !!taskCommands.confirmations.get(id));
        for (const channel of dropped) {
          logger.log(`connector: ${channel.name} (${channel.id}) dropped, its OK never came`);
        }
        void connectorService.scan().catch(() => undefined);
        void connectorListener.sync();
      },
      60_000
    );
    connectorTick.unref?.();
  }
  return {
    projectSettings,
    flushTaskPushes,
    agentCommand,
    securitySweeper,
    connectorListener,
    connectorHealth,
    taskCommands,
  };
}

export function wireTaskSocket(ctx: AppContext) {
  const { ptyManager, taskCommands } = ctx;
  // 2026-10-20: the caller's claims are only claims. `interactive` (a TTY) gave user rights, so
  // an agent with a pseudo-terminal approved its own merges; it gives none now. A session id
  // counts only while that session runs (a dead orchestrator's id, still in projects.json,
  // gave its rights to whoever sent it). The socket can't tell which process is calling, so a
  // running session's id sent by another process is still believed.
  ctx.checkSlots.start();
  apiSocketServer.setAppUpdateStatus(() => ctx.installedApp?.status().text);
  apiSocketServer.setTaskHandler(async (request) => {
    // `ut events`: the public event log, read (or long-polled) by any local caller.
    if (request.op === 'events') return eventsOverSocket(ctx.eventLog, request.args);
    // `ut diag input`: the summary of what devices measured, for any local caller.
    if (request.op === 'diag-input') {
      const since = parseSince(String(request.args?.since ?? '24h'));
      return since === null
        ? { ok: false, code: 'bad-request', message: 'since: 30m, 24h, 7d…' }
        : { ok: true, status: 'done', data: { ...ctx.inputDiag.summary(since) } };
    }
    // `ut doctor`: what the doctor found last (or finds now) and the app's own update.
    if (request.op === 'doctor') {
      const report = await ctx.doctorReport?.(request.args?.run === true);
      return {
        ok: true,
        status: 'done',
        data: { report: report ?? null, appUpdate: ctx.installedApp?.status().text ?? null },
      };
    }
    // `ut check-slot`: a place in the checks' limiter, for any local caller (check-slots.ts).
    if (request.op === 'check-slot') return ctx.checkSlots.handle(request.args ?? {});
    const claimed = request.callerSessionId;
    const running = !!claimed && ptyManager.getSession(claimed)?.status === 'running';
    return taskCommands.run(request.op, request.args, {
      kind: 'cli',
      ...(claimed && running ? { sessionId: claimed } : {}),
    });
  });
}

async function eventsOverSocket(
  eventLog: EventLog,
  args: Record<string, unknown>
): Promise<TaskResponse> {
  try {
    const { wait, ...query } = await parseEventQuery(args ?? {}, resolveProjectRepo);
    const page = await eventLog.wait(query, wait);
    return { ok: true, status: 'done', data: { ...page } };
  } catch (error) {
    if (error instanceof EventQueryError) {
      return { ok: false, code: 'bad-request', message: error.message };
    }
    throw error;
  }
}

export function setupOrchestrator(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    agentCommand,
    config,
    configService,
    flushTaskPushes,
    projectSettings,
    ptyManager,
    pushNotificationService,
    sessionManager,
    sessionReplacements,
    shareMenu,
    statusSeenByRoles,
    taskCommands,
    wakeSuspended,
  } = ctx;
  if (!config.isHQMode) {
    const deliverToOrchestrator = createOrchestratorDelivery({
      sessionStatus: (sessionId) => ptyManager.getSession(sessionId)?.status,
      claudeStatus: async (sessionId) => {
        const session = ptyManager.getSession(sessionId);
        const pid = session ? ptyManager.programRootPid(session) : undefined;
        return pid ? promptStatus((await readClaudeStatuses([pid])).get(pid)) : undefined;
      },
      readChoices: (sessionId) => shareMenu.read(sessionId),
      sendInput: (sessionId, input) => ptyManager.sendInput(sessionId, input),
      // A new orchestrator's folder is trusted like a task's (its start was the user's OK).
      answerTrustDialog: (sessionId) =>
        ctx.answerTrustDialog?.(sessionId) ?? Promise.resolve(false),
      userHold: userHoldOf(ctx),
      log: (message) => logger.warn(message),
    });
    const instance = new Orchestrator({
      commands: taskCommands,
      settings: projectSettings,
      tasks: () => ctx.taskScheduler,
      createSession: async (command, options) => {
        const gitInfo = await detectGitInfo(options.workingDir);
        const shielded =
          configService.getConfig().shieldNewSessions !== false && ptyManager.isShieldAvailable();
        return ptyManager.createSession(command, {
          ...options,
          cols: 120,
          rows: 30,
          shielded,
          ...gitInfo,
        });
      },
      // 2026-10-20: typed with no give-up while the session runs, and the answer is whether it
      // was (it used to say yes at once, so briefs and events of a busy Claude were lost).
      // A suspended orchestrator wakes first (2026-10-31); its queue stays in orchestrators.json
      // until the text was typed.
      deliver: (sessionId, text, options) =>
        wakeSuspended(sessionId, 'orchestrator message').then((woke) =>
          woke.ok ? deliverToOrchestrator(sessionId, text, options) : false
        ),
      sessionStatus: statusSeenByRoles,
      stopSession: (sessionId) => ptyManager.killSession(sessionId),
      claudeCommand: () => agentCommand('claude'),
      // The configured external providers, so the brief lists them (model-providers.ts).
      providers: () =>
        (configService.getConfig().modelProviders ?? []).map((provider) => ({
          id: provider.id,
          label: provider.label,
          ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
          models: providerModels(provider).map((model) => model.id),
          priced: provider.pricing !== undefined,
        })),
      resolveRepo: resolveProjectRepo,
      adoptTasks: (sessionId, repoPath) => ctx.taskScheduler?.adoptTasks(sessionId, repoPath) ?? 0,
      // Done like any task that changed nothing; one with work in its worktree stays open.
      closeReported: (taskId) => {
        ctx.taskScheduler
          ?.closeReported(taskId)
          .then((closed) => {
            if (closed) logger.log(`task ${taskId}: its report reached the orchestrator, done`);
            else logger.warn(`task ${taskId} stays open after its report`);
          })
          .catch((error) => logger.warn(`task ${taskId} could not close: ${error}`));
      },
      // Events it never got, when it goes away, reach the phone after all.
      notify: (payload) => {
        logger.log(`Task push (its orchestrator is gone): ${payload.title}`);
        pushNotificationService?.sendNotification(payload).catch((error) => {
          logger.warn(`Failed to send task notification: ${error}`);
        });
      },
      claudeConversation: (sessionId) => ptyManager.getSession(sessionId)?.claudeSessionId,
      log: (message) => logger.log(message),
      // Other orchestrators' messages: told once typed in, or when they never will be.
      messages: taskCommands.messages,
      // Why a queued message waits (2026-11-10): its Claude's own events and its screen.
      halt: (sessionId) => {
        const events = ctx.agentEvents.snapshot(sessionId);
        return events?.state === 'halted' ? events.halt : undefined;
      },
      screenPrompt: async (sessionId) => (await shareMenu.read(sessionId))?.question ?? null,
      // Queued briefs and task events survive a restart.
      statePath: path.join(CONTROL_DIR, 'orchestrators.json'),
    });
    // Its orchestrators follow a renamed or moved project folder (2026-10-25: toolshed → bakery).
    projectSettings.followedBy('orchestrators', (moved) => instance.projectsMoved(moved));
    // Renamed or moved project folders are found again among these (and their old siblings).
    projectSettings.setLiveDirs(() => [
      ...sessionManager
        .listSessions()
        .flatMap((session) => [session.workingDir, session.workDir ?? '']),
      ...(ctx.taskScheduler?.list() ?? []).flatMap((task) => [
        task.repoPath ?? '',
        task.workingDir,
      ]),
    ]);
    // restore() follows moved projects first; then every 10 minutes.
    instance
      .restore()
      .catch((error) => logger.warn(`Orchestrator restore failed: ${error}`))
      .finally(() => {
        projectSettings.watchMoves();
        flushTaskPushes();
      });
    ptyManager.on('sessionExited', (sessionId: string) => {
      instance.onSessionExited(sessionId);
      taskCommands.messages.sessionEnded(sessionId);
      forgetTyping(sessionId);
    });
    ctx.orchestrator = instance;
    sessionReplacements.followedBy('orchestrators', instance.replacementFollower());
    // Held-back task pushes go at most a minute late, even if restore hangs.
    setTimeout(flushTaskPushes, 60_000).unref?.();
  }
}
