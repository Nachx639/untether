/**
 * Session list: starting things — quick starts, the new-session and folder sheets, the
 * "Ask Claude" box, task sheets, previews to add and the session start request.
 */
import { html, nothing, render } from 'lit';
import { state } from 'lit/decorators.js';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../../shared/constants.js';
import { quickStartProgram } from '../../../shared/quick-start.js';
import type { Session } from '../../../shared/types.js';
import type { QuickStartCommand } from '../../../types/config.js';
import { t } from '../../i18n/index.js';
import {
  fetchQuickStartAvailability,
  isQuickStartAvailable,
  type QuickStartAvailability,
} from '../../services/quick-start-availability.js';
import { serverConfigService } from '../../services/server-config-service.js';
import { type RouteChoiceItem, sendAsTask } from '../../services/task-routing.js';
import { parseCommand } from '../../utils/command-utils.js';
import { lazyViews } from '../../utils/lazy-views.js';
import { formatPathForDisplay } from '../../utils/path-utils.js';
import { actionItems, PhoneActionSheet } from '../../utils/phone-action-sheet.js';
import {
  addPreview,
  announcePreviewsChanged,
  fetchPreviewCandidates,
  type PreviewCandidate,
  previewCandidateLabel,
} from '../../utils/preview-rows.js';
import { normalizeRepoPath, sessionRepoKey } from '../../utils/repo-key.js';
import { lastActivityAt } from '../../utils/session-status.js';
import { agentLogo } from '../agent-avatar.js';
import { type AskAgent, type AskClaudeBox, type AskMode, readAskAgent } from '../ask-claude-box.js';
import { agentKind, icon } from '../icons.js';
import { preferPhoneChatMode } from '../session-view/ui-state-manager.js';
import { SessionListProjects } from './list-projects.js';
import {
  MAX_RECENT_FOLDERS,
  QUICK_START_AVAILABILITY_REFRESH_MS,
  readPhoneStarts,
  writePhoneStarts,
} from './list-shared.js';

export abstract class SessionListLaunch extends SessionListProjects {
  protected addingPreview = false;

  /**
   * "+ Añadir vista previa": the web servers listening on the Mac, one tap each (2026-10-03:
   * from the phone you had to remember the port), then "Otro puerto o URL…" to type one.
   */
  protected async openAddPreviewSheet() {
    if (this.addingPreview) return;
    this.addingPreview = true;
    let candidates: PreviewCandidate[] = [];
    try {
      candidates = (await fetchPreviewCandidates(this.authClient?.getAuthHeader() ?? {})) ?? [];
    } finally {
      this.addingPreview = false;
    }
    if (!this.isConnected) return;
    this.showSheet(t(candidates.length ? 'previewRows.serversTitle' : 'previewRows.noServers'), [
      ...candidates.map((candidate) => ({
        label: previewCandidateLabel(candidate),
        mono: true,
        run: () => void this.addPreviewTarget(String(candidate.port)),
      })),
      // An action, not a server: no `mono`, like "Other folder…" in the folder sheets.
      { label: t('previewRows.otherTarget'), run: () => this.promptAddPreview() },
    ]);
  }

  /** "Otro puerto o URL…": a port or a localhost URL, typed, no session needed. */
  protected promptAddPreview() {
    const target = window.prompt(t('previewRows.addPrompt'), '')?.trim();
    if (target) void this.addPreviewTarget(target);
  }

