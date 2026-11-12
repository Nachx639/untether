/**
 * "Tasks" sheet on the phone: pick a template (or write the prompt), a folder, the agent,
 * shielded or not, on its own branch or not ("En rama aparte": merged into its project when
 * done, shown on the home board), a push when it finishes, and when to run: now, tonight at 2:00 or a time
 * of your choice. Scheduled tasks are listed in a second tab to edit or cancel.
 *
 * The server does the work (POST /api/tasks): it starts the session, types the prompt once
 * the agent is ready, fires scheduled tasks on time and sends the "Task finished" push.
 *
 * Touch acts on pointerup and swallows the click that follows (utils/ghost-click.ts); clicks
 * within 500 ms of opening are ignored (the tap that opened the sheet).
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  nextNightAt2,
  TASK_FINAL_STATES,
  type TaskAgent,
  type TaskRecord,
  type TaskTemplate,
} from '../../shared/tasks.js';
import { type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { taskDetail, taskErrorText } from '../utils/task-status.js';
import { type IconName, icon } from './icons.js';
import './provider-badge.js';

const BUILTIN_IDS = ['tests', 'lint', 'summary', 'deps', 'lastCommit'] as const;

/** The built-in templates, in the user's language. */
export function builtinTemplates(): TaskTemplate[] {
  return BUILTIN_IDS.map((id) => ({
    id: `builtin-${id}`,
    name: t(`tasks.tpl.${id}.name` as MessageKey),
    prompt: t(`tasks.tpl.${id}.prompt` as MessageKey),
  }));
}

type When = 'now' | 'tonight' | 'custom';

/** A request the server turned down: its status and code, told in the user's language. */
class TaskApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(taskErrorText({ ok: false, status, error: code, message: detail }));
  }
}

/** A worktree task that started and is not done: only Descartar removes it (its branch). */
function isOpenWorktreeTask(task: TaskRecord): boolean {
  return (
    task.isolation === 'worktree' &&
    task.state !== 'scheduled' &&
    !TASK_FINAL_STATES.includes(task.state)
  );
}

/** "2026-10-03T14:05" in local time, for <input type="datetime-local">. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface TaskSheetOptions {
  /** Folders to offer, the default first. */
  folders: string[];
  /** The agents' command lines (the user's quick starts). */
  commands: Record<TaskAgent, string[]>;
  agent?: TaskAgent;
  shielded?: boolean;
  /** A task started now: open its session. */
  onStarted?: (sessionId: string) => void;
}

