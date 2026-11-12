import { css, html, LitElement, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * The Untether brand mark: the app icon's white chevron and dash on the orange gradient
 * rounded square (#FF6A00 → #FFB000), drawn inline so it is sharp at every size and needs no
 * request. Same drawing as public/favicon.svg. Shadow DOM keeps the gradient id local.
 */
@customElement('terminal-icon')
export class TerminalIcon extends LitElement {
  @property({ type: Number }) size = 24;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    svg {
      display: block;
      filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.18));
    }
  `;

  render() {
    return html`
      <svg
        viewBox="0 0 32 32"
        width=${this.size}
        height=${this.size}
        role="img"
        aria-label="Untether"
      >
        ${svg`
          <defs>
            <linearGradient id="ut-mark" x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#FF6A00" />
              <stop offset="1" stop-color="#FFB000" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="7" fill="url(#ut-mark)" />
          <g
            fill="none"
            stroke="#fff"
            stroke-width="3.05"
            stroke-linecap="round"
            stroke-linejoin="round"
            transform="translate(16 16) scale(1.45) translate(-9.3 -9)"
          >
            <path d="M3.4 4.6 L8.6 9 L3.4 13.4" />
            <path d="M11.4 5.4 L15.2 5.4" />
          </g>
        `}
      </svg>
    `;
  }
}