  protected async addPreviewTarget(target: string) {
    if (this.addingPreview) return;
    this.addingPreview = true;
    try {
      const result = await addPreview(target, this.authClient?.getAuthHeader() ?? {});
      if (result.error) {
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: t('previewRows.addFailed', { error: result.error }),
          })
        );
      }
      announcePreviewsChanged();
    } finally {
      this.addingPreview = false;
    }
  }

  /**
   * «Conversar» over every session (the copilot's global mode). Opened within the tap when the
   * views chunk is already here (it preloads after the list): iOS lets audio and the microphone
   * start only from a gesture. Otherwise the sheet asks for one more tap («Empezar»).
   */
  protected openGlobalCopilot() {
    lazyViews.copilotSheet.use(({ openCopilot }) => openCopilot({ mode: 'global' }));
  }

  /** Quick starts from the server config (claude, gemini, codex, zsh, …), loaded on first use. */
  @state() protected quickStarts: QuickStartCommand[] = [];
  protected quickStartsLoaded = false;
  /**
   * Quick-start programs the Mac doesn't have ({ gemini: false }): dimmed, and a tap says so.
   * {} (everything offered) until the server answers.
   */
  @state() protected quickStartAvailability: QuickStartAvailability = {};
  protected quickStartAvailabilityAt = 0;

  /** Wait this long after a failed config request before asking again. */
  protected static readonly CONFIG_RETRY_MS = 30_000;
  private launchConfigLoading = false;
  private launchConfigFailedAt = 0;

  /**
   * The quick starts and the repository base path, from one /api/config read. 2026-11-10: both
   * were marked loaded BEFORE the request and loadConfig never throws (it answers a default
   * with serverConfigured false), so one failed read kept the defaults until a reload. Marked
   * loaded only after a real answer; a failed one is asked again, at most every 30 s.
   */
  protected loadQuickStarts() {
    this.refreshQuickStartAvailability();
    if (this.quickStartsLoaded || this.launchConfigLoading) return;
    if (Date.now() - this.launchConfigFailedAt < SessionListLaunch.CONFIG_RETRY_MS) return;
    this.launchConfigLoading = true;
    serverConfigService
      .loadConfig()
      .then((config) => {
        // The server always says true; false is loadConfig's answer to a failed request.
        if (config.serverConfigured === false) {
          this.launchConfigFailedAt = Date.now();
          return;
        }
        this.quickStarts = (config.quickStartCommands ?? []).filter((entry) =>
          entry.command?.trim()
        );
        this.repositoryBasePath = config.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
        this.quickStartsLoaded = true;
      })
      .catch(() => {
        this.launchConfigFailedAt = Date.now();
      })
      .finally(() => {
        this.launchConfigLoading = false;
      });
  }

  /** Your quick starts, the one you started last first (it becomes the big button). */
  protected quickStartList(): QuickStartCommand[] {
    const list = this.quickStarts.length
      ? this.quickStarts
      : [{ name: '✨ claude', command: 'claude' }, { command: 'zsh' }];
    const last = readPhoneStarts().tool;
    const index = list.findIndex((entry) => entry.command.trim() === last);
    return index > 0 ? [list[index], ...list.slice(0, index), ...list.slice(index + 1)] : list;
  }

  protected quickStartLabel(entry: QuickStartCommand): string {
    return (entry.name || entry.command).trim();
  }

  protected refreshQuickStartAvailability() {
    if (Date.now() - this.quickStartAvailabilityAt < QUICK_START_AVAILABILITY_REFRESH_MS) return;
    this.quickStartAvailabilityAt = Date.now();
    void fetchQuickStartAvailability(this.authClient?.getAuthHeader() ?? {}).then(
      (availability) => {
        this.quickStartAvailability = availability;
      }
    );
  }

  protected quickStartAvailable(entry: QuickStartCommand): boolean {
    return isQuickStartAvailable(this.quickStartAvailability, entry.command);
  }

  /** A quick start tapped: on to its folder, unless its program is not on the Mac. */
  protected chooseQuickStart(entry: QuickStartCommand) {
    if (this.quickStartAvailable(entry)) {
      this.openFolderSheet(entry);
      return;
    }
    // Its session would only fail with "command not found": say why nothing starts instead.
    this.dispatchEvent(
      new CustomEvent('error', {
        detail: t('quickStart.notInstalledOnMac', { name: quickStartProgram(entry.command) }),
        bubbles: true,
      })
    );
  }

  /** A quick start's name as shown in tiles and sheets: without its leading emoji. */
  protected quickStartDisplay(entry: QuickStartCommand): string {
    return this.quickStartLabel(entry).replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
  }

  /** Recent working directories, most recent first, then ones remembered from earlier. */
  protected recentFolders(): string[] {
    const recency = (session: Session) =>
      new Date(session.lastModified || session.startedAt || 0).getTime();
    const folders: string[] = [];
    // Local folders only: a remote (HQ) session's folder doesn't exist on this machine.
    const local = this.sessions.filter(
      (session) => session.source !== 'remote' && !session.remoteId
    );
    for (const session of local.sort((a, b) => recency(b) - recency(a))) {
      if (session.workingDir && !folders.includes(session.workingDir)) {
        folders.push(session.workingDir);
      }
      if (folders.length === MAX_RECENT_FOLDERS) break;
    }
    for (const folder of readPhoneStarts().folders ?? []) {
      if (folders.length === MAX_RECENT_FOLDERS) break;
      if (typeof folder === 'string' && folder && !folders.includes(folder)) folders.push(folder);
    }
    // Remember them now: "Clear finished" would otherwise take their folders with them.
    if (folders.length) writePhoneStarts({ folders });
    else folders.push('~');
    return folders;
  }

  protected openCreateDialog() {
    this.dispatchEvent(new CustomEvent('open-create-dialog', { detail: {}, bubbles: true }));
  }

  /**
   * "+ Nueva": first what to start (2026-10-18). Sesión goes on to today's tool sheet; Tarea
   * to the compose sheet (its own branch, merged when done).
   */
  protected openNewChooser = () => {
    const option = (title: string, hint: string) =>
      html`<span class="psr-sheet-text"
        >${title}<span class="psr-sheet-desc">${hint}</span></span
      >`;
    this.closeSheet();
    const opener = document.activeElement;
    const sheet = new PhoneActionSheet({ label: t('newChoice.title'), opener });
    this.sheet = sheet;
    sheet.open(
      (
        s
      ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="new-choice-sheet">
        <div class="psr-sheet-title">${t('newChoice.title')}</div>
        ${actionItems(s, [
          {
            label: option(t('newChoice.session'), t('newChoice.sessionHint')),
            icon: 'terminal',
            testId: 'new-choice-session',
            run: () => this.openToolSheet(),
          },
          {
            label: option(t('newChoice.task'), t('newChoice.taskHint')),
            icon: 'gitBranch',
            testId: 'new-choice-task',
            run: () => this.openNewTask(),
          },
          {
            label: option(t('newChoice.project'), t('newChoice.projectHint')),
            icon: 'folder',
            testId: 'new-choice-project',
            run: () => this.openNewProject(),
          },
        ])}
      </div>`
    );
  };

  /** «Nuevo proyecto»: the server pins it, so the board shows it with its «Orquestar». */
  protected openNewProject = () => {
    lazyViews.newProjectSheet.use(({ openNewProjectSheet }) =>
      openNewProjectSheet({ store: this.taskBoard.store })
    );
  };

  protected openToolSheet = () => {
    this.showSheet(t('newChat.which'), [
      ...this.quickStartList().map((entry) => ({
        label: this.quickStartDisplay(entry),
        unavailableNote: this.quickStartAvailable(entry) ? undefined : t('quickStart.notInstalled'),
        glyph: agentLogo(agentKind({ command: entry.command.trim().split(/\s+/) }), undefined, 20),
        run: () => this.chooseQuickStart(entry),
      })),
      {
        label: t('empty.custom'),
        glyph: icon('settings', 20),
        run: () => this.openCreateDialog(),
      },
    ]);
  };

  protected openFolderSheet(entry: QuickStartCommand) {
    this.showSheet(
      t('newChat.where', { tool: this.quickStartDisplay(entry) }),
      [
        ...this.recentFolders().map((folder) => ({
          label: formatPathForDisplay(folder),
          mono: true,
          run: () => void this.startSession(entry, folder),
        })),
        { label: t('newChat.other'), run: () => this.openCreateDialog() },
      ],
      { shieldToggle: true }
    );
  }

  /** The quick start that runs Claude Code (your configured command and flags), or plain claude. */
  protected claudeQuickStart(): QuickStartCommand {
    return (
      this.quickStartList().find((entry) =>
        /(^|\/)claude$/.test(parseCommand(entry.command.trim())[0] ?? '')
      ) ?? { command: 'claude' }
    );
  }

  /** The quick start that runs Codex (your configured command and flags), or plain codex. */
  protected codexQuickStart(): QuickStartCommand {
    return (
      this.quickStartList().find((entry) =>
        /(^|\/)codex$/.test(parseCommand(entry.command.trim())[0] ?? '')
      ) ?? { command: 'codex' }
    );
  }

  protected isClaudeCommand(command: string): boolean {
    return /(^|\/)claude$/.test(parseCommand(command.trim())[0] ?? '');
  }

  @state() protected repositoryBasePath = '';
  @state() protected askFolderOverride = '';
  @state() protected asking = false;

  /** "Ask Claude…" folder: the one you picked, the last one used for Claude, else the repo base. */
  protected askFolder(): string {
    if (this.askFolderOverride) return this.askFolderOverride;
    const remembered = readPhoneStarts().claudeFolder;
    if (typeof remembered === 'string' && remembered) return remembered;
    const recency = (session: Session) =>
      new Date(session.lastModified || session.startedAt || 0).getTime();
    const lastClaude = this.sessions
      .filter(
        (session) =>
          session.source !== 'remote' &&
          !session.remoteId &&
          session.workingDir &&
          this.isClaudeCommand(session.command?.join(' ') ?? '')
      )
      .sort((a, b) => recency(b) - recency(a))[0];
    return lastClaude?.workingDir || this.repositoryBasePath || '~';
  }

  protected renderAskBox() {
    this.loadQuickStarts();
    const folder = this.askFolder();
    // "Tareas" is a clock icon in the Ask card's row (phone-spec 4.1, 2026-10-12).
    return html`<ask-claude-box
      .folder=${folder}
      .repo=${Boolean(this.askRepoOf(folder))}
      .busy=${this.asking}
      .tasks=${true}
      @ask-claude=${this.handleAskClaude}
      @ask-pick-folder=${this.openAskFolderSheet}
      @ask-open-tasks=${this.openTasks}
    ></ask-claude-box>`;
  }

  /** Tasks sheet (task-sheet.ts): a template prompt now or later, with a push at the end. */
  protected openTasks = () => this.openTaskSheetIn();

  /**
   * "+ Tarea" in a project, or "+ Nueva" → Tarea: the compose sheet (task-compose-sheet.ts),
   * in that project or the last one used.
   */
  protected openNewTask(repoPath?: string) {
    this.loadQuickStarts();
    const repos = this.knownRepos();
    lazyViews.taskComposeSheet.use(({ openTaskComposeSheet }) =>
      openTaskComposeSheet({
        repos,
        ...(repoPath ? { repo: repoPath } : {}),
        agents: this.composeAgents(),
        shielded: this.newShielded,
      })
    );
  }

  /** Projects the list knows: its sessions' repos (most recent first), then its tasks'. */
  protected knownRepos(): string[] {
    const recency = (session: Session) => lastActivityAt(session) ?? 0;
    const keys = [...this.sessions]
      .filter((session) => session.source !== 'remote' && !session.remoteId)
      .sort((a, b) => recency(b) - recency(a))
      .map((session) => sessionRepoKey(session))
      .filter((key): key is string => Boolean(key));
    const fromTasks = this.taskBoard.tasks
      .map((task) => (task.repoPath ? normalizeRepoPath(task.repoPath) : ''))
      .filter(Boolean);
    const board = this.projectBoard(this.sessions, '', false);
    const family = new Map<string, string>();
    for (const group of board.groups) {
      if (!group.key) continue;
      for (const session of group.sessions) {
        const key = sessionRepoKey(session);
        if (key) family.set(key, group.key);
      }
    }
    return [...new Set([...keys.map((key) => family.get(key) ?? key), ...fromTasks])];
  }

  /** The agents a task can run: your Claude and Codex quick starts (names and flags). */
  protected composeAgents(): Array<{
    agent: 'claude' | 'codex';
    label: string;
    command: string[];
  }> {
    const agents = this.quickStartList()
      .map((entry) => {
        const command = parseCommand(entry.command.trim());
        const program = (command[0] ?? '').split('/').pop() ?? '';
        const agent = program === 'claude' ? 'claude' : program === 'codex' ? 'codex' : null;
        return agent ? { agent, label: this.quickStartDisplay(entry), command } : null;
      })
      .filter((entry): entry is { agent: 'claude' | 'codex'; label: string; command: string[] } =>
        Boolean(entry)
      );
    return agents.length
      ? agents
      : [
          { agent: 'claude', label: 'Claude', command: ['claude'] },
          { agent: 'codex', label: 'Codex', command: ['codex'] },
        ];
  }

  protected openTaskSheetIn(folder?: string) {
    const seen = new Set<string>();
    const folders = [
      ...(folder ? [folder] : []),
      this.askFolder(),
      ...this.recentFolders(),
      this.repositoryBasePath || '~',
    ];
    // The sheet is its own chunk (utils/lazy-views.ts), normally preloaded by now.
    lazyViews.taskSheet.use(({ openTaskSheet }) =>
      openTaskSheet({
        folders: folders.filter((folder) => {
          const key = folder && formatPathForDisplay(folder);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
        commands: {
          claude: parseCommand(this.claudeQuickStart().command.trim()),
          codex: parseCommand(this.codexQuickStart().command.trim()),
        },
        agent: readAskAgent(),
        shielded: this.newShielded,
        onStarted: (sessionId) => {
          preferPhoneChatMode();
          this.dispatchEvent(
            new CustomEvent('session-created', { detail: { sessionId }, bubbles: true })
          );
        },
      })
    );
  }

  protected openAskFolderSheet = () => {
    const current = this.askFolder();
    // "~/Projects" and "/Users/me/Projects" are the same folder: compare as displayed.
    const seen = new Set<string>();
    const folders = [current, ...this.recentFolders(), this.repositoryBasePath || '~'].filter(
      (folder) => {
        const key = folder && formatPathForDisplay(folder);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }
    );
    this.showSheet(t(readAskAgent() === 'codex' ? 'ask.whereCodex' : 'ask.where'), [
      ...folders.map((folder) => ({
        label: formatPathForDisplay(folder),
        mono: true,
        run: () => this.setAskFolder(folder),
      })),
      // An action, not a path: no `mono`, like "Other folder…" in the new-session sheet.
      { label: t('ask.otherFolder'), run: () => this.openAskFolderPicker(current) },
    ]);
  };

  protected setAskFolder(folder: string) {
    this.askFolderOverride = folder;
    writePhoneStarts({ claudeFolder: folder });
  }

  protected askFolderPickerHost: HTMLElement | null = null;

  /**
   * "Other folder…": the folder picker of the new-session form (file-browser in select mode),
   * opened in the current ask folder. In <body> like the sheets, above the whole app.
   */
  protected openAskFolderPicker(start: string) {
    // The file browser is its own chunk (utils/lazy-views.ts), normally preloaded by now.
    lazyViews.fileBrowser.use(() => this.showAskFolderPicker(start));
  }

  protected showAskFolderPicker(start: string) {
    this.closeAskFolderPicker();
    // The sheets leave a question being typed focused: its keyboard would cover the picker's
    // Cancel / Select bar.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches('input, textarea')) focused.blur();
    const host = document.createElement('div');
    this.askFolderPickerHost = host;
    document.body.appendChild(host);
    render(
      html`<file-browser
        .visible=${true}
        .mode=${'select'}
        .session=${{ workingDir: start } as Session}
        @directory-selected=${(e: CustomEvent<string>) => {
          this.closeAskFolderPicker();
          this.setAskFolder(e.detail);
        }}
        @browser-cancel=${this.closeAskFolderPicker}
      ></file-browser>`,
      host
    );
  }

  protected closeAskFolderPicker = () => {
    if (!this.askFolderPickerHost) return;
    render(nothing, this.askFolderPickerHost);
    this.askFolderPickerHost.remove();
    this.askFolderPickerHost = null;
  };

  /** Repositories of Ask folders: the main checkout, null outside one (GET /projects/settings). */
  protected askRepos = new Map<string, { repo: string | null; at: number }>();
  protected askRepoProbes = new Set<string>();

  /**
   * The repository the Ask folder is in (undefined while it is being found out). A folder the
   * server could not answer for counts as none for a minute, then is asked again.
   */
  protected askRepoOf(folder: string): string | null | undefined {
    const key = formatPathForDisplay(folder);
    const known = this.sessions.find(
      (session) =>
        session.workingDir &&
        formatPathForDisplay(session.workingDir) === key &&
        (session.gitMainRepoPath || session.gitRepoPath)
    );
    if (known) return normalizeRepoPath(known.gitMainRepoPath || known.gitRepoPath || '');
    const cached = this.askRepos.get(key);
    if (cached && (cached.repo !== null || Date.now() - cached.at < 60_000)) return cached.repo;
    if (!this.askRepoProbes.has(key)) {
      this.askRepoProbes.add(key);
      // Started after render (it runs inside render): a fetch that throws at once, or a test's
      // stub that returns nothing, must not break the list.
      void Promise.resolve()
        .then(() =>
          fetch(`/api/projects/settings?repo=${encodeURIComponent(folder)}`, {
            headers: { ...this.authClient?.getAuthHeader() },
          })
        )
        .then(async (response) => {
          const body = (await response?.json().catch(() => ({}))) as { repoPath?: unknown };
          return response?.ok && typeof body?.repoPath === 'string' ? body.repoPath : null;
        })
        .catch(() => null)
        .then((repo) => {
          this.askRepoProbes.delete(key);
          const before = this.askRepos.get(key)?.repo;
          this.askRepos.set(key, { repo, at: Date.now() });
          if (before !== repo) this.requestUpdate();
        });
    }
    return cached?.repo;
  }

  /**
   * Tarea mode (services/task-routing.ts): to the open task it belongs to, or a new one; the
   * one-tap choices are phone action sheets.
   */
  protected askAsTask(box: AskClaudeBox, repoPath: string, text: string, agent: AskAgent) {
    return sendAsTask(
      { repoPath, text, agent },
      {
        restore: (value) => box.restore(value),
        choose: (title: string, items: RouteChoiceItem[], onCancel: () => void) => {
          this.closeSheet();
          let picked = false;
          const sheet = new PhoneActionSheet({
            label: title,
            opener: document.activeElement,
            // A pick closes the sheet before it runs: decide once that has happened.
            onClose: () =>
              queueMicrotask(() => {
                if (!picked) onCancel();
              }),
          });
          this.sheet = sheet;
          sheet.open(
            (
              s
            ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material" data-testid="route-choice-sheet">
              <div class="psr-sheet-title">${title}</div>
              ${actionItems(
                s,
                items.map((item) => ({
                  label: item.hint
                    ? html`<span class="psr-sheet-text"
                        >${item.label}<span class="psr-sheet-desc" dir="ltr"
                          >${item.hint}</span
                        ></span
                      >`
                    : item.label,
                  testId: item.testId,
                  run: () => {
                    picked = true;
                    item.run();
                  },
                }))
              )}
            </div>`
          );
        },
      }
    );
  }

  /** Start Claude or Codex in the chosen folder; the server types the question once it is ready. */
  protected handleAskClaude = async (
    e: CustomEvent<{ text: string; agent?: AskAgent; mode?: AskMode }>
  ) => {
    if (this.asking) return;
    this.asking = true;
    const folder = this.askFolder();
    writePhoneStarts({ claudeFolder: folder });
    const repoPath = e.detail.mode === 'task' ? this.askRepoOf(folder) : null;
    if (repoPath) {
      try {
        await this.askAsTask(
          e.target as AskClaudeBox,
          repoPath,
          e.detail.text,
          e.detail.agent === 'codex' ? 'codex' : 'claude'
        );
      } finally {
        this.asking = false;
      }
      return;
    }
    // A question is a conversation: open it in chat mode.
    preferPhoneChatMode();
    try {
      const agent = e.detail.agent === 'codex' ? 'codex' : 'claude';
      const entry = agent === 'codex' ? this.codexQuickStart() : this.claudeQuickStart();
      const started = await this.startSession(entry, folder, e.detail.text, agent);
      // Not started: give the question back instead of losing it.
      if (!started) (e.target as AskClaudeBox).restore(e.detail.text);
    } finally {
      this.asking = false;
    }
  };

  /** Same request as the create dialog, with the quick start's exact command. */
  protected async startSession(
    entry: QuickStartCommand,
    workingDir: string,
    initialInput?: string,
    initialInputAgent?: AskAgent
  ): Promise<boolean> {
    const command = parseCommand(entry.command.trim());
    writePhoneStarts({
      tool: entry.command.trim(),
      folders: [
        workingDir,
        ...(readPhoneStarts().folders ?? []).filter((folder) => folder !== workingDir),
      ].slice(0, MAX_RECENT_FOLDERS),
      ...(this.isClaudeCommand(entry.command) ? { claudeFolder: workingDir } : {}),
    });
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authClient?.getAuthHeader() },
        body: JSON.stringify({
          command,
          workingDir,
          name: `${command[0]} (${formatPathForDisplay(workingDir)})`,
          spawn_terminal: false,
          cols: 120,
          rows: 30,
          ...(initialInput ? { initialInput, initialInputAgent } : {}),
          // Only an explicit choice on this device is sent; otherwise the server's setting decides.
          ...(this.newShieldedChoice !== null ? { shielded: this.newShieldedChoice } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.sessionId) throw new Error(result.error || response.statusText);
      // The app opens it once it shows up, as for the full create dialog.
      this.dispatchEvent(new CustomEvent('session-created', { detail: result, bubbles: true }));
      return true;
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', { detail: `${t('newChat.failed')}: ${error}`, bubbles: true })
      );
      return false;
    }
  }
}
