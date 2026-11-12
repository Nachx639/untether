import { css } from 'lit';

/** Paint-only controls for components which encapsulate their native controls in a shadow root.
 * Keep the component's colors, geometry and interaction states. Neutral tokens add no paint. */
export const materialControlStyles = css`
  .ut-surface--control, .ut-surface--inset, .ut-surface--badge, .ut-surface--panel {
    background-image: var(--ut-piece-grain);
    background-size: var(--ut-piece-grain-size);
    background-blend-mode: var(--ut-piece-grain-blend);
  }
  .ut-surface--control, .ut-surface--badge { box-shadow: var(--ut-piece-control); }
  /* A part of its owner (a card's own toggle, the close in its corner) stays flat on it: the
     owner is the piece. Painted as a key it drew a square box in the rounded corner, an edge at
     its side and its base cutting the card (2026-11-11, «Mientras no estabas»). */
  .ut-surface--compact {
    background-color: transparent;
    background-image: none;
    box-shadow: none;
  }
  .ut-surface--inset { box-shadow: var(--ut-piece-inset); }
  .ut-surface--panel { box-shadow: var(--ut-piece-raised); }
  .ut-surface--well {
    box-shadow: var(--ut-piece-inset);
  }
  .ut-text-action { text-shadow: var(--ut-piece-text-shadow); }
`;

/** The document's material surface for shadow roots. Callers already position their surface;
 * this adds only an empty paint layer, never a filter over messages or attached images.
 * With no material-content token it creates no box and leaves the original rendering intact. */
export const materialSurfaceStyles = css`
  .ut-surface--material {
    isolation: var(--ut-material-isolation, auto);
  }
  .ut-surface--material::before {
    content: var(--ut-material-content, none);
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    border-radius: inherit;
    background-color: inherit;
    background-image: var(--ut-grain-strong, none);
    background-size: var(--ut-material-size, auto);
    background-origin: border-box;
    background-blend-mode: soft-light, multiply;
    opacity: var(--ut-material-opacity, 1);
    border: var(--ut-material-border-width, 8px) solid transparent;
    border-image-source: var(--ut-material-edge, none);
    border-image-slice: var(--ut-material-edge-slice, 0);
    border-image-width: 8px;
    box-shadow: var(--ut-material-rim, none);
    clip-path: var(--ut-material-clip, none);
  }
  .ut-surface--well::before {
    background-image: var(--ut-well-grain, var(--ut-grain-strong, none));
    border-image-source: var(--ut-well-edge, var(--ut-material-edge, none));
  }
`;
