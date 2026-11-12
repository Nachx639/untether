/**
 * Session list: «Te necesita» (2026-11-08, Herdr's triage), on the phone list and the desktop
 * home. Everything that waits for the user (sessions asking, tasks needs_you / failed / ready
 * / paused, actions waiting for the OK) in one list ordered by urgency (utils/needs-you.ts):
 * each row says why in one line and has the one button that moves it on (Responder,
 * Fusionar, Abrir). A few rows show; «+n más» and «Solo esto» show only this section, the
 * rest of the home hidden (the desktop's «Te necesitan» filter). It is its own section above
 * the groups: their order (groupOrder, dragged headers) is untouched.
 */
import { html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sessionProviderMarker } from '../../../shared/model-providers.js';
import type { TaskRecord } from '../../../shared/tasks.js';
import type { Session } from '../../../shared/types.js';
import { confirmSeenKey, needsYouSeenKey } from '../../../shared/ws-v3.js';
import { t } from '../../i18n/index.js';
import { midCutTitle } from '../../utils/card-line.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { type NeedsYouItem, needsYouItems } from '../../utils/needs-you.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import { closeResolvedNotifications } from '../../utils/resolved-notifications.js';
import { deriveSessionStatus } from '../../utils/session-status.js';
import { isDoneTask, taskActionLabel, taskDisplayTitle } from '../../utils/task-status.js';
import { agentLogo } from '../agent-avatar.js';
import { agentKind, icon } from '../icons.js';
import { sessionDisplayName } from '../session-card.js';
import { announceTaskResult, type TaskRow } from '../task-row.js';
import { SessionListSections } from './list-sections.js';

/** Rows shown before «+n más»: the phone keeps the list in reach, the desktop has room. */
const SHOWN: Record<'phone' | 'desktop', number> = { phone: 3, desktop: 5 };

export abstract class SessionListNeedsYou extends SessionListSections {
  /** The phone's «Solo esto»: only the «Te necesita» section (not remembered: a list that
   * hid everything after a reload would look empty). The desktop uses its filter. */
  @state() protected needsOnly = false;

  /** What waits for the user now, most urgent first (live sessions, open tasks). */
  protected needsYou(sessions: Session[], tasks: TaskRecord[]): NeedsYouItem[] {
    return needsYouItems({
      sessions,
      tasks,
      confirmations: this.taskBoard.confirmations,
      closed: this.taskBoard.tasks.filter(isDoneTask),
    });
  }

  private waitingStamp = '';

  /** Notifications about what stopped waiting go too (only with the tasks really loaded). */
  protected updated(changed: Map<PropertyKey, unknown>) {
    super.updated(changed);
    if (!this.taskBoard.store.loaded) return;
    const view = {
      sessions: this.sessions,
      tasks: this.taskBoard.tasks,
      confirmations: this.taskBoard.confirmations,
    };
    const stamp = JSON.stringify([
      view.sessions.map((session) => [session.id, session.status, session.claudeStatus?.status]),
      view.tasks.map((task) => [task.id, task.state]),
      view.confirmations.map((confirmation) => confirmation.id),
    ]);
    if (stamp === this.waitingStamp) return;
    this.waitingStamp = stamp;
    void closeResolvedNotifications(view);
  }

  /** «Solo esto» is on (and there is something to show). */
  protected needsOnlyOn(layout: 'phone' | 'desktop', items: readonly NeedsYouItem[]): boolean {
    if (!items.length) return false;
    return layout === 'phone' ? this.needsOnly : this.listFilter === 'attention';
  }

  protected setNeedsOnly(layout: 'phone' | 'desktop', on: boolean) {
    if (layout === 'phone') this.needsOnly = on;
    else this.setFilter(on ? 'attention' : 'all');
  }

  private openAnswer(sessionId: string) {
    window.dispatchEvent(new CustomEvent('ut-open-answer-sheet', { detail: { sessionId } }));
  }

  private openSession(session: Session) {
    this.handleSessionSelect({ detail: session } as CustomEvent);
  }

