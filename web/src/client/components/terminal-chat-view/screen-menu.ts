import { html, nothing } from 'lit';
import { translatePrompt } from '../../../shared/claude-prompt-text.js';
import {
  parseScreenChoices,
  type ScreenChoices,
  sameShownMenu,
} from '../../../shared/claude-screen.js';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { promptT, renderPromptDock } from '../claude-chat-view.js';
import { TerminalChatOutput } from './chat-output.js';
import { KIND_KEYS, SCREEN_MENU_CONFIRM_MS, SCREEN_MENU_POLL_MS } from './shared.js';

/** A menu on the terminal's screen that typing cannot answer, offered as buttons. */
export abstract class TerminalChatScreenMenu extends TerminalChatOutput {
  /** Watches the screen for a menu while this is the phone composer of an open session. */
  protected syncScreenMenuWatch() {
    const watch = this.composerOnly && this.active && Boolean(this.getScreenText);
    if (watch && !this.screenMenuTimer) {
      this.screenMenuTimer = setInterval(this.readScreenMenu, SCREEN_MENU_POLL_MS);
      queueMicrotask(this.readScreenMenu);
    } else if (!watch && this.screenMenuTimer) {
      clearInterval(this.screenMenuTimer);
      this.screenMenuTimer = undefined;
      clearTimeout(this.screenMenuConfirmTimer);
      this.pendingScreenMenu = null;
      this.screenMenu = null;
    }
  }

  protected readScreenMenu = () => {
    // A replay rewrites the buffer through hours of old screens: whatever menu it holds now
    // is history. Nothing changes until the live screen is back.
    if (this.screenSettling?.()) return;
    const found = this.isAgentSession() ? this.parseScreen() : null;
    // A selection menu (cursor and key hints): Enter confirms its highlighted option, such as
    // Codex's "Update now" (a global npm install), whatever the user meant. Numbered lists in
    // Claude's answers have neither and stay out of it.
    const menu = found?.cursor !== undefined ? found : null;
    if (
      menu &&
      this.answeredMenu?.sessionId === this.sessionId &&
      sameShownMenu(this.answeredMenu.menu, menu) &&
      Date.now() - this.answeredMenu.at < 3000
    ) {
      this.screenMenu = null;
      return;
    }
    // A poll landing while Claude redraws the menu may find it cut off or gone: the same
    // options keep the block as it is, and it goes only after two polls without a menu.
    if (!menu) {
      this.pendingScreenMenu = null;
      this.screenMenuMisses++;
      if (this.screenMenu && this.screenMenuMisses >= 2) this.screenMenu = null;
      return;
    }
    this.screenMenuMisses = 0;
    // Nothing shown yet: a menu read once waits for a second read to agree.
    if (!this.screenMenu && !sameShownMenu(menu, this.pendingScreenMenu)) {
      this.pendingScreenMenu = menu;
      clearTimeout(this.screenMenuConfirmTimer);
      this.screenMenuConfirmTimer = setTimeout(this.readScreenMenu, SCREEN_MENU_CONFIRM_MS);
      return;
    }
    this.pendingScreenMenu = null;
    // A new prompt may ask the same question with the same options (consecutive permissions):
    // keeping the old one showed its detail and sent its key, and every tap got "changed"
    // (review of 2026-10-03). Its cursor moving, or a read cut off by a redraw, is the same.
    if (this.refreshScreenMenu || !sameShownMenu(menu, this.screenMenu)) {
      this.screenMenu = menu;
      this.menuDetailOpen = false;
      if (!this.refreshScreenMenu) this.screenMenuNote = '';
      this.refreshScreenMenu = false;
    } else if ((menu.key?.length ?? 0) > (this.screenMenu?.key?.length ?? 0)) {
      // The same menu read whole after a cut-off read: its question and detail too.
      this.screenMenu = menu;
    }
  };

