/**
 * The app's one toast stack (design spec 3.4, 2026-10-12): bottom-right on the desktop, the
 * bottom of the screen on a phone. A toast never interrupts: an icon carries its color
 * (success, error, attention, info), one optional action, a close button.
 *
 *   toast({ kind: 'success', text: t('toast.notificationsEnabled') });
 *   toast({ kind: 'info', text, action: { label: t('x'), run: reload }, timeoutMs: 0 });
 *
 * Errors stay 6 s by default, the rest 4 s; 0 keeps it until dismissed. Actions act on
 * pointerup + swallowNextClick so the tap never reaches what lies underneath (iOS).
 *
 * Phones (phone-spec §3.10, 2026-10-12): the stack sits above the bottom bar the current
 * screen pins (`--ut-bottom-chrome`, set by each bar's owner), above the soft keyboard while it
 * is up (visualViewport), and a horizontal swipe past 60 px dismisses a toast.
 */
import { render } from 'lit';
import { type IconName, icon } from '../components/icons.js';
import { t } from '../i18n/index.js';
import { swallowNextClick } from './ghost-click.js';
import { isPhoneScreen } from './mobile-utils.js';
import { endsADrag } from './pointer-drag.js';
import { softKeyboardTarget } from './soft-keyboard.js';

export type ToastKind = 'info' | 'success' | 'error' | 'attention';

export interface ToastOptions {
  kind?: ToastKind;
  text: string;
  action?: { label: string; run: () => void };
  /** 0 keeps it until dismissed. Default 4000 (errors 6000). */
  timeoutMs?: number;
  /** A second toast with the same key replaces the first. Default: the text. */
  key?: string;
  /** It left: timed out, closed, its action run or replaced by another with the same key. */
  onDismiss?: () => void;
}

const ICONS: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert',
  attention: 'bell',
  info: 'info',
};

/** How long the exit transition runs (--dur-2). */
const EXIT_MS = 180;
/** A horizontal swipe longer than this dismisses the toast. */
export const SWIPE_DISMISS_PX = 60;

const open = new Map<string, () => void>();

/**
 * How much of the layout viewport the soft keyboard covers (0 when it is down). iOS keeps
 * innerHeight and shrinks visualViewport; fixed elements stay under the keyboard otherwise.
 */
function keyboardInset(): number {
  const vv = window.visualViewport;
  // No field focused, no keyboard, whatever a stale viewport says (soft-keyboard.ts).
  if (!vv || !softKeyboardTarget()) return 0;
  const covered = window.innerHeight - (vv.height + vv.offsetTop);
  // Under ~80 px is browser chrome (Safari's toolbar), not a keyboard.
  return covered > 80 ? Math.round(covered) : 0;
}

let viewportListening = false;
function syncKeyboardLift() {
  const el = document.querySelector<HTMLElement>('body > .ut-toast-stack');
  if (!el) return;
  const inset = isPhoneScreen() ? keyboardInset() : 0;
  if (inset > 0) el.style.bottom = `${inset + 12}px`;
  else el.style.removeProperty('bottom');
}
function listenViewport(on: boolean) {
  const vv = window.visualViewport;
  if (!vv || on === viewportListening) return;
  viewportListening = on;
  if (on) {
    vv.addEventListener('resize', syncKeyboardLift);
    vv.addEventListener('scroll', syncKeyboardLift);
  } else {
    vv.removeEventListener('resize', syncKeyboardLift);
    vv.removeEventListener('scroll', syncKeyboardLift);
  }
}

function stack(): HTMLElement {
  let el = document.querySelector<HTMLElement>('body > .ut-toast-stack');
  if (!el) {
    el = document.createElement('div');
    el.className = 'ut-toast-stack';
    document.body.appendChild(el);
    listenViewport(true);
    syncKeyboardLift();
  }
  return el;
}