  /**
   * Its row into view and glowing. With «Solo esto» on the rows are not on screen: the whole
   * list comes back first (2026-11-08 review: «Abrir» did nothing there).
   */
  private async revealTaskRow(taskId: string) {
    if (!this.taskRow(taskId) && (this.needsOnly || this.listFilter === 'attention')) {
      this.needsOnly = false;
      if (this.listFilter === 'attention') this.setFilter('all');
      await this.rowsRendered();
    }
    await this.revealTask(taskId);
  }

  private taskRow(taskId: string): TaskRow | null {
    return this.querySelector<TaskRow>(`task-row[data-task="${CSS.escape(taskId)}"]`);
  }

  /** A tap on the row itself: the phone answers what can be answered; else as before. */
  private openItem(item: NeedsYouItem, layout: 'phone' | 'desktop') {
    if (item.kind === 'confirmation') {
      this.openConfirmation(item.confirmation.id);
    } else if (item.kind === 'session') {
      if (layout === 'phone') this.openAnswer(item.session.id);
      else this.openSession(item.session);
    } else if (
      layout === 'phone' &&
      item.session &&
      deriveSessionStatus(item.session) === 'needs-input'
    ) {
      this.openAnswer(item.session.id);
    } else {
      void this.revealTaskRow(item.task.id);
    }
  }

  /** Its button. */
  private actOn(item: NeedsYouItem) {
    switch (item.action) {
      case 'confirm':
        if (item.kind === 'confirmation') this.openConfirmation(item.confirmation.id);
        return;
      case 'answer':
        if (item.kind === 'session') this.openAnswer(item.session.id);
        else if (item.kind === 'task' && item.session) this.openAnswer(item.session.id);
        return;
      case 'merge': {
        if (item.kind !== 'task') return;
        const row = this.taskRow(item.task.id);
        if (row) void row.mergeFromNeedsYou();
        else void this.mergeWithoutRow(item.task, item.session);
        return;
      }
      default:
        if (item.kind === 'session') this.openSession(item.session);
        else if (item.kind === 'task' && item.session) this.openSession(item.session);
        else if (item.kind === 'task') void this.revealTaskRow(item.task.id);
    }
  }

  /** Tasks whose merge from the section is on its way (its button waits). */
  @state() protected needsMerging = new Set<string>();

  /**
   * «Fusionar» with its row not on screen («Solo esto», a search): the plain merge, with the
   * row's toasts. One of a parallel group is kept, not merged, and that asks first: the home
   * comes back with its row in view instead.
   */
  private async mergeWithoutRow(task: TaskRecord, session: Session | undefined) {
    if (task.groupId) {
      await this.revealTaskRow(task.id);
      return;
    }
    if (this.needsMerging.has(task.id)) return;
    this.needsMerging = new Set([...this.needsMerging, task.id]);
    try {
      const result = await this.taskBoard.store.act(task.id, 'merge');
      announceTaskResult(
        result,
        t('board.toast.merging', { name: taskDisplayTitle(task, session) }),
        'merge'
      );
      if (result.ok) await this.taskBoard.store.refresh();
    } finally {
      const next = new Set(this.needsMerging);
      next.delete(task.id);
      this.needsMerging = next;
    }
  }

