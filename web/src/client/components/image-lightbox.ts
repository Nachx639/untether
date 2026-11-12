/**
 * Full-screen viewer for chat images: tap a thumbnail to open, pinch to zoom (native),
 * ✕ / Escape / swipe down to close.
 */
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import { Z_INDEX } from '../utils/constants.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';

/** How far a one-finger drag down must go to close the viewer. */
const SWIPE_CLOSE_PX = 110;

@customElement('image-lightbox')
export class ImageLightbox extends LitElement {
  static styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
    :host {
      position: fixed;
      inset: 0;
      display: block;
      background: color-mix(in srgb, var(--color-bg) 94%, var(--ut-mix-darken));
    }
    .scroller {
      position: absolute;
      inset: 0;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      /* Let the browser handle pinch zoom and panning natively. */
      touch-action: pan-x pan-y pinch-zoom;
      -webkit-overflow-scrolling: touch;
    }
    img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      transition: transform 0.15s;
      user-select: none;
      -webkit-user-select: none;
    }
    .close {
      position: absolute;
      top: calc(env(safe-area-inset-top, 0px) + 10px);
      right: 12px;
      width: 40px;
      height: 40px;
      border-radius: var(--ut-r-circle);
      border: none;
      background: color-mix(in srgb, var(--color-bg-elevated) 85%, transparent);
      color: var(--color-text);
      font-size: 18px;
      cursor: pointer;
      touch-action: manipulation;
    }
  `,
    materialControlStyles,
  ];

  private locale = new LocaleController(this);

  @property() src = '';
  @property() alt = '';

  private startY: number | null = null;
  private pointers = new Set<number>();
  private dragY = 0;

  connectedCallback() {
    super.connectedCallback();
    this.style.zIndex = String(Z_INDEX.NOTIFICATION + 1);
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    document.addEventListener('keydown', this.onKey, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.onKey, true);
  }

  close = () => {
    this.remove();
    this.dispatchEvent(new CustomEvent('lightbox-close'));
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  private closeTap = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerup') {
      // A drag that started on ✕ (panning a zoomed image) ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    this.close();
  };

  private zoomed() {
    const scale = window.visualViewport?.scale ?? 1;
    return scale > 1.05;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    this.startY = this.pointers.size === 1 && !this.zoomed() ? e.clientY : null;
    this.dragY = 0;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.startY === null || this.pointers.size !== 1) return;
    this.dragY = Math.max(0, e.clientY - this.startY);
    const img = this.renderRoot.querySelector('img');
    if (img) img.style.transform = this.dragY ? `translateY(${this.dragY}px)` : '';
  };

  private onPointerEnd = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.startY !== null && this.dragY > SWIPE_CLOSE_PX) {
      swallowNextClick();
      this.close();
      return;
    }
    const img = this.renderRoot.querySelector('img');
    if (img) img.style.transform = '';
    if (this.pointers.size === 0) this.startY = null;
  };

  render() {
    void this.locale;
    return html`
      <div
        class="scroller"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerEnd}
        @pointercancel=${this.onPointerEnd}
      >
        <img src=${this.src} alt=${this.alt} draggable="false" />
      </div>
      <button
        class="ut-surface--control close"
        data-action="close"
        aria-label=${t('lightbox.close')}
        title=${t('lightbox.close')}
        @pointerup=${this.closeTap}
        @click=${this.closeTap}
      >
        ✕
      </button>
    `;
  }
}

/** Show `src` full screen; returns the viewer (it removes itself when closed). */
export function openImageLightbox(src: string, alt = ''): ImageLightbox {
  document.querySelector('image-lightbox')?.remove();
  const box = document.createElement('image-lightbox');
  box.src = src;
  box.alt = alt;
  document.body.appendChild(box);
  return box;
}

declare global {
  interface HTMLElementTagNameMap {
    'image-lightbox': ImageLightbox;
  }
}
