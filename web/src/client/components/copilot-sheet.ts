/**
 * «Conversar»: the voice copilot, a full-screen sheet on <body>. It talks with the copilot on
 * the Mac (services/copilot on the server, socket protocol in shared/copilot-protocol.ts): the
 * page sends only words (audio or typed), the server decides, acts on the sessions and answers
 * with speech. Two scopes, one component:
 *  - session: opened from a session's chat, about that session only;
 *  - global: opened from the home page, over every session (chips to pick the focus).
 *
 * Fixed layout (2026-10-13, user report «lo de escuchando se queda arriba»): header / orb with
 * the mic icon in its own box / one status line of fixed height / captions, the only flexible
 * row, scrolling inside / typing box (only without a microphone) / toggles. Nothing but the
 * captions depends on the text, so the orb, its icon and «Escuchando…» never move.
 *
 * Hold the orb to talk (a short tap sends nothing); «Manos libres» lets the voice alone open
 * and close a phrase. Talking over the copilot ducks it, then cuts it (barge-in). Interjection
 * clips («A ver…») come as a pool on connect and play when the server says, so they need no
 * network at that moment.
 *
 * Open it with `openCopilot()` inside the tap: iOS only allows the microphone and audio there.
 */
import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  CLIP_TURN,
  COPILOT_PROTOCOL_VERSION,
  type CopilotClientMessage,
  type CopilotErrorCode,
  type CopilotScope,
  type CopilotServerMessage,
  type CopilotSessionChip,
  decodeAudioFrame,
} from '../../shared/copilot-protocol.js';
import { getLocale, LocaleController, type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import { Z_INDEX } from '../utils/constants.js';
import { CopilotAudio, type MicProblem, ScreenAwake, wav16k } from '../utils/copilot-audio.js';
import { CopilotSocket, copilotUrl } from '../utils/copilot-socket.js';
import { type TurnEvent, TurnTaker } from '../utils/copilot-vad.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { type IconName, icon } from './icons.js';

const logger = createLogger('copilot');

type StateMsg = Extract<CopilotServerMessage, { type: 'state' }>;
type TurnEndMsg = Extract<CopilotServerMessage, { type: 'turn-end' }>;
type StatusTone = 'plain' | 'hint' | 'attn' | 'err';
export type CopilotMode = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface CopilotCaption {
  id: number;
  who: 'me' | 'cop' | 'sys';
  text: string;
  turn?: number;
  /** A system line about something that failed (red), not a warning (orange). */
  tone?: 'error';
  /** What the copilot did that turn, drawn as the chat's tool lines. */
  chips: CopilotActionLine[];
}

export interface CopilotActionLine {
  text: string;
  /** ok | held | fail | '' (not sent: read-only). */
  cls: string;
  /** The session it was about, set in mono inside the line. */
  name?: string;
  icon?: IconName;
}

/** One entry per utterance, performance.now() ms (smoke tests and on-device checks). */
export interface CopilotTiming {
  eos: number;
  durMs: number;
  spokenMs: number;
  silentMs: number;
  peekAt?: number;
  clipStart?: number;
  clipEnd?: number;
  clipId?: string;
  leadMs?: number;
  holdStart?: number;
  holdEnd?: number;
  holdId?: string;
  answerStart?: number;
  gapMs?: number;
  overlap?: boolean;
  bargeAt?: number;
  contAt?: number;
}

export const MAX_CAPTIONS = 12;
/**
 * The user starts talking again within 1.5 s of their last utterance, before any of its answer
 * was heard: they had only paused (2026-10-13), so the server carries the first half into this
 * one instead of answering half a sentence. Otherwise it is a plain barge-in.
 */
const CONT_MS = 1500;

const STORE = {
  handsFree: 'untether.copilot.handsFree',
  earcons: 'untether.copilot.earcons',
  readOnly: 'untether.copilot.readOnly',
};

function stored(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function store(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // private mode: not remembered
  }
}

const MIC_TEXT: Record<MicProblem, MessageKey> = {
  insecure: 'copilot.mic.insecure',
  denied: 'copilot.mic.denied',
  'denied-frame': 'copilot.mic.deniedFrame',
  none: 'copilot.mic.none',
  other: 'copilot.mic.other',
};

/**
 * Inside the iPhone app the permission is under the app, not Safari (2026-10-13, review). The
 * app's web view has no «Safari/» in its user agent; Safari and the Home Screen app do.
 */
function micText(problem: MicProblem): MessageKey {
  if (problem !== 'denied') return MIC_TEXT[problem];
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return iOS && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
    ? 'copilot.mic.deniedApp'
    : MIC_TEXT[problem];
}

const ERROR_TEXT: Partial<Record<CopilotErrorCode, MessageKey>> = {
  'no-token': 'copilot.error.noToken',
  'no-claude': 'copilot.error.noClaude',
  brain: 'copilot.error.brain',
};

const ACTION_TEXT: Record<string, MessageKey> = {
  send: 'copilot.action.send',
  answer: 'copilot.action.answer',
  interrupt: 'copilot.action.interrupt',
};

export function sameScope(a: CopilotScope, b: CopilotScope): boolean {
  return a.mode === b.mode && (a.mode === 'global' || a.sessionId === (b as typeof a).sessionId);
}

/** Act on pointerup (a first tap on iOS can be eaten as hover) and keyboard clicks. */
function onTap(action: () => void) {
  return {
    pointerup: (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (endsADrag(e)) return;
      e.preventDefault();
      swallowNextClick();
      action();
    },
    click: (e: MouseEvent) => {
      if (e.detail === 0) action(); // Enter/Space; real taps were handled on pointerup
    },
  };
}

@customElement('copilot-sheet')
export class CopilotSheet extends LitElement {
  static styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
      /*
       * Untether look (2026-10-14, user report «hacerlo más untether»): a full-height bottom
       * sheet on the app's tokens, like the other phone sheets. Grabber, «CONVERSAR» over the
       * session's name, a flat voice indicator in the app's recording language (amber while
       * listening, accent while speaking), chat bubbles and tool lines, the composer pill and
       * three toggle cells. No local colours: every colour is a --color-* token (custom
       * properties cross the shadow root), so light/dark and the accent themes apply here too.
       * The page's reset (padding: 0 on every element) beats :host, so the sheet inside pads.
       */
      :host {
        --orb: clamp(96px, 17dvh, 120px);
        --gut: var(
          --p-gutter,
          max(16px, env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px))
        );
        --lvl: 0;
        position: fixed;
        inset: 0;
        display: block;
        overflow: hidden;
        background: var(--ut-overlay-medium);
        color: var(--color-text);
        font: var(--p-text-body, 15px) / var(--p-text-body--line-height, 20px)
          var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
        overscroll-behavior: none;
        -webkit-user-select: none;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        animation: cop-fade var(--dur-2, 180ms) var(--ease-out, ease-out) both;
      }
      @supports not (height: 1dvh) {
        :host {
          --orb: clamp(96px, 17vh, 120px);
        }
      }
      * {
        box-sizing: border-box;
      }
      button {
        font: inherit;
        color: inherit;
        -webkit-tap-highlight-color: transparent;
      }
      /* The sheet: header / session cards (global) / voice indicator and status / text, the only
         flexible row / typing box (only without a microphone) / toggles. Nothing but the text
         depends on the text, so the indicator, its icon and «Escuchando…» never move. */
      .frame {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        top: max(8px, env(safe-area-inset-top, 0px));
        width: min(100%, 640px);
        margin: 0 auto;
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: 'head' 'chips' 'stage' 'caps' 'type' 'foot';
        padding: 14px var(--gut) max(12px, env(safe-area-inset-bottom, 0px));
        background: var(--color-bg-elevated);
        border-radius: var(--radius-dialog, 14px) var(--radius-dialog, 14px) 0 0;
        box-shadow: var(--shadow-e3, none);
        animation: cop-up 240ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
      }
      .grabber {
        position: absolute;
        top: 6px;
        left: 50%;
        width: 36px;
        height: 5px;
        margin-left: -18px;
        border-radius: var(--ut-r-pill);
        background: var(--color-border-strong);
        pointer-events: none;
      }
      header {
        grid-area: head;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        min-height: 52px;
        margin: 0 calc(-1 * var(--gut));
        padding: 0 calc(var(--gut) - 10px) 8px var(--gut);
        border-bottom: 1px solid var(--color-border);
      }
      .heading {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .eyebrow {
        font-size: 11px;
        line-height: 14px;
        font-weight: var(--ut-fw-semibold);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-text-dim);
      }
      .title {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        font-size: var(--p-text-title, 17px);
        line-height: var(--p-text-title--line-height, 22px);
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text-bright);
      }
      .title .chip,
      .title .name {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title .chip span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 12px;
        line-height: 16px;
        color: var(--color-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub.waiting {
        color: var(--color-attention-text);
      }
      .icon-btn {
        flex: none;
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        padding: 0;
        border: none;
        border-radius: var(--radius-ctl, 6px);
        background: var(--ut-piece-control-fill, none);
        color: var(--color-text-muted);
        cursor: pointer;
        touch-action: manipulation;
        transition: background-color var(--dur-1, 120ms) var(--ease-out, ease-out);
      }
      .icon-btn:active {
        background: var(--color-surface-hover);
      }
      .badge {
        flex: none;
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        color: var(--color-text-muted);
      }
      /* Status dots, as the app's .ut-dot: working pulses in the accent, needs-you is amber,
         live is green, finished grey, a failed turn red. */
      .dot {
        flex: none;
        width: 6px;
        height: 6px;
        border-radius: var(--ut-r-circle);
        background: var(--color-alive);
      }
      .busy .dot {
        background: var(--color-primary);
        animation: ut-pulse 1.6s ease-in-out infinite;
      }
      .waiting .dot {
        background: var(--color-attention);
      }
      .exited .dot {
        background: var(--color-text-dim);
      }
      .error .dot {
        background: var(--color-status-error);
        animation: none;
      }
      /* Global mode: one card per session, scrolling sideways. */
      .chips {
        grid-area: chips;
        display: flex;
        gap: 8px;
        min-width: 0;
        margin: 0 calc(-1 * var(--gut));
        padding: 10px var(--gut) 2px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
      }
      .chips::-webkit-scrollbar {
        display: none;
      }
      .chips.more {
        -webkit-mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 28px), transparent);
        mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 28px), transparent);
      }
      button.chip {
        flex: none;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: 220px;
        height: 52px;
        padding: 0 14px 0 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-card, 10px);
        background: var(--color-bg-secondary);
        text-align: left;
        cursor: pointer;
        transition:
          background-color var(--dur-2, 180ms) var(--ease-out, ease-out),
          border-color var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      button.chip[aria-pressed='true'] {
        background: var(--color-selected);
        border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
      }
      .chip.muted {
        opacity: 0.6;
      }
      .avatar {
        position: relative;
        flex: none;
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: var(--ut-r-8);
        background: var(--color-avatar-live-bg);
        color: var(--color-avatar-live-fg);
        font-size: 14px;
        font-weight: var(--ut-fw-semibold);
        text-transform: uppercase;
      }
      .waiting .avatar {
        background: var(--color-avatar-attn-bg);
        color: var(--color-avatar-attn-fg);
      }
      .exited .avatar {
        background: var(--color-avatar-off-bg);
        color: var(--color-avatar-off-fg);
      }
      .avatar .dot {
        position: absolute;
        right: -2px;
        bottom: -2px;
        width: 8px;
        height: 8px;
        box-shadow: 0 0 0 2px var(--color-bg-secondary);
      }
      .lines {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .lines .name {
        font-size: 15px;
        line-height: 20px;
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* The voice indicator: a flat circle in its own fixed box. Level bars, not size, follow
         the voice (--lvl, set per frame), so nothing around it ever moves. */
      .stage {
        grid-area: stage;
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 0;
        padding-top: clamp(14px, 3dvh, 28px);
      }
      .orbwrap {
        position: relative;
        flex: none;
        width: var(--orb);
        height: var(--orb);
        margin: 6px 0;
      }
      .orb {
        position: absolute;
        inset: 0;
        padding: 0;
        border: none;
        border-radius: var(--ut-r-circle);
        background: var(--color-bg-tertiary);
        box-shadow: inset 0 0 0 1px var(--color-border);
        cursor: pointer;
        touch-action: none;
        -webkit-touch-callout: none;
        transition: background-color var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      .orb:focus-visible {
        box-shadow:
          inset 0 0 0 1px var(--color-border),
          var(--focus-ring, 0 0 0 2px currentColor);
      }
      .ring {
        position: absolute;
        inset: -6px;
        border-radius: var(--ut-r-circle);
        border: 2px solid transparent;
        pointer-events: none;
        transition: border-color var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      .glyph {
        position: absolute;
        left: 50%;
        top: calc(50% - 26px);
        width: 28px;
        height: 28px;
        margin-left: -14px;
        color: var(--color-text-muted);
        pointer-events: none;
        transition:
          color var(--dur-2, 180ms) var(--ease-out, ease-out),
          opacity var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      .glyph > span {
        display: none;
      }
      .glyph svg {
        display: block;
      }
      .glyph .g-dots circle {
        r: 1.75px;
        fill: currentColor;
      }
      :host([data-mode='idle']) .g-mic,
      :host([data-mode='listening']) .g-mic,
      :host([data-mode='thinking']) .g-dots,
      :host([data-mode='speaking']) .g-spk {
        display: block;
      }
      .bars {
        position: absolute;
        left: 50%;
        top: calc(50% + 8px);
        width: 31px;
        height: 18px;
        margin-left: -15.5px;
        display: flex;
        align-items: center;
        gap: 4px;
        pointer-events: none;
      }
      .bars i {
        --k: 1;
        width: 3px;
        height: calc(3px + 15px * var(--lvl) * var(--k));
        border-radius: var(--ut-r-2);
        background: var(--color-border-strong);
        transition: height 80ms linear;
      }
      .bars i:nth-child(1),
      .bars i:nth-child(5) {
        --k: 0.6;
      }
      .bars i:nth-child(2),
      .bars i:nth-child(4) {
        --k: 0.85;
      }
      :host([data-mode='listening']) .orb {
        background: var(--color-attention-muted);
      }
      :host([data-mode='listening']) .glyph {
        color: var(--color-attention-text);
      }
      :host([data-mode='listening']) .bars i {
        background: var(--color-attention);
      }
      :host([data-mode='listening']) .ring {
        border-color: var(--color-attention);
        opacity: calc(0.5 + 0.5 * var(--lvl));
      }
      :host([data-mode='thinking']) .glyph {
        color: var(--color-text-dim);
        animation: ut-pulse 1.6s ease-in-out infinite;
      }
      :host([data-mode='thinking']) .bars {
        visibility: hidden;
      }
      :host([data-mode='speaking']) .orb {
        background: var(--color-avatar-live-bg);
      }
      :host([data-mode='speaking']) .glyph {
        color: var(--color-primary-text);
      }
      :host([data-mode='speaking']) .bars i {
        background: var(--color-primary-text);
        animation: cop-bar 0.9s ease-in-out infinite alternate;
      }
      .bars i:nth-child(2) {
        animation-delay: -0.3s;
      }
      .bars i:nth-child(3) {
        animation-delay: -0.6s;
      }
      .bars i:nth-child(4) {
        animation-delay: -0.15s;
      }
      .bars i:nth-child(5) {
        animation-delay: -0.45s;
      }
      /* A session waits for the user: amber, and a dashed ring so it never reads as listening. */
      :host([needs][data-mode='idle']) .orb {
        background: var(--color-attention-muted);
      }
      :host([needs][data-mode='idle']) .glyph {
        color: var(--color-attention-text);
      }
      :host([needs][data-mode='idle']) .ring {
        border: 2px dashed var(--color-attention);
      }
      .frame.off .glyph {
        opacity: 0.5;
      }
      .status {
        width: 100%;
        height: 20px;
        line-height: 20px;
        margin-top: 10px;
        color: var(--color-text-muted);
        font-size: var(--p-text-body, 15px);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
      .status b {
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text);
      }
      .status[data-tone='hint'] b {
        font-weight: var(--ut-fw-normal);
        color: inherit;
      }
      .status[data-tone='attn'] b {
        color: var(--color-attention-text);
      }
      .status[data-tone='err'] b {
        color: var(--color-status-error-text);
      }
      .status .time {
        margin-left: 8px;
        color: var(--color-text-dim);
      }
      /* The text: the only row that takes the leftover height, on the page colour between two
         hairlines; newest line kept in view. */
      .capsbox {
        grid-area: caps;
        min-height: 0;
        display: flex;
        margin: 14px calc(-1 * var(--gut)) 0;
        background: var(--color-bg);
        border-top: 1px solid var(--color-border);
        border-bottom: 1px solid var(--color-border);
      }
      .captions {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 16px var(--gut) 12px;
        font-size: var(--p-text-row, 16px);
        line-height: var(--p-text-row--line-height, 21px);
        overflow-y: auto;
        overscroll-behavior: contain;
        touch-action: pan-y;
        -webkit-overflow-scrolling: touch;
        -webkit-user-select: text;
        user-select: text;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0, var(--ut-mask-opaque) 18px);
        mask-image: linear-gradient(to bottom, transparent 0, var(--ut-mask-opaque) 18px);
      }
      .captions > :first-child {
        margin-top: auto;
      }
      .cap {
        flex: none;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        min-width: 0;
      }
      .cap.me {
        align-items: flex-end;
      }
      .bubble {
        max-width: 85%;
        padding: 9px 14px;
        border-radius: var(--ut-r-18);
        color: var(--color-text);
        overflow-wrap: anywhere;
        transition: color var(--dur-3, 240ms) var(--ease-out, ease-out);
      }
      .cop .bubble {
        background: var(--color-bg-elevated);
        border: 1px solid var(--color-border);
        border-bottom-left-radius: var(--ut-r-sm);
      }
      .me .bubble {
        background: var(--color-bg-tertiary);
        border-bottom-right-radius: var(--ut-r-sm);
      }
      .cap.old .bubble {
        color: var(--color-text-muted);
      }
      .cap.live .bubble::after {
        content: '';
        display: inline-block;
        width: 2px;
        height: 1em;
        margin-left: 3px;
        vertical-align: -2px;
        border-radius: var(--ut-r-1);
        background: var(--color-primary-text);
        animation: ut-pulse 1.6s ease-in-out infinite;
      }
      .cap.sys {
        flex-direction: row;
        gap: 8px;
        font-size: var(--p-text-body, 15px);
        line-height: var(--p-text-body--line-height, 20px);
        color: var(--color-status-warning-text);
        overflow-wrap: anywhere;
      }
      .cap.sys.error {
        color: var(--color-status-error-text);
      }
      .cap.sys svg {
        flex: none;
        margin-top: 2px;
      }
      .sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      /* What the copilot did, as the chat's tool lines: icon, the session, what happened. */
      .tag {
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        padding: 0 4px;
        font-size: 13px;
        line-height: 18px;
        color: var(--color-text-dim);
      }
      .tag svg {
        flex: none;
      }
      .tag b {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text-muted);
      }
      .tag.ok svg {
        color: var(--color-status-success-text);
      }
      .tag.held svg {
        color: var(--color-attention-text);
      }
      .tag.fail svg {
        color: var(--color-status-error-text);
      }
      .confirm {
        flex: none;
        overflow: hidden;
        border: 1px solid var(--color-attention);
        border-radius: var(--radius-card, 10px);
        background: var(--color-bg-elevated);
      }
      .confirm .strip {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: var(--color-attention-muted);
        color: var(--color-attention-text);
        font-size: 12px;
        line-height: 16px;
        font-weight: var(--ut-fw-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .confirm .body {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 12px 12px;
        font-size: var(--p-text-body, 15px);
        line-height: var(--p-text-body--line-height, 20px);
        color: var(--color-text-muted);
      }
      .confirm code {
        max-width: 100%;
        padding: 2px 6px;
        border-radius: var(--radius-chip, 4px);
        background: var(--color-bg-tertiary);
        color: var(--color-text);
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 13px;
        line-height: 18px;
        overflow-wrap: anywhere;
      }
      .empty {
        padding: 0 12px 6px;
        text-align: center;
      }
      .empty b {
        display: block;
        font-size: var(--p-text-title, 17px);
        line-height: var(--p-text-title--line-height, 22px);
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text);
      }
      .empty span {
        display: block;
        margin-top: 4px;
        font-size: var(--p-text-body, 15px);
        line-height: var(--p-text-body--line-height, 20px);
        color: var(--color-text-dim);
      }
      /* Typing box, as the composer: a pill field and a round send button. */
      form {
        grid-area: type;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        margin: 0;
        padding-top: 10px;
      }
      form input {
        flex: 1;
        min-width: 0;
        height: 44px;
        padding: 0 16px;
        border: 1px solid var(--color-border-strong);
        border-radius: var(--ut-r-rem-20);
        background: var(--color-surface);
        color: var(--color-text);
        font: inherit;
        font-size: 16px;
        outline: none;
        transition:
          border-color var(--dur-2, 180ms) var(--ease-out, ease-out),
          box-shadow var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      form input:focus,
      form input:focus-visible {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px var(--color-primary-muted);
      }
      .send {
        flex: none;
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        padding: 0;
        border: none;
        border-radius: var(--ut-r-circle);
        background: var(--color-bg-tertiary);
        color: var(--color-text-muted);
        cursor: pointer;
      }
      /* Three independent switches: icon, label and its state, pressed in the accent tint. */
      footer {
        grid-area: foot;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        min-width: 0;
        padding-top: 10px;
      }
      .toggle {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        grid-template-areas: 'icon state' 'label label';
        align-items: center;
        row-gap: 2px;
        column-gap: 6px;
        min-width: 0;
        height: 52px;
        padding: 0 8px 0 10px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-card, 10px);
        background: var(--color-bg-secondary);
        color: var(--color-text-muted);
        text-align: left;
        cursor: pointer;
        transition:
          background-color var(--dur-2, 180ms) var(--ease-out, ease-out),
          border-color var(--dur-2, 180ms) var(--ease-out, ease-out);
      }
      .toggle svg {
        grid-area: icon;
      }
      .toggle .state {
        grid-area: state;
        justify-self: end;
        font-size: 12px;
        line-height: 16px;
        color: var(--color-text-dim);
      }
      .toggle .label {
        grid-area: label;
        min-width: 0;
        font-size: 14px;
        line-height: 18px;
        font-weight: var(--ut-fw-semibold);
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .toggle[aria-pressed='true'] {
        background: color-mix(in srgb, var(--color-primary) 15%, var(--color-bg-elevated));
        border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
        color: var(--color-primary-text);
      }
      .toggle[aria-pressed='true'] .state {
        color: var(--color-primary-text);
      }
      /* The smallest phones (320 px): «Manos libres» still fits its cell. */
      @media (max-width: 359px) {
        footer {
          grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr);
        }
        .toggle {
          padding: 0 6px 0 8px;
        }
        .toggle .label {
          font-size: 13px;
          letter-spacing: -0.02em;
        }
      }
      /* Audio needs one more tap: the same sheet, one button, the only accent fill. */
      .unlock {
        grid-row: stage-start / foot-end;
        grid-column: 1 / -1;
        z-index: 5;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        margin: 0 calc(-1 * var(--gut));
        padding: 0 var(--gut);
        background: var(--color-bg-elevated);
      }
      .unlock .still {
        display: grid;
        place-items: center;
        width: 120px;
        height: 120px;
        border-radius: var(--ut-r-circle);
        background: var(--color-bg-tertiary);
        box-shadow: inset 0 0 0 1px var(--color-border);
        color: var(--color-text-muted);
      }
      .unlock button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 44px;
        padding: 0 20px;
        border: none;
        border-radius: var(--radius-ctl, 6px);
        background: var(--color-primary);
        color: var(--color-on-fill);
        font-size: 16px;
        font-weight: var(--ut-fw-semibold);
        cursor: pointer;
      }
      .unlock p {
        max-width: 280px;
        margin: 0;
        color: var(--color-text-dim);
        font-size: var(--p-text-body, 15px);
        line-height: var(--p-text-body--line-height, 20px);
        text-align: center;
      }
      @keyframes cop-up {
        from {
          transform: translateY(100%);
        }
        to {
          transform: none;
        }
      }
      @keyframes cop-fade {
        from {
          opacity: 0;
        }
      }
      /* The page's ut-pulse does not reach the shadow root. */
      @keyframes ut-pulse {
        50% {
          opacity: 0.45;
        }
      }
      @keyframes cop-bar {
        from {
          height: 4px;
        }
        to {
          height: calc(18px * var(--k));
        }
      }
      /* Short frames (a phone on its side, the preview pane): smaller indicator, tighter rows. */
      @media (max-height: 420px) {
        :host {
          --orb: 64px;
        }
        .frame {
          top: max(4px, env(safe-area-inset-top, 0px));
          padding-top: 12px;
          padding-bottom: max(6px, env(safe-area-inset-bottom, 0px));
        }
        .eyebrow,
        .sub {
          display: none;
        }
        header {
          min-height: 40px;
          padding-bottom: 4px;
        }
        /* The keyboard is up: the text and the typing box get the room, not the toggles. */
        .frame:has(form:focus-within) footer {
          display: none;
        }
        .stage {
          padding-top: 6px;
        }
        .glyph {
          top: calc(50% - 20px);
          width: 22px;
          height: 22px;
          margin-left: -11px;
        }
        .glyph svg {
          width: 22px;
          height: 22px;
        }
        .bars {
          top: calc(50% + 6px);
          height: 12px;
        }
        .bars i {
          height: calc(3px + 9px * var(--lvl) * var(--k));
        }
        button.chip {
          height: 40px;
        }
        button.chip .sub {
          display: none;
        }
        .avatar {
          width: 26px;
          height: 26px;
          font-size: 12px;
        }
        .capsbox {
          margin-top: 8px;
        }
        .captions {
          padding-top: 10px;
        }
        footer {
          padding-top: 6px;
        }
        .toggle {
          grid-template-areas: 'icon label';
          height: 40px;
        }
        .toggle .state {
          display: none;
        }
        .unlock .still {
          width: 64px;
          height: 64px;
        }
      }
      /* Landscape: indicator and status on the left; text, typing box and toggles on the right. */
      @media (orientation: landscape) and (max-height: 500px) {
        .frame {
          width: 100%;
          grid-template-columns: minmax(150px, 34%) minmax(0, 1fr);
          grid-template-rows: auto auto minmax(0, 1fr) auto auto;
          grid-template-areas: 'head head' 'chips chips' 'stage caps' 'stage type' 'stage foot';
          column-gap: 16px;
          padding-left: max(16px, env(safe-area-inset-left, 0px));
          padding-right: max(16px, env(safe-area-inset-right, 0px));
        }
        .stage {
          align-self: center;
          padding-top: 0;
        }
        .capsbox {
          margin: 8px 0 0;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-card, 10px);
          overflow: hidden;
        }
        .captions {
          padding-left: 12px;
          padding-right: 12px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .frame {
          animation-name: cop-fade;
        }
        :host([data-mode='speaking']) .bars i {
          animation: none !important;
          height: calc(18px * var(--k));
        }
      }
    `,
    materialControlStyles,
  ];

  protected readonly i18n = new LocaleController(this);

  scope: CopilotScope = { mode: 'global' };
  /** Last state from the server. */
  @state() private server: StateMsg | null = null;
  @state() private socketOpen = false;
  @state() private everOpen = false;
  @state() mode: CopilotMode = 'idle';
  @state() captions: CopilotCaption[] = [];
  @state() private micProblem: MicProblem | null = null;
  @state() private audioPaused = false;
  @state() handsFree = stored(STORE.handsFree, false);
  @state() private earcons = stored(STORE.earcons, true);
  /** «Solo mirar»: this page's turns never act on a session. Off until the user turns it on. */
  @state() readOnly = stored(STORE.readOnly, false);
  /** The audio could not be unlocked by the opening tap: one more tap («Empezar»). */
  @state() private needsStart = false;
  @state() private listenSecs = 0;
  private listenTimer: ReturnType<typeof setInterval> | null = null;

  /** Timings per utterance (see CopilotTiming). */
  readonly timings: CopilotTiming[] = [];

  private readonly audio = new CopilotAudio();
  private readonly awake = new ScreenAwake();
  private socket: CopilotSocket | null = null;
  private vad: TurnTaker | null = null;
  private started = false;
  private captionSeq = 0;
  private capStick = true;
  private resizeObserver: ResizeObserver | null = null;
  // Turn bookkeeping (as the prototype's page).
  private playingTurn = 0;
  private lastUserTurn = 0;
  private readonly cancelled = new Set<number>();
  private readonly turnAudioStarted = new Set<number>();
  /** Answer audio that arrived while the user was talking: played once they stop. */
  private heldAudio: Array<{ turn: number; audio: AudioBuffer }> = [];
  private clipMeta: Record<string, Record<number, { id: string; cat: string; text: string }>> = {};
  private clipBuffers: Record<string, AudioBuffer> = {};
  private clipLang = 'es';
  private decodeChain: Promise<void> = Promise.resolve();
  private lastEosAt = -1e9;
  private pointerDown = false;
  private peekAt = 0;
  private shownErrors = new Set<string>();

  // ------------------------------------------------------------------ lifecycle

  /** Must run synchronously inside the opening tap (audio unlock and mic prompt on iOS). */
  begin(): void {
    try {
      this.audio.unlock();
    } catch (error) {
      logger.warn('no audio here', error);
    }
    this.audio.onIdle = () => this.onPlaybackIdle();
    this.audio.onState = (running) => this.onAudioState(running);
    this.started = true;
    this.connect();
    void this.startMic().then((ok) => {
      if (ok && this.handsFree) void this.awake.acquire();
      else if (!ok) this.handsFree = false;
    });
    // Opened without a gesture that unlocks audio: ask for one tap.
    setTimeout(() => {
      if (this.isConnected && this.audio.ctx && !this.audio.running) this.needsStart = true;
    }, 600);
  }

  /** Moves this sheet to another scope (the server moves the page's conversation). */
  setScope(scope: CopilotScope): void {
    if (sameScope(scope, this.scope)) return;
    this.scope = scope;
    this.captions = [];
    this.server = null;
    this.stopAudio();
    this.socket?.send(this.hello());
  }

  private hello(): CopilotClientMessage {
    return {
      type: 'hello',
      v: COPILOT_PROTOCOL_VERSION,
      ...this.scope,
      readOnly: this.readOnly,
      clipLang: getLocale() === 'en' ? 'en' : 'es',
    };
  }

  private connect() {
    this.socket = new CopilotSocket(() => copilotUrl(authClient.getCurrentUser()?.token), {
      hello: () => this.hello(),
      onMessage: (m) => this.onMessage(m),
      onAudio: (f) => this.onAudio(f),
      onOpenChange: (open) => {
        this.socketOpen = open;
        if (open) this.everOpen = true;
        else {
          this.abortUtterance();
          this.stopAudio();
          // The answer to a turn in flight is lost with the socket.
          if (this.mode === 'thinking') this.setMode('idle');
        }
      },
    });
    this.socket.connect();
  }

  private finish = () => {
    this.cleanup();
    this.remove();
  };

  private releaseFocus: (() => void) | null = null;
  private bodyOverflow: string | null = null;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>('button:not([disabled]), input')
    );
    if (!items.length) return;
    const active = (this.renderRoot as ShadowRoot).activeElement;
    const index = active ? items.indexOf(active as HTMLElement) : -1;
    const next = e.shiftKey
      ? index <= 0
        ? items.length - 1
        : index - 1
      : index === -1 || index === items.length - 1
        ? 0
        : index + 1;
    e.preventDefault();
    items[next].focus();
  };

  private onVisibility = () => {
    if (document.hidden) this.abortUtterance();
    else if (this.audio.ctx && !this.audio.running) this.onAudioState(false);
  };

  /** Any tap brings the audio engine back (iOS needs a gesture after a call or an app switch). */
  private onAnyPointer = () => {
    const ctx = this.audio.ctx;
    if (this.started && ctx && ctx.state !== 'running') {
      ctx.resume().then(
        () => this.onAudioState(ctx.state === 'running'),
        () => undefined
      );
    }
  };

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    this.setAttribute('aria-label', t('copilot.title'));
    this.style.zIndex = String(Z_INDEX.COPILOT_SHEET);
    this.dataset.mode = this.mode;
    this.addEventListener('keydown', this.onKeyDown);
    this.addEventListener('pointerdown', this.onAnyPointer, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.bodyOverflow === null) {
      this.bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    this.releaseFocus?.();
    this.releaseFocus = holdSheetFocus(this, this.finish);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.onKeyDown);
    this.removeEventListener('pointerdown', this.onAnyPointer, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.bodyOverflow !== null) {
      document.body.style.overflow = this.bodyOverflow;
      this.bodyOverflow = null;
    }
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.cleanup();
  }

  private cleanup() {
    this.started = false;
    this.socket?.close();
    this.socket = null;
    this.audio.close();
    this.awake.release();
    this.vad = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.listenTimer) clearInterval(this.listenTimer);
    this.listenTimer = null;
  }

  firstUpdated() {
    const caps = this.captionsEl();
    if (caps && typeof ResizeObserver !== 'undefined') {
      // The area shrinks (typing box shown, rotation): keep the newest line in view.
      this.resizeObserver = new ResizeObserver(() => {
        if (this.capStick) caps.scrollTop = caps.scrollHeight;
      });
      this.resizeObserver.observe(caps);
    }
    this.renderRoot.querySelector<HTMLElement>('#copilot-orb')?.focus({ preventScroll: true });
  }

  updated(changed: Map<PropertyKey, unknown>) {
    if (changed.has('mode')) {
      this.dataset.mode = this.mode;
      this.trackListening();
    }
    if (changed.has('server')) {
      this.toggleAttribute(
        'needs',
        Boolean(this.server?.sessions.some((s) => s.status === 'waiting'))
      );
      this.markChipsOverflow();
    }
    if (changed.has('captions')) {
      const el = this.captionsEl();
      if (el && this.capStick) el.scrollTop = el.scrollHeight;
    }
  }

  /** «Escuchando… 0:04»: seconds since the phrase started, ticking once a second. */
  private trackListening() {
    if (this.mode === 'listening') {
      if (this.listenTimer) return;
      const at = performance.now();
      this.listenSecs = 0;
      this.listenTimer = setInterval(() => {
        this.listenSecs = Math.floor((performance.now() - at) / 1000);
      }, 1000);
    } else if (this.listenTimer) {
      clearInterval(this.listenTimer);
      this.listenTimer = null;
    }
  }

  private captionsEl(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('#copilot-captions');
  }

  private onCaptionsScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    // Scrolled up to reread: stop following; back at the bottom: follow again.
    this.capStick = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  private markChipsOverflow = () => {
    const d = this.renderRoot.querySelector<HTMLElement>('.chips');
    if (!d) return;
    d.classList.toggle(
      'more',
      d.scrollWidth > d.clientWidth + 1 && d.scrollLeft + d.clientWidth < d.scrollWidth - 4
    );
  };

  // ------------------------------------------------------------------ server messages

  private onMessage(m: CopilotServerMessage) {
    switch (m.type) {
      case 'state':
        this.server = m;
        break;
      case 'turn-start':
        // Only this page's own turns change its state (another open page's turns add captions).
        if (m.origin === 'user' && m.own) {
          this.lastUserTurn = m.turn;
          this.setMode('thinking');
        }
        break;
      case 'sentence':
        this.addCaption('cop', m.text, m.turn);
        break;
      case 'turn-end':
        this.onTurnEnd(m);
        break;
      case 'earcon':
        if (this.earcons) this.audio.earcon(m.kind);
        break;
      case 'transcript':
        if (m.text && !m.ignored) this.addCaption('me', m.text);
        else if (this.mode === 'thinking') this.setMode('idle');
        break;
      case 'stop-audio':
        this.stopAudio();
        break;
      case 'clips':
        this.clipLang = m.lang;
        this.clipMeta[m.lang] = {};
        for (const c of m.clips)
          this.clipMeta[m.lang][c.n] = { id: c.id, cat: c.cat, text: c.text };
        break;
      case 'clip':
        this.playClip(m.lang, m.id, m.turn, m.stage);
        break;
      case 'action':
        break;
      case 'error': {
        const key = ERROR_TEXT[m.code];
        if (key && !this.shownErrors.has(m.code)) {
          this.shownErrors.add(m.code);
          this.addCaption('sys', t(key), undefined, 'error');
        }
        break;
      }
    }
  }

  private onTurnEnd(m: TurnEndMsg) {
    const names = new Map((this.server?.sessions ?? []).map((s) => [s.sid, s.name]));
    const chips = m.actions
      .filter((a) => a.kind !== 'none' && a.kind !== 'invalid')
      .map((a): CopilotActionLine => {
        const name = (a.sid && names.get(a.sid)) || a.sid || '';
        if (a.outcome === 'held') {
          return { text: t('copilot.action.held', { name }), cls: 'held', name, icon: 'clock' };
        }
        if (a.outcome === 'readonly') {
          return { text: t('copilot.action.readonly', { name }), cls: '', name, icon: 'eye' };
        }
        const key = ACTION_TEXT[a.kind];
        if (a.outcome !== 'done' || !key) {
          return { text: t('copilot.action.failed', { name }), cls: 'fail', name, icon: 'alert' };
        }
        const done: IconName = a.kind === 'send' ? 'send' : 'check';
        return { text: t(key, { name }), cls: 'ok', name, icon: done };
      });
    if (chips.length) {
      const i = this.captions.map((c) => c.who === 'cop' && c.turn === m.turn).lastIndexOf(true);
      if (i >= 0) {
        const next = this.captions.slice();
        next[i] = { ...next[i], chips };
        this.captions = next;
      }
    }
    if (!m.own) return;
    // Audio still being decoded is about to play: idle only once it has settled with nothing
    // playing (2026-10-13, review: «Mantén pulsado para hablar» flashed mid-turn).
    const chain = this.decodeChain;
    void chain.then(() => {
      if (this.decodeChain !== chain) return;
      if (!this.audio.playing() && !this.heldAudio.length && this.mode === 'thinking') {
        this.setMode('idle');
      }
    });
  }

  private addCaption(
    who: CopilotCaption['who'],
    text: string,
    turn?: number,
    tone?: CopilotCaption['tone']
  ) {
    const caps = this.captions.slice();
    const last = caps[caps.length - 1];
    if (who === 'cop' && last && last.who === 'cop' && last.turn === turn) {
      caps[caps.length - 1] = { ...last, text: `${last.text} ${text}` };
    } else {
      caps.push({ id: ++this.captionSeq, who, text, turn, chips: [], ...(tone ? { tone } : {}) });
    }
    while (caps.length > MAX_CAPTIONS) caps.shift();
    this.captions = caps;
  }

  // ------------------------------------------------------------------ audio out

  private curTiming(): CopilotTiming | undefined {
    return this.timings[this.timings.length - 1];
  }

  private onAudio(buf: ArrayBuffer) {
    const frame = decodeAudioFrame(buf);
    if (!frame || !this.audio.ctx) return;
    // decodeAudioData detaches its input: give it its own copy.
    const payload = frame.payload.slice().buffer as ArrayBuffer;
    const { turn, index } = frame;
    if (turn === CLIP_TURN) {
      const meta = this.clipMeta[this.clipLang]?.[index];
      if (!meta) return;
      const key = `${this.clipLang}|${meta.id}`;
      this.audio.decode(payload).then(
        (audio) => {
          this.clipBuffers[key] = audio;
        },
        () => undefined
      );
      return;
    }
    if (turn < this.playingTurn && this.audio.playing()) return;
    // Decoded one after another: the pieces of one sentence play in the order they came.
    this.decodeChain = this.decodeChain.then(async () => {
      let audio: AudioBuffer;
      try {
        audio = await this.audio.decode(payload);
      } catch {
        return;
      }
      if (this.cancelled.has(turn)) return;
      // An answer arriving while the user talks waits until they stop.
      if (this.vad?.listening) {
        this.heldAudio.push({ turn, audio });
        return;
      }
      this.playAnswer(turn, audio);
    });
  }

  private playAnswer(turn: number, audio: AudioBuffer) {
    this.playingTurn = Math.max(this.playingTurn, turn);
    this.turnAudioStarted.add(turn);
    // A hold clip («Un momento.») still playing when the answer is here: fade it, answer now.
    const holdEnd = this.audio.fadeHoldClips();
    const t = this.curTiming();
    if (t && holdEnd !== null) t.holdEnd = this.audio.perfAt(holdEnd);
    const start = this.audio.schedule(audio, 'answer');
    this.setMode('speaking');
    if (t && t.answerStart === undefined && performance.now() > t.eos) {
      t.answerStart = this.audio.perfAt(start);
      const end = Math.max(
        t.clipEnd ?? Number.NEGATIVE_INFINITY,
        t.holdEnd ?? Number.NEGATIVE_INFINITY
      );
      if (Number.isFinite(end)) {
        t.gapMs = Math.round(t.answerStart - end);
        t.overlap = t.answerStart < end - 1;
      }
    }
  }

  private flushHeldAudio() {
    const held = this.heldAudio;
    this.heldAudio = [];
    for (const x of held) if (!this.cancelled.has(x.turn)) this.playAnswer(x.turn, x.audio);
  }

  /** A clip from the pool, now. Skipped once its turn is cut or talking, or while the user talks. */
  private playClip(lang: string, id: string, turn: number, stage: 'A' | 'B' | 'hold') {
    const buf = this.clipBuffers[`${lang}|${id}`];
    if (!buf || !this.audio.ctx) return;
    if (this.cancelled.has(turn) || this.turnAudioStarted.has(turn)) return;
    if (this.vad?.listening || this.audioPaused) return; // never over the user
    if (turn > this.playingTurn) this.playingTurn = turn;
    const start = this.audio.schedule(buf, stage === 'hold' ? 'hold' : 'clip');
    const t = this.curTiming();
    if (t && stage !== 'hold' && t.clipStart === undefined) {
      t.clipStart = this.audio.perfAt(start);
      t.clipEnd = this.audio.perfAt(start + buf.duration);
      t.clipId = id;
      t.leadMs = Math.round(t.clipStart - t.eos);
    } else if (t && stage === 'hold') {
      t.holdStart = this.audio.perfAt(start);
      t.holdEnd = this.audio.perfAt(start + buf.duration);
      t.holdId = id;
    }
  }

  private onPlaybackIdle() {
    if (this.mode === 'speaking') this.setMode(this.vad?.listening ? 'listening' : 'idle');
  }

  private stopAudio() {
    this.heldAudio = [];
    this.audio.stop();
    this.cancelled.add(this.playingTurn);
    if (this.mode === 'speaking') this.setMode(this.vad?.listening ? 'listening' : 'idle');
  }

  /** The user talks while the copilot speaks or thinks: cut it, or carry the paused phrase on. */
  private bargeNow(voiceAt: number = performance.now()) {
    const sinceEos = voiceAt - this.lastEosAt;
    const t = this.curTiming();
    const playing = this.audio.playing();
    const clipsOnly = this.audio.onlyClipsPlaying();
    const cont =
      !this.turnAudioStarted.has(this.lastUserTurn) &&
      (clipsOnly || !playing) &&
      (sinceEos < CONT_MS || this.mode === 'thinking');
    this.stopAudio();
    if (t && clipsOnly && t.bargeAt === undefined) t.bargeAt = performance.now();
    if (cont) {
      if (this.lastUserTurn) this.cancelled.add(this.lastUserTurn);
      if (t) t.contAt = performance.now();
      this.socket?.send({ type: 'barge', cont: true });
    } else {
      this.socket?.send({ type: 'barge', turn: this.playingTurn });
    }
  }

  // ------------------------------------------------------------------ audio in

  private startMic(): Promise<boolean> {
    if (!this.audio.ctx) return Promise.resolve(false);
    return this.audio
      .openMic(
        (frame) => this.onFrame(frame),
        (problem) => {
          const first = this.micProblem !== problem;
          this.micProblem = problem;
          // Short line under the orb; the full explanation once in the captions.
          if (first) this.addCaption('sys', t(micText(problem)));
        }
      )
      .then((ok) => {
        if (ok) {
          this.micProblem = null;
          this.vad ??= new TurnTaker(this.audio.sampleRate);
        }
        return ok;
      });
  }

  private onFrame(frame: Float32Array) {
    const vad = this.vad;
    if (!vad || !this.started) return;
    const speakingOut = this.audio.playing();
    const events = vad.frame(frame, {
      now: performance.now(),
      speakingOut,
      clipsOnly: speakingOut && this.audio.onlyClipsPlaying(),
      handsFree: this.handsFree,
      thinking: this.mode === 'thinking',
    });
    // The level bars follow the voice (--lvl, 0..1); the indicator itself never changes size.
    if (vad.listening) this.style.setProperty('--lvl', String(Math.min(vad.level * 3, 1)));
    this.handle(events);
  }

  private handle(events: TurnEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case 'duck':
          this.audio.duck(e.on);
          break;
        case 'barge':
          this.bargeNow(e.voiceAt);
          break;
        case 'start':
          this.socket?.send({ type: 'vad', speaking: true });
          this.setMode('listening');
          break;
        case 'peek':
          if (!this.socket?.open) break;
          this.peekAt = performance.now();
          this.socket.send({ type: 'utt-peek' });
          this.socket.sendAudio(wav16k(e.chunks, this.audio.sampleRate));
          break;
        case 'resume':
          this.socket?.send({ type: 'utt-resume' });
          break;
        case 'end': {
          const eos = performance.now();
          this.socket?.send({ type: 'vad', speaking: false });
          this.lastEosAt = eos;
          const timing: CopilotTiming = {
            eos,
            durMs: e.durMs,
            spokenMs: e.spokenMs,
            silentMs: e.silentMs,
          };
          if (e.peeked) timing.peekAt = this.peekAt;
          this.timings.push(timing);
          if (this.timings.length > 40) this.timings.shift();
          // Nothing new since the peek: no second WAV.
          const sent = e.peeked
            ? this.socket?.send({ type: 'utt-commit' })
            : this.socket?.sendAudio(wav16k(e.chunks, this.audio.sampleRate));
          // A phrase that never left (socket closed) has no answer coming: no "Un momento…"
          // forever, the status line says the Mac is unreachable.
          this.setMode(sent ? 'thinking' : 'idle');
          this.flushHeldAudio();
          break;
        }
        case 'drop':
          this.socket?.send({ type: 'vad', speaking: false });
          this.socket?.send({ type: 'utt-drop' });
          this.setMode('idle');
          this.flushHeldAudio();
          break;
      }
    }
  }

  /** The phrase can't finish (audio paused, page hidden, socket gone): drop it. */
  private abortUtterance() {
    if (!this.vad) return;
    this.pointerDown = false;
    const events = this.vad.abort();
    if (events.length) this.heldAudio = [];
    this.handle(events);
  }

  private onAudioState(running: boolean) {
    if (!this.started) return;
    if (!running) this.abortUtterance();
    this.audioPaused = !running;
    if (running) this.needsStart = false;
  }

  /** While the mic records, the page stays «listening» whatever else arrives. */
  private setMode(m: CopilotMode) {
    if (this.vad?.listening && m !== 'listening') return;
    this.mode = m;
    if (m !== 'listening') this.style.setProperty('--lvl', '0');
  }

  // ------------------------------------------------------------------ controls

  private onOrbDown = async (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // synthetic events have no active pointer
    }
    this.pointerDown = true;
    const pressAt = performance.now();
    if (!(await this.startMic())) {
      // No microphone: a tap still cuts the copilot's voice.
      if (this.audio.playing()) this.bargeNow(pressAt);
      return;
    }
    // The first press can open the permission sheet; if the finger is already up, don't record.
    if (!this.pointerDown || !this.vad) return;
    if (this.audio.playing() || this.mode === 'thinking') this.bargeNow(pressAt);
    this.handle(this.vad.press());
  };

  private onOrbUp = () => {
    this.pointerDown = false;
    if (this.vad) this.handle(this.vad.release());
  };

  private onOrbKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.type === 'keydown' && !e.repeat && !this.pointerDown) {
      void this.onOrbDown(new PointerEvent('pointerdown', { button: 0 }));
    } else if (e.type === 'keyup') {
      this.onOrbUp();
    }
  };

  private toggleHandsFree = async () => {
    const on = !this.handsFree;
    this.handsFree = on;
    if (on) {
      if (!(await this.startMic())) {
        this.handsFree = false;
        return;
      }
      void this.awake.acquire();
    } else {
      this.awake.release();
      if (this.vad?.listening) this.handle(this.vad.finish());
    }
    store(STORE.handsFree, this.handsFree);
  };

  private toggleEarcons = () => {
    this.earcons = !this.earcons;
    store(STORE.earcons, this.earcons);
  };

  private toggleReadOnly = () => {
    this.readOnly = !this.readOnly;
    store(STORE.readOnly, this.readOnly);
    this.socket?.send({ type: 'read-only', on: this.readOnly });
  };

  private onType = (e: Event) => {
    e.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>('#copilot-text-input');
    const text = input?.value.trim();
    if (!input || !text) return;
    if (this.audio.playing()) {
      this.stopAudio();
      this.socket?.send({ type: 'barge', turn: this.playingTurn });
    }
    // Closed socket: the text stays in the box (the status line says the Mac is unreachable)
    // instead of vanishing with a "Un momento…" that never ends.
    if (!this.socket?.send({ type: 'text', text })) return;
    input.value = '';
    this.setMode('thinking');
  };

  private onStart = () => {
    try {
      this.audio.unlock();
    } catch {
      // no audio here
    }
    this.needsStart = false;
    void this.startMic();
  };

  private focusSession(sessionId: string, focused: boolean) {
    this.socket?.send({ type: 'focus', sessionId: focused ? null : sessionId });
  }

  // ------------------------------------------------------------------ render

  private statusText(): { text: string; title: string; tone: StatusTone } {
    const s = this.server;
    if (!this.socketOpen || (s && !s.connected)) {
      return this.everOpen
        ? { text: t('copilot.status.offline'), title: '', tone: 'err' }
        : { text: t('copilot.status.connecting'), title: '', tone: 'plain' };
    }
    if (this.micProblem && !this.audio.hasMic)
      return { text: t('copilot.status.noMic'), title: '', tone: 'plain' };
    if (this.mode === 'listening')
      return { text: t('copilot.status.listening'), title: '', tone: 'attn' };
    if (this.audioPaused) return { text: t('copilot.status.paused'), title: '', tone: 'plain' };
    if (this.mode === 'thinking')
      return { text: t('copilot.status.thinking'), title: '', tone: 'plain' };
    if (this.mode === 'speaking')
      return { text: t('copilot.status.speaking'), title: '', tone: 'plain' };
    if (s?.pending) return { text: t('copilot.status.confirm'), title: s.pending, tone: 'attn' };
    return {
      text: t(this.handsFree ? 'copilot.status.handsFree' : 'copilot.status.hold'),
      title: '',
      tone: 'hint',
    };
  }

  /** «Hablando · toca para cortar»: the state in bold, the hint after it in the muted grey. */
  private renderStatus() {
    const status = this.statusText();
    const cut = status.text.indexOf(' · ');
    const lead = cut < 0 ? status.text : status.text.slice(0, cut);
    const rest = cut < 0 ? '' : status.text.slice(cut);
    const secs = this.listenSecs;
    return html`<div
      class="status"
      id="copilot-status"
      role="status"
      aria-live="polite"
      data-tone=${status.tone}
      title=${status.title}
    ><b>${lead}</b>${rest}${
      this.mode === 'listening'
        ? html`<span class="time" aria-hidden="true">${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</span>`
        : nothing
    }</div>`;
  }

  private chipState(s: CopilotSessionChip): string {
    return s.error ? 'error' : s.status;
  }

  private stateWord(s: CopilotSessionChip): string {
    switch (s.status) {
      case 'busy':
        return t('status.working');
      case 'waiting':
        return t('status.needsInput');
      case 'shell':
        return t('copilot.state.shell');
      case 'exited':
        return t('status.exitedOk');
      default:
        return t('copilot.state.idle');
    }
  }

  /** Global mode: one card per session (avatar, name, state); a tap moves the focus there. */
  private renderChips() {
    const sessions = this.server?.sessions ?? [];
    return html`<div class="chips" aria-label=${t('copilot.sessions')} @scroll=${this.markChipsOverflow}>
      ${repeat(
        sessions,
        (s) => s.sessionId,
        (s) => html`<button
          class="ut-surface--badge chip ${this.chipState(s)}${s.focus ? ' focus' : ''}${s.muted ? ' muted' : ''}"
          id="copilot-chip-${s.sid}"
          aria-pressed=${s.focus ? 'true' : 'false'}
          @click=${() => this.focusSession(s.sessionId, s.focus)}
        >
          <span class="avatar" aria-hidden="true">${[...s.name][0] ?? '·'}<i class="dot"></i></span>
          <span class="lines">
            <span class="name">${s.name}</span>
            <span class="sub ${s.status === 'waiting' ? 'waiting' : ''}">${this.stateWord(s)}</span>
          </span>
        </button>`
      )}
    </div>`;
  }

  /** «CONVERSAR» over the session's name (session mode) or «Todas las sesiones» (global). */
  private renderHeading() {
    const one = this.scope.mode === 'session' ? this.server?.sessions[0] : undefined;
    return html`<div class="heading">
      <span class="eyebrow">${t('copilot.open')}</span>
      <span class="title">${
        this.scope.mode === 'global'
          ? html`<span class="name">${t('copilot.allSessions')}</span>`
          : one
            ? html`<span class="chip ${this.chipState(one)}${one.muted ? ' muted' : ''}" id="copilot-chip-${one.sid}"
                ><i class="dot"></i><span>${one.name}</span></span
              >`
            : html`<span class="name">${t('copilot.title')}</span>`
      }</span>
      ${
        one
          ? html`<span class="sub ${one.status === 'waiting' ? 'waiting' : ''}">${this.stateWord(one)}</span>`
          : nothing
      }
    </div>`;
  }

  private renderAction(a: CopilotActionLine) {
    const text = a.text.replace(/^→\s*/, '');
    const at = a.name ? text.indexOf(a.name) : -1;
    return html`<div class="tag ${a.cls}">${icon(a.icon ?? 'check', 16)}<span>${
      a.name && at >= 0
        ? html`${text.slice(0, at)}<b>${a.name}</b>${text.slice(at + a.name.length)}`
        : text
    }</span></div>`;
  }

  private renderCaptions() {
    const caps = this.captions;
    const pending = this.server?.pending;
    const last = caps[caps.length - 1];
    return html`${repeat(
      caps,
      (c) => c.id,
      (c, i) => {
        if (c.who === 'sys') {
          return html`<div class="cap sys ${c.tone ?? ''}">${icon('alert', 16)}<span>${c.text}</span></div>`;
        }
        const old = i < caps.length - 2 ? ' old' : '';
        const live = c === last && c.who === 'cop' && this.mode === 'speaking' ? ' live' : '';
        return html`<div class="cap ${c.who}${old}${live}">
          <div class="bubble"><span class="sr">${c.who === 'me' ? t('copilot.you') : t('copilot.title')}: </span>${c.text}</div>
          ${c.chips.map((ch) => this.renderAction(ch))}
        </div>`;
      }
    )}${
      pending
        ? html`<div class="confirm">
            <div class="strip">${icon('alert', 14)}${t('copilot.confirm.title')}</div>
            <div class="body"><code>${pending}</code><span>${t('copilot.confirm.say')}</span></div>
          </div>`
        : nothing
    }${
      !caps.length && !pending
        ? html`<div class="empty"><b>${t('copilot.empty.title')}</b><span>${t('copilot.empty.hint')}</span></div>`
        : nothing
    }`;
  }

  private renderToggle(
    id: string,
    on: boolean,
    glyph: IconName,
    label: string,
    action: () => void
  ) {
    return html`<button class="ut-surface--control toggle" id=${id} aria-pressed=${on ? 'true' : 'false'} @click=${action}>
      ${icon(glyph, 20)}<span class="state" aria-hidden="true">${t(on ? 'copilot.on' : 'copilot.off')}</span
      ><span class="label">${label}</span>
    </button>`;
  }

  render() {
    const close = onTap(this.finish);
    const noMic = Boolean(this.micProblem) && !this.audio.hasMic;
    const s = this.server;
    const off = !this.socketOpen || (s && !s.connected) || noMic;
    return html`<div class="ut-surface--panel ut-surface--material frame${off ? ' off' : ''}">
      <div class="grabber" aria-hidden="true"></div>
      <header>
        ${this.renderHeading()}
        ${
          this.readOnly
            ? html`<span
                class="badge"
                id="copilot-readonly-badge"
                role="img"
                aria-label=${t('copilot.readOnly')}
                title=${t('copilot.readOnly')}
              >${icon('eye', 20)}</span>`
            : nothing
        }
        <button
          class="ut-surface--control icon-btn"
          id="copilot-close"
          aria-label=${t('copilot.end')}
          title=${t('copilot.end')}
          @pointerup=${close.pointerup}
          @click=${close.click}
        >
          ${icon('x', 20)}
        </button>
      </header>
      ${this.scope.mode === 'global' ? this.renderChips() : nothing}
      <section class="stage">
        <div class="orbwrap">
          <div class="ring"></div>
          <button
            class="ut-surface--control orb"
            id="copilot-orb"
            aria-label=${t('copilot.status.hold')}
            @pointerdown=${this.onOrbDown}
            @pointerup=${this.onOrbUp}
            @pointercancel=${this.onOrbUp}
            @lostpointercapture=${this.onOrbUp}
            @keydown=${this.onOrbKey}
            @keyup=${this.onOrbKey}
            @contextmenu=${(e: Event) => e.preventDefault()}
          ></button>
          <div class="glyph" aria-hidden="true">
            <span class="g-mic">${icon('mic', 28)}</span>
            <span class="g-dots">${icon('more', 28)}</span>
            <span class="g-spk">${icon('volume2', 28)}</span>
          </div>
          <div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        </div>
        ${this.renderStatus()}
      </section>
      <div class="capsbox">
        <div class="captions" id="copilot-captions" aria-live="polite" @scroll=${this.onCaptionsScroll}>
          ${this.renderCaptions()}
        </div>
      </div>
      ${
        noMic
          ? html`<form
              id="copilot-type"
              @submit=${this.onType}
              @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
            >
              <input
                id="copilot-text-input"
                autocomplete="off"
                enterkeyhint="send"
                aria-label=${t('copilot.typePlaceholder')}
                placeholder=${t('copilot.typePlaceholder')}
              /><button
                class="ut-surface--control send"
                id="copilot-text-send"
                type="submit"
                aria-label=${t('copilot.typeSend')}
                title=${t('copilot.typeSend')}
              >${icon('send', 18)}</button>
            </form>`
          : nothing
      }
      <footer>
        ${this.renderToggle('copilot-handsfree-toggle', this.handsFree, 'mic', t('copilot.handsFree'), this.toggleHandsFree)}
        ${this.renderToggle('copilot-earcons-toggle', this.earcons, this.earcons ? 'bell' : 'bellOff', t('copilot.sounds'), this.toggleEarcons)}
        ${this.renderToggle('copilot-readonly-toggle', this.readOnly, 'eye', t('copilot.readOnly'), this.toggleReadOnly)}
      </footer>
      ${
        this.needsStart
          ? html`<div class="unlock">
              <div class="still" aria-hidden="true">${icon('mic', 28)}</div>
              <button id="copilot-start" @click=${this.onStart}>${icon('mic', 18)}${t('copilot.start')}</button>
              <p>${t('copilot.startHint')}</p>
            </div>`
          : nothing
      }
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'copilot-sheet': CopilotSheet;
  }
}

/**
 * Open «Conversar» over `scope` as a full-screen sheet on <body>. Call it synchronously from the
 * tap. Only one is open at a time: a second call moves the open one to the new scope.
 */
export function openCopilot(scope: CopilotScope): CopilotSheet {
  const existing = document.body.querySelector('copilot-sheet');
  if (existing) {
    existing.setScope(scope);
    return existing;
  }
  const sheet = document.createElement('copilot-sheet');
  sheet.scope = scope;
  document.body.appendChild(sheet);
  sheet.begin();
  return sheet;
}

/** Handlers for a «Conversar» button: opens the copilot within the tap itself. */
export function copilotTap(scope: () => CopilotScope) {
  return onTap(() => {
    openCopilot(scope());
  });
}
