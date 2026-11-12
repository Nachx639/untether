/**
 * Session list: drag and drop in the sidebar and the desktop home (2026-11-07, user request:
 * organize
 * the sessions by dragging them). A session dropped on another group is anchored there (the
 * same Session.groupPin as «Mover a…», applyGroupPin); dropped on "Otras" it leaves its
 * project; dropped back on its automatic group its anchor goes. Dropped on another row (by
 * activity, as the group order) it goes before or after it, in its group or another one
 * (TaskStore.saveSessionOrder). A group's header dropped between groups reorders them
 * (TaskStore.saveGroupOrder). Every drop that changes something offers «Deshacer» for 8 s
 * (utils/undo-toast.ts, Cmd+Z too), which puts back exactly what was there: the anchor before
 * (none, another project, "Otras"), the session order and the group order before.
 * The pointer side is utils/list-drag.ts; the keyboard has the menus («Mover a…», «Subir» /
 * «Bajar»).
 *
 * 2026-11-07, first use: «Insights…» dropped on "Otras", then the orchestrator «Bakery»
 * (dragged within bakery, which had no in-group order then) was released over the "Otras"
 * group right below and anchored there. Rows are drop targets of their own now (the line
 * between rows), and the undo puts back a slip.
 */
import { html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import type { Session, SessionGroupPin } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { toast } from '../../utils/action-toast.js';
import { type DragSource, type DropTarget, ListDragController } from '../../utils/list-drag.js';
import {
  anchoredGroupKey,
  groupSessionsByRepo,
  moveSessionInOrder,
  placeInGroup,
} from '../../utils/project-groups.js';
import { applyGroupPin } from '../../utils/session-group-pin.js';
import { isFinishedSession } from '../../utils/session-suspend.js';
import { offerUndo } from '../../utils/undo-toast.js';
import { SessionListPhone } from './list-phone.js';

export abstract class SessionListDrag extends SessionListPhone {
  /** What is being dragged now (drop zones that only show then, such as an empty "Otras"). */
  @state() protected dragKind: DragSource['kind'] | null = null;

  protected readonly listDrag = new ListDragController(this, {
    enabled: () => !this.usePhoneRows() && (this.compactMode || this.groupByRepo),
    start: (source) => {
      this.dragKind = source.kind;
    },
    end: () => {
      this.dragKind = null;
    },
    drop: (source, target) => void this.handleDrop(source, target),
    // Rows take an order of their own only by activity, as the groups (2026-11-07).
    rows: () => this.listSort === 'activity',
  });

  connectedCallback() {
    super.connectedCallback();
    this.listDrag.connect();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.listDrag.disconnect();
  }

  protected async handleDrop(source: DragSource, target: DropTarget) {
    if (source.kind === 'group') {
      const before = [...this.taskBoard.groupOrder];
      // The automatic order is sticky (it starts from the last one shown): put that back too,
      // or an order that was automatic would stay as the drop left it.
      const sticky = { repo: [...this.repoOrder], board: [...this.boardOrder] };
      if (!(await this.moveGroup(source.key, target.key, target.place))) return;
      if (JSON.stringify(before) === JSON.stringify(this.taskBoard.groupOrder)) return;
      offerUndo(t('groupPin.orderChanged'), t('groupPin.undo'), () => {
        this.repoOrder = sticky.repo;
        this.boardOrder = sticky.board;
        void this.saveGroupOrder(before);
      });
      return;
    }
    const session = this.sessions.find((entry) => entry.id === source.id);
    if (!session) return;
    const automatic = this.automaticGroupOf(session);
    const anchored = anchoredGroupKey(session);
    // Its anchor: none where it would be on its own («Quitar ancla», also when the anchor
    // points at that same group: it would no longer follow the automatic grouping), else the
    // group it was dropped on; undefined when it stays as it is.
    let pin: { repoPath: string | null } | null | undefined;
    if (target.key === automatic) {
      if (session.groupPin) pin = null;
    } else if (anchored !== target.key) {
      pin = { repoPath: target.key };
    }
    const orderBefore = [...this.taskBoard.sessionOrder];
    const order = target.row ? this.droppedOrder(session.id, target) : undefined;
    if (pin === undefined && !order) return;
    const pinBefore = session.groupPin ?? null;
    const pinned = pin !== undefined && (await this.pinSession(session.id, pin));
    if (pin !== undefined && !pinned) return;
    // The order may fail after the anchor was saved (review 2026-11-07): the toast already said
    // so, and what was saved (the anchor) can still be undone.
    const ordered = !!order && (await this.saveSessionOrder(order));
    if (!pinned && !ordered) return;
    const text = pinned
      ? t('groupPin.movedTo', {
          group: target.key === null ? t('board.others') : this.getRepoName(target.key),
        })
      : t('groupPin.orderChanged');
    offerUndo(text, t('groupPin.undo'), () => {
      void (async () => {
        if (ordered) await this.saveSessionOrder(orderBefore);
        if (pinned) await this.pinSession(session.id, pinOf(pinBefore));
      })();
    });
  }

  /**
   * The session order once `id` goes before or after `target.row` in `target`'s group, as the
   * group shows now; undefined when the group would look the same.
   */
  protected droppedOrder(id: string, target: DropTarget): string[] | undefined {
    if (!target.row) return undefined;
    const shown = [...target.el.querySelectorAll('[data-drag-session]')]
      .map((el) => el.getAttribute('data-drag-session'))
      .filter((entry): entry is string => !!entry);
    const next = placeInGroup(shown, id, target.row.id, target.place);
    if (shown.includes(id) && next.join('\n') === shown.join('\n')) return undefined;
    return moveSessionInOrder(
      this.taskBoard.sessionOrder,
      shown,
      id,
      target.row.id,
      target.place,
      new Set(this.sessions.map((session) => session.id))
    );
  }

  /** Save a session order; says so when it fails (the one before it is back on screen). */
  protected async saveSessionOrder(order: readonly string[]): Promise<boolean> {
    const result = await this.taskBoard.store.saveSessionOrder(order);
    if (!result.ok) toast({ kind: 'error', text: t('groupPin.sessionOrderFailed') });
    return result.ok;
  }

  /**
   * Anchor a session (null: back to automatic) and regroup the list at once. The row it was
   * dragged from may be gone by then (an undo seconds later): the list regroups itself.
   */
  protected async pinSession(
    id: string,
    pin: { repoPath: string | null } | null
  ): Promise<boolean> {
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) return false;
    const saved = await applyGroupPin(this, session, pin, this.authClient);
    if (saved) {
      this.handleGroupPinned(
        new CustomEvent('session-group-pinned', {
          detail: { sessionId: id, groupPin: session.groupPin ?? null },
        })
      );
    }
    return saved;
  }

  /** The group the layout on screen puts `session` in without its anchor. */
  protected automaticGroupOf(session: Session): string | null {
    const unpinned = { ...session };
    delete unpinned.groupPin;
    const live = this.sessions
      .filter((entry) => !isFinishedSession(entry) && !entry.suspended)
      .map((entry) => (entry.id === session.id ? unpinned : entry));
    if (!live.some((entry) => entry.id === session.id)) live.push(unpinned);
    if (this.compactMode) {
      const groups = groupSessionsByRepo(live, this.repoWorktrees, this.taskBoard.orchestrators);
      for (const [key, sessions] of groups) {
        if (sessions.some((entry) => entry.id === session.id)) return key;
      }
      return null;
    }
    const board = this.projectBoard(live, '', false);
    return (
      board.groups.find((group) => group.sessions.some((s) => s.id === session.id))?.key ?? null
    );
  }

  /**
   * While a session is dragged and no "Otras" group shows: a zone to drop it there, so it can
   * leave its project (2026-11-07: «Insights del canal StarterStoryBuild», opened in ~, fell in
   * bakery by the majority rule, and every other session was in a project).
   */
  protected renderOthersDropZone(othersShown: boolean, compact: boolean) {
    if (this.dragKind !== 'session' || othersShown) return nothing;
    return html`<div
      class="ut-drop-zone ${compact ? 'ut-drop-zone--compact' : 'ut-grid-header'}"
      data-group-key=""
      data-testid="drop-others"
    >
      <span class="ut-section-label">${t('sessions.group.noRepo')}</span>
      <span class="ut-drop-zone-hint">${t('groupPin.dropOthers')}</span>
    </div>`;
  }
}

/** The anchor to save to put `pin` back exactly (the server works out `git` again). */
function pinOf(pin: SessionGroupPin | null): { repoPath: string | null } | null {
  return pin ? { repoPath: pin.repoPath } : null;
}
