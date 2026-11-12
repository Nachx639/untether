/**
 * Session list base: properties, shared state, popovers, action sheets, list options and
 * the session card events every layout uses.
 */
import { html, LitElement, nothing, render } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { MacSessionsResponse } from '../../../shared/mac-sessions.js';
import type { Session } from '../../../shared/types.js';
import { HttpMethod } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { AuthClient } from '../../services/auth-client.js';
import type { Worktree } from '../../services/git-service.js';
import { serverConfigService } from '../../services/server-config-service.js';
import { TaskStoreController } from '../../services/task-store.js';
import { toast } from '../../utils/action-toast.js';
import { confirmDialog } from '../../utils/confirm-dialog.js';
import {
  type ActionSheetItem,
  actionItems,
  PhoneActionSheet,
} from '../../utils/phone-action-sheet.js';
import { currentPhoneListLayout, type PhoneListLayout } from '../../utils/phone-list-layout.js';
import {
  menuKeyboard,
  type PopoverPlacement,
  positionPopover,
} from '../../utils/popover-position.js';
import type { PreviewItem } from '../../utils/preview-rows.js';
import { normalizeRepoPath } from '../../utils/repo-key.js';
import { deriveSessionStatus } from '../../utils/session-status.js';
import { isFinishedSession } from '../../utils/session-suspend.js';
import { ShortLandscapeController } from '../../utils/short-landscape.js';
import { agentKind, icon } from '../icons.js';
import { sessionDisplayName } from '../session-card.js';
import {
  basename,
  isPhoneListLayout,
  LIST_FILTERS,
  LIST_SORTS,
  LIST_VIEWS,
  type ListFilter,
  type ListSort,
  type ListView,
  logger,
  readListPref,
  readNewShieldedChoice,
  writeListPref,
  writeNewShielded,
} from './list-shared.js';

