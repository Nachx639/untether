// The state createApp's setup steps share (AppContext).

import type express from 'express';
import type * as http from 'http';
import type { WebSocketServer } from 'ws';
import type { createAuthMiddleware } from './middleware/auth.js';
import type { PtyManager } from './pty/index.js';
import type { SessionManager } from './pty/session-manager.js';
import type { ShareRoutesConfig } from './routes/share.js';
import type { setupAppUpdate } from './server-app-update.js';
import type { Config } from './server-config.js';
import type { AgentEventService } from './services/agent-event-service.js';
import type { SignalLedger } from './services/agent-events.js';
import type { AuthService } from './services/auth-service.js';
import type { BackupExclusion } from './services/backup-exclusion.js';
import type { CastOutputHub } from './services/cast-output-hub.js';
import type { CheckSlots } from './services/check-slots.js';
import type { ClaudeHookFiles } from './services/claude-hooks.js';
import type { ClaudeRestartActions } from './services/claude-update-restart.js';
import type { CodexMenus, CodexSessions } from './services/codex-session-status.js';
import type { ConfigService } from './services/config-service.js';
import type { ConnectorHealthDeps } from './services/connector/connector-health.js';
import type { ConnectorListener } from './services/connector/connector-http.js';
import type { ControlDirWatcher } from './services/control-dir-watcher.js';
import type { CopilotService } from './services/copilot/service.js';
import type { EventLog } from './services/event-log.js';
import type { FlakyTestStore } from './services/flaky-tests.js';
import type { GitStatusHub } from './services/git-status-hub.js';
import type { HQClient } from './services/hq-client.js';
import type { InputDiagStore } from './services/input-diagnostics.js';
import type { MacSessionsScanner } from './services/mac-sessions/scanner.js';
import type {
  MacSessionsStartOptions,
  macSessionsSettings,
} from './services/mac-sessions/settings.js';
import type { MacShareStartOptions } from './services/mac-sessions/share-settings.js';
import type { ProviderLauncher } from './services/model-provider-launch.js';
import type { Orchestrator } from './services/orchestrator.js';
import type { PreviewHealthMonitor } from './services/preview-health.js';
import type { PreviewProxy } from './services/preview-proxy.js';
import type { PreviewRegistry } from './services/preview-registry.js';
import type { ProjectSettingsStore } from './services/project-settings.js';
import type { PushNotificationService } from './services/push-notification-service.js';
import type { RemoteRegistry } from './services/remote-registry.js';
import type { ResourceMonitor } from './services/resource-monitor.js';
import type { AnswerScreenMenu, ScreenMenu } from './services/screen-menu.js';
import type { SecuritySweeper } from './services/security-sweep.js';
import type { SessionMonitor } from './services/session-monitor.js';
import type { SessionReplacements } from './services/session-replacements.js';
import type { SessionStateEvents } from './services/session-state-events.js';
import type { SessionSuspender, WakeResult } from './services/session-suspender.js';
import type { StableTmux } from './services/stable-tmux.js';
import type { TaskCommands } from './services/task-commands.js';
import type { DeliverInitialInput } from './services/task-launcher.js';
import type { TaskOrphanReaper } from './services/task-processes.js';
import type { TaskScheduler } from './services/task-scheduler.js';
import type { TerminalManager } from './services/terminal-manager.js';
import type { DoctorReport } from './services/untether-doctor.js';
import type { WsV3Hub } from './services/ws-v3-hub.js';
import type { InflightRequests } from './utils/inflight-requests.js';
import type { VapidManager } from './utils/vapid-manager.js';

/**
 * Everything createApp (server-app.ts) builds, shared by its setup steps (server-*.ts). Each
 * step reads what earlier steps made; the fields marked "set later" are read through `ctx.` at
 * the time they are needed, since a later step (or a request, or the listen callback) sets them.
 */
export interface AppContext {
  config: Config;
  app: express.Application;
  server: http.Server;
  wss: WebSocketServer;
  copilotWss: WebSocketServer;
  /** Control directory for session data. */
  controlDir: string;
  /** The public event log (`ut events`, GET /api/events): created first, everyone records. */
  eventLog: EventLog;
  /** What devices with input diagnostics on measure (`ut diag input`, POST /api/diag/input). */
  inputDiag: InputDiagStore;
  /** Check slots for runs agents and scripts start (`ut check-slot`, check-slots.ts). */
  checkSlots: CheckSlots;

