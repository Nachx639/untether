import { css } from 'lit';

/**
 * The page's keyboard focus ring (a box-shadow, --focus-ring, since 2026-10-12) and placeholder
 * color (styles.css), for shadow roots, which
 * the page's rules don't reach: chat buttons showed no focus ring and the chat's search and
 * prompt-editor fields used WebKit's grey placeholder, 2.3:1 on the light theme (2026-10-04).
 * Also iOS's long-press menu in text fields: body turns the callout off and it is inherited
 * into shadow roots, so holding the composer showed no Paste (2026-10-10; index.html has the
 * same rule for the page's own fields).
 */
export const a11yBaseStyles = css`
  :where(:focus-visible):where(
      :not(
          [tabindex='-1'],
          input:not([type='checkbox'], [type='radio'], [type='range'], [type='file']),
          textarea,
          select,
          [contenteditable]
        )
    ) {
    box-shadow: var(--focus-ring, 0 0 0 2px currentColor);
    outline: none;
  }
  @media (forced-colors: active) {
    :where(:focus-visible) {
      outline: 2px solid CanvasText;
      outline-offset: 2px;
    }
  }
  :where(input, textarea, [contenteditable='true']) {
    -webkit-touch-callout: default;
  }
  ::placeholder {
    color: var(--color-placeholder, GrayText);
    opacity: 1;
  }
`;
