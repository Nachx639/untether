/**
 * 2026-10-04: in the home-screen app on the owner's iPhone, chat mode shows a dark band between
 * the composer and the keyboard, and iOS offers its ↑ ↓ field arrows (it does when it sees
 * another field to move to). The SE simulator doesn't reproduce it, so the phone reports what it
 * sees: every field iOS could move to, and the viewport geometry. No text content is included.
 */

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Every field in the document, shadow roots included (chat-keyboard-fix3.ts uses it too). */
export function allFields(root: Document | ShadowRoot): HTMLElement[] {
  const found: HTMLElement[] = [...root.querySelectorAll<HTMLElement>(FIELD_SELECTOR)];
  for (const host of root.querySelectorAll<HTMLElement>('*')) {
    if (host.shadowRoot) found.push(...allFields(host.shadowRoot));
  }
  return found;
}

function describe(field: HTMLElement): string {
  const style = getComputedStyle(field);
  const rect = field.getBoundingClientRect();
  const name = [
    field.tagName.toLowerCase(),
    field.id ? `#${field.id}` : '',
    typeof field.className === 'string' && field.className
      ? `.${field.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '',
  ].join('');
  const flags = [
    (field as HTMLInputElement).disabled ? 'disabled' : '',
    (field as HTMLInputElement).readOnly ? 'readonly' : '',
    field.closest('[inert]') ? 'inert' : '',
    field.tabIndex < 0 ? `tab${field.tabIndex}` : '',
    style.display === 'none' ? 'display:none' : '',
    style.visibility !== 'visible' ? `vis:${style.visibility}` : '',
    Number(style.opacity) < 1 ? `op:${style.opacity}` : '',
    document.activeElement === field ? 'FOCUSED' : '',
  ].filter(Boolean);
  const box = `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  return `${name} [${box}]${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

/** One line: viewport geometry, then every field iOS could move to (disabled ones left out). */
export function focusDiagnostics(composer?: Element | null): string {
  const vv = window.visualViewport;
  const rect = composer?.getBoundingClientRect();
  const geometry = [
    `inner ${window.innerWidth}x${window.innerHeight}`,
    vv
      ? `vv ${Math.round(vv.width)}x${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}`
      : 'no vv',
    `scroll ${Math.round(window.scrollX)},${Math.round(window.scrollY)}`,
    rect ? `composer ${Math.round(rect.top)}-${Math.round(rect.bottom)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const fields = allFields(document).filter((field) => !(field as HTMLInputElement).disabled);
  return `${geometry} | ${fields.length} fields: ${fields.map(describe).join('; ')}`;
}
