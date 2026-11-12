/**
 * Git Branch and Worktree Selector Component
 *
 * Handles branch selection, worktree management, and follow mode
 * for Git repositories in the session creation form.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { GitRepoInfo } from '../../services/git-service.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('git-branch-selector');

export interface WorktreeInfo {
  branch: string;
  path: string;
  isMainWorktree?: boolean;
  isCurrentWorktree?: boolean;
}

@customElement('git-branch-selector')
export class GitBranchSelector extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) gitRepoInfo: GitRepoInfo | null = null;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) isCreating = false;
  @property({ type: String }) currentBranch = '';
  @property({ type: String }) selectedBaseBranch = '';
  @property({ type: String }) selectedWorktree?: string;
  @property({ type: Array }) availableBranches: string[] = [];
  @property({ type: Array }) availableWorktrees: WorktreeInfo[] = [];
  @property({ type: Boolean }) isLoadingBranches = false;
  @property({ type: Boolean }) isLoadingWorktrees = false;
  @property({ type: Boolean }) followMode = false;
  @property({ type: String }) followBranch: string | null = null;
  @property({ type: Boolean }) showFollowMode = false;

  @state() private showCreateWorktree = false;
  @state() private newBranchName = '';
  @state() private isCreatingWorktree = false;
  @state() private customPath = '';
  @state() private useCustomPath = false;

  private handleBaseBranchChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedBaseBranch = select.value;
    this.dispatchEvent(
      new CustomEvent('branch-changed', {
        detail: { branch: select.value },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleWorktreeChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.selectedWorktree = select.value === 'none' ? undefined : select.value;
    this.dispatchEvent(
      new CustomEvent('worktree-changed', {
        detail: { worktree: this.selectedWorktree },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async handleCreateWorktree() {
    const branchName = this.newBranchName.trim();

    if (!branchName) {
      return;
    }

    // Validate branch name
    const validationError = this.validateBranchName(branchName);
    if (validationError) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: validationError,
          bubbles: true,
          composed: true,
        })
      );
      return;
    }

    this.isCreatingWorktree = true;
    this.dispatchEvent(
      new CustomEvent('create-worktree', {
        detail: {
          branchName: branchName,
          baseBranch: this.selectedBaseBranch || 'main',
          customPath: this.useCustomPath ? this.customPath.trim() : null,
          // Whoever creates it says how it went (2026-11-10: nothing ever did, and the panel
          // stayed on "Creating…" with every control disabled, created or not).
          done: (created: boolean) => {
            this.isCreatingWorktree = false;
            if (created) this.handleCancelCreateWorktree();
          },
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private validateBranchName(name: string): string | null {
    // Check if branch already exists
    if (this.availableBranches.includes(name)) {
      return t('worktrees.branch.exists', { branch: name });
    }

    // Git branch name validation rules
    if (name.startsWith('-') || name.endsWith('-')) {
      return t('worktrees.branch.hyphen');
    }

    if (name.includes('..') || name.includes('~') || name.includes('^') || name.includes(':')) {
      return t('worktrees.branch.invalidChars');
    }

    if (name.endsWith('.lock')) {
      return t('worktrees.branch.lock');
    }

    if (name.includes('//') || name.includes('\\')) {
      return t('worktrees.branch.slashes');
    }

    // Reserved names
    const reserved = ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD'];
    if (reserved.includes(name.toUpperCase())) {
      return t('worktrees.branch.reserved', { branch: name });
    }

    return null;
  }

  private handleNewBranchInput(e: InputEvent) {
    this.newBranchName = (e.target as HTMLInputElement).value;
  }

  private handleCancelCreateWorktree() {
    this.showCreateWorktree = false;
    this.newBranchName = '';
    this.customPath = '';
    this.useCustomPath = false;
  }

  render() {
    if (!this.gitRepoInfo?.isGitRepo) {
      return nothing;
    }

    logger.log('Rendering Git branch selector', {
      isGitRepo: this.gitRepoInfo?.isGitRepo,
      currentBranch: this.currentBranch,
      selectedBaseBranch: this.selectedBaseBranch,
    });

    return html`
      <div class="mt-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <!-- Base Branch Selection -->
          <div>
            <label class="ut-label flex items-center gap-2">
              ${
                this.availableWorktrees.some((wt) => wt.isCurrentWorktree && !wt.isMainWorktree)
                  ? t('branchSelector.baseForCurrentWorktree')
                  : this.selectedWorktree
                    ? t('branchSelector.baseForWorktree')
                    : t('branchSelector.switchTo')
              }
              ${
                this.gitRepoInfo?.hasChanges && !this.selectedWorktree
                  ? html`
                  <span class="text-status-warning text-caption flex items-center gap-1">
                    <span>●</span>
                    <span>${t('worktrees.uncommitted')}</span>
                  </span>
                `
                  : ''
              }
            </label>
            <div class="relative">
              <select
                .value=${this.selectedBaseBranch || this.currentBranch}
                @change=${this.handleBaseBranchChange}
                class="ut-field ut-field--mono ut-select"
                ?disabled=${this.disabled || this.isCreating || this.isLoadingBranches}
                data-testid="git-base-branch-select"
              >
                ${this.availableBranches.map(
                  (branch) => html`
                    <option value="${branch}" ?selected=${branch === (this.selectedBaseBranch || this.currentBranch)}>
                      ${branch}${branch === this.currentBranch ? ` (${t('branchSelector.tag.currentBranch')})` : ''}
                    </option>
                  `
                )}
              </select>
            </div>
            ${
              !this.isLoadingBranches
                ? html`
                <p class="text-caption text-text-muted mt-1">
                  ${
                    this.selectedWorktree
                      ? t('branchSelector.willUseWorktree', { worktree: this.selectedWorktree })
                      : this.selectedBaseBranch && this.selectedBaseBranch !== this.currentBranch
                        ? // The server starts it on that branch in its own worktree (made when
                          // there is none), never switching your checkout (2026-10-20).
                          html`<span data-testid="branch-worktree-hint">${t(
                            'branchSelector.willUseBranchWorktree',
                            { branch: this.selectedBaseBranch, current: this.currentBranch }
                          )}</span>`
                        : ''
                  }
                  ${
                    this.followMode &&
                    this.followBranch &&
                    (
                      (this.gitRepoInfo?.hasChanges && !this.selectedWorktree) ||
                        this.selectedWorktree ||
                        (this.selectedBaseBranch && this.selectedBaseBranch !== this.currentBranch)
                    )
                      ? html`${
                          (this.gitRepoInfo?.hasChanges && !this.selectedWorktree) ||
                          this.selectedWorktree ||
                          (
                            this.selectedBaseBranch &&
                              this.selectedBaseBranch !== this.currentBranch
                          )
                            ? html`<br>`
                            : ''
                        }<span class="text-text-muted">${t('branchSelector.followActive', { branch: this.followBranch })}</span>`
                      : this.followMode && this.followBranch
                        ? html`<span class="text-text-muted">${t('branchSelector.followActive', { branch: this.followBranch })}</span>`
                        : ''
                  }
                </p>
              `
                : nothing
            }
          </div>
          
          <!-- Worktree Selection -->
          <div>
            <label class="ut-label">
              ${t('branchSelector.worktree')}
            </label>
            ${
              !this.showCreateWorktree
                ? html`
                <div class="relative">
                  <select
                    .value=${this.selectedWorktree || 'none'}
                    @change=${this.handleWorktreeChange}
                    class="ut-field ut-field--mono ut-select"
                    ?disabled=${this.disabled || this.isCreating || this.isLoadingWorktrees}
                    data-testid="git-worktree-select"
                  >
                    <option value="none">
                      ${
                        this.availableWorktrees.some(
                          (wt) => wt.isCurrentWorktree && !wt.isMainWorktree
                        )
                          ? t('branchSelector.useMainRepo')
                          : t('branchSelector.useSelectedWorktree')
                      }
                    </option>
                    ${this.availableWorktrees.map((worktree) => {
                      const folderName = worktree.path.split('/').pop() || worktree.path;
                      const showBranch =
                        folderName.toLowerCase() !== worktree.branch.toLowerCase() &&
                        !folderName.toLowerCase().endsWith(`-${worktree.branch.toLowerCase()}`);

                      return html`
                        <option value="${worktree.branch}" ?selected=${worktree.branch === this.selectedWorktree}>
                          ${folderName}${showBranch ? ` [${worktree.branch}]` : ''}${worktree.isMainWorktree ? ` (${t('branchSelector.tag.mainWorktree')})` : ''}${worktree.isCurrentWorktree ? ` (${t('branchSelector.tag.currentWorktree')})` : ''}${this.followMode && this.followBranch === worktree.branch ? ` · ${t('branchSelector.tag.following')}` : ''}
                        </option>
                      `;
                    })}
                  </select>
                </div>
                <div class="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    @click=${() => {
                      this.showCreateWorktree = true;
                      this.newBranchName = '';
                    }}
                    class="text-caption text-primary hover:underline flex items-center gap-1"
                    ?disabled=${this.disabled || this.isCreating}
                  >
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                    </svg>
                    ${t('branchSelector.createWorktree')}
                  </button>
                </div>
              `
                : html`
                <!-- Create Worktree Mode -->
                <div class="space-y-2">
                  <input
                    type="text"
                    .value=${this.newBranchName}
                    @input=${this.handleNewBranchInput}
                    placeholder=${t('branchSelector.newBranchPlaceholder')}
                    class="ut-field ut-field--mono"
                    ?disabled=${this.disabled || this.isCreating || this.isCreatingWorktree}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === 'Escape') {
                        this.handleCancelCreateWorktree();
                      }
                    }}
                  />
                  
                  <!-- Path customization toggle -->
                  <label class="flex items-center gap-2 text-caption text-text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      .checked=${this.useCustomPath}
                      @change=${(e: Event) => {
                        this.useCustomPath = (e.target as HTMLInputElement).checked;
                        if (!this.useCustomPath) {
                          this.customPath = '';
                        }
                      }}
                      ?disabled=${this.disabled || this.isCreating || this.isCreatingWorktree}
                      class="rounded-rem"
                    />
                    <span>${t('worktrees.customizePath')}</span>
                  </label>
                  
                  <!-- Custom path input -->
                  ${
                    this.useCustomPath
                      ? html`
                      <div class="space-y-1">
                        <input
                          type="text"
                          .value=${this.customPath}
                          @input=${(e: InputEvent) => {
                            this.customPath = (e.target as HTMLInputElement).value;
                          }}
                          placeholder="/path/to/worktree"
                          class="ut-field ut-field--mono"
                          ?disabled=${this.disabled || this.isCreating || this.isCreatingWorktree}
                        />
                        <div class="text-caption text-text-dim">
                          ${
                            this.customPath.trim()
                              ? t('worktrees.willCreateAt', { path: this.customPath.trim() })
                              : t('worktrees.enterPath')
                          }
                        </div>
                      </div>
                    `
                      : html`
                      <div class="text-caption text-text-dim">
                        ${t('branchSelector.defaultPath', {
                          path: `${this.gitRepoInfo?.repoPath || ''}-${this.newBranchName.trim().replace(/[^a-zA-Z0-9-_]/g, '-') || 'branch'}`,
                        })}
                      </div>
                    `
                  }
                  
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      @click=${this.handleCancelCreateWorktree}
                      class="ut-btn ut-btn--ghost ut-btn--sm"
                      ?disabled=${this.disabled || this.isCreating || this.isCreatingWorktree}
                    >
                      ${t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      @click=${this.handleCreateWorktree}
                      class="ut-btn ut-btn--secondary ut-btn--sm"
                      ?disabled=${!this.newBranchName.trim() || (this.useCustomPath && !this.customPath.trim()) || this.disabled || this.isCreating || this.isCreatingWorktree}
                    >
                      ${this.isCreatingWorktree ? t('create.creating') : t('create.create')}
                    </button>
                  </div>
                </div>
              `
            }
          </div>
        </div>
      </div>
    `;
  }
}