export abstract class SessionListBase extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);
  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) hideExited = true;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: String }) selectedSessionId: string | null = null;
  @property({ type: Boolean }) compactMode = false;
  @property({ type: String }) activeSessionId: string | null = null;
  /** Persistent previews (GET /api/previews), fetched by the app with the sessions. */
  @property({ attribute: false }) previews: PreviewItem[] = [];
  /**
   * "On this Mac" (GET /api/mac-sessions), polled by the app on phones; null until it answers,
   * or from a server without it. Its items are not Untether sessions and never join `sessions`.
   */
  @property({ attribute: false }) macSessions: MacSessionsResponse | null = null;

  @state() protected cleaningExited = false;
  @state() protected repoFollowMode = new Map<string, string | undefined>();
  @state() protected repoWorktrees = new Map<string, Worktree[]>();
  /** When loading a repo's worktrees last failed (see WORKTREE_RETRY_MS). */
  protected worktreeFailures = new Map<string, number>();
  @state() protected loadingWorktrees = new Set<string>();

  /**
   * How the phone list fits the screen (utils/phone-list-layout.ts); the sidebar opened
   * from a session (compactMode) and larger screens keep the classic layout.
   */
  protected listLayout(): PhoneListLayout {
    if (this.compactMode || !this.usePhoneRows()) return { tight: false, compact: false };
    return currentPhoneListLayout(this.shortLandscape.value);
  }

  /** A phone on its side (utils/short-landscape.ts): re-renders the list on every rotation. */
  protected readonly shortLandscape = new ShortLandscapeController(this);

  // ---- Desktop popovers (repo menu, sort, more) ------------------------------------------

  /** The one popover open from the list: rendered into a host on <body>, position: fixed. */
  protected listPopover: {
    key: string;
    anchor: HTMLElement;
    content: () => unknown;
    placement: PopoverPlacement;
  } | null = null;
  protected popoverHost: HTMLElement | null = null;
  protected popoverKeysOff: (() => void) | null = null;

  /** Key of the open popover (aria-expanded on its button). */
  @state() protected openPopoverKey: string | null = null;

  protected openPopover(
    key: string,
    anchor: HTMLElement,
    content: () => unknown,
    placement: PopoverPlacement = 'bottom-start'
  ) {
    if (this.listPopover?.key === key) {
      this.closePopover();
      return;
    }
    this.closePopover(false);
    const host = document.createElement('div');
    host.className = 'ut-popover-host';
    document.body.appendChild(host);
    this.popoverHost = host;
    this.listPopover = { key, anchor, content, placement };
    this.openPopoverKey = key;
    this.renderPopover();
    const menu = host.firstElementChild as HTMLElement | null;
    if (menu) {
      this.popoverKeysOff = menuKeyboard(menu, {
        onClose: () => this.closePopover(),
        focusFirst: true,
      });
    }
    document.addEventListener('pointerdown', this.handlePopoverOutside, true);
    window.addEventListener('resize', this.placePopover);
    window.addEventListener('scroll', this.placePopover, true);
  }

  protected renderPopover() {
    if (!this.listPopover || !this.popoverHost) return;
    render(this.listPopover.content(), this.popoverHost, { host: this });
    this.placePopover();
  }

  protected placePopover = () => {
    const menu = this.popoverHost?.firstElementChild as HTMLElement | null;
    if (!this.listPopover || !menu) return;
    if (!this.listPopover.anchor.isConnected) {
      this.closePopover(false);
      return;
    }
    positionPopover(this.listPopover.anchor, menu, { placement: this.listPopover.placement });
  };

  protected handlePopoverOutside = (e: Event) => {
    const target = e.target as Node;
    if (this.popoverHost?.contains(target) || this.listPopover?.anchor.contains(target)) return;
    this.closePopover(false);
  };

  protected closePopover(restoreFocus = true) {
    if (!this.listPopover) return;
    const { anchor } = this.listPopover;
    const hadFocus = this.popoverHost?.contains(document.activeElement) ?? false;
    this.popoverKeysOff?.();
    this.popoverKeysOff = null;
    if (this.popoverHost) {
      render(nothing, this.popoverHost);
      this.popoverHost.remove();
    }
    this.popoverHost = null;
    this.listPopover = null;
    this.openPopoverKey = null;
    document.removeEventListener('pointerdown', this.handlePopoverOutside, true);
    window.removeEventListener('resize', this.placePopover);
    window.removeEventListener('scroll', this.placePopover, true);
    if (restoreFocus && hadFocus && anchor.isConnected) anchor.focus();
  }

  // ---- Desktop view options (persisted per browser) -------------------------------------

  @state() protected desktopQuery = '';
  @state() protected listFilter: ListFilter = readListPref('filter', LIST_FILTERS, 'all');
  @state() protected listSort: ListSort = readListPref('sort', LIST_SORTS, 'activity');
  @state() protected listView: ListView = readListPref('view', LIST_VIEWS, 'grid');
  @state() protected groupByRepo = readListPref('group', ['on', 'off'] as const, 'on') === 'on';
  /** The card reachable with Tab (roving tabindex). */
  @state() protected focusId: string | null = null;
  /** Loading for more than 150ms: show skeleton cards. */
  @state() protected showSkeleton = false;
  protected skeletonTimer: ReturnType<typeof setTimeout> | null = null;

  protected setFilter(filter: ListFilter) {
    this.listFilter = filter;
    writeListPref('filter', filter);
  }

  protected setSort(sort: ListSort) {
    this.listSort = sort;
    writeListPref('sort', sort);
    this.closePopover();
  }

  protected setView(view: ListView) {
    this.listView = view;
    writeListPref('view', view);
  }

  protected toggleGroupByRepo() {
    this.groupByRepo = !this.groupByRepo;
    writeListPref('group', this.groupByRepo ? 'on' : 'off');
  }

  protected passesFilter(session: Session, filter: ListFilter = this.listFilter): boolean {
    switch (filter) {
      case 'agents':
        return agentKind(session) !== 'shell';
      case 'terminals':
        return agentKind(session) === 'shell';
      case 'attention':
        return deriveSessionStatus(session) === 'needs-input';
      default:
        return true;
    }
  }

  protected handleSessionSelect(e: CustomEvent) {
    const session = e.detail as Session;

    // Dispatch a custom event that the app can handle with view transitions
    this.dispatchEvent(
      new CustomEvent('navigate-to-session', {
        detail: { sessionId: session.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected async handleSessionKilled(e: CustomEvent) {
    // The card/row event bubbles and is composed: without this the app saw every kill
    // twice (the original plus the re-dispatch below) and refreshed twice as often.
    e.stopPropagation();
    const { sessionId } = e.detail;
    logger.debug(`session ${sessionId} killed, updating session list`);

    // Remove the session from the local state
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);

    // Re-dispatch the event for parent components
    this.dispatchEvent(
      new CustomEvent('session-killed', {
        detail: sessionId,
        bubbles: true,
        composed: true,
      })
    );

    // Then trigger a refresh to get the latest server state
    this.dispatchEvent(new CustomEvent('refresh'));
  }

  protected handleSessionKillError(e: CustomEvent) {
    const { sessionId, error } = e.detail;
    logger.error(`failed to kill session ${sessionId}:`, error);

    // The cards send it already worded for the user (session-action-service).
    this.dispatchEvent(new CustomEvent('error', { detail: String(error) }));
  }

  protected handleSessionRenamed = (e: CustomEvent) => {
    const { sessionId, newName } = e.detail;
    // Update the local session object: its name, or the title the user gave it (null clears it)
    const sessionIndex = this.sessions.findIndex((s) => s.id === sessionId);
    if (sessionIndex >= 0) {
      const session = this.sessions[sessionIndex];
      this.sessions[sessionIndex] =
        'userTitle' in e.detail
          ? { ...session, userTitle: e.detail.userTitle ?? undefined }
          : { ...session, name: newName };
      this.requestUpdate();
    }
  };

  protected handleSessionRenameError = (e: CustomEvent) => {
    const { sessionId, error } = e.detail;
    logger.error(`failed to rename session ${sessionId}:`, error);

    this.dispatchEvent(
      new CustomEvent('error', { detail: t('toast.renameFailed', { error: String(error) }) })
    );
  };

  /**
   * `all`: the user asked for every finished session to go, resumable ones too (2026-10-20:
   * "Borrar todas" listed them all, then kept 20 and said so).
   */
  public async handleCleanupExited(options: { all?: boolean } = {}) {
    if (this.cleaningExited) return;

    this.cleaningExited = true;
    this.requestUpdate();

    try {
      const response = await fetch(`/api/cleanup-exited${options.all ? '?all=1' : ''}`, {
        method: HttpMethod.POST,
        headers: {
          ...this.authClient.getAuthHeader(),
        },
      });

      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { kept?: unknown };
        // Resumable sessions the server kept on purpose (their conversation can go on).
        const kept = typeof body.kept === 'number' && body.kept > 0 ? body.kept : 0;
        // Get the list of exited sessions before cleanup
        const exitedSessions = kept ? [] : this.sessions.filter((s) => isFinishedSession(s));

        // Apply black hole animation to all exited sessions
        if (exitedSessions.length > 0) {
          const sessionCards = this.querySelectorAll('session-card');
          const exitedCards: HTMLElement[] = [];

          sessionCards.forEach((card) => {
            const sessionCard = card as HTMLElement & { session?: { id: string; status: string } };
            if (sessionCard.session?.status === 'exited') {
              exitedCards.push(sessionCard);
            }
          });

          // Apply animation to all exited cards
          exitedCards.forEach((card) => {
            card.classList.add('black-hole-collapsing');
          });

          // Wait for animation to complete
          if (exitedCards.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }

          // Remove all exited sessions at once
          this.sessions = this.sessions.filter((session) => session.status !== 'exited');
        }

        if (kept) {
          // Some stay: the list is read again rather than emptied and refilled.
          toast({ kind: 'info', text: t('toast.cleanupKept', { n: kept }) });
        }
        this.dispatchEvent(new CustomEvent('refresh'));
      } else {
        this.dispatchEvent(new CustomEvent('error', { detail: t('toast.cleanupExitedFailed') }));
      }
    } catch (error) {
      logger.error('error cleaning up exited sessions:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: t('toast.cleanupExitedFailed') }));
    } finally {
      this.cleaningExited = false;
      this.requestUpdate();
    }
  }

  /** The group's name: the main worktree's folder (git lists it first), else the key's. */
  protected getRepoName(repoPath: string): string {
    const main = this.repoWorktrees.get(repoPath)?.[0]?.path;
    return basename(main ? normalizeRepoPath(main) : repoPath);
  }

  /** Phones get a chat-style list (phone-session-row) instead of cards, sidebar included. */
  protected usePhoneRows(): boolean {
    return isPhoneListLayout();
  }

  // ---- Tasks on the home, grouped by project (2026-10-18) -----------------------------------

  /** Worktree tasks (services/task-store.ts), polled every 3 s while the list is on screen. */
  protected readonly taskBoard = new TaskStoreController(this);

  protected sessionsById(): Map<string, Session> {
    return new Map(this.sessions.map((session) => [session.id, session]));
  }

  /**
   * Search over what a row shows: Claude's title and last message, name, folder, command, and
   * the app of the terminal window a session runs in.
   */
  protected matchesQuery(session: Session, rawQuery: string): boolean {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return true;
    return [
      session.userTitle,
      session.claudeStatus?.title,
      session.claudeTitle,
      session.codexTitle,
      session.geminiTitle,
      session.claudeStatus?.preview?.text,
      session.name,
      session.workingDir,
      session.command?.join(' '),
      session.gitBranch,
      session.macWindow?.app,
    ].some((field) => field?.toLowerCase().includes(query));
  }

  /** Clears every finished session (not only the ones a search shows), after asking. */
  protected confirmClearFinished = async () => {
    const exited = this.sessions.filter((session) => isFinishedSession(session));
    if (!exited.length) return;
    const ok = await confirmDialog({
      title: t('phoneList.clearFinishedConfirm', { n: exited.length }),
      confirmLabel: t('sessions.clearExited'),
      tone: 'danger',
      details: exited.map((session) => sessionDisplayName(session)),
    });
    if (ok) void this.handleCleanupExited({ all: true });
  };

  /** The new-session / folder / preview sheets (utils/phone-action-sheet.ts). */
  protected sheet: PhoneActionSheet | null = null;

  /** Whether the phone's new-session flow starts shielded sessions (remembered per browser). */
  /**
   * The new-session sheet's "Blindada" switch: this device's explicit choice, or null to follow
   * the server's "shield new sessions" setting (on by default since 2026-10-03).
   */
  protected newShieldedChoice: boolean | null = readNewShieldedChoice();
  protected shieldDefault = true;
  protected get newShielded(): boolean {
    return this.newShieldedChoice ?? this.shieldDefault;
  }
  protected loadShieldDefault() {
    void serverConfigService
      .loadConfig()
      .then((config) => {
        const next = config.shieldNewSessions !== false && config.shieldAvailable !== false;
        if (next !== this.shieldDefault) {
          this.shieldDefault = next;
          this.requestUpdate();
        }
      })
      .catch(() => {});
  }

  /**
   * An action sheet (utils/phone-action-sheet.ts): a title, one button per choice (paths in
   * mono), Cancel; the folder step adds the "Blindada" switch at the top.
   */
  protected showSheet(
    title: string,
    buttons: Array<{
      label: string;
      mono?: boolean;
      unavailableNote?: string;
      /** A 20 px glyph before the label (the tool sheet's agent marks and icons). */
      glyph?: unknown;
      run: () => void;
    }>,
    options: { shieldToggle?: boolean } = {}
  ) {
    // Closing a previous sheet (tool → folder) already handed focus back to its opener.
    this.closeSheet();
    const opener = document.activeElement;
    const sheet = new PhoneActionSheet({ label: title, opener });
    this.sheet = sheet;
    const toggleShield = () => {
      this.newShieldedChoice = !this.newShielded;
      writeNewShielded(this.newShieldedChoice);
      sheet.update();
    };
    // The sheet's icon slot takes icons.ts names only; an agent's mark rides in the label with
    // the same 20 px slot and gap (list.css .psr-sheet-glyph), so the sheet reads like the rest.
    const items: ActionSheetItem[] = buttons.map((button) => ({
      label: button.glyph
        ? html`<span class="psr-sheet-glyph" aria-hidden="true">${button.glyph}</span>${button.label}`
        : button.label,
      className: button.mono ? 'folder' : undefined,
      note: button.unavailableNote,
      run: button.run,
    }));
    sheet.open(
      (s) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
        <div class="psr-sheet-title">${title}</div>
        ${
          options.shieldToggle
            ? html`<button
                class="ut-surface--inset psr-sheet-item psr-sheet-switch"
                role="switch"
                aria-checked=${this.newShielded ? 'true' : 'false'}
                data-testid="new-session-shield-toggle"
                @pointerup=${s.tap(toggleShield, true)}
                @click=${s.tap(toggleShield, true)}
              >
                <span class="psr-sheet-icon" aria-hidden="true">${icon('shield', 20)}</span>
                <span class="psr-sheet-label">${t('shield.newToggle')}</span>
                <span class="ut-switch-track ${this.newShielded ? 'on' : ''}" aria-hidden="true"
                  ><span class="ut-switch-thumb"></span
                ></span>
              </button>`
            : nothing
        }
        ${actionItems(s, items)}
      </div>`
    );
  }

  protected closeSheet = () => {
    this.sheet?.close();
    this.sheet = null;
  };
}
