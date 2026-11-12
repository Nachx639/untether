/**
 * TerminalRenderer Component
 *
 * A pure presentational component that renders the terminal.
 * Renders the Ghostty-based terminal and wires events upward.
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import type { Session } from '../../../shared/types.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import '../terminal.js';

@customElement('terminal-renderer')
export class TerminalRenderer extends LitElement {
  // Disable shadow DOM to use parent styles
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    // Bind event handlers to ensure proper context
    this.handleClick = this.handleClick.bind(this);
    this.handleTerminalInput = this.handleTerminalInput.bind(this);
    this.handleTerminalResize = this.handleTerminalResize.bind(this);
    this.handleTerminalReady = this.handleTerminalReady.bind(this);
  }

  @property({ type: Object }) session: Session | null = null;
  @property({ type: Number }) terminalFontSize = 14;
  @property({ type: Number }) terminalMaxCols = 0;
  @property({ type: String }) terminalTheme: TerminalThemeId = 'auto';
  @property({ type: Boolean }) disableClick = false;
  @property({ type: Boolean }) hideScrollButton = false;
  @property({ type: Boolean }) keyboardCatcher = false;
  @property({ type: Boolean }) isMobile = false;
  @property({ type: Boolean }) showQuickKeys = false;
  /** Under the phone's chat view: the terminal keeps its rows (see ut-terminal holdRows). */
  @property({ type: Boolean }) holdRows = false;

  // Event handlers passed as properties
  @property({ type: Object }) onTerminalClick?: (e: Event) => void;
  @property({ type: Object }) onTerminalInput?: (e: CustomEvent) => void;
  @property({ type: Object }) onTerminalResize?: (e: CustomEvent) => void;
  @property({ type: Object }) onTerminalReady?: (e: CustomEvent) => void;

  override render(): unknown {
    if (!this.session) {
      return html``;
    }

    const terminal = html`
      <ut-terminal
        .sessionId=${this.session.id || ''}
        .sessionStatus=${this.session.status || 'running'}
        .cols=${80}
        .rows=${24}
        .fontSize=${this.terminalFontSize}
        .fitHorizontally=${false}
        .maxCols=${this.terminalMaxCols}
        .theme=${this.terminalTheme}
        .disableClick=${this.disableClick}
        .hideScrollButton=${this.hideScrollButton}
        .keyboardCatcher=${this.keyboardCatcher}
        .holdRows=${this.holdRows}
        class="w-full h-full p-0 m-0 terminal-container"
        @click=${(e: Event) => this.handleClick(e)}
        @touchend=${(e: Event) => this.handleClick(e)}
        @terminal-input=${(e: Event) => this.handleTerminalInput(e)}
        @terminal-resize=${(e: Event) => this.handleTerminalResize(e)}
        @terminal-ready=${(e: Event) => this.handleTerminalReady(e)}
      ></ut-terminal>
    `;
    return keyed(this.session.id, terminal);
  }

  private handleClick(e: Event) {
    this.onTerminalClick?.(e);
  }

  private handleTerminalInput(e: Event) {
    this.onTerminalInput?.(e as CustomEvent);
  }

  private handleTerminalResize(e: Event) {
    this.onTerminalResize?.(e as CustomEvent);
  }

  private handleTerminalReady(e: Event) {
    this.onTerminalReady?.(e as CustomEvent);
  }
}