  // Set later (read through ctx.)
  /** The dev-server preview listener's port, once it listens. */
  previewListenPort: number | null;
  /** Tasks from the phone (run now or at a time); created once the session routes exist. */
  taskScheduler: TaskScheduler | null;
  /** Ends what closed tasks left running (task-processes.ts, 2026-11-02); with the tasks. */
  taskOrphanReaper: TaskOrphanReaper | null;
  /** Projects' orchestrators (P7): their tasks' events go to them; created with the tasks. */
  orchestrator: Orchestrator | null;
  /** Idle Claude sessions suspended to free memory (2026-10-31); created with the restarter. */
  sessionSuspender: SessionSuspender | null;
  /** The doctor's last report, or a new one (`ut doctor`, server-doctor.ts). */
  doctorReport: ((run: boolean) => Promise<DoctorReport | undefined>) | null;
  /** The installed Mac app this server runs under and its updater (server-app-update.ts). */
  installedApp: ReturnType<typeof setupAppUpdate>['installedApp'] | null;
  hqClient: HQClient | null;
  controlDirWatcher: ControlDirWatcher | null;
  remoteBearerToken: string | null;
  authService: AuthService;
  deliverTaskInput: DeliverInitialInput | null;
  answerTrustDialog: ((sessionId: string) => Promise<boolean>) | null;
  /** Picks an option of the menu on a session's screen, while it is still that menu. */
  answerScreenMenu: AnswerScreenMenu | null;
  claudeRestartActions: ClaudeRestartActions | null;
  sessionKeptForTasks: (sessionId: string) => boolean;

  // setupCore
  previewRegistry: PreviewRegistry;
  previewPublicOrigin: string | null;
  mainListenPort: () => number | null;
  previewProxy: PreviewProxy;
  identifyPreviewPort: (port: number) => Promise<void>;
  previewHealth: PreviewHealthMonitor;
  previewServer: http.Server;
  inflightRequests: InflightRequests;
  configService: ConfigService;
  resourceMonitor: ResourceMonitor;
  /** Tests that failed a task's check under load and passed on the rerun, per project. */
  flakyTests: FlakyTestStore;
  /** Marks Untether's disposable folders out of Time Machine (config excludeFromBackups). */
  backupExclusion: BackupExclusion;
  stableTmux: StableTmux | null;
  ptyManager: PtyManager;
  /** External model providers launcher (model-providers.ts), shared by tasks and sessions. */
  providerLauncher: ProviderLauncher;
  hookFiles: ClaudeHookFiles;
  agentEvents: AgentEventService;
  /** The sessions a Codex runs in, typed in a shell included (codex-session-status.ts). */
  codexSessions: CodexSessions;
  agentSignals: SignalLedger;
  /** Agent sessions' states for the event log (session-state-events.ts). */
  sessionStates: SessionStateEvents;
  claudeBusySeen: Map<string, number>;
  sessionManager: SessionManager;
  terminalManager: TerminalManager;
  sessionReplacements: SessionReplacements;
  shareRoutesConfig: ShareRoutesConfig;
  castOutputHub: CastOutputHub;
  gitStatusHub: GitStatusHub;
  sessionMonitor: SessionMonitor;

  // setupPush
  vapidManager: VapidManager | null;
  pushNotificationService: PushNotificationService | null;

  // setupClaudeStatus
  /** The menu a Codex waits on, read off its screen (codex-session-status.ts). */
  codexMenus: CodexMenus;
  statusSeenByRoles: (sessionId: string) => string | undefined;
  wakeSuspended: (
    sessionId: string,
    why: string,
    options?: { byUser?: boolean }
  ) => Promise<WakeResult>;

  // setupAuth
  remoteRegistry: RemoteRegistry | null;
  wsV3Hub: WsV3Hub;
  authMiddleware: ReturnType<typeof createAuthMiddleware>;

  // setupStatic
  publicPath: string;
  isDevelopment: boolean;
  sendIndexHtml: (res: express.Response) => Promise<void>;

  // setupSessions
  macSessionsStart: MacSessionsStartOptions;
  macSessionsNow: () => ReturnType<typeof macSessionsSettings>;
  macShareStart: MacShareStartOptions;
  macSessionsScanner: MacSessionsScanner;
  shareMenu: ScreenMenu;
  disposeMacShare: () => void;
  liveConversations: () => ReturnType<MacSessionsScanner['liveClaudeConversations']>;
  copilotService: CopilotService | null;

  // setupTasks
  projectSettings: ProjectSettingsStore;
  flushTaskPushes: () => void;
  agentCommand: (agent: 'claude' | 'codex') => string[];
  securitySweeper: SecuritySweeper | null;
  connectorListener: ConnectorListener | null;
  connectorHealth: ConnectorHealthDeps;
  taskCommands: TaskCommands;
}
