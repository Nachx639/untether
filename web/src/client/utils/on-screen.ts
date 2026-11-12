/**
 * Whether at least half of an element is on screen: rendered and visible, inside the viewport
 * and not clipped away by a scrolling or clipping ancestor. checkVisibility alone says yes for
 * a pill scrolled out of a strip or below the fold (2026-11-02 review), and a SEEN key for it
 * would drop an important push the user never saw.
 */
export function isOnScreen(el: Element, minFraction = 0.5): boolean {
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  }
  const rect = el.getBoundingClientRect();
  const area = rect.width * rect.height;
  if (area <= 0) return false;
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const box = node.getBoundingClientRect();
      left = Math.max(left, box.left);
      top = Math.max(top, box.top);
      right = Math.min(right, box.right);
      bottom = Math.min(bottom, box.bottom);
    }
    if (right <= left || bottom <= top) return false;
  }
  return ((right - left) * (bottom - top)) / area >= minFraction;
}