/** Drag a toast sideways; past SWIPE_DISMISS_PX it leaves that way, else it springs back. */
function swipeToDismiss(el: HTMLElement, dismiss: (direction: number) => void) {
  let id: number | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let sliding = false;
  const reset = () => {
    id = null;
    sliding = false;
    el.style.removeProperty('transition');
    el.style.removeProperty('transform');
    el.style.removeProperty('opacity');
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    sliding = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    dx = e.clientX - startX;
    if (!sliding) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - startY)) return;
      sliding = true;
      el.style.transition = 'none';
    }
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 240));
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const wasSliding = sliding;
    const distance = dx;
    reset();
    if (!wasSliding) return;
    // The tap that ends a swipe must not press the button it ended on.
    swallowNextClick();
    if (Math.abs(distance) > SWIPE_DISMISS_PX) dismiss(Math.sign(distance));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', reset);
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function toast(options: ToastOptions): () => void {
  const kind = options.kind ?? 'info';
  const key = options.key ?? options.text;
  open.get(key)?.();

  const el = document.createElement('div');
  el.className = 'ut-toast';
  el.dataset.kind = kind;
  el.dataset.state = 'enter';
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const iconEl = document.createElement('span');
  iconEl.className = 'ut-toast-icon';
  render(icon(ICONS[kind]), iconEl);
  const label = document.createElement('span');
  label.className = 'ut-toast-text';
  label.textContent = options.text;
  const actions = document.createElement('span');
  actions.className = 'ut-toast-actions';

  let timer: number | undefined;
  let gone = false;
  const leave = (direction = 0) => {
    if (gone) return;
    gone = true;
    options.onDismiss?.();
    if (timer !== undefined) window.clearTimeout(timer);
    if (open.get(key) === dismiss) open.delete(key);
    const finish = () => {
      el.remove();
      const host = document.querySelector('body > .ut-toast-stack');
      if (host && !host.childElementCount) {
        host.remove();
        listenViewport(false);
      }
    };
    if (reducedMotion()) finish();
    else {
      // A swiped toast keeps going the way it was thrown.
      if (direction) el.style.transform = `translateX(${direction * 120}%)`;
      el.dataset.state = 'exit';
      window.setTimeout(finish, EXIT_MS);
    }
  };
  const dismiss = () => leave();

  const act = (run: () => void) => (e: Event) => {
    if (e.type === 'pointerup') {
      if ((e as PointerEvent).pointerType === 'mouse') return;
      // A drag that started on the button ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  const buttons: Array<[HTMLButtonElement, () => void]> = [];
  if (options.action) {
    const { label: actionLabel, run } = options.action;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ut-btn ut-btn--ghost ut-btn--sm ut-toast-action';
    button.textContent = actionLabel;
    actions.append(button);
    buttons.push([
      button,
      () => {
        dismiss();
        run();
      },
    ]);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ut-icon-btn ut-icon-btn--sm ut-toast-close';
  close.setAttribute('aria-label', t('toast.dismiss'));
  close.title = t('toast.dismiss');
  render(icon('x', 14), close);
  actions.append(close);
  buttons.push([close, dismiss]);
  for (const [button, run] of buttons) {
    for (const type of ['pointerup', 'click']) button.addEventListener(type, act(run));
  }

  el.append(iconEl, label, actions);
  swipeToDismiss(el, leave);
  stack().appendChild(el);
  open.set(key, dismiss);
  // Next frame: transition from the enter state.
  requestAnimationFrame(() => {
    if (!gone) delete el.dataset.state;
  });

  const timeoutMs = options.timeoutMs ?? (kind === 'error' ? 6_000 : 4_000);
  if (timeoutMs > 0) timer = window.setTimeout(dismiss, timeoutMs);
  return dismiss;
}

export interface ActionToastOptions {
  text: string;
  action: string;
  onAction: () => void;
  /** 0 keeps it until dismissed. Default 10 s. */
  timeoutMs?: number;
  /** A second notice with the same key replaces the first. */
  key?: string;
}

/** A notice with one action ("Recargar", "Abrir"): a toast that stays 10 s. */
export function showActionToast(options: ActionToastOptions): () => void {
  return toast({
    kind: 'info',
    text: options.text,
    action: { label: options.action, run: options.onAction },
    timeoutMs: options.timeoutMs ?? 10_000,
    key: options.key,
  });
}
