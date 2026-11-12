/**
 * One project (git repository) on the phone home (2026-10-18): a header with the repo's name
 * and the branch its tasks merge into, "Orquestar", "+ Tarea" and the settings gear; then its
 * orchestrator's session pinned on top with an "Orquestador" badge (P7), its open tasks
 * (te necesita first, task-row) and its other sessions (the list's own phone rows, through
 * `renderSession`). "Otras" (no repository) has no buttons. A project folder without git
 * (group.folder) has "Orquestar" and "+ Tarea" too, without branch or gear: their events carry
 * `folder: true` and the list turns version control on first (git-init-sheet.ts).
 *
 * @fires project-new-task - "+ Tarea" (detail: { repoPath, name, folder? })
 * @fires project-settings - The gear (detail: { repoPath, name })
 * @fires project-orchestrate - "Orquestar" / the running orchestrator's button
 * @fires project-menu - The project's name: pin it on top or unpin it (detail: { repoPath, name, pinned })
 *   (detail: { repoPath, name, sessionId, folder? }: sessionId when one runs)
 * @fires project-forget - "Olvidar" on a project whose folder is gone (detail: { repoPath, name })
 * @fires project-resume-merges - "Reactivar" on paused automatic merges (detail: { repoPath, name })
 * @fires project-fold - The header's chevron (or the folded project's summary): fold it or
 *   open it again (detail: { repoPath, name, collapsed })
 *
 * Folded (2026-11-10, `collapsed`): only the header and one line with what it holds
 * (`summary`, what waits for the user first and in its colour); utils/group-fold.ts.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import type { ProjectNotice } from '../services/task-store.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import type { FoldSummary } from '../utils/group-fold.js';
import { unwatchHeaderFit, watchHeaderFit } from '../utils/header-fit.js';
import { endsADrag } from '../utils/pointer-drag.js';
import type { ProjectGroup } from '../utils/project-groups.js';
import { mergePauseText, movedFromName } from '../utils/project-notice.js';
import { attemptLetter, taskDisplayTitle, taskUnits } from '../utils/task-status.js';
import { icon } from './icons.js';
import './task-row.js';
import { isFinishedSession } from '../utils/session-suspend.js';
import type { TaskRowVariant } from './task-row.js';

/**
 * A project's open tasks as rows (or desktop cards): a parallel group's attempts together
 * under "N intentos · <name>", lettered A-D, each with its own counts and "Quedarme con este".
 */
export function renderTaskUnits(
  tasks: readonly TaskRecord[],
  options: {
    sessionsById: ReadonlyMap<string, Session>;
    selectedSessionId: string | null;
    variant: TaskRowVariant;
  }
) {
  const row = (task: TaskRecord, attempt?: { letter: string; others: number }) => {
    const session = task.sessionId ? options.sessionsById.get(task.sessionId) : undefined;
    return html`<task-row
      data-task=${task.id}
      .task=${task}
      .session=${session}
      .variant=${options.variant}
      .prefix=${attempt?.letter ?? ''}
      .attempts=${attempt?.others ?? 0}
      .selected=${!!session && session.id === options.selectedSessionId}
    ></task-row>`;
  };
  return repeat(
    taskUnits(tasks),
    (unit) => (unit.kind === 'task' ? unit.task.id : `group:${unit.groupId}`),
    (unit) => {
      if (unit.kind === 'task') return row(unit.task);
      const [first] = unit.tasks;
      const name = taskDisplayTitle(first);
      return html`<div
        class="tsk-attempts"
        role="group"
        aria-label=${t('board.attemptsLabel', { n: unit.tasks.length, name })}
        data-testid="task-attempts"
      >
        <div class="tsk-attempts-head">
          ${icon('gitBranch', 12)}<span>${t('board.attempts', { n: unit.tasks.length })}</span>
          <span class="tsk-attempts-name">${name}</span>
        </div>
        ${repeat(
          unit.tasks,
          // Keyed: a discarded attempt must not hand its row (busy, flash) to the next one.
          (task) => task.id,
          (task, index) =>
            row(task, { letter: attemptLetter(task, index), others: unit.tasks.length - 1 })
        )}
      </div>`;
    }
  );
}

