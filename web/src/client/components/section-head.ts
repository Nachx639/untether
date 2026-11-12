/**
 * The desktop home's folding section header, one piece for every section that folds
 * («Suspendidas», «Hechas», «Terminadas»): the chevron that turns, the section's name with its
 * count, the hairline to the end of the row and, after it, the section's own actions
 * (2026-11-11: «Hechas» wore the phone's eyebrow, whose styles a desktop never loads, so its
 * chevron fell on a line of its own with no hairline, next to «Terminadas» with both).
 * Styles: `.ut-section-head` / `.ut-section-toggle` (desktop-project-header.css).
 */
import { html, nothing } from 'lit';
import { icon } from './icons.js';

export function renderSectionHead(options: {
  label: string;
  open: boolean;
  toggle: () => void;
  testid: string;
  id?: string;
  /** The id of what it folds (aria-controls). */
  controls?: string;
  disabled?: boolean;
  /** What follows the hairline (a section's own buttons). */
  actions?: unknown;
}) {
  return html`<div class="ut-section-head">
    <button
      type="button"
      class="ut-section-toggle"
      id=${options.id ?? nothing}
      data-testid=${options.testid}
      aria-expanded=${options.open ? 'true' : 'false'}
      aria-controls=${options.controls ?? nothing}
      ?disabled=${!!options.disabled}
      @click=${options.toggle}
    >
      ${icon('chevronRight')}${options.label}
    </button>
    ${options.actions ?? nothing}
  </div>`;
}
