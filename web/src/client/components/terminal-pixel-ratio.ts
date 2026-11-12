/**
 * ghostty-web 0.4's CanvasRenderer reads window.devicePixelRatio once, when the terminal opens,
 * and sizes its canvas at that ratio for good (its render() only checks the canvas against the
 * ratio it kept). Opened at the wrong one, the canvas was drawn at a lower resolution and
 * stretched by its CSS size until the terminal was made again: after a cold start of the
 * iPhone home-screen app the terminal came up blurry (header sharp) and switching to another
 * session and back fixed it (2026-10-12). The page can be at another ratio later, too: a
 * cold-launched web view before it is on the screen, a window moved to another display,
 * browser zoom on a desktop.
 *
 * The ratio is private in ghostty-web, read here through a narrow view of the renderer.
 */
interface RatioRenderer {
  devicePixelRatio?: unknown;
}

/** The page's pixel ratio now (1 where there is none). */
export function currentPixelRatio(): number {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Brings the renderer's pixel ratio to the page's. Returns the ratio it had when it changed
 * (ghostty's next render() then sees the canvas at the wrong size, resizes it at the new ratio
 * and redraws every row), or null when it was already right or the renderer has none.
 */
export function syncRendererPixelRatio(
  renderer: object | null | undefined,
  ratio: number = currentPixelRatio()
): number | null {
  if (!renderer) return null;
  const view = renderer as RatioRenderer;
  const before = view.devicePixelRatio;
  if (typeof before !== 'number' || before === ratio) return null;
  view.devicePixelRatio = ratio;
  return before;
}
