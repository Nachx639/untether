/**
 * QA aid: open the app with `?layoutcheck` and, every few seconds, every visible element that
 * sticks out of the screen sideways is logged (once) to the server log through the client
 * logger. 2026-10-03: a 375 pt phone cut off the chat search's close button; looking for
 * that by eye, screen by screen, missed it. Only the outermost element of an overflow is
 * reported, and anything inside a box that scrolls sideways on purpose (code, tables) is
 * left out. The flag lasts for the tab (sessionStorage), across in-app navigation.
 */
import { createLogger } from './logger.js';

const logger = createLogger('layout-check');
const FLAG_KEY = 'ut-layoutcheck';
const CHECK_INTERVAL_MS = 4000;

/** Every element of the page, shadow roots included. */
function* allElements(root: Document | ShadowRoot): Generator<Element> {
  for (const element of root.querySelectorAll('*')) {
    yield element;
    if (element.shadowRoot) yield* allElements(element.shadowRoot);
  }
}

/** The element's parent, crossing out of a shadow root to its host. */
function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function scrollsSideways(element: Element): boolean {
  const overflowX = getComputedStyle(element).overflowX;
  return (
    (overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth
  );
}

function label(element: Element): string {
  const classes =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
  const testId = element.getAttribute('data-testid');
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}${
    testId ? `[data-testid="${testId}"]` : ''
  }`;
}

/** Visible elements sticking out of a `width`-wide screen, outermost only (exported for tests). */
export function findOverflow(width = window.innerWidth): string[] {
  const reported = new Set<Element>();
  const found: string[] = [];
  for (const element of allElements(document)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= width + 1 && rect.left >= -1) continue;
    // Wholly off screen is hiding on purpose (helper inputs at -9999px, closed drawers).
    if (rect.right <= 0 || rect.left >= width) continue;
    let ancestor = composedParent(element);
    let skip = false;
    while (ancestor) {
      // Monaco scrolls its own huge virtual layer inside a clipped box.
      if (
        reported.has(ancestor) ||
        scrollsSideways(ancestor) ||
        ancestor.classList.contains('monaco-editor')
      ) {
        skip = true;
        break;
      }
      ancestor = composedParent(ancestor);
    }
    if (skip) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    reported.add(element);
    // Its path up to the nearest shadow host or body, so the element can be found.
    const path: string[] = [];
    for (let up = composedParent(element); up && path.length < 3; up = composedParent(up)) {
      path.unshift(label(up));
    }
    found.push(
      `${[...path, label(element)].join(' > ')}: ${Math.round(rect.left)}→${Math.round(rect.right)}`
    );
  }
  return found;
}

/** Starts checking if `?layoutcheck` is (or was, in this tab) in the URL. */
export function startLayoutCheckIfAsked(): void {
  try {
    if (new URLSearchParams(location.search).has('layoutcheck')) {
      sessionStorage.setItem(FLAG_KEY, '1');
    }
    if (sessionStorage.getItem(FLAG_KEY) !== '1') return;
  } catch {
    return;
  }
  const seen = new Set<string>();
  const check = () => {
    const fresh = findOverflow().filter((line) => !seen.has(`${location.pathname} ${line}`));
    if (fresh.length === 0) return;
    for (const line of fresh) seen.add(`${location.pathname} ${line}`);
    logger.warn(`overflow at ${window.innerWidth}px on ${location.pathname}:\n${fresh.join('\n')}`);
  };
  logger.warn(`layout check on (${window.innerWidth}×${window.innerHeight})`);
  setInterval(check, CHECK_INTERVAL_MS);
}