/**
 * What a folded project holds, in one line: «1 te necesita · 3 sesiones · 2 tareas · 2 en
 * cola». What waits for the user comes first and in its colour, so a narrow row never cuts it.
 */
export function renderFoldSummary(summary: FoldSummary | undefined) {
  if (!summary) return nothing;
  const parts = [
    summary.sessions ? t('sidebar.sessionCount', { n: summary.sessions }) : '',
    summary.tasks ? t('fold.tasks', { n: summary.tasks }) : '',
    summary.queued ? t('fold.queued', { n: summary.queued }) : '',
  ].filter(Boolean);
  if (!summary.needsYou && !parts.length) return t('fold.empty');
  return html`${
    summary.needsYou
      ? html`<span class="ut-fold-needs" data-testid="fold-needs"
            >${t('mission.waitingCount', { n: summary.needsYou })}</span
          >${parts.length ? ' · ' : ''}`
      : nothing
  }${parts.join(' · ')}`;
}

/** Each project's folding part has an id of its own (the chevron's aria-controls). */
let foldBodies = 0;

/**
 * The desktop grid's line under a project header: its folder is gone («Olvidar»), it moved
 * («antes «skylark»»), or its automatic merges are paused («Reactivar»). Nothing otherwise.
 */
export function renderProjectNoticeBanner(
  notice: ProjectNotice | undefined,
  name: string,
  actions: { forget: () => void; resume: () => void; resuming?: boolean }
) {
  if (!notice) return nothing;
  const pause = mergePauseText(notice);
  const before = movedFromName(notice);
  if (!notice.missingSince && !pause && (!before || before === name)) return nothing;
  return html`<div class="prj-pause ut-grid-header" role="status" data-testid="project-notice">
    <span class="prj-pause-text"
      >${
        notice.missingSince
          ? t('board.folderMissingLong')
          : pause || t('board.movedFromLong', { name: before })
      }</span
    >
    ${
      notice.missingSince
        ? html`<button
            type="button"
            class="ut-surface--control tsk-btn"
            data-testid="project-forget"
            aria-label=${t('board.forgetProjectOf', { name })}
            @click=${actions.forget}
          >
            ${t('board.forgetProject')}
          </button>`
        : pause
          ? html`<button
              type="button"
              class="ut-surface--control tsk-btn"
              data-testid="project-resume-merges"
              aria-busy=${actions.resuming ? 'true' : 'false'}
              ?disabled=${!!actions.resuming}
              @click=${actions.resume}
            >
              ${t('board.resumeMerges')}
            </button>`
          : nothing
    }
  </div>`;
}

