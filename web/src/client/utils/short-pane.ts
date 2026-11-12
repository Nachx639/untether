/** Below this height (px) the session pane counts as short. */
export const SHORT_PANE_PX = 440;

/**
 * Is the session pane short? Its height is what the visual viewport shows minus a split
 * preview above it: a split preview on a small phone, or the keyboard open on an iPhone SE
 * (or a phone in landscape), where the chat's secondary rows left ~2 lines for messages
 * (2026-10-03).
 */
export function isShortPane(visibleHeight: number, previewOffset: number): boolean {
  return visibleHeight - Math.max(0, previewOffset) < SHORT_PANE_PX;
}
