/**
 * CSS height that fits a textarea's text. scrollHeight already includes the padding, so a
 * content-box field must subtract it (and a border-box one add its borders).
 * 2026-10-03: the composer is content-box; setting height = scrollHeight counted the padding
 * twice, so the first typed letter grew the one-line field by an empty extra line (iPhone).
 * Its own module (2026-10-04): the list's ask box uses it too, without the chat view.
 */
export function composerHeightFor(
  scrollHeight: number,
  style: Pick<
    CSSStyleDeclaration,
    'boxSizing' | 'paddingTop' | 'paddingBottom' | 'borderTopWidth' | 'borderBottomWidth'
  >
): number {
  const px = (value: string) => Number.parseFloat(value) || 0;
  if (style.boxSizing === 'border-box') {
    return scrollHeight + px(style.borderTopWidth) + px(style.borderBottomWidth);
  }
  return Math.max(0, scrollHeight - px(style.paddingTop) - px(style.paddingBottom));
}
