/**
 * "Nueva tarea" (2026-10-18): from "+ Nueva" → Tarea, or a project's "+ Tarea". Pick the
 * project, type or dictate what to do, the agent (your quick starts) and, if you like, "Lanzar
 * en paralelo ×N" (the same request to 1-4 agents, then "Quedarme con este" on the best). The
 * user never sees a worktree: the task just "works on its own branch and merges on its own".
 *
 * POST /api/tasks { isolation: 'worktree', repoPath, parallel }. Lazy (deferred-views.ts), in
 * <body> with the answer sheet's look (ans-*); the last project, agent and N are remembered on
 * this device, the text is kept if launching fails.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  TASK_PARALLEL_MAX,
  type TaskAgent,
  type TaskRecord,
  taskTitleFromPrompt,
} from '../../shared/tasks.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { type TaskStore, taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { SHOW_TASK_EVENT } from '../utils/constants.js';
import { DictationController, type DictationState, dictationErrorKey } from '../utils/dictation.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { normalizeRepoPath } from '../utils/repo-key.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { taskErrorText } from '../utils/task-status.js';
import { icon } from './icons.js';

export interface ComposeAgent {
  agent: TaskAgent;
  /** The quick start's name ("claude", "Claude (yolo)"). */
  label: string;
  command: string[];
}

export interface TaskComposeOptions {
  /** Known projects (main checkouts), the most relevant first. */
  repos: string[];
  /** The project to start in ("+ Tarea" in its header). */
  repo?: string;
  /** Agents from the user's quick starts (Claude, Codex). */
  agents: ComposeAgent[];
  shielded?: boolean;
  store?: TaskStore;
}

const PREFS_KEY = 'ut-task-compose';
const OPEN_GUARD_MS = 500;

interface ComposePrefs {
  repo?: string;
  agent?: string;
  parallel?: number;
}

function readPrefs(): ComposePrefs {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writePrefs(prefs: ComposePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...prefs }));
  } catch {
    // Blocked storage: it starts from the defaults next time.
  }
}

const repoName = (repo: string) => repo.split('/').filter(Boolean).pop() ?? repo;

/**
 * An agent's name as the Ask box writes it: a quick start that is just the program ("claude")
 * reads "Claude"; a named one keeps its name.
 */
export function agentDisplayLabel(agent: ComposeAgent): string {
  const label = agent.label.trim();
  if (label.toLowerCase() === agent.agent) return agent.agent === 'claude' ? 'Claude' : 'Codex';
  return label;
}

