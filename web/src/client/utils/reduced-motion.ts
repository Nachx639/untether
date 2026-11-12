import { css } from 'lit';

/**
 * Reduce Motion inside a shadow root. styles.css turns transitions, animations and smooth
 * scrolling off for the whole page, but its `*` rule does not cross into a component's
 * shadow DOM: the chat's message slide-in, smooth scroll and button transitions still ran
 * there (2026-10-04). Every shadow-DOM component that animates adds this to its styles
 * (reduced-motion.test.ts checks). Like the page rule, indicators of work in progress may
 * keep a slow loop: they set their own `animation-duration` after this fragment.
 */
export const reducedMotionStyles = css`
  @media (prefers-reduced-motion: reduce) {
    :host,
    :host *,
    :host *::before,
    :host *::after {
      transition-duration: 0.01ms !important;
      transition-delay: 0s !important;
      animation-duration: 0.01ms !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
    }
  }
`;

/** True when the user asked for less motion (iOS: Accessibility → Motion → Reduce Motion). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