@customElement('task-sheet')
export class TaskSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) options: TaskSheetOptions = {
    folders: ['~'],
    commands: { claude: ['claude'], codex: ['codex'] },
  };

  @state() private tab: 'new' | 'scheduled' = 'new';
  @state() private templates: TaskTemplate[] = [];
  @state() private templateId = '';
  @state() private name = '';
  @state() private prompt = '';
  @state() private folder = '';
  @state() private otherFolder = false;
  @state() private agent: TaskAgent = 'claude';
  @state() private shielded = false;
  @state() private notify = true;
  /** "En rama aparte": a worktree task, merged into its project when done (remembered). */
  @state() private isolated = readIsolated();
  @state() private when: When = 'now';
  @state() private customTime = '';
  @state() private tasks: TaskRecord[] = [];
  @state() private busy = false;
  @state() private error = '';
  /** The scheduled task being edited (its form replaces "new"). */
  @state() private editingId = '';

  private openedAt = 0;
  private actionAt = 0;
  private releaseFocus: (() => void) | null = null;
  private stopKeyboard: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    this.folder = this.options.folders[0] || '~';
    this.agent = this.options.agent ?? 'claude';
    this.shielded = this.options.shielded ?? false;
    void this.loadTemplates();
    void this.loadTasks();
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.task-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.close, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
    // Its sticky Run button stays above the keyboard while the prompt is typed.
    if (sheet) this.stopKeyboard = followKeyboard(sheet);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.stopKeyboard?.();
    this.stopKeyboard = null;
  }

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
    this.remove();
  };

  /** pointerup for touch (click swallowed), click for mouse and keyboard. */
  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < 500) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll of the form that started on a button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.actionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.actionAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...authClient.getAuthHeader(),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (error) {
      throw new TaskApiError(0, error instanceof Error ? error.message : String(error));
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new TaskApiError(
        response.status,
        typeof body.error === 'string' ? body.error : response.statusText,
        typeof body.message === 'string' ? body.message : undefined
      );
    }
    return body as T;
  }

  private async loadTemplates() {
    try {
      const { templates } = await this.api<{ templates: TaskTemplate[] }>('/api/task-templates');
      this.templates = templates;
    } catch {
      this.templates = [];
    }
  }

  private async loadTasks() {
    try {
      const { tasks } = await this.api<{ tasks: TaskRecord[] }>('/api/tasks');
      this.tasks = tasks;
    } catch {
      this.tasks = [];
    }
  }

  private allTemplates(): TaskTemplate[] {
    return [...builtinTemplates(), ...this.templates];
  }

  private pickTemplate(template: TaskTemplate) {
    this.templateId = template.id;
    this.name = template.name;
    this.prompt = template.prompt;
  }

  private isUserTemplate(): boolean {
    return this.templates.some((tpl) => tpl.id === this.templateId);
  }

  private runAt(): Date | null | 'invalid' {
    if (this.when === 'now') return null;
    if (this.when === 'tonight') return nextNightAt2();
    if (!this.customTime) return 'invalid';
    const date = new Date(this.customTime);
    return Number.isNaN(date.getTime()) ? 'invalid' : date;
  }

  private taskName(): string {
    return (this.name.trim() || this.prompt.trim().split('\n')[0]).slice(0, 80);
  }

  private async submit() {
    if (this.busy || !this.prompt.trim()) return;
    const runAt = this.runAt();
    if (runAt === 'invalid') {
      this.error = t('tasks.pickTime');
      return;
    }
    if (runAt && runAt.getTime() < Date.now() - 60_000) {
      this.error = t('tasks.timeInPast');
      return;
    }
    this.busy = true;
    this.error = '';
    const body = {
      name: this.taskName(),
      prompt: this.prompt.trim(),
      workingDir: this.folder.trim() || '~',
      command: this.options.commands[this.agent],
      agent: this.agent,
      shielded: this.shielded,
      notify: this.notify,
      // Editing a scheduled task with "Now": runAt null tells the server to run it at once
      // (a PUT without runAt would keep its old time).
      ...(runAt ? { runAt: runAt.toISOString() } : this.editingId ? { runAt: null } : {}),
      // A scheduled task keeps how it was made: the edit form has no switch for it.
      ...(this.isolated && !this.editingId ? { isolation: 'worktree' } : {}),
    };
    try {
      if (this.editingId) {
        await this.api(`/api/tasks/${encodeURIComponent(this.editingId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        this.editingId = '';
        await this.loadTasks();
        this.tab = 'scheduled';
        return;
      }
      const { task, status } = await this.api<{ task?: TaskRecord; status?: string }>(
        '/api/tasks',
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!task) {
        // 202: the server waits for the user's OK first (its push says so).
        if (status === 'pending-confirmation') {
          toast({ kind: 'info', text: t('board.toast.pending') });
          this.close();
          return;
        }
        throw new TaskApiError(500, 'error', t('tasks.failed'));
      }
      if (task.isolation === 'worktree' && !runAt) {
        // Its row on the home board shows it getting ready: no session to open yet.
        toast({ kind: 'success', text: t('compose.launched', { name: task.name }) });
        void taskStore.refresh();
        this.close();
        return;
      }
      if (task.sessionId && !runAt) {
        this.options.onStarted?.(task.sessionId);
        this.close();
        return;
      }
      await this.loadTasks();
      this.tab = 'scheduled';
    } catch (error) {
      this.error = `${t('tasks.failed')}: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.busy = false;
    }
  }

  private async saveTemplate() {
    const name = this.taskName();
    if (!name || !this.prompt.trim()) return;
    try {
      if (this.isUserTemplate()) {
        await this.api(`/api/task-templates/${encodeURIComponent(this.templateId)}`, {
          method: 'PUT',
          body: JSON.stringify({ name, prompt: this.prompt }),
        });
      } else {
        const { template } = await this.api<{ template: TaskTemplate }>('/api/task-templates', {
          method: 'POST',
          body: JSON.stringify({ name, prompt: this.prompt }),
        });
        this.templateId = template.id;
      }
      await this.loadTemplates();
    } catch (error) {
      this.error = String(error instanceof Error ? error.message : error);
    }
  }

  private async deleteTemplate() {
    const template = this.templates.find((tpl) => tpl.id === this.templateId);
    if (
      !template ||
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('tasks.deleteTemplateConfirm', { name: template.name }),
        confirmLabel: t('tasks.deleteTemplate'),
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      await this.api(`/api/task-templates/${encodeURIComponent(template.id)}`, {
        method: 'DELETE',
      });
      this.templateId = '';
      await this.loadTemplates();
    } catch (error) {
      this.error = String(error instanceof Error ? error.message : error);
    }
  }

  private async removeTask(task: TaskRecord) {
    if (isOpenWorktreeTask(task)) {
      await this.discardTask(task);
      return;
    }
    if (
      task.state === 'scheduled' &&
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('tasks.cancelConfirm', { name: task.name }),
        confirmLabel: t('tasks.cancelTask'),
        cancelLabel: t('board.action.keepScheduled'),
        tone: 'danger',
      }))
    ) {
      return;
    }
    this.error = '';
    try {
      await this.api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      await this.loadTasks();
    } catch (error) {
      this.error = String(error instanceof Error ? error.message : error);
    }
  }

  /**
   * An open worktree task: "Quitar" was refused (it still has its branch, 2026-10-20 audit), so
   * it is discarded like on the home board, asking first.
   */
  private async discardTask(task: TaskRecord) {
    const ok = await confirmDialog({
      title: t('board.discardTitle', { name: task.name }),
      body: t('board.discardBody'),
      confirmLabel: t('board.action.discard'),
      tone: 'danger',
      details: task.files.slice(0, 6),
    });
    if (!ok) return;
    this.error = '';
    const result = await taskStore.act(task.id, 'discard', { confirm: true });
    if (!result.ok) {
      this.error = t('board.toast.failed', { error: taskErrorText(result) });
      return;
    }
    if (result.status === 202) toast({ kind: 'info', text: t('board.toast.pending') });
    else toast({ kind: 'success', text: t('board.toast.discarded', { name: task.name }) });
    await this.loadTasks();
  }

  private editTask(task: TaskRecord) {
    this.editingId = task.id;
    this.templateId = '';
    this.name = task.name;
    this.prompt = task.prompt;
    this.folder = task.workingDir;
    this.otherFolder = !this.options.folders.includes(task.workingDir);
    this.agent = task.agent;
    this.shielded = task.shielded;
    this.notify = task.notify;
    this.when = 'custom';
    this.customTime = toLocalInputValue(new Date(task.runAt));
    this.tab = 'new';
  }

  private formatTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private stateLabel(task: TaskRecord): string {
    switch (task.state) {
      case 'scheduled':
        return t('tasks.state.scheduled', { time: this.formatTime(task.runAt) });
      case 'failed':
        return t('tasks.state.failed', {
          error: (task.blocker ? taskDetail(task) : '') || task.error || '',
        });
      case 'missed':
        return t('tasks.state.missed');
      case 'preparing':
      case 'working':
      case 'needs_you':
      case 'paused':
      case 'verifying':
      case 'merging':
        return t('tasks.state.running');
      default:
        // ready, merged, discarded: the agent is done with it.
        return t('tasks.state.finished');
    }
  }

  private segment<T extends string>(
    label: string,
    value: T,
    options: Array<[T, string]>,
    set: (value: T) => void,
    testid: string
  ) {
    return html`<div class="task-row">
      <span class="task-label">${label}</span>
      <span class="task-seg" role="radiogroup" aria-label=${label} data-testid=${testid}>
        ${options.map(
          ([option, text]) => html`<button
            type="button"
            role="radio"
            aria-checked=${option === value ? 'true' : 'false'}
            class=${option === value ? 'selected' : ''}
            data-value=${option}
            @pointerup=${this.tap(() => set(option))}
            @click=${this.tap(() => set(option))}
          >${text}</button>`
        )}
      </span>
    </div>`;
  }

  private toggle(
    label: string,
    on: boolean,
    set: (on: boolean) => void,
    testid: string,
    glyph?: IconName
  ) {
    return html`<button
      type="button"
      role="switch"
      class="ut-surface--inset task-switch"
      aria-checked=${on ? 'true' : 'false'}
      data-testid=${testid}
      @pointerup=${this.tap(() => set(!on))}
      @click=${this.tap(() => set(!on))}
    >
      <span class="task-switch-label"
        >${glyph ? html`<span class="task-switch-icon" aria-hidden="true">${icon(glyph, 16)}</span>` : nothing}${label}</span
      >
      <span class="task-knob ${on ? 'on' : ''}" aria-hidden="true"><span></span></span>
    </button>`;
  }

  private renderNew() {
    const folders = this.options.folders;
    const editing = this.tasks.find((task) => task.id === this.editingId);
    const primary = this.editingId
      ? t('tasks.saveChanges')
      : this.when === 'now'
        ? t('tasks.runNow')
        : t('tasks.schedule');
    return html`
      ${editing ? html`<div class="task-note">${t('tasks.editing', { name: editing.name })}</div>` : nothing}
      <div class="task-chips" role="listbox" aria-label=${t('tasks.template')} data-testid="task-templates">
        ${this.allTemplates().map(
          (template) => html`<button
            type="button"
            role="option"
            aria-selected=${template.id === this.templateId ? 'true' : 'false'}
            class="task-chip ${template.id === this.templateId ? 'selected' : ''} ut-surface--control"
            data-id=${template.id}
            @pointerup=${this.tap(() => this.pickTemplate(template))}
            @click=${this.tap(() => this.pickTemplate(template))}
          >${template.name}</button>`
        )}
      </div>
      <input
        class="task-input ut-surface--inset"
        data-testid="task-name"
        aria-label=${t('tasks.name')}
        placeholder=${t('tasks.name')}
        maxlength="80"
        .value=${this.name}
        @input=${(e: Event) => {
          this.name = (e.target as HTMLInputElement).value;
        }}
      />
      <textarea
        class="task-input ut-surface--inset"
        rows="3"
        dir="auto"
        data-testid="task-prompt"
        aria-label=${t('tasks.prompt')}
        placeholder=${t('tasks.prompt')}
        .value=${this.prompt}
        @input=${(e: Event) => {
          this.prompt = (e.target as HTMLTextAreaElement).value;
        }}
      ></textarea>
      <div class="task-hint">${t('tasks.placeholdersHint')}</div>
      <div class="task-tpl-actions">
        ${
          this.prompt.trim()
            ? html`<button
                type="button"
                data-testid="task-save-template"
                @pointerup=${this.tap(() => void this.saveTemplate())}
                @click=${this.tap(() => void this.saveTemplate())}
              >${this.isUserTemplate() ? t('tasks.updateTemplate') : t('tasks.saveTemplate')}</button>`
            : nothing
        }
        ${
          this.isUserTemplate()
            ? html`<button
                type="button"
                class="ut-surface--badge destructive"
                data-testid="task-delete-template"
                @pointerup=${this.tap(() => void this.deleteTemplate())}
                @click=${this.tap(() => void this.deleteTemplate())}
              >${t('tasks.deleteTemplate')}</button>`
            : nothing
        }
      </div>
      <label class="task-row">
        <span class="task-label">${t('tasks.folder')}</span>
        <select
          class="task-input task-select ut-surface--inset"
          data-testid="task-folder"
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this.otherFolder = value === '__other__';
            if (!this.otherFolder) this.folder = value;
          }}
        >
          ${folders.map(
            (folder) =>
              html`<option value=${folder} ?selected=${!this.otherFolder && folder === this.folder}>${formatPathForDisplay(folder)}</option>`
          )}
          <option value="__other__" ?selected=${this.otherFolder}>${t('tasks.otherFolder')}</option>
        </select>
      </label>
      ${
        this.otherFolder
          ? html`<input
              class="task-input mono ut-surface--inset"
              data-testid="task-folder-other"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              placeholder="~/Projects/app"
              .value=${folders.includes(this.folder) ? '' : this.folder}
              @input=${(e: Event) => {
                this.folder = (e.target as HTMLInputElement).value;
              }}
            />`
          : nothing
      }
      ${this.segment<TaskAgent>(
        t('tasks.agent'),
        this.agent,
        [
          ['claude', 'Claude'],
          ['codex', 'Codex'],
        ],
        (agent) => {
          this.agent = agent;
        },
        'task-agent'
      )}
      ${
        this.editingId
          ? nothing
          : html`${this.toggle(
              t('tasks.isolated'),
              this.isolated,
              (on) => {
                this.isolated = on;
                writeIsolated(on);
              },
              'task-isolated',
              'gitBranch'
            )}${this.isolated ? html`<div class="task-hint">${t('tasks.isolatedHint')}</div>` : nothing}`
      }
      ${this.toggle(
        t('tasks.shielded'),
        this.shielded,
        (on) => {
          this.shielded = on;
        },
        'task-shielded',
        'shield'
      )}
      ${this.toggle(
        t('tasks.notify'),
        this.notify,
        (on) => {
          this.notify = on;
        },
        'task-notify',
        'bell'
      )}
      ${this.segment<When>(
        t('tasks.when'),
        this.when,
        [
          ['now', t('tasks.whenNow')],
          ['tonight', t('tasks.whenTonight')],
          ['custom', t('tasks.whenCustom')],
        ],
        (when) => {
          this.when = when;
          if (when === 'custom' && !this.customTime) {
            this.customTime = toLocalInputValue(new Date(Date.now() + 60 * 60_000));
          }
        },
        'task-when'
      )}
      ${
        this.when === 'custom'
          ? html`<input
              type="datetime-local"
              class="task-input ut-surface--inset"
              data-testid="task-time"
              aria-label=${t('tasks.pickTime')}
              min=${toLocalInputValue(new Date())}
              .value=${this.customTime}
              @input=${(e: Event) => {
                this.customTime = (e.target as HTMLInputElement).value;
              }}
              @change=${(e: Event) => {
                this.customTime = (e.target as HTMLInputElement).value;
              }}
            />`
          : nothing
      }
      ${this.error ? html`<div class="task-error" role="alert">${this.error}</div>` : nothing}
      <button
        type="button"
        class="task-primary ut-surface--control ut-surface--primary"
        data-testid="task-submit"
        ?disabled=${this.busy || !this.prompt.trim()}
        @pointerup=${this.tap(() => void this.submit())}
        @click=${this.tap(() => void this.submit())}
      >${primary}</button>
    `;
  }

  /** A tab's own error only: the other tab's would read as about this one. */
  private switchTab(tab: 'new' | 'scheduled') {
    if (tab !== this.tab) this.error = '';
    this.tab = tab;
    if (tab === 'scheduled') void this.loadTasks();
  }

  private removeLabel(task: TaskRecord): string {
    if (task.state === 'scheduled') return t('tasks.cancelTask');
    return isOpenWorktreeTask(task) ? t('board.action.discard') : t('tasks.remove');
  }

  private renderScheduled() {
    const order = (task: TaskRecord) => (task.state === 'scheduled' ? 0 : 1);
    const tasks = [...this.tasks].sort(
      (a, b) =>
        order(a) - order(b) ||
        (order(a) === 0
          ? Date.parse(a.runAt) - Date.parse(b.runAt)
          : Date.parse(b.runAt) - Date.parse(a.runAt))
    );
    // Its own error line: a failed Cancelar/Quitar said nothing on this tab (2026-10-20 audit).
    const error = this.error
      ? html`<div class="task-error" role="alert" data-testid="task-scheduled-error">${this.error}</div>`
      : nothing;
    if (!tasks.length) {
      return html`${error}<div class="task-note">${t('tasks.noScheduled')}</div>`;
    }
    return html`${error}<ul class="task-list" data-testid="task-list">
      ${tasks.map(
        (
          task
        ) => html`<li class="task-item ut-surface--panel ut-surface--material" data-state=${task.state} data-id=${task.id}>
          <div class="task-item-main">
            <div class="task-item-name">${task.name}</div>
            <div class="task-item-meta"><bdi>${formatPathForDisplay(task.workingDir)}</bdi> · ${this.stateLabel(task)}${
              task.shielded
                ? html` · <span class="task-item-shield" role="img" aria-label=${t('shield.badge')}
                      >${icon('shield', 12)}</span
                    >`
                : nothing
            }${
              task.modelProvider
                ? html` · <ut-provider-badge
                      data-testid="task-item-provider-badge"
                      .providerId=${task.modelProvider}
                      .model=${task.model}
                    ></ut-provider-badge>`
                : nothing
            }</div>
          </div>
          <div class="task-item-actions">
            ${
              task.state === 'scheduled'
                ? html`<button
                    type="button"
                    data-action="edit"
                    @pointerup=${this.tap(() => this.editTask(task))}
                    @click=${this.tap(() => this.editTask(task))}
                  >${t('tasks.edit')}</button>`
                : task.sessionId
                  ? html`<button
                      type="button"
                      data-action="open"
                      @pointerup=${this.tap(() => {
                        this.options.onStarted?.(task.sessionId as string);
                        this.close();
                      })}
                      @click=${this.tap(() => {
                        this.options.onStarted?.(task.sessionId as string);
                        this.close();
                      })}
                    >${t('tasks.openSession')}</button>`
                  : nothing
            }
            <button
              type="button"
              class="ut-surface--badge destructive"
              data-action=${isOpenWorktreeTask(task) ? 'discard' : 'remove'}
              data-testid="task-item-remove"
              @pointerup=${this.tap(() => void this.removeTask(task))}
              @click=${this.tap(() => void this.removeTask(task))}
            >${this.removeLabel(task)}</button>
          </div>
        </li>`
      )}
    </ul>`;
  }

  render() {
    const scheduledCount = this.tasks.filter((task) => task.state === 'scheduled').length;
    return html`
      <style>
        .task-sheet { position: fixed; left: max(8px, env(safe-area-inset-left, 0px));
          right: max(8px, env(safe-area-inset-right, 0px)); bottom: calc(8px + env(safe-area-inset-bottom, 0px));
          top: calc(24px + env(safe-area-inset-top, 0px)); max-width: 560px; margin: 0 auto; z-index: 2001;
          display: flex; flex-direction: column; border-radius: var(--ut-r-16); overflow: hidden;
          background: var(--color-bg-elevated); color: var(--color-text); border: 1px solid var(--color-border);
          font-family: var(--ut-font-ui-system);
          transform: translateY(110%); transition: transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1); }
        .task-sheet.open { transform: translateY(0); }
        .task-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px;
          border-bottom: 1px solid var(--color-border-light); }
        .task-tabs { display: flex; flex: 1; gap: 4px; }
        .task-tabs button, .task-close { padding: 8px 12px; border-radius: var(--ut-r-lg); font-size: 15px;
          color: var(--color-text-dim); min-height: 40px; }
        .task-tabs button.selected { background: var(--color-bg-tertiary); color: var(--color-text); font-weight: var(--ut-fw-semibold); }
        .task-close { color: var(--color-primary-text); }
        .task-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px;
          display: flex; flex-direction: column; gap: 10px; }
        .task-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .task-chip { padding: 8px 12px; border-radius: var(--ut-r-pill); font-size: 14px; min-height: 36px;
          background: var(--color-bg-tertiary); color: var(--color-text); border: 1px solid var(--color-border-light); }
        .task-chip.selected { background: var(--color-primary); color: var(--ut-text-on-solid); border-color: var(--color-primary); }
        .task-input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: var(--ut-r-lg);
          font-size: 16px; background: var(--color-bg); color: var(--color-text); border: 1px solid var(--color-border); }
        .task-input.mono { font-family: var(--ut-font-mono-system); }
        textarea.task-input { resize: vertical; min-height: 84px; }
        .task-select { flex: 1; width: auto; min-width: 0; }
        .task-hint, .task-note { font-size: 13px; color: var(--color-text-dim); }
        .task-note { padding: 8px 0; }
        .task-tpl-actions { display: flex; gap: 12px; flex-wrap: wrap; }
        .task-tpl-actions button { font-size: 14px; color: var(--color-primary-text); padding: 4px 0; min-height: 32px; }
        .task-sheet .destructive { color: var(--color-status-error); }
        .task-row { display: flex; align-items: center; gap: 10px; }
        .task-label { flex: none; font-size: 14px; color: var(--color-text-dim); min-width: 64px; }
        .task-seg { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; padding: 3px; border-radius: var(--ut-r-lg);
          background: var(--color-bg-tertiary); }
        .task-seg button { flex: 1; padding: 8px 6px; border-radius: var(--ut-r-8); font-size: 14px; min-height: 36px;
          color: var(--color-text); white-space: nowrap; }
        .task-seg button.selected { background: var(--color-bg-elevated); font-weight: var(--ut-fw-semibold);
          box-shadow: var(--ut-drop-3-20); }
        .task-switch { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          width: 100%; padding: 8px 0; font-size: 15px; color: var(--color-text); text-align: start; min-height: 40px; }
        .task-knob { flex: none; width: 42px; height: 26px; border-radius: var(--ut-r-13); position: relative;
          background: var(--color-bg-tertiary); transition: background 0.15s; }
        .task-knob.on { background: var(--color-primary); }
        .task-switch-label { display: inline-flex; align-items: center; gap: 8px; }
        .task-switch-icon { display: inline-flex; color: var(--color-text-muted); }
        .task-item-shield { display: inline-flex; vertical-align: -1px; }
        .task-knob span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: var(--ut-r-circle);
          background: var(--ut-knob); transition: left 0.15s; }
        .task-knob.on span { left: 19px; }
        [dir='rtl'] .task-knob span { left: auto; right: 3px; }
        [dir='rtl'] .task-knob.on span { right: 19px; }
        .task-error { font-size: 14px; color: var(--color-status-error); }
        /* Pinned to the bottom of the scrolling form, with a band of the sheet's own colour
           around it: on an iPhone SE it sat below the form, out of sight (2026-10-03). */
        .task-primary { padding: 14px; border-radius: var(--ut-r-12); font-size: 17px; font-weight: var(--ut-fw-semibold);
          background: var(--color-primary); color: var(--ut-text-on-solid);
          position: sticky; bottom: 0; z-index: 1; flex-shrink: 0;
          box-shadow: 0 var(--ut-glow-0-12) var(--color-bg-elevated); }
        /* Opaque when disabled: the form scrolls beneath it, and see-through it showed through. */
        .task-primary:disabled { background: color-mix(in srgb, var(--color-primary) 45%, var(--color-bg-elevated)); }
        .task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .task-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--ut-r-12);
          background: var(--color-bg-tertiary); }
        .task-item-main { flex: 1; min-width: 0; }
        .task-item-name { font-size: 15px; font-weight: var(--ut-fw-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .task-item-meta { font-size: 13px; color: var(--color-text-dim); overflow-wrap: anywhere; }
        .task-item-actions { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
        .task-item-actions button { font-size: 14px; color: var(--color-primary-text); padding: 4px 2px; min-height: 32px; }
      </style>
      <div class="psr-sheet-backdrop" @click=${this.tap(this.close)}></div>
      <div class="task-sheet ut-surface--floating ut-surface--material ut-surface--fixed" role="dialog" aria-modal="true" aria-label=${t('tasks.title')} data-testid="task-sheet">
        <div class="task-head">
          <div class="task-tabs" role="tablist">
            <button
              role="tab"
              aria-selected=${this.tab === 'new' ? 'true' : 'false'}
              class=${this.tab === 'new' ? 'selected' : ''}
              data-testid="task-tab-new"
              @pointerup=${this.tap(() => this.switchTab('new'))}
              @click=${this.tap(() => this.switchTab('new'))}
            >${this.editingId ? t('tasks.edit') : t('tasks.tabNew')}</button>
            <button
              role="tab"
              aria-selected=${this.tab === 'scheduled' ? 'true' : 'false'}
              class=${this.tab === 'scheduled' ? 'selected' : ''}
              data-testid="task-tab-scheduled"
              @pointerup=${this.tap(() => this.switchTab('scheduled'))}
              @click=${this.tap(() => this.switchTab('scheduled'))}
            >${t('tasks.tabScheduled', { n: scheduledCount })}</button>
          </div>
          <button class="ut-surface--control task-close" data-testid="task-close" @click=${this.close}>${t('common.close')}</button>
        </div>
        <div class="task-body">${this.tab === 'new' ? this.renderNew() : this.renderScheduled()}</div>
      </div>
    `;
  }
}

const ISOLATED_KEY = 'ut-task-isolated';

function readIsolated(): boolean {
  try {
    return localStorage.getItem(ISOLATED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeIsolated(on: boolean) {
  try {
    localStorage.setItem(ISOLATED_KEY, on ? '1' : '0');
  } catch {
    // Blocked storage: the switch starts off next time.
  }
}

/** Open the tasks sheet in <body> (the phone sidebar's transform would trap position:fixed). */
export function openTaskSheet(options: TaskSheetOptions): TaskSheet {
  document.querySelector('task-sheet')?.remove();
  const sheet = document.createElement('task-sheet') as TaskSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'task-sheet': TaskSheet;
  }
}