  protected showScreenMenuNote(note: string) {
    clearTimeout(this.screenMenuNoteTimer);
    this.screenMenuNote = note;
    this.screenMenuNoteTimer = setTimeout(() => (this.screenMenuNote = ''), 6000);
  }

  /**
   * A menu on screen that typing cannot answer, docked over the composer with the chat's own
   * prompt anatomy (renderPromptDock): eyebrow, detail, question, numbered options.
   */
  protected renderScreenMenu() {
    const menu = this.screenMenu;
    if (!this.composerOnly || !menu || this.menuInChat) return nothing;
    const shown = translatePrompt(menu, promptT);
    return html`<div
      class="screen-menu"
      role="group"
      aria-label=${shown.question || t('screenMenu.label')}
      data-testid="screen-menu"
      @click=${(e: Event) => e.stopPropagation()}
    >
      ${renderPromptDock({
        kind: t(KIND_KEYS[shown.kind]),
        question: shown.question,
        detail: menu.detail,
        options: menu.options,
        shown: shown.options,
        disabled: this.screenMenuBusy,
        note: this.screenMenuNote,
        detailOpen: this.menuDetailOpen,
        onToggleDetail: () => {
          this.menuDetailOpen = !this.menuDetailOpen;
        },
        pick: (index) => {
          const tap = this.quickPromptTap(() => void this.chooseScreenMenuOption(index));
          return { pointerup: tap, click: tap };
        },
        testId: 'screen-menu-dock',
        ids: { note: 'screen-menu-note', detail: 'screen-menu-detail' },
        classes: { option: 'screen-menu-option', question: 'screen-menu-question' },
      })}
    </div>`;
  }

  /** Picks a menu option through the server, which moves the cursor there and presses Enter. */
  protected async chooseScreenMenuOption(index: number) {
    const menu = this.screenMenu;
    const sessionId = this.sessionId;
    if (!menu || this.screenMenuBusy || !sessionId) return;
    this.screenMenuBusy = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify({
          option: index + 1,
          question: menu.question,
          options: menu.options,
          key: menu.key,
        }),
      });
      // Another session opened meanwhile: this answer is not about what it shows (its result
      // blanked the new session's menu or said its prompt changed; fourth review).
      if (this.sessionId !== sessionId) return;
      if (response.ok) {
        this.answeredMenu = { sessionId, menu, at: Date.now() };
        this.screenMenu = null;
      } else {
        const error =
          response.status === 409
            ? ((await response.json().catch(() => ({}))) as { error?: string }).error
            : undefined;
        // A changed menu: the next poll shows the one on screen now, with this note.
        if (response.status === 409 && error !== 'busy') this.refreshScreenMenu = true;
        // "busy": another answer to this session is still on its way, not a changed menu.
        this.showScreenMenuNote(
          t(
            error === 'busy'
              ? 'screenMenu.sending'
              : response.status === 409
                ? 'screenMenu.changed'
                : 'screenMenu.failed'
          )
        );
      }
    } catch {
      if (this.sessionId === sessionId) this.showScreenMenuNote(t('screenMenu.failed'));
    } finally {
      this.screenMenuBusy = false;
    }
  }

  /**
   * The menu on screen right now, read when sending: the watch's copy may be a poll old, or
   * hidden for a moment after an answer while the next menu shows the same options.
   */
  protected menuOnScreen(): ScreenChoices | null {
    if (!this.isAgentSession() || !this.getScreenText) return null;
    const found = this.parseScreen();
    return found?.navigate ? found : null;
  }

  /** The screen's menu, read with the terminal's layout (labels, and its key, read right). */
  protected parseScreen(): ScreenChoices | null {
    return parseScreenChoices(this.getScreenText?.() ?? '', this.getScreenLayout?.());
  }

  protected isAgentSession(): boolean {
    return (
      this.claudeSession === true ||
      this.agent === 'claude' ||
      this.agent === 'codex' ||
      this.agent === 'gemini'
    );
  }
}