@customElement('task-compose-sheet')
export class TaskComposeSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) options: TaskComposeOptions = { repos: [], agents: [] };

  @state() private repos: string[] = [];
  @state() private repo = '';
  @state() private prompt = '';
  @state() private agentIndex = 0;
  @state() private parallel = 1;
  @state() private busy = false;
  @state() private error = '';
  @state() private discovering = false;
  @state() private dictation: DictationState = 'idle';
  @state() private dictationNote = '';

  private openedAt = 0;
  private touchedAt = 0;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;

  private dictationController = new DictationController({
    getText: () => this.prompt,
    setText: (value) => {
      this.prompt = value;
    },
    onState: (state) => {
      this.dictation = state;
      if (state !== 'idle') this.dictationNote = '';
    },
    onError: (error) => {
      this.dictationNote = t(dictationErrorKey(error) as MessageKey);
    },
    authHeaders: () => authClient.getAuthHeader(),
  });

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    const prefs = readPrefs();
    this.repos = this.unique(this.options.repos);
    this.repo =
      this.options.repo ??
      (prefs.repo && this.repos.includes(prefs.repo) ? prefs.repo : (this.repos[0] ?? ''));
    if (this.repo && !this.repos.includes(this.repo)) this.repos = [this.repo, ...this.repos];
    const agent = this.options.agents.findIndex((entry) => entry.label === prefs.agent);
    this.agentIndex = Math.max(0, agent);
    this.parallel = Math.min(TASK_PARALLEL_MAX, Math.max(1, Number(prefs.parallel) || 1));
    void this.loadProjects();
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.ans-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.close, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
    if (sheet) {
      const stopDrag = attachSheetDrag(sheet, {
        scroller: sheet.querySelector<HTMLElement>('.ans-body'),
        onDismiss: this.close,
      });
      // Lanzar sits at the bottom: above the keyboard while the prompt is typed.
      const stopKeyboard = followKeyboard(sheet);
      this.detachDrag = () => {
        stopDrag();
        stopKeyboard();
      };
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.dictationController.cancel();
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.detachDrag?.();
    this.detachDrag = null;
  }

  close = () => {
    this.remove();
  };

  private unique(repos: string[]): string[] {
    const seen = new Set<string>();
    return repos.filter((repo) => {
      const key = repo && normalizeRepoPath(repo);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < OPEN_GUARD_MS) return;
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

  private headers() {
    return { 'Content-Type': 'application/json', ...authClient.getAuthHeader() };
  }

  /** Projects with settings or tasks on the server join the ones the list knows. */
  private async loadProjects() {
    try {
      const response = await fetch('/api/projects', { headers: this.headers() });
      if (!response.ok) return;
      const body = (await response.json()) as { projects?: Array<{ repoPath: string }> };
      const extra = (body.projects ?? []).map((project) => project.repoPath);
      this.repos = this.unique([...this.repos, ...extra]);
      if (!this.repo && this.repos[0]) this.repo = this.repos[0];
    } catch {
      // The known ones are enough.
    }
  }

  /** "Más proyectos…": the git repositories under the repository base folder. */
  private async discover() {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const config = await fetch('/api/config', { headers: this.headers() })
        .then((response) => (response.ok ? response.json() : {}))
        .catch(() => ({}));
      const base = (config as { repositoryBasePath?: string }).repositoryBasePath || '~';
      const response = await fetch(`/api/repositories/discover?path=${encodeURIComponent(base)}`, {
        headers: this.headers(),
      });
      if (!response.ok) return;
      const found = (await response.json()) as Array<{ path: string }>;
      this.repos = this.unique([...this.repos, ...found.map((repo) => repo.path)]);
    } catch {
      // Nothing more to offer.
    } finally {
      this.discovering = false;
    }
  }

  private async launch() {
    const prompt = this.prompt.trim();
    // Still turning the dictation into text: sending now would throw that text away.
    if (this.busy || !prompt || this.dictation === 'transcribing') return;
    if (!this.repo) {
      this.error = t('compose.pickProject');
      return;
    }
    const agent = this.options.agents[this.agentIndex] ?? {
      agent: 'claude' as const,
      label: 'claude',
      command: ['claude'],
    };
    this.dictationController.cancel();
    this.busy = true;
    this.error = '';
    writePrefs({ repo: this.repo, agent: agent.label, parallel: this.parallel });
    const name = taskTitleFromPrompt(prompt);
    const store = this.options.store ?? taskStore;
    try {
      const result = await store.create({
        name,
        prompt,
        workingDir: this.repo,
        repoPath: this.repo,
        isolation: 'worktree',
        agent: agent.agent,
        command: agent.command,
        parallel: this.parallel,
        ...(this.options.shielded !== undefined ? { shielded: this.options.shielded } : {}),
      });
      if (!result.ok) {
        this.error = t('compose.failed', { error: taskErrorText(result) });
        return;
      }
      if (result.status === 202) {
        // Waiting for the user's OK (its push says so): nothing was launched yet.
        toast({ kind: 'info', text: t('board.toast.pending') });
        this.close();
        return;
      }
      const tasks = (result.data?.tasks as TaskRecord[] | undefined) ?? [];
      toast({
        kind: 'success',
        text:
          this.parallel > 1
            ? t('compose.launchedN', { n: tasks.length || this.parallel, name })
            : t('compose.launched', { name }),
      });
      this.close();
      // Its row on the board, in view (the sheet covered where it lands).
      const first = tasks.find((task) => typeof task?.id === 'string');
      if (first) {
        window.dispatchEvent(new CustomEvent(SHOW_TASK_EVENT, { detail: { taskId: first.id } }));
      }
    } finally {
      this.busy = false;
    }
  }

  private renderRepos() {
    if (!this.repos.length) {
      return html`<p class="ans-note" data-testid="compose-no-projects">${t('compose.noProjects')}</p>`;
    }
    const more = this.tap(() => void this.discover());
    return html`<div class="tks-chips" role="radiogroup" aria-label=${t('compose.project')} data-testid="compose-repos">
      ${this.repos.map((repo) => {
        const on = repo === this.repo;
        const pick = this.tap(() => {
          this.repo = repo;
          this.error = '';
        });
        return html`<button
          type="button"
          role="radio"
          aria-checked=${on ? 'true' : 'false'}
          class="tks-chip ${on ? 'selected' : ''} ut-surface--control"
          title=${formatPathForDisplay(repo)}
          data-repo=${repo}
          @pointerup=${pick}
          @click=${pick}
        >
          ${icon('folder', 14)}<span>${repoName(repo)}</span>
        </button>`;
      })}
      <button
        type="button"
        class="tks-chip tks-chip--more ut-surface--control"
        data-testid="compose-more-projects"
        aria-busy=${this.discovering ? 'true' : 'false'}
        @pointerup=${more}
        @click=${more}
      >
        ${t('compose.moreProjects')}
      </button>
    </div>`;
  }

  private renderAgents() {
    const agents = this.options.agents;
    if (agents.length < 2) return nothing;
    return html`<div class="tks-field">
      <span class="tks-label" id="compose-agent">${t('compose.agent')}</span>
      <div class="tks-seg" role="radiogroup" aria-labelledby="compose-agent" data-testid="compose-agents">
        ${agents.map((agent, index) => {
          const on = index === this.agentIndex;
          const pick = this.tap(() => {
            this.agentIndex = index;
          });
          return html`<button
            type="button"
            role="radio"
            aria-checked=${on ? 'true' : 'false'}
            class=${on ? 'selected' : ''}
            @pointerup=${pick}
            @click=${pick}
          >
            ${agentDisplayLabel(agent)}
          </button>`;
        })}
      </div>
    </div>`;
  }

  private renderParallel() {
    const fewer = this.tap(() => {
      this.parallel = Math.max(1, this.parallel - 1);
    });
    const more = this.tap(() => {
      this.parallel = Math.min(TASK_PARALLEL_MAX, this.parallel + 1);
    });
    return html`<div class="tks-field tks-stepper-row">
      <span class="tks-option-text">
        <span class="tks-option-label">${t('compose.parallel')}</span>
        <span class="tks-hint" data-testid="compose-parallel-hint"
          >${this.parallel > 1 ? t('compose.parallelHint', { n: this.parallel }) : t('compose.parallelOne')}</span
        >
      </span>
      <span class="tks-stepper" data-testid="compose-parallel">
        <button
          type="button"
          aria-label=${t('compose.fewer')}
          data-testid="compose-fewer"
          ?disabled=${this.parallel <= 1}
          @pointerup=${fewer}
          @click=${fewer}
        >
          −
        </button>
        <span class="tks-stepper-value" aria-live="polite">×${this.parallel}</span>
        <button
          type="button"
          aria-label=${t('compose.more')}
          data-testid="compose-more"
          ?disabled=${this.parallel >= TASK_PARALLEL_MAX}
          @pointerup=${more}
          @click=${more}
        >
          +
        </button>
      </span>
    </div>`;
  }

  render() {
    const close = this.tap(this.close);
    const mic = this.tap(() => void this.dictationController.toggle());
    const live = this.dictation !== 'idle' && this.dictation !== 'transcribing';
    const launch = this.tap(() => void this.launch());
    return html`
      <div class="ans-backdrop" @click=${close}></div>
      <div
        class="ans-sheet tks-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-compose-title"
        data-testid="task-compose-sheet"
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="ans-head" data-sheet-handle>
          <div class="ans-head-text">
            <h2 id="task-compose-title" class="ans-title">${t('compose.title')}</h2>
            <p class="ans-subtitle">${t('compose.subtitle')}</p>
          </div>
          <button class="ans-x ut-icon-btn" aria-label=${t('common.close')} @pointerup=${close} @click=${close}>
            ${icon('x', 20)}
          </button>
        </div>
        <div class="ans-body">
          <div class="tks-field">
            <span class="tks-label">${t('compose.project')}</span>
            ${this.renderRepos()}
          </div>
          <div class="tks-field">
            <div class="tks-prompt">
              <textarea
                class="tks-input ut-surface--inset"
                rows="4"
                dir="auto"
                data-testid="compose-prompt"
                aria-label=${t('compose.prompt')}
                placeholder=${t('compose.prompt')}
                .value=${this.prompt}
                @input=${(e: Event) => {
                  this.prompt = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              <button
                type="button"
                class="tks-mic ${live ? 'listening' : ''} ut-surface--control"
                data-testid="compose-mic"
                aria-label=${t(this.dictation === 'idle' ? 'chat.dictate' : 'chat.stopDictation')}
                aria-pressed=${this.dictation === 'idle' ? 'false' : 'true'}
                ?disabled=${this.dictation === 'transcribing'}
                @pointerup=${mic}
                @click=${mic}
              >
                ${
                  this.dictation === 'idle'
                    ? icon('mic', 18)
                    : this.dictation === 'transcribing'
                      ? html`<span class="tsk-spinner" aria-hidden="true"></span>`
                      : icon('stop', 16)
                }
              </button>
            </div>
            ${
              this.dictation !== 'idle' || this.dictationNote
                ? html`<span class="tks-hint" role="status"
                    >${
                      this.dictation === 'transcribing'
                        ? t('dictation.transcribing')
                        : this.dictation !== 'idle'
                          ? t('dictation.recording')
                          : this.dictationNote
                    }</span
                  >`
                : nothing
            }
          </div>
          ${this.renderAgents()} ${this.renderParallel()}
          ${this.error ? html`<p class="ans-error" role="alert" data-testid="compose-error">${this.error}</p>` : nothing}
          <div class="tks-foot">
            <button
              type="button"
              class="tks-primary ut-surface--control ut-surface--primary"
              data-testid="compose-launch"
              aria-busy=${this.busy ? 'true' : 'false'}
              ?disabled=${this.busy || !this.prompt.trim() || !this.repo || this.dictation === 'transcribing'}
              @pointerup=${launch}
              @click=${launch}
            >
              ${this.busy ? html`<span class="tsk-spinner" aria-hidden="true"></span>` : nothing}${this.parallel > 1 ? t('compose.launchN', { n: this.parallel }) : t('compose.launch')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

/** Open the sheet in <body> (one at a time). */
export function openTaskComposeSheet(options: TaskComposeOptions): TaskComposeSheet {
  document.querySelector('task-compose-sheet')?.remove();
  const sheet = document.createElement('task-compose-sheet') as TaskComposeSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'task-compose-sheet': TaskComposeSheet;
  }
}
