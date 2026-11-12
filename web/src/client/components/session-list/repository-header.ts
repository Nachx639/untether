/**
 * Repository Header Component
 *
 * One repo (worktree family) over its sessions (design spec 5.1, 2026-10-12): 28px row with a
 * folder icon, the main worktree's name, the session count (only when > 1), a branch chip right
 * next to the name and a hairline. The chip opens the repo popover (follow branch, worktrees),
 * which session-list renders and positions. `compact` is the split-view sidebar version: a 24px
 * section label with icon buttons for "Orquestar" and "+ Tarea" and a "⋯" that opens the same
 * popover, all of them always shown (2026-10-24: the sidebar had only a "⋯" on hover, so its
 * project actions and its orchestrator could not be seen).
 *
 * With `taskActions` (the desktop grid), "Orquestar", "+ Tarea" and the project's task settings
 * sit at the end of the row (2026-10-18), as on the phone's project header. A project folder
 * without git (`folder`) has "Orquestar" and "+ Tarea" but no gear: both open the git-init sheet.
 * A project whose folder is gone (`notice.missingSince`) has none of them: the line under the
 * header says so and offers «Olvidar» (renderProjectNoticeBanner), as on the phone.
 * A project with an app icon (`projectIcon`, TaskStore.iconFor) shows it before its name, in
 * both versions (2026-10-24: only the phone showed it); one that can't load is dropped.
 * The grid's header gives its room to the project's name first, as the phone's does
 * (2026-11-11: one column wide, it read «b…» and «ia-s…» beside "Orquestador" and "+ Tarea" in
 * full). Measured, not guessed: `data-squeeze` on the row says what has given way so far, and
 * the styles follow it (desktop-project-header.css). 0 nothing (the branch chip shrinks on its
 * own), 1 the branch is its icon, 2 "Orquestador" is its icon, 3 "+ Tarea" is its "+"; only
 * then is the name cut.
 *
 * @fires repo-menu - The chip or "⋯" was clicked (detail: { repoPath, anchor: HTMLElement })
 * @fires project-orchestrate - "Orquestar" (detail: { repoPath, name, sessionId, folder? })
 * @fires project-new-task - "+ Tarea" (detail: { repoPath, name, folder? })
 * @fires project-settings - The gear (detail: { repoPath, name })
 * @fires project-fold - The sidebar's name and chevron (`foldable`): fold the project or open it
 *   again (detail: { repoPath, name, collapsed }); utils/group-fold.ts
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { ProjectNotice } from '../../services/task-store.js';
import { unwatchHeaderFit, watchHeaderFit } from '../../utils/header-fit.js';
import { icon } from '../icons.js';

/**
 * The sidebar header's name as the button that folds its group (2026-11-10): a chevron, the
 * project's icon and the name. The header still drags by it (utils/list-drag.ts swallows the
 * click a drag ends with).
 */
export function renderSideFoldToggle(options: {
  label: string;
  collapsed: boolean;
  bodyId: string;
  icon?: unknown;
  toggle: () => void;
}) {
  const hint = t(options.collapsed ? 'fold.expand' : 'fold.collapse', { name: options.label });
  return html`<button
    type="button"
    class="ut-fold-toggle ut-repo-fold"
    data-testid="project-fold"
    aria-expanded=${options.collapsed ? 'false' : 'true'}
    aria-controls=${options.bodyId || nothing}
    aria-label=${hint}
    title=${hint}
    @click=${options.toggle}
  >
    ${icon('chevronRight', 12)}${options.icon ?? nothing}<span class="ut-section-label"
      >${options.label}</span
    >
  </button>`;
}

