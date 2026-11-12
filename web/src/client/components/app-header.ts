/**
 * App Header Component
 *
 * Conditionally renders either a compact sidebar header or full-width header
 * based on the showSplitView property.
 *
 * @fires create-session - When create button is clicked
 * @fires kill-all-sessions - When kill all button is clicked
 * @fires open-file-browser - When browse button is clicked
 * @fires open-tmux-sessions - When tmux sessions button is clicked
 * @fires open-history - When the Claude conversation history is asked for (phone More menu)
 * @fires logout - When logout is clicked
 * @fires toggle-sidebar - When sidebar toggle button is clicked
 * @fires open-palette - When the header search trigger asks for the ⌘K palette
 *
 * Both desktop headers share HeaderBase.iconButton() (borderless .ut-icon-btn, sans, no
 * bordered boxes); the phone header keeps its own markup (design spec 5.4, 2026-10-12).
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import './sidebar-header.js';
import './full-header.js';

@customElement('app-header')
export class AppHeader extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Boolean }) showSplitView = false;
  @property({ type: String }) currentUser: string | null = null;
  @property({ type: String }) authMethod: string | null = null;

  private forwardEvent = (e: Event) => {
    // Forward events from child components to parent
    // Don't bubble to prevent unintended propagation
    this.dispatchEvent(
      new CustomEvent(e.type, {
        detail: (e as CustomEvent).detail,
        bubbles: false,
      })
    );
  };

  render() {
    return this.showSplitView ? this.renderSidebarHeader() : this.renderFullHeader();
  }

  private renderSidebarHeader() {
    return html`
      <sidebar-header
        .sessions=${this.sessions}
        .currentUser=${this.currentUser}
        .authMethod=${this.authMethod}
        @create-session=${this.forwardEvent}
        @kill-all-sessions=${this.forwardEvent}
        @open-file-browser=${this.forwardEvent}
        @open-tmux-sessions=${this.forwardEvent}
        @open-settings=${this.forwardEvent}
        @logout=${this.forwardEvent}
        @navigate-to-list=${this.forwardEvent}
        @toggle-sidebar=${this.forwardEvent}
        @open-palette=${this.forwardEvent}
      ></sidebar-header>
    `;
  }

  private renderFullHeader() {
    return html`
      <full-header
        .sessions=${this.sessions}
        .currentUser=${this.currentUser}
        .authMethod=${this.authMethod}
        @create-session=${this.forwardEvent}
        @kill-all-sessions=${this.forwardEvent}
        @open-file-browser=${this.forwardEvent}
        @open-tmux-sessions=${this.forwardEvent}
        @open-settings=${this.forwardEvent}
        @open-history=${this.forwardEvent}
        @logout=${this.forwardEvent}
        @navigate-to-list=${this.forwardEvent}
        @open-palette=${this.forwardEvent}
      ></full-header>
    `;
  }
}