/** A name's letters as a reader counts them: an emoji or an accented letter is never split. */
function letters(text: string): string[] {
  // Not in this build's `lib` yet; every browser the app supports has it.
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: 'grapheme' }
      ) => { segment(text: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(
    new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (part) => part.segment
  );
}

@customElement('project-group')
export class ProjectGroupView extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) group!: ProjectGroup;
  /** The header's name (the main worktree's folder; "Otras" for no repository). */
  @property({ type: String }) name = '';
  /** The branch tasks start from and merge into. */
  @property({ type: String }) branch = '';
  /** Every session by id: a task row gets its own. */
  @property({ attribute: false }) sessionsById: ReadonlyMap<string, Session> = new Map();
  @property({ attribute: false }) renderSession: (
    session: Session,
    extras?: { projectIcon?: string | null }
  ) => unknown = () => nothing;
  @property({ type: String }) selectedSessionId: string | null = null;
  /** Without the header (the only group, and nothing to do with tasks there). */
  @property({ type: Boolean }) headless = false;
  /** Changes whenever something shown inside changes (the app mutates sessions in place). */
  @property({ type: String }) stamp = '';
  /** The session of the project's running orchestrator (pinned on top), if any. */
  @property({ type: String }) orchestratorSessionId: string | null = null;
  /** Its orchestrator's brief is queued, not typed in yet («Preparando…»). */
  @property({ type: Boolean }) orchestratorPending = false;
  /** What the server says about the project: folder gone or moved, merges paused. */
  @property({ attribute: false }) notice?: ProjectNotice;
  /** The project's icon (a blob URL), shown on its orchestrator's row. */
  @property({ attribute: false }) projectIcon: string | null = null;
  /** Its «Reactivar» request is on its way: the button waits (no second request). */
  @property({ type: Boolean }) resuming = false;
  /** Folded by the user: only its header and its summary show. */
  @property({ type: Boolean }) collapsed = false;
  /** What it holds, shown while folded (utils/group-fold.ts). */
  @property({ attribute: false }) summary?: FoldSummary;
  /** A search is on: every project shows open and its chevron waits. */
  @property({ type: Boolean }) foldLocked = false;

  private readonly foldBodyId = `prj-fold-${++foldBodies}`;
  /** Opened by a tap since it was mounted: its rows come in with a short motion. */
  private unfolded = false;

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('collapsed') && this.hasUpdated) this.unfolded = !this.collapsed;
  }

  /** Shown folded now (never while searching, nor without a header to open it again). */
  private get folded(): boolean {
    return this.collapsed && !this.foldLocked && !this.headless;
  }

  private touchedAt = 0;

  /**
   * The header's room goes to the project's name first (2026-11-10: a real iPhone, 440 pt wide
   * in Dark Premium, read "UNT…" and "BEAVE…" next to "Orquestador" and "+ Tarea" in full; the
   * cuts were viewport widths, blind to the name, the style's type size and the language).
   * Measured, not guessed: `data-squeeze` on the header says how much has given way so far, and
   * the styles follow it (list.css). 0 everything (the branch chip shrinks on its own), 1 no
   * branch, 2 "Orquestador" is its icon, 3 "+ Tarea" is its "+", and only then is the name cut.
   */
  private fitObserver?: ResizeObserver;
  private fitting = false;
  /** What the header showed when it was last measured (its sizes are the observer's). */
  private fitted = '';

  /** The sizes the last measure left: a resize that only reports them is that measure's own
   *  doing (giving a word away resizes its button), not a reason to measure again. */
  private fitSizes = '';

  private headerSizes(head: HTMLElement) {
    return [head, ...head.querySelectorAll('.prj-name-btn, .prj-tools > *')]
      .map((piece) => piece.getBoundingClientRect().width.toFixed(1))
      .join(' ');
  }

  fitHeader() {
    const head = this.querySelector<HTMLElement>('.prj-head:not(.prj-head--missing)');
    const last = head?.lastElementChild;
    if (!head || !last || this.fitting) return;
    this.fitting = true;
    try {
      const style = getComputedStyle(head);
      // Its actions may reach into the gutter by their own negative margin, no further.
      const reach = Math.min(0, Number.parseFloat(getComputedStyle(last).marginRight) || 0);
      const over = () =>
        last.getBoundingClientRect().right + reach >
        head.getBoundingClientRect().right -
          Number.parseFloat(style.paddingRight) -
          Number.parseFloat(style.borderRightWidth) +
          0.5;
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
    // Its width, the type's size or the words changed (rotation, another style, another
    // language, fonts arriving): the header's own boxes say so, whatever the cause.
    if (typeof ResizeObserver !== 'undefined') {
      this.fitObserver = new ResizeObserver(() => {
        const head = this.querySelector<HTMLElement>('.prj-head:not(.prj-head--missing)');
        if (head && this.headerSizes(head) !== this.fitSizes) this.fitHeader();
      });
    }
    // 2026-11-10: a node moved by repeat() reconnects with a new observer that watched nothing
    // (updated() returned early, its header unchanged): so the header turned unmeasured.
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
    const head = this.querySelector('.prj-head');
    const shown = head
      ? [
          this.name,
          this.branch,
          this.group.pinned,
          this.group.folder,
          !!this.orchestratorSession(),
          this.orchestratorPending,
          movedFromName(this.notice),
          this.notice?.missingSince,
        ].join('\n')
      : '';
    // A header Lit left alone keeps its `data-squeeze`; one it made anew starts unmeasured.
    if (shown === this.fitted && (!head || (head as HTMLElement).dataset.squeeze)) return;
    this.fitted = shown;
    this.fitObserver?.disconnect();
    if (!head) return;
    this.fitHeader();
    this.observeHeader();
  }

  /** Watches the header and its pieces: their boxes say when it must be measured again. */
  private observeHeader() {
    const head = this.querySelector('.prj-head');
    if (!head) return;
    this.fitObserver?.observe(head);
    for (const piece of head.querySelectorAll('.prj-name-btn, .prj-tools > *')) {
      this.fitObserver?.observe(piece);
    }
  }

  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse' || endsADrag(p)) return;
          this.touchedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private emit(
    type:
      | 'project-new-task'
      | 'project-settings'
      | 'project-orchestrate'
      | 'project-menu'
      | 'project-forget'
      | 'project-resume-merges'
      | 'project-fold'
  ) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: {
          repoPath: this.group.key,
          name: this.name,
          ...(this.group.folder ? { folder: true } : {}),
          ...(type === 'project-menu' ? { pinned: !!this.group.pinned } : {}),
          ...(type === 'project-fold' ? { collapsed: !this.collapsed } : {}),
          ...(type === 'project-orchestrate'
            ? { sessionId: this.orchestratorSession()?.id ?? null }
            : {}),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** The orchestrator's session, when it runs and the list has it. */
  private orchestratorSession(): Session | undefined {
    const id = this.orchestratorSessionId;
    if (!id) return undefined;
    const session =
      this.group.sessions.find((entry) => entry.id === id) ?? this.sessionsById.get(id);
    return session && !isFinishedSession(session) ? session : undefined;
  }

  /**
   * "Orquestar" (P7): the goal sheet. While one runs it reads "Orquestador" with a live dot and
   * opens its choices (new goal, open, stop).
   */
  private renderOrchestratorSlot() {
    const running = !!this.orchestratorSession();
    const pending = running && this.orchestratorPending;
    const orchestrate = this.tap(() => this.emit('project-orchestrate'));
    const label = pending
      ? t('board.orchestratorPreparing')
      : running
        ? t('board.orchestrator')
        : t('board.orchestrate');
    return html`<button
      type="button"
      class="ut-surface--control ut-surface--compact prj-orch-btn ${running ? 'running' : ''}"
      data-testid="project-orchestrate"
      data-pending=${pending ? 'true' : 'false'}
      aria-label=${running ? t('board.orchestratorOf', { name: this.name }) : t('board.orchestrateIn', { name: this.name })}
      title=${label}
      @pointerup=${orchestrate}
      @click=${orchestrate}
    >
      ${icon('sparkles', 16)}${running ? html`<span class="prj-orch-dot" aria-hidden="true"></span>` : nothing}<span
        class="prj-orch-label"
        >${label}</span
      >
    </button>`;
  }

  private renderHeader() {
    const repo = this.group.key;
    const newTask = this.tap(() => this.emit('project-new-task'));
    const settings = this.tap(() => this.emit('project-settings'));
    const projectMenu = this.tap(() => this.emit('project-menu'));
    const missing = !!(repo && this.notice?.missingSince);
    return html`<div
      class="ut-phone-section prj-head ${missing ? 'prj-head--missing' : ''}"
      data-testid="project-header"
    >
      <h3 class="prj-title">
        ${this.renderFoldToggle()}${
          repo
            ? html`<button
                type="button"
                class="ut-text-action prj-name-btn"
                data-testid="project-menu"
                aria-haspopup="dialog"
                aria-label=${t('board.projectMenu', { name: this.name })}
                @pointerup=${projectMenu}
                @click=${projectMenu}
              >
                ${
                  this.group.pinned
                    ? html`<span class="prj-pin" data-testid="project-pin-mark">${icon('pin', 14)}</span>`
                    : nothing
                }${this.renderName()}
              </button>`
            : this.renderName()
        }
      </h3>
      ${this.renderMoved()}
      ${
        repo && this.branch && !this.group.folder && !this.notice?.missingSince
          ? html`<span
              class="prj-branch"
              dir="ltr"
              title=${t('board.baseBranch', { branch: this.branch })}
              data-testid="project-branch"
              >${icon('gitBranch', 12)}<span>${this.branch}</span></span
            >`
          : nothing
      }
      ${
        repo && this.notice?.missingSince
          ? this.renderMissingTools()
          : repo
            ? html`<span class="prj-tools">
              ${this.renderOrchestratorSlot()}
              <button
                type="button"
                class="ut-text-action prj-new"
                data-testid="project-new-task"
                aria-label=${t('board.newTaskIn', { name: this.name })}
                @pointerup=${newTask}
                @click=${newTask}
              >
                ${icon('plus', 16)}<span>${t('board.newTask')}</span>
              </button>
              ${this.group.folder ? nothing : this.renderGear(settings)}
            </span>`
            : nothing
      }
    </div>`;
  }

  /**
   * The chevron before the name: folds the project or opens it again. A button of its own (the
   * name opens the project's menu), with the row's height and a little of the gutter as its
   * target. It takes the place the folder icon had, so the name has the room it had.
   */
  private renderFoldToggle() {
    const fold = this.tap(() => {
      if (!this.foldLocked) this.emit('project-fold');
    });
    const label = t(this.folded ? 'fold.expand' : 'fold.collapse', { name: this.name });
    return html`<button
      type="button"
      class="ut-fold-toggle prj-fold"
      data-testid="project-fold"
      aria-expanded=${this.folded ? 'false' : 'true'}
      aria-controls=${this.foldBodyId}
      aria-label=${label}
      title=${label}
      ?disabled=${this.foldLocked}
      @pointerup=${fold}
      @click=${fold}
    >
      ${icon('chevronRight', 14)}
    </button>`;
  }

  /** The folded project's one line; a tap on it opens the project too. */
  private renderFolded() {
    const open = this.tap(() => this.emit('project-fold'));
    return html`<div
      class="ut-fold-summary prj-fold-summary"
      id=${this.foldBodyId}
      data-testid="project-fold-summary"
      @pointerup=${open}
      @click=${open}
    >
      ${renderFoldSummary(this.summary)}
    </div>`;
  }

  /**
   * The name in two parts, so that one too long for the row is cut in the middle and keeps its
   * end ("ia-sober…pana": projects often differ there). A short one is never cut.
   */
  private renderName() {
    const parts = letters(this.name);
    const cut = parts.length > 8 ? parts.length - 4 : 0;
    return html`<span class="prj-name" title=${this.name}
      >${cut ? html`<span class="prj-name-start">${parts.slice(0, cut).join('')}</span>` : nothing}<span
        class="prj-name-end"
        >${parts.slice(cut).join('')}</span
      ></span
    >`;
  }

  /** «antes «skylark»» for a while after the server followed a moved or renamed folder. */
  private renderMoved() {
    const before = movedFromName(this.notice);
    if (!before || before === this.name) return nothing;
    return html`<span class="prj-moved" data-testid="project-moved" title=${this.notice?.movedFrom ?? ''}
      >${t('board.movedFrom', { name: before })}</span
    >`;
  }

  /**
   * Its folder is gone (and was not found elsewhere): no task can run there. The header says
   * so and offers to forget it, instead of buttons that would only fail.
   */
  private renderMissingTools() {
    const forget = this.tap(() => this.emit('project-forget'));
    return html`<span class="prj-tools prj-tools--missing">
      <span class="prj-missing" data-testid="project-missing"
        >${icon('alert', 14)}<span>${t('board.folderMissing')}</span></span
      >
      <button
        type="button"
        class="ut-surface--control tsk-btn"
        data-testid="project-forget"
        aria-label=${t('board.forgetProjectOf', { name: this.name })}
        @pointerup=${forget}
        @click=${forget}
      >
        ${t('board.forgetProject')}
      </button>
    </span>`;
  }

  /** «Fusión automática en pausa hasta las 14:05: …» with «Reactivar». */
  private renderPause() {
    const pause = mergePauseText(this.notice);
    if (!pause || !this.group.key) return nothing;
    const resume = this.tap(() => {
      if (!this.resuming) this.emit('project-resume-merges');
    });
    return html`<div class="prj-pause" role="status" data-testid="project-merge-paused">
      <span class="prj-pause-text">${pause}</span>
      <button
        type="button"
        class="ut-surface--control tsk-btn"
        data-testid="project-resume-merges"
        aria-busy=${this.resuming ? 'true' : 'false'}
        ?disabled=${this.resuming}
        @pointerup=${resume}
        @click=${resume}
      >
        ${t('board.resumeMerges')}
      </button>
    </div>`;
  }

  /** The settings gear: a repository's task settings (a folder without git has none yet). */
  private renderGear(settings: { handleEvent: (e: Event) => void }) {
    return html`<button
                type="button"
                class="ut-icon-btn prj-gear"
                data-testid="project-settings"
                data-ut-optical-edge
                aria-label=${t('board.settingsOf', { name: this.name })}
                title=${t('board.settings')}
                @pointerup=${settings}
                @click=${settings}
              >
      ${icon('settings', 18)}
    </button>`;
  }

  render() {
    const group = this.group;
    if (!group) return nothing;
    const orchestrator = group.key ? this.orchestratorSession() : undefined;
    const sessions = orchestrator
      ? group.sessions.filter((session) => session.id !== orchestrator.id)
      : group.sessions;
    return html`<section
      class="prj"
      data-testid="project-group"
      data-project=${group.key ?? ''}
      data-folded=${this.folded ? 'true' : 'false'}
      aria-label=${this.name}
    >
      ${this.headless ? nothing : this.renderHeader()}
      ${this.headless ? nothing : this.renderPause()}
      ${this.folded ? this.renderFolded() : this.renderRows(orchestrator, sessions)}
    </section>`;
  }

  private renderRows(orchestrator: Session | undefined, sessions: Session[]) {
    const group = this.group;
    return html`<div
        class="psr-list ${this.unfolded ? 'ut-fold-in' : ''}"
        id=${this.foldBodyId}
        data-testid="phone-session-list"
      >
        ${
          orchestrator
            ? html`<div class="prj-orch" data-testid="project-orchestrator-row">
                <span
                  class="prj-orch-badge"
                  data-testid="project-orchestrator-badge"
                  data-pending=${this.orchestratorPending ? 'true' : 'false'}
                  >${icon('sparkles', 12)}<span
                    >${this.orchestratorPending ? t('board.orchestratorPreparing') : t('board.orchestrator')}</span
                  ></span
                >
                ${this.renderSession(orchestrator, { projectIcon: this.projectIcon })}
              </div>`
            : nothing
        }
        ${renderTaskUnits(group.tasks, {
          sessionsById: this.sessionsById,
          selectedSessionId: this.selectedSessionId,
          variant: 'row',
        })}
        ${repeat(
          sessions,
          (session) => session.id,
          (session) => this.renderSession(session)
        )}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'project-group': ProjectGroupView;
  }
}