  /** pointerup for touch (the click that follows is swallowed), click for mouse and keys. */
  private tapped(fn: () => void) {
    let touchedAt = 0;
    return {
      handleEvent: (e: Event) => {
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse' || endsADrag(p)) return;
          touchedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - touchedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private itemTitle(item: NeedsYouItem): string {
    if (item.kind === 'confirmation') {
      return t('board.confirmPill', { where: item.confirmation.where });
    }
    if (item.kind === 'session') return sessionDisplayName(item.session);
    return taskDisplayTitle(item.task, item.session);
  }

  private itemGlyph(item: NeedsYouItem) {
    if (item.kind === 'confirmation') return icon('shield', 16);
    if (item.kind === 'session') {
      return agentLogo(agentKind(item.session), sessionProviderMarker(item.session));
    }
    const { agent, modelProvider, model } = item.task;
    const provider = modelProvider ? { id: modelProvider, model } : undefined;
    return agentLogo(agent === 'codex' ? 'codex' : 'claude', provider);
  }

  private actionLabel(item: NeedsYouItem): string {
    if (item.action === 'answer' || item.action === 'confirm') return t('phone.reply');
    return taskActionLabel(item.action === 'merge' ? 'merge' : 'open');
  }

  private renderItem(item: NeedsYouItem, layout: 'phone' | 'desktop') {
    const testId =
      item.kind === 'session'
        ? 'needs-you-pill'
        : item.kind === 'task'
          ? 'needs-you-task-pill'
          : 'needs-you-confirm-pill';
    const seenKey =
      item.kind === 'task'
        ? needsYouSeenKey(item.task.id)
        : item.kind === 'confirmation'
          ? confirmSeenKey(item.confirmation.id)
          : nothing;
    const open = this.tapped(() => this.openItem(item, layout));
    const act = this.tapped(() => this.actOn(item));
    const title = this.itemTitle(item);
    return html`<li class="ut-needs-item ut-surface--material ut-surface--request" data-tier=${item.tier} data-action=${item.action} data-key=${item.key}>
      <button
        type="button"
        class="ut-needs-main"
        data-testid=${testId}
        data-seen-key=${seenKey}
        aria-label=${item.line ? `${title}, ${item.line}` : title}
        @pointerup=${open}
        @click=${open}
      >
        ${this.itemGlyph(item)}
        <span class="ut-needs-text">
          <span class="ut-needs-name ut-mid" dir="auto">${midCutTitle(title)}</span>
          ${
            item.line
              ? html`<span class="ut-needs-line" data-testid="needs-you-line" dir="auto"
                  >${item.line}</span
                >`
              : nothing
          }
        </span>
        ${
          item.since
            ? html`<span class="ut-needs-time"
                ><ut-row-time at=${new Date(item.since).toISOString()}></ut-row-time
              ></span>`
            : nothing
        }
      </button>
      <button
        type="button"
        class="ut-needs-act ut-surface--request-action ut-surface--material ut-surface--action ut-surface--primary ${item.action === 'merge' ? 'ut-needs-act--merge' : ''}"
        id="needs-you-action-${item.key.replace(/[^\w-]/g, '-')}"
        data-testid="needs-you-action"
        data-action=${item.action}
        ?disabled=${item.kind === 'task' && this.needsMerging.has(item.task.id)}
        @pointerup=${act}
        @click=${act}
      >
        ${this.actionLabel(item)}
      </button>
    </li>`;
  }

  /**
   * The section: nothing when nothing waits. `items` from needsYou(); the head's toggle shows
   * only this section («Solo esto») or everything again («Ver todo»).
   */
  protected renderNeedsYouSection(items: NeedsYouItem[], layout: 'phone' | 'desktop') {
    if (!items.length) return nothing;
    const only = this.needsOnlyOn(layout, items);
    const shown = only ? items : items.slice(0, SHOWN[layout]);
    const hidden = items.length - shown.length;
    const label =
      layout === 'phone'
        ? t('phone.needsYouStrip', { n: items.length })
        : `${t('sessions.needsYouStrip')} (${items.length})`;
    const toggle = this.tapped(() => this.setNeedsOnly(layout, !only));
    const more = this.tapped(() => this.setNeedsOnly(layout, true));
    return html`<section
      class="ut-needs ut-needs--${layout}"
      role="group"
      aria-label=${label}
      data-testid="needs-you-strip"
    >
      <div class="ut-needs-head">
        <span class="ut-needs-label">${label}</span>
        <button
          type="button"
          class="ut-needs-toggle"
          id="needs-you-only-toggle"
          data-testid="needs-you-only-toggle"
          aria-pressed=${only ? 'true' : 'false'}
          @pointerup=${toggle}
          @click=${toggle}
        >
          ${only ? t('needsYou.showAll') : t('needsYou.onlyThis')}
        </button>
      </div>
      <ul class="ut-needs-list" data-testid="needs-you-list">
        ${repeat(
          shown,
          (item) => item.key,
          (item) => this.renderItem(item, layout)
        )}
      </ul>
      ${
        hidden > 0
          ? html`<button
              type="button"
              class="ut-needs-more"
              id="needs-you-more"
              data-testid="needs-you-more"
              @pointerup=${more}
              @click=${more}
            >
              ${t('needsYou.more', { n: hidden })}${icon('chevronRight', 14)}
            </button>`
          : nothing
      }
    </section>`;
  }
}
