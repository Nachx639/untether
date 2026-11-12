/**
 * Session Create Form Component
 *
 * Modal dialog for creating new terminal sessions. Provides command input,
 * working directory selection, and options for spawning in native terminal.
 *
 * @fires session-created - When session is successfully created (detail: { sessionId: string })
 * @fires cancel - When form is cancelled
 * @fires error - When creation fails (detail: string)
 *
 * @listens file-selected - From file browser when directory is selected
 * @listens browser-cancel - From file browser when cancelled
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './file-browser.js';
import './session-create-form/git-branch-selector.js';
import './session-create-form/quick-start-section.js';
import './session-create-form/form-options-section.js';
import './session-create-form/directory-autocomplete.js';
import './session-create-form/repository-dropdown.js';
import './modal-wrapper.js';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import {
  type PublicModelProvider,
  providerSessionLabel,
  publicDefaultModel,
} from '../../shared/model-providers.js';
import type { Session } from '../../shared/types.js';
import { TitleMode } from '../../shared/types.js';
import type { QuickStartCommand } from '../../types/config.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { type GitRepoInfo, GitService } from '../services/git-service.js';
import {
  fetchQuickStartAvailability,
  type QuickStartAvailability,
} from '../services/quick-start-availability.js';
import { RemoteService, type RemoteSummary } from '../services/remote-service.js';
import { RepositoryService } from '../services/repository-service.js';
import { ServerConfigService } from '../services/server-config-service.js';
import { type SessionCreateData, SessionService } from '../services/session-service.js';
import { toast } from '../utils/action-toast.js';
import { parseCommand } from '../utils/command-utils.js';
import { captureOpener, cycleTabWithin, restoreFocusLater } from '../utils/dialog-focus.js';
import { createLogger } from '../utils/logger.js';
import { isPhoneScreen } from '../utils/mobile-utils.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import {
  getSessionFormValue,
  loadSessionFormData,
  removeSessionFormValue,
  saveSessionFormData,
  setSessionFormValue,
} from '../utils/storage-utils.js';
import {
  type AutocompleteItem,
  AutocompleteManager,
  type Repository,
} from './autocomplete-manager.js';
import { icon } from './icons.js';
import type { WorktreeInfo } from './session-create-form/git-branch-selector.js';
import {
  checkFollowMode,
  enableFollowMode,
  generateWorktreePath,
  loadBranches,
} from './session-create-form/git-utils.js';
import type {
  QuickStartItem,
  QuickStartSection,
} from './session-create-form/quick-start-section.js';

const REMOTE_DEFAULT_WORKING_DIRECTORY = '~/';

const logger = createLogger('session-create-form');

@customElement('session-create-form')
export class SessionCreateForm extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: String }) workingDir = DEFAULT_REPOSITORY_BASE_PATH;
  @property({ type: String }) command = 'zsh';
  @property({ type: String }) sessionName = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) visible = false;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: Boolean }) spawnWindow = false;
  @property({ type: String }) titleMode = TitleMode.STATIC;

  @state() private isCreating = false;
  /**
   * A phone (phone-spec §4.4, 2026-10-12): the form is a bottom sheet with "Cancelar" in its
   * header and a full-width "Crear" pinned at the bottom. Decided when it opens.
   */
  @state() private phoneSheet = false;
  protected readonly i18n = new LocaleController(this);
  @state() private showFileBrowser = false;
  @state() private showRepositoryDropdown = false;
  @state() private repositories: Repository[] = [];
  @state() private macAppConnected = false;
  @state() private isHQMode = false;
  @state() private remotes: RemoteSummary[] = [];
  @state() private selectedRemoteId = '';
  @state() private isLoadingRemoteTargets = true;
  @state() private remoteTargetError = '';
  @state() private showCompletions = false;
  @state() private completions: AutocompleteItem[] = [];
  @state() private selectedCompletionIndex = -1;
  @state() private gitRepoInfo: GitRepoInfo | null = null;
  @state() private availableBranches: string[] = [];

  // New properties for split branch/worktree selectors
  @state() private currentBranch: string = '';
  @state() private selectedBaseBranch: string = '';
  @state() private selectedWorktree?: string;
  @state() private availableWorktrees: WorktreeInfo[] = [];
  @state() private isLoadingBranches = false;
  @state() private isLoadingWorktrees = false;

  // Follow mode state
  @state() private followMode = false;
  @state() private followBranch: string | null = null;
  @state() private showFollowMode = false;

  @state() private quickStartCommands: QuickStartItem[] = [
    { label: 'codex', command: 'codex' },
    { label: 'claude', command: 'claude' },
    { label: 'auggie', command: 'auggie' },
    { label: 'gemini3', command: 'gemini3' },
    { label: 'opencode 4', command: 'opencode 4' },
    { label: 'zsh', command: 'zsh' },
    { label: 'node', command: 'node' },
  ];
  /** Quick-start programs missing on the Mac, asked each time the form opens; {} until known. */
  @state() private quickStartAvailability: QuickStartAvailability = {};

  /** External model providers (model-providers.ts); empty when none is configured. */
  @state() private modelProviders: PublicModelProvider[] = [];
  /** The provider the session runs against (its id), or null for a normal session. */
  @state() private selectedProvider: string | null = null;
  /** The provider model the session starts on. */
  @state() private selectedProviderModel = '';

  // State properties for UI
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in template
  @state() private selectedQuickStart = '';
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in discoverDirectories method
  @state() private isDiscovering = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in checkGitEnabled method
  @state() private isCheckingGit = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in checkFollowMode method
  @state() private isCheckingFollowMode = false;

  private completionsDebounceTimer?: ReturnType<typeof setTimeout>;
  /** Where focus was when the dialog opened; it goes back there on cancel. */
  private restoreFocusTo: HTMLElement | null = null;
  /** Set by a successful create: the new session takes focus, not the opener. */
  private skipFocusRestore = false;
  private gitCheckDebounceTimer?: ReturnType<typeof setTimeout>;
  /** The newest repository check: an older answer arriving late is dropped. */
  private gitCheckId = 0;
  /** The folder the Git state on screen (repository, branches, worktrees) was read for. */
  private gitCheckedPath = '';
  private autocompleteManager!: AutocompleteManager;
  private repositoryService?: RepositoryService;
  private remoteService?: RemoteService;
  private sessionService?: SessionService;
  private serverConfigService?: ServerConfigService;
  private gitService?: GitService;
  private visibleInitializationId = 0;

  connectedCallback() {
    super.connectedCallback();
    // Initialize services - AutocompleteManager handles optional authClient
    this.autocompleteManager = new AutocompleteManager(this.authClient);
    this.serverConfigService = new ServerConfigService(this.authClient);

    // Initialize other services only if authClient is available
    if (this.authClient) {
      this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
      this.remoteService = new RemoteService(this.authClient);
      this.sessionService = new SessionService(this.authClient);
      this.gitService = new GitService(this.authClient);
    }
    // Load server configuration including quick start commands
    void this.loadServerConfig();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up document event listener if modal is still visible
    if (this.visible) {
      document.removeEventListener('keydown', this.handleGlobalKeyDown);
    }
    // Clean up debounce timers
    if (this.completionsDebounceTimer) {
      clearTimeout(this.completionsDebounceTimer);
    }
    if (this.gitCheckDebounceTimer) {
      clearTimeout(this.gitCheckDebounceTimer);
    }
  }

  private handleGlobalKeyDown = (e: KeyboardEvent) => {
    // Only handle events when modal is visible
    if (!this.visible) return;

    if (e.key === 'Tab') {
      // The folder picker is its own dialog on top of this one.
      if (this.showFileBrowser) return;
      const root = this.querySelector<HTMLElement>('[data-testid="session-create-modal"]');
      if (root) cycleTabWithin(root, e);
      return;
    }

    if (e.key === 'Escape') {
      // The folder picker on top closes on its own Escape; this one used to close the whole
      // form under it too.
      if (this.showFileBrowser) return;
      e.preventDefault();
      e.stopPropagation();

      // An open "+N not installed" menu closes first (QA 2026-10-12: Esc there closed the
      // whole dialog).
      const quickStarts = this.querySelector<QuickStartSection>('quick-start-section');
      if (quickStarts?.missingOpen) {
        quickStarts.closeMissing();
      } else if (this.showCompletions) {
        // If autocomplete is visible, close it first
        this.showCompletions = false;
        this.selectedCompletionIndex = -1;
      } else {
        // Otherwise close the dialog
        this.handleCancel();
      }
    } else if (e.key === 'Enter') {
      // ⌘↵ / Ctrl+↵ creates from anywhere in the form (also a textarea or an open list);
      // a plain ↵ in a single-line field does too, unless it picks an autocomplete item.
      const modified = e.metaKey || e.ctrlKey;
      if (e.isComposing) return;
      if (!modified) {
        if (e.target instanceof HTMLTextAreaElement) return;
        if (this.showCompletions && this.selectedCompletionIndex >= 0) return;
        // ↵ on a button (Cancel, a pill, Options) is that button's own click.
        if (e.target instanceof HTMLButtonElement) return;
      }

      if (this.canCreate) {
        e.preventDefault();
        e.stopPropagation();
        this.handleCreate();
      }
    }
  };

  /** Same conditions as the Create button. */
  private get canCreate(): boolean {
    return (
      !this.disabled &&
      !this.isCreating &&
      !this.isLoadingRemoteTargets &&
      !this.remoteTargetError &&
      !!this.workingDir?.trim() &&
      !!this.command?.trim() &&
      !(this.isHQMode && !this.remotes.some((remote) => remote.id === this.selectedRemoteId))
    );
  }

  private async loadFromLocalStorage(initializationId: number): Promise<boolean> {
    const formData = loadSessionFormData();

    // Get repository base path from server config to use as default working dir
    let appRepoBasePath = DEFAULT_REPOSITORY_BASE_PATH;
    if (this.serverConfigService) {
      try {
        appRepoBasePath = await this.serverConfigService.getRepositoryBasePath();
      } catch (error) {
        logger.error('Failed to get repository base path from server:', error);
        appRepoBasePath = DEFAULT_REPOSITORY_BASE_PATH;
      }
    }

    if (!this.isCurrentVisibleInitialization(initializationId)) {
      return false;
    }

    // Always set values, using saved values or defaults
    // Priority: savedWorkingDir > appRepoBasePath > default
    this.workingDir = formData.workingDir || appRepoBasePath || DEFAULT_REPOSITORY_BASE_PATH;
    // Phones start on the last agent used, else Claude (phone-spec §4.4); desktop on zsh.
    this.command = formData.command || (isPhoneScreen() ? 'claude' : 'zsh');

    // For spawn window, use saved value or default to false
    this.spawnWindow = formData.spawnWindow ?? false;

    // For title mode, use saved value or default to STATIC
    const allowedTitleModes = new Set(Object.values(TitleMode));
    this.titleMode = allowedTitleModes.has(formData.titleMode as TitleMode)
      ? (formData.titleMode as TitleMode)
      : TitleMode.STATIC;

    // Force re-render to update the input values
    this.requestUpdate();
    return true;
  }

  private saveToLocalStorage() {
    const workingDir = this.workingDir?.trim() || '';
    const command = this.command?.trim() || '';

    saveSessionFormData({
      workingDir,
      command,
      spawnWindow: this.spawnWindow,
      titleMode: this.titleMode,
    });
  }

  private async loadServerConfig() {
    if (!this.serverConfigService) {
      return;
    }

    try {
      const quickStartCommands = await this.serverConfigService.getQuickStartCommands();
      if (quickStartCommands && quickStartCommands.length > 0) {
        // Map server config to our format
        this.quickStartCommands = quickStartCommands.map((cmd: QuickStartCommand) => ({
          label: cmd.name || cmd.command,
          command: cmd.command,
        }));
        logger.debug('Loaded quick start commands from server:', this.quickStartCommands);
      }
      // External model providers (model-providers.ts): the "Claude · <label>" options.
      this.modelProviders = await this.serverConfigService.getModelProviders();
    } catch (error) {
      logger.error('Failed to load server config:', error);
      // Keep default quick start commands on error
    }
  }

  /** Pick a provider: the session runs Claude Code against it, on its default model. */
  private handleProviderSelected(provider: PublicModelProvider) {
    this.selectedProvider = provider.id;
    this.selectedProviderModel = publicDefaultModel(provider) ?? '';
    this.command = 'claude';
    this.selectedQuickStart = '';
  }

  private handleProviderModelChange(e: Event) {
    this.selectedProviderModel = (e.target as HTMLSelectElement).value;
  }

  /** "Claude · <label>" per external provider, with a model selector (model-providers.ts). */
  private renderModelProviders() {
    if (!this.modelProviders.length) return nothing;
    const active = this.modelProviders.find((p) => p.id === this.selectedProvider);
    return html`
      <div class="mb-4" id="model-providers-section">
        <label class="ut-label">${t('create.providers.label')}</label>
        <div class="cf-agents">
          ${this.modelProviders.map(
            (provider) => html`
              <button
                type="button"
                id="provider-${provider.id}"
                class="ut-surface--badge cf-agent ${this.selectedProvider === provider.id ? 'cf-agent--active' : ''}"
                ?disabled=${this.disabled || this.isCreating}
                @click=${() => this.handleProviderSelected(provider)}
              >
                ${providerSessionLabel(provider)}
              </button>
            `
          )}
        </div>
        ${
          active
            ? html`
              <select
                id="provider-model-select"
                class="ut-field h-9 mt-2"
                aria-label=${t('create.providers.model')}
                .value=${this.selectedProviderModel}
                ?disabled=${this.disabled || this.isCreating}
                @change=${this.handleProviderModelChange}
              >
                ${
                  active.models.length
                    ? active.models.map(
                        (model) => html`
                        <option value=${model.id} ?selected=${model.id === this.selectedProviderModel}>
                          ${model.label}
                        </option>
                      `
                      )
                    : html`<option value=${this.selectedProviderModel}>
                      ${this.selectedProviderModel || t('create.providers.default')}
                    </option>`
                }
              </select>
              <p class="ut-hint mt-1">${t('create.providers.hint')}</p>
            `
            : nothing
        }
      </div>
    `;
  }

  private async handleQuickStartChanged(e: CustomEvent<QuickStartCommand[]>) {
    const commands = e.detail;

    if (!this.serverConfigService) {
      logger.error('Server config service not initialized');
      return;
    }

    try {
      await this.serverConfigService.updateQuickStartCommands(commands);

      // Update local state
      this.quickStartCommands = commands.map((cmd: QuickStartCommand) => ({
        label: cmd.name || cmd.command,
        command: cmd.command,
      }));
      logger.debug('Updated quick start commands:', this.quickStartCommands);
    } catch (error) {
      logger.error('Failed to save quick start commands:', error);
    }
  }

  private async checkServerStatus(initializationId?: number): Promise<boolean> {
    // Defensive check - authClient should always be provided
    if (!this.authClient) {
      logger.warn('checkServerStatus called without authClient');
      this.macAppConnected = false;
      throw new Error('Authentication client is unavailable');
    }

    const response = await fetch('/api/server/status', {
      headers: this.authClient.getAuthHeader(),
    });
    if (!response.ok) {
      throw new Error(`Failed to load server status (${response.status})`);
    }

    const status = await response.json();
    if (!status || typeof status.isHQMode !== 'boolean') {
      throw new Error('Failed to load server status: invalid response');
    }
    if (initializationId !== undefined && !this.isCurrentVisibleInitialization(initializationId)) {
      return status.isHQMode;
    }
    this.macAppConnected = status.macAppConnected || false;
    this.isHQMode = status.isHQMode || false;
    logger.debug('server status:', status);
    return this.isHQMode;
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    // Handle authClient becoming available
    if (changedProperties.has('authClient') && this.authClient) {
      // Initialize services if they haven't been created yet
      if (!this.repositoryService && this.serverConfigService) {
        this.repositoryService = new RepositoryService(this.authClient, this.serverConfigService);
      }
      if (!this.remoteService) {
        this.remoteService = new RemoteService(this.authClient);
      }
      if (!this.sessionService) {
        this.sessionService = new SessionService(this.authClient);
      }
      if (!this.gitService) {
        this.gitService = new GitService(this.authClient);
      }
      // Update autocomplete manager's authClient
      this.autocompleteManager.setAuthClient(this.authClient);
      // Update server config service's authClient
      if (this.serverConfigService) {
        this.serverConfigService.setAuthClient(this.authClient);
      }
    }

    // Handle visibility changes
    if (changedProperties.has('visible')) {
      if (this.visible) {
        // Reset to defaults first to ensure clean state
        this.workingDir = DEFAULT_REPOSITORY_BASE_PATH;
        this.command = 'zsh';
        this.sessionName = '';
        this.spawnWindow = false;
        this.titleMode = TitleMode.STATIC;
        this.showFileBrowser = false;
        this.isLoadingRemoteTargets = true;
        this.remoteTargetError = '';

        // Load saved values, establish whether this is an HQ, then query only
        // the filesystem that actually owns the session.
        void this.initializeVisibleForm();

        // Add global keyboard listener
        document.addEventListener('keydown', this.handleGlobalKeyDown);

        this.restoreFocusTo = captureOpener(this);
        this.skipFocusRestore = false;

        this.phoneSheet = isPhoneScreen();
        // Command first: the agent pills fill it, or it is typed (design spec 5.3). On touch
        // the sheet itself takes focus instead: a focused field raises the keyboard over the
        // agent choices (phone-spec §1.6).
        const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
        void this.updateComplete.then(() =>
          requestAnimationFrame(() => {
            if (coarse) {
              this.querySelector<HTMLElement>('[data-testid="session-create-modal"]')?.focus({
                preventScroll: true,
              });
              return;
            }
            this.querySelector<HTMLInputElement>('[data-testid="command-input"]')?.focus();
          })
        );

        // Set data attributes for testing - both synchronously to avoid race conditions
        this.setAttribute('data-modal-state', 'open');
        this.setAttribute('data-modal-rendered', 'true');
      } else {
        this.visibleInitializationId += 1;
        // Remove global keyboard listener when hidden
        document.removeEventListener('keydown', this.handleGlobalKeyDown);

        // Back to the opener (create-session-button), like modal-wrapper, unless a session
        // was just created or the caller already moved focus somewhere.
        restoreFocusLater(this.skipFocusRestore ? null : this.restoreFocusTo);
        this.restoreFocusTo = null;

        // Remove data attributes synchronously
        this.removeAttribute('data-modal-state');
        this.removeAttribute('data-modal-rendered');
      }
    }
  }

  private async initializeVisibleForm() {
    const initializationId = ++this.visibleInitializationId;

    try {
      if (!(await this.loadFromLocalStorage(initializationId))) {
        return;
      }
      const isHQMode = await this.refreshRemoteTargets(initializationId);
      if (!this.visible || initializationId !== this.visibleInitializationId) {
        return;
      }

      if (this.remoteTargetError) {
        this.clearLocalRepositoryContext();
        return;
      }

      if (isHQMode) {
        // Router paths and saved paths may not exist on the selected machine.
        this.workingDir = REMOTE_DEFAULT_WORKING_DIRECTORY;
        this.clearLocalRepositoryContext();
        return;
      }

      // This server's own programs: never asked on an HQ, whose sessions run elsewhere.
      void this.loadQuickStartAvailability();
      await Promise.all([this.checkGitRepository(), this.discoverRepositories()]);
    } catch (error) {
      logger.error('Failed to initialize session form:', error);
    }
  }

  private async loadQuickStartAvailability() {
    if (!this.authClient) return;
    this.quickStartAvailability = await fetchQuickStartAvailability(
      this.authClient.getAuthHeader()
    );
  }

  private clearLocalRepositoryContext() {
    this.repositories = [];
    this.showRepositoryDropdown = false;
    this.showCompletions = false;
    this.gitCheckId++;
    this.gitCheckedPath = '';
    this.isCheckingGit = false;
    this.gitRepoInfo = null;
    this.availableBranches = [];
    this.currentBranch = '';
    this.selectedBaseBranch = '';
    this.availableWorktrees = [];
    this.selectedWorktree = undefined;
    this.followMode = false;
    this.followBranch = null;
    this.showFollowMode = false;
  }

  private isCurrentVisibleInitialization(initializationId: number): boolean {
    return this.visible && initializationId === this.visibleInitializationId;
  }

  private handleWorkingDirChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.workingDir = input.value;

    // HQ paths belong to the selected machine. The filesystem helpers below
    // run on the HTTP server, so using them in HQ mode would inspect the router.
    if (this.isHQMode) {
      return;
    }

    // Hide repository dropdown when typing
    this.showRepositoryDropdown = false;

    // Trigger autocomplete with debounce
    if (this.completionsDebounceTimer) {
      clearTimeout(this.completionsDebounceTimer);
    }

    this.completionsDebounceTimer = setTimeout(() => {
      this.fetchCompletions();
    }, 300);

    // Check if directory is a Git repository with debounce
    if (this.gitCheckDebounceTimer) {
      clearTimeout(this.gitCheckDebounceTimer);
    }

    this.gitCheckDebounceTimer = setTimeout(() => {
      this.checkGitRepository();
    }, 500);
  }

  private handleCommandChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.command = input.value;
    // Typing a command by hand drops the external provider (model-providers.ts).
    this.selectedProvider = null;
  }

  private handleSessionNameChange(e: CustomEvent<{ name: string }>) {
    this.sessionName = e.detail.name;
  }

  private handleSpawnWindowChanged(e: CustomEvent) {
    this.spawnWindow = e.detail.enabled;
  }

  private handleTitleModeChanged(e: CustomEvent) {
    this.titleMode = e.detail.mode as TitleMode;
  }

  private handleFollowModeChanged(e: CustomEvent) {
    this.showFollowMode = e.detail.enabled;
  }

  private handleBrowse() {
    if (this.isHQMode) {
      return;
    }
    logger.debug('handleBrowse called, setting showFileBrowser to true');
    this.showFileBrowser = true;
    this.requestUpdate();
  }

  private handleDirectorySelected(e: CustomEvent) {
    this.workingDir = formatPathForDisplay(e.detail);
    this.showFileBrowser = false;
    // Check Git repository after directory selection
    this.checkGitRepository();
  }

  private handleBrowserCancel() {
    this.showFileBrowser = false;
  }

  private async handleCreate() {
    if (!this.workingDir?.trim() || !this.command?.trim()) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('create.error.missingFields'),
        })
      );
      return;
    }

    // HQ mode never spawns locally: without a registered machine there's nowhere
    // for the session to land. Block before the request (the server also 400s).
    if (this.isLoadingRemoteTargets) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('create.error.machinesLoading'),
        })
      );
      return;
    }

    if (this.remoteTargetError) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: this.remoteTargetError,
        })
      );
      return;
    }

    if (this.isHQMode && !this.remotes.some((remote) => remote.id === this.selectedRemoteId)) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('create.error.noMachines'),
        })
      );
      return;
    }

    this.isCreating = true;

    // Determine if we're actually spawning a terminal window
    // HQ does not know whether the selected machine can open a native window.
    // A provider session is always a shielded web session (its env never reaches a terminal spawn).
    const effectiveSpawnTerminal =
      !this.selectedProvider && !this.isHQMode && this.spawnWindow && this.macAppConnected;

    // Determine the working directory and branch
    let effectiveWorkingDir = this.workingDir?.trim() || '';
    let effectiveBranch = '';
    // The branch and worktree on screen belong to the folder they were read for. With another
    // folder typed and its check still pending (⌘↵ inside the debounce), the session opens in
    // that folder as it is, never on the previous repository's branch.
    const gitStateIsCurrent = this.gitCheckedPath === effectiveWorkingDir;

    if (!gitStateIsCurrent) {
      // Nothing to add: the folder alone decides.
    } else if (this.selectedWorktree && this.availableWorktrees.length > 0) {
      // Using a worktree - use its path and branch
      const selectedWorktreeInfo = this.availableWorktrees.find(
        (wt) => wt.branch === this.selectedWorktree
      );
      if (selectedWorktreeInfo?.path) {
        effectiveWorkingDir = formatPathForDisplay(selectedWorktreeInfo.path);
        effectiveBranch = this.selectedWorktree;
        logger.log(
          `Using worktree path: ${effectiveWorkingDir} for branch: ${this.selectedWorktree}`
        );
      }
    } else {
      // Its branch: another than the checked-out one runs in that branch's own worktree (the
      // server makes it when there is none and answers with the folder it used).
      effectiveBranch = this.selectedBaseBranch || this.currentBranch;
    }

    const sessionData: SessionCreateData = {
      command: parseCommand(this.command?.trim() || ''),
      workingDir: effectiveWorkingDir,
      spawn_terminal: effectiveSpawnTerminal,
      titleMode: this.titleMode,
    };

    // A session against an external model provider (model-providers.ts): the server runs Claude
    // Code against it with the provider's key; the key never reaches the client. Always sent
    // once a provider is picked (even with an empty model: the server uses the provider's
    // default, or refuses) so a provider session never falls back to the normal Anthropic
    // account silently.
    if (this.selectedProvider) {
      sessionData.modelProvider = {
        id: this.selectedProvider,
        model: this.selectedProviderModel,
      };
    }

    // Add Git information if available
    if (this.gitRepoInfo?.isGitRepo && this.gitRepoInfo.repoPath && effectiveBranch) {
      sessionData.gitBranch = effectiveBranch;
    }

    // Only add dimensions for web sessions (not external terminal spawns)
    if (!effectiveSpawnTerminal) {
      // Use conservative defaults that work well across devices
      // The terminal will auto-resize to fit the actual container after creation
      sessionData.cols = 120;
      sessionData.rows = 30;
    }

    // Add session name if provided
    if (this.sessionName?.trim()) {
      sessionData.name = this.sessionName.trim();
    }

    // Target a registered machine when one is selected (HQ mode). The HQ never
    // spawns locally — the server enforces this with a 400 — so a session must
    // carry a remoteId there. Outside HQ mode there are no remotes and this is
    // omitted, preserving local-spawn behavior.
    if (this.selectedRemoteId) {
      sessionData.remoteId = this.selectedRemoteId;
    }

    // Handle follow mode - only enable when a worktree is selected
    if (
      this.showFollowMode &&
      this.selectedWorktree &&
      this.selectedWorktree !== 'none' &&
      this.gitRepoInfo?.repoPath &&
      effectiveBranch &&
      this.authClient
    ) {
      try {
        // Check if follow mode is already active for a different branch
        if (this.followMode && this.followBranch && this.followBranch !== effectiveBranch) {
          logger.log(
            `Follow mode is already active for branch: ${this.followBranch}, switching to: ${effectiveBranch}`
          );
        }

        logger.log(`Enabling follow mode for worktree branch: ${effectiveBranch}`);
        const success = await enableFollowMode(
          this.gitRepoInfo.repoPath,
          effectiveBranch,
          this.authClient
        );

        if (!success) {
          // Show error to user
          this.dispatchEvent(
            new CustomEvent('error', {
              detail: t('create.error.followModeFailed'),
              bubbles: true,
              composed: true,
            })
          );
        } else {
          logger.log('Follow mode enabled successfully for worktree');
          // Update local state
          this.followMode = true;
          this.followBranch = effectiveBranch;
        }
      } catch (error) {
        logger.error('Error enabling follow mode:', error);
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: t('create.error.followModeError'),
            bubbles: true,
            composed: true,
          })
        );
      }
    }

    try {
      // Check if sessionService is initialized
      if (!this.sessionService) {
        throw new Error('Session service not initialized');
      }
      const result = await this.sessionService.createSession(sessionData);

      // Save to localStorage before clearing the fields
      // In test environments, don't save spawn window to avoid cross-test contamination
      const isTestEnvironment =
        window.location.search.includes('test=true') ||
        navigator.userAgent.includes('HeadlessChrome');

      if (isTestEnvironment) {
        // Save everything except spawn window in tests
        const currentSpawnWindow = getSessionFormValue('SPAWN_WINDOW');
        this.saveToLocalStorage();
        // Restore the original spawn window value
        if (currentSpawnWindow !== null) {
          setSessionFormValue('SPAWN_WINDOW', currentSpawnWindow);
        } else {
          removeSessionFormValue('SPAWN_WINDOW');
        }
      } else {
        this.saveToLocalStorage();
      }

      // Another branch than the checked-out one runs in its own worktree: say which folder.
      if (
        result.workingDir &&
        effectiveBranch &&
        effectiveBranch !== this.currentBranch &&
        !this.selectedWorktree &&
        formatPathForDisplay(result.workingDir) !== formatPathForDisplay(effectiveWorkingDir)
      ) {
        toast({
          kind: 'info',
          text: t('create.startedOnBranch', {
            branch: effectiveBranch,
            folder: formatPathForDisplay(result.workingDir),
          }),
        });
      }

      this.command = ''; // Clear command on success
      this.skipFocusRestore = true;
      this.sessionName = ''; // Clear session name on success
      this.dispatchEvent(
        new CustomEvent('session-created', {
          detail: result,
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('create.error.createFailed');
      logger.error('Error creating session:', error);
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: errorMessage,
        })
      );
    } finally {
      this.isCreating = false;
    }
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent('cancel'));
  }

  private handleQuickStartSelected(e: CustomEvent) {
    const command = e.detail.command;
    this.command = command;
    this.selectedQuickStart = command;
    // A normal quick start leaves the external providers (model-providers.ts).
    this.selectedProvider = null;
  }

  private handleBranchChanged(e: CustomEvent) {
    this.selectedBaseBranch = e.detail.branch;
  }

  private handleWorktreeChanged(e: CustomEvent) {
    this.selectedWorktree = e.detail.worktree;

    // Reset follow mode toggle when no worktree is selected
    if (!this.selectedWorktree || this.selectedWorktree === 'none') {
      this.showFollowMode = false;
    }
  }

  private async handleCreateWorktreeRequest(e: CustomEvent) {
    const { branchName, baseBranch, customPath, done } = e.detail as {
      branchName: string;
      baseBranch: string;
      customPath: string | null;
      done: (created: boolean) => void;
    };
    if (!this.gitRepoInfo?.repoPath || !this.gitService) {
      done(false);
      return;
    }

    try {
      // Use custom path if provided, otherwise generate default
      const worktreePath =
        customPath || generateWorktreePath(this.gitRepoInfo.repoPath, branchName);

      // Create the worktree
      await this.gitService.createWorktree(
        this.gitRepoInfo.repoPath,
        branchName,
        worktreePath,
        baseBranch
      );

      // Update working directory to the new worktree
      this.workingDir = worktreePath;
      this.gitCheckedPath = worktreePath;

      // Update selected base branch to the new branch
      this.selectedBaseBranch = branchName;

      // Add new branch to available branches
      if (!this.availableBranches.includes(branchName)) {
        this.availableBranches = [...this.availableBranches, branchName];
      }

      // Reload worktrees
      await this.loadWorktrees(this.gitRepoInfo.repoPath, worktreePath);

      // Select the newly created worktree
      this.selectedWorktree = branchName;

      done(true);

      // Show success message
      this.dispatchEvent(
        new CustomEvent('success', {
          detail: t('create.worktreeCreated', { branch: branchName }),
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      logger.error('Failed to create worktree:', error);

      done(false);

      // Determine specific error message
      let errorMessage = t('create.error.worktreeFailed');
      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          errorMessage = t('create.error.worktreeExists');
        } else if (error.message.includes('already checked out')) {
          errorMessage = t('create.error.branchCheckedOut', { branch: branchName });
        } else if (error.message.includes('Permission denied')) {
          errorMessage = t('create.error.permissionDenied');
        } else {
          errorMessage = error.message;
        }
      }

      this.dispatchEvent(
        new CustomEvent('error', {
          detail: errorMessage,
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private handleAutocompleteItemSelected(e: CustomEvent) {
    this.handleSelectCompletion(e.detail.suggestion);
  }

  private handleRepositorySelected(e: CustomEvent) {
    this.handleSelectRepository(e.detail.path);
  }

  private async discoverRepositories() {
    if (this.isHQMode) {
      this.repositories = [];
      return;
    }

    this.isDiscovering = true;
    try {
      // Only proceed if repositoryService is initialized
      if (this.repositoryService) {
        this.repositories = await this.repositoryService.discoverRepositories();
        // Update autocomplete manager with discovered repositories
        this.autocompleteManager.setRepositories(this.repositories);
      } else {
        logger.warn('Repository service not initialized yet');
        this.repositories = [];
      }
    } finally {
      this.isDiscovering = false;
    }
  }

  private async refreshRemoteTargets(initializationId: number): Promise<boolean> {
    this.isLoadingRemoteTargets = true;
    this.remoteTargetError = '';
    let detectedHQMode = this.isHQMode;

    try {
      detectedHQMode = await this.checkServerStatus(initializationId);
      if (!this.isCurrentVisibleInitialization(initializationId)) {
        return detectedHQMode;
      }
      if (!detectedHQMode) {
        this.remotes = [];
        this.selectedRemoteId = '';
        return false;
      }

      if (!this.remoteService) {
        throw new Error('Machine service is unavailable');
      }

      const remotes = await this.remoteService.listRemotes();
      if (!this.isCurrentVisibleInitialization(initializationId)) {
        return true;
      }
      this.remotes = remotes;
      // Preselect the first machine so a single-machine HQ needs no interaction,
      // and the picker always has a valid target. Keep a still-valid selection.
      if (!this.remotes.some((r) => r.id === this.selectedRemoteId)) {
        this.selectedRemoteId = this.remotes[0]?.id ?? '';
      }
      return true;
    } catch (error) {
      if (!this.isCurrentVisibleInitialization(initializationId)) {
        return detectedHQMode;
      }
      logger.error('Failed to load session targets:', error);
      this.remotes = [];
      this.selectedRemoteId = '';
      this.remoteTargetError = t('create.error.machinesLoadFailed');
      return detectedHQMode;
    } finally {
      if (this.isCurrentVisibleInitialization(initializationId)) {
        this.isLoadingRemoteTargets = false;
      }
    }
  }

  private handleRemoteChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedRemoteId = select.value;
  }

  private handleToggleAutocomplete() {
    if (this.isHQMode) {
      return;
    }

    // If we have text input, toggle the autocomplete
    if (this.workingDir?.trim()) {
      if (this.showCompletions) {
        this.showCompletions = false;
        this.completions = [];
      } else {
        this.fetchCompletions();
      }
    } else {
      // If no text, show repository dropdown instead
      this.showRepositoryDropdown = !this.showRepositoryDropdown;
    }
  }

  private handleSelectRepository(repoPath: string) {
    this.workingDir = formatPathForDisplay(repoPath);
    this.showRepositoryDropdown = false;
    // Check Git repository after selection
    this.checkGitRepository();
  }

  private async fetchCompletions() {
    if (this.isHQMode) {
      this.completions = [];
      this.showCompletions = false;
      return;
    }

    const path = this.workingDir?.trim();
    if (!path || path === '') {
      this.completions = [];
      this.showCompletions = false;
      return;
    }

    try {
      // Use the autocomplete manager to fetch completions
      this.completions = await this.autocompleteManager.fetchCompletions(path);
      this.showCompletions = this.completions.length > 0;
      // Auto-select the first item when completions are shown
      this.selectedCompletionIndex = this.completions.length > 0 ? 0 : -1;
    } catch (error) {
      logger.error('Error fetching completions:', error);
      this.completions = [];
      this.showCompletions = false;
    }
  }

  private handleSelectCompletion(suggestion: string) {
    this.workingDir = formatPathForDisplay(suggestion);
    this.showCompletions = false;
    this.completions = [];
    this.selectedCompletionIndex = -1;
    // Check Git repository after autocomplete selection
    this.checkGitRepository();
  }

  private handleWorkingDirKeydown(e: KeyboardEvent) {
    if (!this.showCompletions || this.completions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedCompletionIndex = Math.min(
        this.selectedCompletionIndex + 1,
        this.completions.length - 1
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedCompletionIndex = Math.max(this.selectedCompletionIndex - 1, -1);
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      // Allow Enter/Tab to select the auto-selected first item or any selected item
      if (this.selectedCompletionIndex >= 0 && this.completions[this.selectedCompletionIndex]) {
        e.preventDefault();
        e.stopPropagation();
        this.handleSelectCompletion(this.completions[this.selectedCompletionIndex].suggestion);
      }
    }
  }

  private handleWorkingDirBlur() {
    // Hide completions after a delay to allow clicking on them
    setTimeout(() => {
      this.showCompletions = false;
      this.selectedCompletionIndex = -1;
    }, 200);
  }

  private async checkGitRepository() {
    if (this.isHQMode) {
      this.clearLocalRepositoryContext();
      return;
    }

    const path = this.workingDir?.trim();
    const checkId = ++this.gitCheckId;
    logger.log(`🔍 Checking Git repository for path: ${path}`);

    if (!path || !this.gitService) {
      logger.debug('No path or gitService, clearing Git info');
      this.clearGitState();
      this.isCheckingGit = false;
      return;
    }

    this.isCheckingGit = true;
    try {
      const repoInfo = await this.gitService.checkGitRepo(path);
      // Another folder was typed meanwhile: its own check answers for it.
      if (checkId !== this.gitCheckId) return;
      logger.log(`✅ Git check result:`, repoInfo);

      if (repoInfo.isGitRepo && repoInfo.repoPath) {
        logger.log(`🎉 Git repository detected at: ${repoInfo.repoPath}`);
        // Another repository than the one the branch and worktree were chosen in: they do not
        // carry over (2026-11-10: going from a repo on main to one on develop sent
        // gitBranch "main", and the session opened in a worktree of main instead of the folder).
        if (this.gitRepoInfo?.repoPath !== repoInfo.repoPath) {
          this.currentBranch = '';
          this.selectedBaseBranch = '';
          this.availableWorktrees = [];
          this.selectedWorktree = undefined;
        }
        this.gitRepoInfo = repoInfo;
        this.gitCheckedPath = path;

        // Load branches, worktrees, and follow mode status in parallel
        await Promise.all([
          this.loadBranches(repoInfo.repoPath),
          this.loadWorktrees(repoInfo.repoPath),
          this.checkFollowMode(repoInfo.repoPath),
        ]);
      } else {
        logger.log(`❌ Not a Git repository: ${path}`, repoInfo);
        this.clearGitState();
        this.gitCheckedPath = path;
      }
    } catch (error) {
      if (checkId !== this.gitCheckId) return;
      logger.error('❌ Error checking Git repository:', error);
      this.clearGitState();
    } finally {
      if (checkId === this.gitCheckId) this.isCheckingGit = false;
    }
  }

  /** No repository in the folder (or none known yet): nothing of Git stays on screen. */
  private clearGitState() {
    this.gitCheckedPath = '';
    this.gitRepoInfo = null;
    this.availableBranches = [];
    this.currentBranch = '';
    this.selectedBaseBranch = '';
    this.availableWorktrees = [];
    this.selectedWorktree = undefined;
    this.followMode = false;
    this.followBranch = null;
  }

  private async loadBranches(repoPath: string): Promise<void> {
    if (!this.authClient) {
      return;
    }

    this.isLoadingBranches = true;
    try {
      const { branches, currentBranch } = await loadBranches(repoPath, this.authClient);
      if (this.gitRepoInfo?.repoPath !== repoPath) return;
      this.availableBranches = branches;

      if (currentBranch) {
        this.currentBranch = currentBranch;
        if (!this.selectedBaseBranch) {
          this.selectedBaseBranch = this.currentBranch;
        }
      }
    } finally {
      this.isLoadingBranches = false;
    }
  }

  /**
   * `currentPath` is the working tree the folder is in: the repository path the check gave
   * (absolute, like the paths of the list; the folder typed can be "~/…" or a subfolder).
   */
  private async loadWorktrees(repoPath: string, currentPath = repoPath): Promise<void> {
    if (!this.gitService) {
      return;
    }

    this.isLoadingWorktrees = true;
    try {
      const response = await this.gitService.listWorktrees(repoPath);
      if (this.gitRepoInfo?.repoPath !== repoPath) return;
      this.availableWorktrees = response.worktrees.map((wt) => ({
        // Strip refs/heads/ prefix for display
        branch: wt.branch.replace(/^refs\/heads\//, ''),
        path: wt.path,
        isMainWorktree: wt.isMainWorktree,
        isCurrentWorktree: wt.path === currentPath,
      }));

      // Update current branch based on worktree info
      const currentWorktree = response.worktrees.find((wt) => wt.path === currentPath);
      if (currentWorktree) {
        // Strip refs/heads/ prefix from branch name
        this.currentBranch = currentWorktree.branch.replace(/^refs\/heads\//, '');
        if (!this.selectedBaseBranch) {
          this.selectedBaseBranch = this.currentBranch;
        }

        // Pre-select the current worktree if we're already in one (not the main worktree)
        if (!currentWorktree.isMainWorktree && !this.selectedWorktree) {
          this.selectedWorktree = currentWorktree.branch.replace(/^refs\/heads\//, '');
        }
      }
    } catch (error) {
      logger.error('Failed to load worktrees:', error);
      this.availableWorktrees = [];
    } finally {
      this.isLoadingWorktrees = false;
    }
  }

  private async checkFollowMode(repoPath: string): Promise<void> {
    if (!this.authClient) {
      return;
    }

    this.isCheckingFollowMode = true;
    try {
      const { followMode: mode, followBranch: branch } = await checkFollowMode(
        repoPath,
        this.authClient
      );
      this.followMode = mode;
      this.followBranch = branch;
      logger.log('Follow mode status:', {
        followMode: this.followMode,
        followBranch: this.followBranch,
      });
    } finally {
      this.isCheckingFollowMode = false;
    }
  }

  private renderMachineSelector() {
    if (this.isLoadingRemoteTargets) {
      return html`
        <div class="mb-4 space-y-2" data-testid="machines-loading" aria-busy="true">
          <span class="sr-only">${t('create.loadingMachines')}</span>
          <div class="ut-skeleton h-8"></div>
          <div class="ut-skeleton h-8 w-2/3"></div>
        </div>
      `;
    }

    if (this.remoteTargetError) {
      return html`
        <div class="cf-callout cf-callout--error mb-4 ut-surface--panel ut-surface--material" data-testid="machine-load-error">
          ${icon('alert')}
          <p class="flex-1 m-0">${this.remoteTargetError}</p>
          <button
            type="button"
            class="ut-btn ut-btn--ghost ut-btn--sm"
            @click=${() => void this.initializeVisibleForm()}
          >
            ${t('create.retry')}
          </button>
        </div>
      `;
    }

    // HQ with no machines: nowhere to spawn. Warn the user (Create is also
    // disabled). The server enforces the same invariant with a 400.
    if (this.isHQMode && this.remotes.length === 0) {
      return html`
        <div class="cf-callout cf-callout--warning mb-4 ut-surface--panel ut-surface--material" data-testid="no-machines-warning">
          ${icon('alert')}
          <p class="flex-1 m-0">${t('create.noMachinesWarning')}</p>
        </div>
      `;
    }

    // No remotes and not HQ → a plain single-server deploy; no picker needed.
    if (this.remotes.length === 0) {
      return nothing;
    }

    return html`
      <div class="mb-4">
        <label for="session-machine-select" class="ut-label">${t('create.machine')}</label>
        <select
          id="session-machine-select"
          class="ut-field ut-select"
          .value=${this.selectedRemoteId}
          @change=${this.handleRemoteChange}
          ?disabled=${this.disabled || this.isCreating}
          data-testid="machine-select"
        >
          ${this.remotes.map(
            (remote) =>
              html`<option value=${remote.id} ?selected=${remote.id === this.selectedRemoteId}>${remote.name}</option>`
          )}
        </select>
      </div>
    `;
  }

  /** The header chip: where the session will start, and its branch when it is a repo. */
  private renderCwdChip() {
    const dir = this.workingDir?.trim();
    if (!dir || this.isLoadingRemoteTargets) return nothing;
    const branch = this.gitRepoInfo?.isGitRepo ? this.currentBranch : '';
    return html`<span class="ut-chip ut-chip--mono cf-cwd" title=${dir} dir="ltr" data-testid="create-cwd-chip">
      ${icon(branch ? 'gitBranch' : 'folder')}
      <span class="truncate">${formatPathForDisplay(dir)}${branch ? html` · ${branch}` : nothing}</span>
    </span>`;
  }

  render() {
    if (!this.visible) {
      return html``;
    }
    const busy = this.disabled || this.isCreating;
    const completionsOpen = this.showRepositoryDropdown || this.showCompletions;
    const phone = this.phoneSheet;
    // The frame is modal-wrapper (phone-spec task 12): a centred dialog, or on a phone a bottom
    // sheet with a grabber and swipe-down to close. The form keeps its own focus handling
    // (its folder picker opens on top) and Escape (it closes menus first).
    return html`
      <modal-wrapper
        .visible=${true}
        .manageFocus=${false}
        .closeOnEscape=${false}
        placement="sheet"
        contentClass="ut-dialog ut-dialog--md cf-dialog ${phone ? 'cf-dialog--sheet' : ''}"
        .ariaLabel=${t('actionBar.newSession')}
        @close=${this.handleCancel}
      >
        <div
          aria-labelledby="modal-title"
          tabindex="-1"
          style="pointer-events: auto;"
          data-testid="session-create-modal"
        >
          ${
            phone
              ? html`<div class="p-sheet-header cf-sheet-header" data-sheet-handle>
                  <button
                    type="button"
                    class="p-sheet-text-btn p-sheet-text-btn--start ut-text-action"
                    id="session-cancel-button"
                    @click=${this.handleCancel}
                    ?disabled=${this.isCreating}
                  >
                    ${t('common.cancel')}
                  </button>
                  <h2 id="modal-title" class="p-sheet-title">${t('actionBar.newSession')}</h2>
                  <span></span>
                </div>`
              : nothing
          }
          ${
            phone
              ? nothing
              : html`
          <div class="ut-dialog-header">
            <div class="flex items-center gap-2.5 min-w-0">
              <h2 id="modal-title" class="m-0 text-title font-semibold text-text-bright whitespace-nowrap">
                ${t('actionBar.newSession')}
              </h2>
              ${this.renderCwdChip()}
            </div>
            <button
              type="button"
              class="ut-icon-btn"
              @click=${this.handleCancel}
              title=${`${t('common.close')} (⎋)`}
              aria-label=${t('common.close')}
              data-modal-close
            >
              ${icon('x')}
            </button>
          </div>`
          }

          <div class="ut-dialog-body cf-body" data-sheet-scroll>
            ${this.renderMachineSelector()}

            <quick-start-section
              .commands=${this.quickStartCommands}
              .availability=${this.quickStartAvailability}
              .selectedCommand=${this.command}
              .disabled=${this.disabled}
              .isCreating=${this.isCreating}
              @quick-start-selected=${this.handleQuickStartSelected}
              @quick-start-changed=${this.handleQuickStartChanged}
            ></quick-start-section>

            ${this.renderModelProviders()}

            <div class="mb-4">
              <label class="ut-label" for="session-command-input">${t('create.command')}</label>
              <input
                id="session-command-input"
                type="text"
                class="ut-field ut-field--mono h-9"
                .value=${this.command}
                @input=${this.handleCommandChange}
                placeholder="zsh"
                dir="ltr"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                enterkeyhint="go"
                spellcheck="false"
                ?autofocus=${!phone}
                ?disabled=${busy}
                data-testid="command-input"
              />
            </div>

            ${
              this.isLoadingRemoteTargets
                ? nothing
                : html`
                  <div>
                    <label class="ut-label" for="session-working-dir-input">
                      ${this.isHQMode ? t('create.workingDirOnMachine').replace(/:\s*$/, '') : t('create.workingDir')}
                    </label>
                    <div class="relative">
                      <div class="cf-path">
                        <input
                          id="session-working-dir-input"
                          type="text"
                          class="ut-field ut-field--mono ${this.isHQMode ? '' : 'cf-path-input'}"
                          .value=${this.workingDir}
                          @input=${this.handleWorkingDirChange}
                          @keydown=${this.handleWorkingDirKeydown}
                          @blur=${this.handleWorkingDirBlur}
                          placeholder="~/"
                          dir="ltr"
                          ?disabled=${busy}
                          data-testid="working-dir-input"
                          autocomplete="off"
                          autocapitalize="off"
                          autocorrect="off"
                          enterkeyhint="go"
                          spellcheck="false"
                          role="combobox"
                          aria-expanded=${completionsOpen ? 'true' : 'false'}
                        />
                        ${
                          this.isHQMode
                            ? nothing
                            : html`<div class="cf-path-actions">
                              <button
                                id="session-autocomplete-button"
                                type="button"
                                class="ut-icon-btn ut-icon-btn--sm ${completionsOpen ? 'is-active' : ''}"
                                @click=${this.handleToggleAutocomplete}
                                ?disabled=${busy}
                                title=${t('create.chooseDirectory')}
                                aria-label=${t('create.chooseDirectory')}
                              >
                                ${icon('chevronDown', 14)}
                              </button>
                              <button
                                id="session-browse-button"
                                type="button"
                                class="ut-icon-btn ut-icon-btn--sm"
                                @click=${this.handleBrowse}
                                ?disabled=${busy}
                                title=${t('create.browseDirectories')}
                                aria-label=${t('create.browseDirectories')}
                              >
                                ${icon('folderOpen', 14)}
                              </button>
                            </div>`
                        }
                      </div>
                      ${
                        this.isHQMode
                          ? nothing
                          : html`
                            <directory-autocomplete
                              .visible=${this.showCompletions}
                              .items=${this.completions}
                              .selectedIndex=${this.selectedCompletionIndex}
                              @item-selected=${this.handleAutocompleteItemSelected}
                            ></directory-autocomplete>
                            <repository-dropdown
                              .visible=${this.showRepositoryDropdown}
                              .repositories=${this.repositories}
                              @repository-selected=${this.handleRepositorySelected}
                            ></repository-dropdown>
                          `
                      }
                    </div>
                  </div>

                  ${
                    this.isHQMode
                      ? nothing
                      : html`<git-branch-selector
                        .gitRepoInfo=${this.gitRepoInfo}
                        .disabled=${this.disabled}
                        .isCreating=${this.isCreating}
                        .currentBranch=${this.currentBranch}
                        .selectedBaseBranch=${this.selectedBaseBranch}
                        .selectedWorktree=${this.selectedWorktree}
                        .availableBranches=${this.availableBranches}
                        .availableWorktrees=${this.availableWorktrees}
                        .isLoadingBranches=${this.isLoadingBranches}
                        .isLoadingWorktrees=${this.isLoadingWorktrees}
                        .followMode=${this.followMode}
                        .followBranch=${this.followBranch}
                        .showFollowMode=${this.showFollowMode}
                        @branch-changed=${this.handleBranchChanged}
                        @worktree-changed=${this.handleWorktreeChanged}
                        @create-worktree=${this.handleCreateWorktreeRequest}
                      ></git-branch-selector>`
                  }
                `
            }

            <form-options-section
              .sessionName=${this.sessionName}
              .macAppConnected=${this.macAppConnected && !this.isHQMode}
              .spawnWindow=${this.spawnWindow}
              .titleMode=${this.titleMode}
              .gitRepoInfo=${this.gitRepoInfo}
              .followMode=${this.followMode}
              .followBranch=${this.followBranch}
              .showFollowMode=${this.showFollowMode}
              .selectedWorktree=${this.selectedWorktree}
              .disabled=${this.disabled}
              .isCreating=${this.isCreating}
              @session-name-changed=${this.handleSessionNameChange}
              @spawn-window-changed=${this.handleSpawnWindowChanged}
              @title-mode-changed=${this.handleTitleModeChanged}
              @follow-mode-changed=${this.handleFollowModeChanged}
            ></form-options-section>
          </div>

          <!-- Pinned under the scrolling body: on an iPhone SE "Create" sat below it, out of
               sight until the form was scrolled (2026-10-03). Phone-sized taps. -->
          ${
            phone
              ? html`<div class="cf-footer cf-footer--sheet" data-testid="create-session-actions">
                  <button
                    id="session-create-button"
                    type="button"
                    class="ut-btn ut-btn--primary cf-create-sheet"
                    @click=${this.handleCreate}
                    ?disabled=${!this.canCreate}
                    data-testid="create-session-submit"
                  >
                    ${this.isCreating ? t('create.creating') : t('create.create')}
                  </button>
                </div>`
              : nothing
          }
          ${
            phone
              ? nothing
              : html`
          <div class="ut-dialog-footer cf-footer sticky bottom-0 z-10" data-testid="create-session-actions">
            <span class="cf-hint">
              <kbd class="ut-kbd">${formatShortcut('mod+enter')}</kbd>
              ${t('create.submitHint')}
            </span>
            <button
              id="session-cancel-button"
              type="button"
              class="ut-btn ut-btn--ghost h-9 min-h-[44px] sm:min-h-0"
              @click=${this.handleCancel}
              ?disabled=${this.isCreating}
            >
              ${t('common.cancel')}
            </button>
            <button
              id="session-create-button"
              type="button"
              class="ut-btn ut-btn--primary h-9 min-w-[112px] justify-center min-h-[44px] sm:min-h-0"
              @click=${this.handleCreate}
              ?disabled=${!this.canCreate}
              data-testid="create-session-submit"
            >
              ${this.isCreating ? t('create.creating') : t('create.create')}
            </button>
          </div>`
          }
        </div>
      </modal-wrapper>

      <file-browser
        .visible=${!this.isLoadingRemoteTargets && !this.isHQMode && this.showFileBrowser}
        .mode=${'select'}
        .session=${{ workingDir: this.workingDir } as Session}
        @directory-selected=${this.handleDirectorySelected}
        @browser-cancel=${this.handleBrowserCancel}
      ></file-browser>
    `;
  }
}
