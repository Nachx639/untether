/**
 * 2026-10-12, the user (iPhone, home-screen app, iOS 26): with text in the chat composer, a tap
 * in the middle of it did not put the caret there. WebKit with real touch taps (Playwright,
 * iPhone 15 Pro, chatKeyboardFix3 on and off, keyboard state faked) puts it at the tap in the
 * composer and in the Ask box, focused or not, and no handler of ours cancels the tap, sets the
 * value or moves the selection. What is left is iOS itself (its text interaction, the keyboard
 * and the home-screen app's 62 px innerHeight drop), which only the phone shows. So the phone
 * reports each touch tap in these fields: where it landed, the field's box, what is under the
 * finger, the caret before and once iOS has placed it, and whether the field kept the focus
 * (a tap iOS takes as "outside" closes the keyboard instead). No text content is included.
 * Passive: it never cancels or changes anything.
 *
 * 2026-10-14: the field, the visual viewport and what is under the finger are read when the
 * finger lands, as well as once the caret settled. Read only afterwards, a first tap that opened
 * the keyboard looked about 400 px below a field that had since moved up above the keyboard.
 */

/** iOS places the caret after its double-tap window; read it once that is over. */
const SETTLE_MS = 450;
/** A finger that moved this far scrolled the field or dragged a selection: not a tap. */
const TAP_SLOP_PX = 10;

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** The innermost element under the point, through open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let element = document.elementFromPoint?.(x, y) ?? null;
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint?.(x, y) ?? null;
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

function describeElement(element: Element | null, field: TextField): string {
  if (!element) return 'nothing';
  if (element === field) return 'the field';
  const name = `${element.tagName.toLowerCase()}${
    typeof element.className === 'string' && element.className
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : ''
  }`;
  return field.contains(element) ? `in the field (${name})` : name;
}

function isFocused(field: TextField): boolean {
  const root = field.getRootNode() as Document | ShadowRoot;
  return root.activeElement === field;
}

export interface CaretTapSample {
  x: number;
  y: number;
  focusedBefore: boolean;
  caretBefore: number | null;
  /** Read when the finger landed: the field's box, the visual viewport, what was under it. */
  fieldAtTap?: string;
  vvAtTap?: string;
  underAtTap?: string;
}

const box = (rect: DOMRect) =>
  `[${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}]`;

function describeViewport(): string {
  const vv = window.visualViewport;
  return vv ? `${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}` : 'none';
}

/** One log line for a tap: no text, only positions, lengths and geometry. */
export function describeCaretTap(field: TextField, tap: CaretTapSample): string {
  const rect = field.getBoundingClientRect();
  const length = field.value.length;
  const caret = (value: number | null) => (value === null ? '-' : String(value));
  const end = field.selectionEnd;
  const after =
    field.selectionStart === end
      ? caret(field.selectionStart)
      : `${caret(field.selectionStart)}-${caret(end)}`;
  const now = describeElement(deepElementFromPoint(tap.x, tap.y), field);
  return [
    `at ${Math.round(tap.x)},${Math.round(tap.y)}`,
    tap.fieldAtTap ? `field at the tap ${tap.fieldAtTap} now ${box(rect)}` : `field ${box(rect)}`,
    tap.underAtTap
      ? `under the finger: ${tap.underAtTap} (now ${now})`
      : `under the finger: ${now}`,
    `caret ${caret(tap.caretBefore)} -> ${after} of ${length}`,
    `focus ${tap.focusedBefore ? 'yes' : 'no'} -> ${isFocused(field) ? 'yes' : 'no (lost)'}`,
    `inner ${window.innerWidth}x${window.innerHeight}`,
    tap.vvAtTap
      ? `vv at the tap ${tap.vvAtTap} now ${describeViewport()}`
      : `vv ${describeViewport()}`,
    `scrollY ${Math.round(window.scrollY)}`,
  ].join(', ');
}

/**
 * Lit event bindings for a text field: `@pointerdown=${t.pointerdown} @pointerup=${t.pointerup}`.
 * Touch only, taps only; logs one line SETTLE_MS after the finger lifts.
 */
export function caretTapDiagnostics(log: (line: string) => void) {
  let down: (CaretTapSample & { id: number }) | null = null;
  return {
    pointerdown: (e: PointerEvent) => {
      const field = e.currentTarget as TextField | null;
      if (e.pointerType !== 'touch' || !field) {
        down = null;
        return;
      }
      down = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        focusedBefore: isFocused(field),
        caretBefore: field.selectionStart,
        fieldAtTap: box(field.getBoundingClientRect()),
        vvAtTap: describeViewport(),
        underAtTap: describeElement(deepElementFromPoint(e.clientX, e.clientY), field),
      };
    },
    pointerup: (e: PointerEvent) => {
      const field = e.currentTarget as TextField | null;
      const tap = down;
      down = null;
      if (!field || !tap || e.pointerType !== 'touch' || e.pointerId !== tap.id) return;
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_PX) return;
      setTimeout(() => {
        if (field.isConnected) log(describeCaretTap(field, tap));
      }, SETTLE_MS);
    },
  };
}