@customElement('repository-header')
export class RepositoryHeader extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: String }) repoPath!: string;
  /** What the group is called: the main worktree's folder name. */
  @property({ type: String }) label = '';
  @property({ type: Number }) count = 0;
  /** The branch shown on the chip (the followed one, else the sessions' branch). */
  @property({ type: String }) branch = '';
  /** The branch Untether follows in this repo, if any. */
  @property({ type: String }) followMode?: string;
  /** The popover for this repo is open (aria-expanded). */
  @property({ type: Boolean }) open = false;
  @property({ type: Boolean }) compact = false;
  /** "+ Tarea" and the settings gear after the hairline. */
  @property({ type: Boolean }) taskActions = false;
  /** A project folder without git yet (no gear). */
  @property({ type: Boolean }) folder = false;
  /** Pinned on top of the home: a pin instead of the folder icon. */
  @property({ type: Boolean }) pinned = false;
  /** The session of the project's running orchestrator, if any ("Orquestador" with a dot). */
  @property({ type: String }) orchestratorSessionId: string | null = null;
  /** The project's app icon (an object URL from TaskStore.iconFor), null until it loads. */
  @property({ attribute: false }) projectIcon: string | null = null;
  /** What the server says about the project (its folder gone: no task buttons). */
  @property({ attribute: false }) notice?: ProjectNotice;
  /** The sidebar's header folds its project (2026-11-10): its name is the button. */
  @property({ type: Boolean }) foldable = false;
  /** Folded by the user: only this header and the project's summary show. */
  @property({ type: Boolean }) collapsed = false;
  /** The id of what the header folds (aria-controls). */
  @property({ type: String }) foldBodyId = '';

  private emit(
    type: 'project-new-task' | 'project-settings' | 'project-orchestrate' | 'project-fold'
  ) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: {
          repoPath: this.repoPath,
          name: this.label,
          ...(this.folder ? { folder: true } : {}),
          ...(type === 'project-orchestrate' ? { sessionId: this.orchestratorSessionId } : {}),
          ...(type === 'project-fold' ? { collapsed: !this.collapsed } : {}),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private openMenu(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('repo-menu', {
        detail: {
          repoPath: this.repoPath,
          anchor: e.currentTarget as HTMLElement,
          ...(this.folder ? { folder: true } : {}),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** The icon URL that failed to load: the header goes back to its folder. */
  @state() private brokenIcon: string | null = null;

  private get appIcon(): string | null {
    return this.projectIcon && this.projectIcon !== this.brokenIcon ? this.projectIcon : null;
  }

  private renderIcon() {
    if (!this.appIcon) return nothing;
    const broken = () => {
      this.brokenIcon = this.projectIcon;
    };
    return html`<img
      class="ut-repo-icon"
      data-testid="repo-project-icon"
      src=${this.appIcon}
      alt=""
      aria-hidden="true"
      @error=${broken}
    />`;
  }

  private fitObserver?: ResizeObserver;
  private fitting = false;
  /** What the header showed when it was last measured. */
  private fitted = '';
  /** The sizes the last measure left: a resize that only reports them is that measure's own
   *  doing (a word given away resizes its button), not a reason to measure again. */
  private fitSizes = '';

  private get fitHead(): HTMLElement | null {
    return this.querySelector<HTMLElement>('.ut-repo-head--fit');
  }

  private headerSizes(head: HTMLElement) {
    return [head, ...head.children]
      .map((piece) => piece.getBoundingClientRect().width.toFixed(1))
      .join(' ');
  }

  /** Lets go of what the name needs, one step at a time, until the row fits (the grid's header). */
  fitHeader() {
    const head = this.fitHead;
    const last = head?.lastElementChild;
    if (!head || !last || this.fitting) return;
    this.fitting = true;
    try {
      const over = () =>
        last.getBoundingClientRect().right > head.getBoundingClientRect().right + 0.5;
      let level = 0;
      head.dataset.squeeze = '0';
      while (level < 3 && over()) head.dataset.squeeze = String(++level);
      this.fitSizes = this.headerSizes(head);
    } finally {
      this.fitting = false;
    }
  }

  connectedCallback() {
    super.connectedCallback();
    // Its width (the grid's columns), the type's size or the words changed: its boxes say so.
    if (typeof ResizeObserver !== 'undefined') {
      this.fitObserver = new ResizeObserver(() => {
        const head = this.fitHead;
        if (head && this.headerSizes(head) !== this.fitSizes) this.fitHeader();
      });
    }
    // A node moved by repeat() reconnects with a new observer that watches nothing yet.
    if (this.hasUpdated) this.observeHeader();
    watchHeaderFit(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.fitObserver?.disconnect();
    this.fitObserver = undefined;
    unwatchHeaderFit(this);
  }

  protected updated() {
    const head = this.fitHead;
    const shown = head
      ? [
          this.label,
          this.count,
          this.followMode,
          this.branch,
          this.pinned,
          this.folder,
          this.taskActions,
          this.appIcon,
          !!this.orchestratorSessionId,
        ].join('\n')
      : '';
    // A header Lit left alone keeps its `data-squeeze`; one it made anew starts unmeasured.
    if (shown === this.fitted && (!head || head.dataset.squeeze)) return;
    this.fitted = shown;
    this.fitObserver?.disconnect();
    if (!head) return;
    this.fitHeader();
    this.observeHeader();
  }

  /** Watches the row and its pieces: their boxes say when it must be measured again. */
  private observeHeader() {
    const head = this.fitHead;
    if (!head) return;
    this.fitObserver?.observe(head);
    for (const piece of head.children) this.fitObserver?.observe(piece);
  }

  render() {
    const following = this.followMode?.replace(/^refs\/heads\//, '');
    const branch = following || this.branch;
    const running = !!this.orchestratorSessionId;
    // Its folder is gone: nothing can run there (2026-10-20 verify: the desktop still offered
    // + Tarea, Orquestar and the gear, which could only fail).
    const missing = !!this.notice?.missingSince;
    if (this.compact) {
      return html`
        <div class="ut-repo-head ut-repo-head--compact" data-testid="repo-header">
          ${
            this.foldable
              ? renderSideFoldToggle({
                  label: this.label,
                  collapsed: this.collapsed,
                  bodyId: this.foldBodyId,
                  icon: this.renderIcon(),
                  toggle: () => this.emit('project-fold'),
                })
              : html`${this.renderIcon()}<span class="ut-section-label">${this.label}</span>`
          }
          ${this.count > 1 ? html`<span class="ut-repo-count">${this.count}</span>` : nothing}
          ${
            missing
              ? html`<span
                  class="prj-missing ut-repo-missing ut-repo-missing--compact"
                  data-testid="repo-missing"
                  role="img"
                  aria-label=${t('board.folderMissing')}
                  title=${t('board.folderMissing')}
                  >${icon('alert', 12)}</span
                >`
              : html`<span class="ut-repo-compact-actions">
                  <button
                    type="button"
                    class="ut-icon-btn ut-icon-btn--sm ut-repo-orch ${running ? 'running' : ''}"
                    data-testid="project-orchestrate"
                    aria-label=${
                      running
                        ? t('board.orchestratorOf', { name: this.label })
                        : t('board.orchestrateIn', { name: this.label })
                    }
                    title=${running ? t('board.orchestrator') : t('board.orchestrate')}
                    @click=${() => this.emit('project-orchestrate')}
                  >
                    ${icon('sparkles', 14)}${running ? html`<span class="prj-orch-dot" aria-hidden="true"></span>` : nothing}
                  </button>
                  <button
                    type="button"
                    class="ut-icon-btn ut-icon-btn--sm"
                    data-testid="project-new-task"
                    aria-label=${t('board.newTaskIn', { name: this.label })}
                    title=${t('board.newTaskIn', { name: this.label })}
                    @click=${() => this.emit('project-new-task')}
                  >
                    ${icon('plus', 14)}
                  </button>
                </span>`
          }
          <button
            class="ut-icon-btn ut-icon-btn--sm ut-repo-more"
            data-testid="repo-branch-chip"
            aria-haspopup="menu"
            aria-expanded=${this.open ? 'true' : 'false'}
            aria-label=${t('sessions.more')}
            title=${t('sessions.more')}
            @click=${this.openMenu}
          >
            ${icon('more')}
          </button>
        </div>
      `;
    }
    return html`
      <div class="ut-repo-head ${missing ? '' : 'ut-repo-head--fit'}" data-testid="repo-header">
        ${this.pinned ? icon('pin', 14) : this.appIcon ? nothing : icon('folder', 14)}${this.renderIcon()}
        <span class="ut-repo-name" title=${this.label}>${this.label}</span>
        ${this.count > 1 ? html`<span class="ut-repo-count">${this.count}</span>` : nothing}
${
  missing
    ? html`<span class="prj-missing ut-repo-missing" data-testid="repo-missing"
        >${icon('alert', 12)}<span>${t('board.folderMissing')}</span></span
      >`
    : this.folder
      ? // A folder without git: no branch to follow (2026-10-18 review); its pin is "⋯".
        html`<button
                class="ut-icon-btn ut-icon-btn--sm"
                data-testid="repo-branch-chip"
                aria-haspopup="menu"
                aria-expanded=${this.open ? 'true' : 'false'}
                aria-label=${t('sessions.more')}
                title=${t('sessions.more')}
                @click=${this.openMenu}
              >
                ${icon('more')}
              </button>`
      : html`<button
          class="ut-chip ut-chip--mono ut-repo-chip"
          data-testid="repo-branch-chip"
          aria-haspopup="menu"
          aria-expanded=${this.open ? 'true' : 'false'}
          title=${
            following
              ? t('repoHeader.following', { branch: following })
              : t('repoHeader.follow.title')
          }
          @click=${this.openMenu}
        >
          ${icon('gitBranch', 12)}<span>${branch || t('repoHeader.follow.none')}</span>${icon('chevronDown', 12)}
        </button>`
}
        <span class="ut-repo-rule"></span>
        ${
          this.taskActions && !missing
            ? html`<button
                  type="button"
                  class="ut-btn ut-btn--ghost ut-btn--sm ut-repo-task ut-repo-orch ${running ? 'running' : ''}"
                  data-testid="project-orchestrate"
                  aria-label=${
                    running
                      ? t('board.orchestratorOf', { name: this.label })
                      : t('board.orchestrateIn', { name: this.label })
                  }
                  title=${running ? t('board.orchestrator') : t('board.orchestrate')}
                  @click=${() => this.emit('project-orchestrate')}
                >
                  ${icon('sparkles', 14)}${running ? html`<span class="prj-orch-dot" aria-hidden="true"></span>` : nothing}<span
                    class="ut-repo-word"
                    >${running ? t('board.orchestrator') : t('board.orchestrate')}</span
                  >
                </button>
                <button
                  type="button"
                  class="ut-btn ut-btn--ghost ut-btn--sm ut-repo-task"
                  data-testid="project-new-task"
                  title=${t('board.newTaskIn', { name: this.label })}
                  @click=${() => this.emit('project-new-task')}
                >
                  ${icon('plus', 14)}<span class="ut-repo-word">${t('board.newTask')}</span>
                </button>
                ${
                  this.folder
                    ? nothing
                    : html`<button
                  type="button"
                  class="ut-icon-btn ut-icon-btn--sm"
                  data-testid="project-settings"
                  aria-label=${t('board.settingsOf', { name: this.label })}
                  title=${t('board.settings')}
                  @click=${() => this.emit('project-settings')}
                >
                  ${icon('settings', 14)}
                </button>`
                }`
            : nothing
        }
      </div>
    `;
  }
}
