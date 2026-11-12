import { css } from 'lit';
import { a11yBaseStyles } from '../../utils/a11y-base-styles.js';
import {
  materialControlStyles,
  materialSurfaceStyles,
} from '../../utils/material-surface-styles.js';
import { reducedMotionStyles } from '../../utils/reduced-motion.js';
import { promptDockStyles } from '../claude-chat-view.js';

/** The styles of <terminal-chat-view> (terminal-chat-view.ts). */
export const terminalChatViewStyles = [
  reducedMotionStyles,
  materialSurfaceStyles,
  a11yBaseStyles,
  css`
    :host([composerOnly]) {
      height: auto;
    }

    :host([composerOnly]) .chat-input-container {
      align-items: flex-end;
      /* Home indicator clearance, set by the session view only while the keyboard is down
         (with the keyboard up the composer sits on it; both would leave a gap). */
      padding-bottom: calc(0.625rem + var(--composer-safe-bottom, 0px));
    }

    :host {
      display: block;
      height: 100%;
      width: 100%;
      background-color: var(--color-bg);
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
      position: relative;
      z-index: 10;
      pointer-events: auto !important; /* Ensure interactions work */
    }

    .chat-view-container {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .chat-messages-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 1rem;
      /* Large top padding to ensure first message clears the header on iPad */
      padding-top: 8rem;
      /* Never a smooth scroll behaviour: it animated every scrollTop the view sets, so opening a
         conversation scrolled it from the top to the latest message (2026-10-04). */
      -webkit-overflow-scrolling: touch; /* Smooth scrolling on iOS */
      touch-action: pan-y; /* Allow vertical scrolling */
      overscroll-behavior: contain; /* Prevent scroll chaining */
    }

    /* Chat input container (WhatsApp style) */
    .chat-input-container {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.625rem 0.875rem;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      position: relative;
      z-index: 100;
    }

    .chat-input {
      flex: 1;
      padding: 0.75rem 1.125rem;
      background-color: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-rem-24);
      color: var(--color-text);
      font-family: inherit;
      font-size: max(16px, 1rem); /* Prevent zoom on iOS */
      outline: none;
      -webkit-user-select: text;
      user-select: text;
      opacity: 1;
    }

    .slash-list {
      display: flex;
      flex-direction: column;
      max-height: 14rem;
      overflow-y: auto;
      background: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
    }

    .slash-list button {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 10px 16px;
      border: none;
      border-bottom: 1px solid var(--color-border-light);
      background: none;
      color: var(--color-text);
      text-align: left;
      font-size: 0.9375rem;
    }

    .slash-list button span {
      color: var(--color-text-dim);
      font-size: 0.8125rem;
    }

    /* A menu on screen that typing cannot answer (trust this folder?): its options as buttons,
       floating over the bottom of the terminal, where the menu itself is drawn. Taking layout
       space, it shrank the terminal; the menu no longer fit there, Claude drew it cut off,
       the block went, the terminal grew back, and round again (2026-10-03, keyboard open). */
    .screen-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      z-index: 1;
      padding: 8px 14px;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      box-shadow: var(--ut-piece-raised), var(--ut-drop-up-16-18);
    }

    .screen-menu-question {
      margin-bottom: 6px;
      overflow: hidden;
      color: var(--color-text-dim);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 0.8125rem;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* One-tap prompts above the composer; scrolls sideways, hidden while typing. */
    .quick-prompts {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding: 6px 14px 0;
      background-color: var(--color-bg-secondary);
      border-top: 1px solid var(--color-border);
      scrollbar-width: none;
      touch-action: pan-x;
      overscroll-behavior-x: contain;
    }

    .quick-prompts::-webkit-scrollbar {
      display: none;
    }

    .quick-prompts + .chat-input-container {
      border-top: none;
    }

    /* One slim row, opened from the composer on a phone on its side. */
    .quick-prompts.slim {
      padding-top: 4px;
    }
    .quick-prompts.slim .quick-prompt {
      min-height: 30px;
      padding: 0 10px;
      background-color: var(--ut-piece-control-fill, transparent);
    }
    .prompts-toggle.open {
      color: var(--color-primary);
    }

    .quick-prompt {
      flex-shrink: 0;
      min-height: 36px;
      padding: 0 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-18);
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      font-size: 0.875rem;
      white-space: nowrap;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }

    .quick-prompt:active {
      background-color: var(--color-surface-hover);
    }

    .quick-prompt.edit {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      padding: 0;
      color: var(--color-text-dim);
    }

    .prompt-editor {
      width: min(28rem, calc(100vw - 32px));
      max-height: 85vh;
      padding: 0;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-xl);
      background-color: var(--color-bg-secondary);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      box-shadow: var(--ut-piece-raised);
    }

    .prompt-editor::backdrop {
      background: var(--ut-overlay-strong);
    }

    .prompt-editor h2 {
      margin: 0;
      padding: 14px 16px 4px;
      font-size: 1rem;
    }

    .prompt-editor p {
      margin: 0;
      padding: 0 16px 8px;
      color: var(--color-text-dim);
      font-size: 0.8125rem;
    }

    .prompt-editor ol {
      list-style: none;
      margin: 0;
      padding: 0 12px;
      max-height: 55vh;
      overflow-y: auto;
    }

    .prompt-editor li {
      display: grid;
      grid-template-columns: 1fr repeat(3, 36px);
      align-items: center;
      gap: 4px 6px;
      padding: 8px 0;
      border-bottom: 1px solid var(--color-border-light);
    }

    .prompt-editor li input {
      grid-column: 1;
      min-width: 0;
      padding: 6px 10px;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-8);
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font: inherit;
      font-size: max(16px, 1rem); /* Prevent zoom on iOS */
      box-shadow: var(--ut-piece-inset);
    }

    .prompt-editor li button {
      grid-row: 1 / span 2;
      height: 36px;
      border: none;
      border-radius: var(--ut-r-8);
      background: none;
      color: var(--color-text-dim);
      font-size: 1.125rem;
    }

    .prompt-editor li button:disabled {
      opacity: 0.3;
    }

    .prompt-editor footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px;
    }

    .prompt-editor footer button {
      min-height: 36px;
      padding: 0 14px;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-18);
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      font: inherit;
      font-size: 0.875rem;
      box-shadow: var(--ut-piece-control);
    }

    .prompt-editor footer .spacer {
      flex: 1;
    }

    .prompt-editor footer .save {
      border-color: var(--color-primary);
      background-color: var(--color-primary);
      color: var(--color-on-fill);
    }

    /* Desktop attach menu: a small popover over the attach button, in the top layer. */
    .attach-popover {
      position: fixed;
      inset: auto auto 0 0;
      margin: 0;
      padding: 4px;
      min-width: 220px;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-12);
      background: var(--color-bg-elevated);
      color: var(--color-text);
      font-family: var(--font-ui, system-ui, sans-serif);
      box-shadow: var(--ut-piece-raised), var(--shadow-e3);
    }
    .attach-popover::backdrop {
      background: transparent;
    }
    .attach-popover-items {
      display: flex;
      flex-direction: column;
    }
    .attach-popover-item {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: var(--ut-r-8);
      background: none;
      color: var(--color-text);
      font: inherit;
      font-size: 0.875rem;
      text-align: start;
      cursor: pointer;
    }
    .attach-popover-item .ut-icon {
      color: var(--color-text-muted);
    }
    .attach-popover-item:hover,
    .attach-popover-item:focus-visible {
      background: var(--color-surface-hover);
      outline: none;
    }

    /* Icon buttons stay in px: grown with the system text size they squeezed the field. */
    .attach-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 44px;
      flex-shrink: 0;
      border: none;
      background: none;
      color: var(--color-text-dim);
      -webkit-tap-highlight-color: transparent;
    }

    .composer-input {
      resize: none;
      line-height: 1.35;
      max-height: 8.5rem;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      border-radius: var(--ut-r-rem-20);
      display: block;
    }

    .chat-input:focus {
      border-color: var(--color-primary);
      /* Not --color-border: the placeholder was 4.1:1 on it. */
      background-color: var(--color-surface-hover);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent);
    }

    .chat-input::placeholder {
      color: var(--color-text-dim);
      opacity: 1;
    }

    .send-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      /* Flat accent with black ink: white on the emerald end of the old gradient was 2.5:1. */
      background: var(--color-primary);
      border: none;
      border-radius: var(--ut-action-radius, var(--ut-r-circle));
      color: var(--color-on-fill);
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      box-shadow: var(--ut-piece-control), var(--ut-glow-2-6) color-mix(in srgb, var(--color-primary) 30%, transparent);
    }

    .send-button:hover:not(:disabled) {
      background: var(--color-primary-light);
      transform: var(--ut-control-hover-transform, scale(1.05));
      box-shadow: var(--ut-glow-3-10) color-mix(in srgb, var(--color-primary) 40%, transparent);
    }

    .send-button:active:not(:disabled) {
      transform: var(--ut-control-active-transform, scale(0.95));
    }

    /* Disabled: a grey circle with a dim arrow (4.5:1), not the whole button at 50% (1.1:1). */
    .send-button:disabled {
      background: var(--color-bg-tertiary);
      color: var(--color-text-dim);
      box-shadow: none;
      cursor: not-allowed;
    }

    .dictation-note {
      margin: 0 12px 6px;
      padding: 6px 10px;
      border-radius: var(--ut-r-lg);
      font-size: 0.8125rem;
      line-height: 1.35;
    }
    .dictation-note.error {
      color: var(--color-text);
      background: var(--color-bg-tertiary);
    }
    .mic-spinner {
      width: 16px;
      height: 16px;
      border-radius: var(--ut-r-circle);
      border: 2px solid currentColor;
      border-right-color: transparent;
      animation: mic-spin 0.8s linear infinite;
    }
    @keyframes mic-spin {
      to {
        transform: rotate(360deg);
      }
    }
    /* Reduce Motion: the spinner still says dictation is starting, slower. */
    @media (prefers-reduced-motion: reduce) {
      .mic-spinner {
        animation-duration: 2.4s !important;
        animation-iteration-count: infinite !important;
      }
    }
    .keyboard-dismiss-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background-color: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-circle);
      color: var(--color-text-dim);
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .keyboard-dismiss-button:hover {
      background-color: var(--color-surface-hover);
      color: var(--color-text-muted);
    }

    .keyboard-dismiss-button:active {
      transform: scale(0.95);
    }

    .chat-message {
      margin-bottom: 1rem;
      display: flex;
      flex-direction: column;
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin-bottom: 0.25rem;
      font-size: 0.7rem;
      color: var(--color-text-muted);
      padding: 0 0.5rem;
    }

    .message-icon {
      font-size: 0.875rem;
    }

    .message-sender {
      font-weight: var(--ut-fw-semibold);
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }

    .message-separator {
      opacity: 0.4;
    }

    .message-time {
      opacity: 0.6;
    }

    .message-path {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
      color: var(--color-primary-text);
      font-size: 0.65rem;
    }

    .message-bubble {
      padding: 0.875rem 1rem;
      border-radius: var(--ut-r-rem-18);
      max-width: 88%;
      word-wrap: break-word;
      font-size: 0.9rem;
      line-height: 1.5;
      position: relative;
    }

    .message-content {
      /* Terminal output stays left-to-right even in RTL languages. */
      direction: ltr;
      text-align: left;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
    }

    /* Command messages (user) - align right, WhatsApp green style */
    .chat-message.command {
      align-items: flex-end;
    }

    .chat-message.command .message-header {
      justify-content: flex-end;
    }

    /* 2026-10-12: neutral fill, not solid orange. Spec 2.3 keeps orange for the one primary
       action per surface (the send button); a hairline primary/30 border marks "you". */
    .chat-message.command .message-bubble {
      background: var(--color-selected, var(--color-bg-tertiary));
      color: var(--color-text-bright, var(--color-text));
      border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent);
      border-radius: var(--ut-r-rem-18) var(--ut-r-rem-18) var(--ut-r-rem-1) var(--ut-r-rem-18);
      box-shadow: none;
    }

    /* Output messages (system) - align left, dark bubble */
    .chat-message.output {
      align-items: flex-start;
    }

    .chat-message.output .message-bubble {
      background-color: var(--color-bg-tertiary);
      color: var(--color-text);
      border-radius: var(--ut-r-rem-18) var(--ut-r-rem-18) var(--ut-r-rem-18) var(--ut-r-rem-1);
      box-shadow: var(--ut-drop-3-20);
    }

    /* Error messages */
    .chat-message.error {
      align-items: flex-start;
    }

    .chat-message.error .message-bubble {
      background-color: color-mix(in srgb, var(--color-status-error) 15%, var(--color-bg));
      color: var(--color-status-error-text);
      border-radius: var(--ut-r-rem-18) var(--ut-r-rem-18) var(--ut-r-rem-18) var(--ut-r-rem-1);
      box-shadow: var(--ut-glow-1-3) color-mix(in srgb, var(--color-status-error) 20%, transparent);
    }

    /* Desktop chat (not the phone composer), design spec 5.2 (2026-10-12): a centered 820 px
       composer card with the send button inside, sans type, and a calm empty state. */
    :host(:not([composerOnly])) {
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
      background-color: var(--ut-chat-canvas, var(--ut-terminal-bg, var(--color-bg)));
    }
    :host(:not([composerOnly])) {
      /* 820 px, or the chat's column where "Chat width" makes it wider (2026-11-11). */
      --chat-card-width: max(820px, var(--ut-chat-column));
    }
    :host(:not([composerOnly])) .chat-messages-container {
      padding: 24px max(16px, calc((100% - var(--chat-card-width)) / 2)) 16px;
    }
    :host(:not([composerOnly])) .chat-input-container {
      box-sizing: border-box;
      width: calc(100% - 32px);
      max-width: var(--chat-card-width);
      min-height: 44px;
      margin: 0 auto 16px;
      padding: 5px 6px 5px 14px;
      gap: 6px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card, 10px);
      background-color: var(--ut-well-fill, var(--color-bg-elevated));
      transition: border-color var(--dur-1, 120ms) ease, box-shadow var(--dur-1, 120ms) ease;
    }
    :host(:not([composerOnly])) .chat-input-container:focus-within {
      border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border));
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 40%, transparent);
    }
    :host(:not([composerOnly])) .chat-input {
      padding: 6px 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
      font-size: 0.8125rem;
      line-height: 1.125rem;
    }
    :host(:not([composerOnly])) .chat-input:focus {
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    :host(:not([composerOnly])) .send-button {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-ctl, 6px);
      box-shadow: var(--ut-piece-control);
    }
    :host(:not([composerOnly])) .send-button svg {
      width: 16px;
      height: 16px;
    }
    :host(:not([composerOnly])) .send-button:hover:not(:disabled) {
      transform: none;
      box-shadow: none;
      background: color-mix(in oklab, var(--color-primary) 88%, var(--ut-mix-lighten));
    }
    :host(:not([composerOnly])) .send-button:active:not(:disabled) {
      transform: none;
      filter: brightness(0.95);
    }
    @media (pointer: fine) {
      :host(:not([composerOnly])) .keyboard-dismiss-button {
        display: none;
      }
    }
    .ut-chat-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 100%;
      max-width: 480px;
      margin: 0 auto;
      padding: 32px 16px;
      text-align: center;
    }
    .ut-chat-empty-tile {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      margin-bottom: 10px;
      border-radius: var(--ut-r-16);
      background: var(--color-bg-tertiary);
      color: var(--color-text-dim);
    }
    .ut-chat-empty-tile svg {
      width: 24px;
      height: 24px;
    }
    .ut-chat-empty-title {
      margin: 0;
      color: var(--color-text-bright);
      font-size: 0.9375rem;
      line-height: 1.25rem;
      font-weight: var(--ut-fw-semibold);
    }
    .ut-chat-empty-body {
      margin: 0;
      color: var(--color-text-muted);
      font-size: 0.8125rem;
      line-height: 1.125rem;
    }
    .ut-chat-suggestions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      margin-top: 12px;
    }
    .ut-chat-suggestions button {
      max-width: 260px;
      height: 26px;
      padding: 0 10px;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--ut-r-pill);
      background: var(--color-bg-elevated);
      color: var(--color-text-muted);
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.75rem;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .ut-chat-suggestions button:hover {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .message-icon svg {
      width: 12px;
      height: 12px;
      vertical-align: -2px;
    }

    /* Scrollbar styling */
    .chat-messages-container::-webkit-scrollbar {
      width: 8px;
    }

    .chat-messages-container::-webkit-scrollbar-track {
      background: var(--color-bg-secondary);
    }

    .chat-messages-container::-webkit-scrollbar-thumb {
      background: var(--color-border);
      border-radius: var(--ut-r-sm);
    }

    .chat-messages-container::-webkit-scrollbar-thumb:hover {
      background: var(--color-text-muted);
    }

    /* Interactive options - pill-style bubbles */
    .interactive-options {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.875rem;
      padding-top: 0.75rem;
    }

    .option-button {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 15%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 20%, transparent) 100%);
      border: 1.5px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
      border-radius: var(--ut-r-rem-20);
      color: var(--color-primary-text);
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: var(--ut-fw-medium);
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: left;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      white-space: nowrap;
    }

    .option-button:hover {
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 25%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 30%, transparent) 100%);
      border-color: var(--color-primary);
      transform: scale(1.03);
      box-shadow: var(--ut-glow-2-8) color-mix(in srgb, var(--color-primary) 25%, transparent);
    }

    .option-button:active {
      transform: scale(0.97);
      background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 35%, transparent) 0%, color-mix(in srgb, var(--color-primary-dark) 40%, transparent) 100%);
    }

    .option-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      background-color: var(--color-primary);
      color: var(--color-on-fill);
      border-radius: var(--ut-r-circle);
      font-size: 0.7rem;
      font-weight: var(--ut-fw-bold);
      flex-shrink: 0;
    }

    .option-text {
      line-height: 1.3;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    /* ---- Phone composer (phone-spec §3.5-3.7, 2026-10-12) ------------------------------------
       composerOnly is the phone's: [+] [capsule: tiles, field or recording] [mic | Send]. Sans
       chrome, one primary (Send, only when there is something to send), safe areas on the
       sides, and the prompt docked above with the chat's own anatomy. */
    :host([composerOnly]) {
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
      background-color: var(--ut-chat-surface, var(--color-bg-secondary));
    }
    /* With Claude's chat over the terminal the composer is part of the chat's one surface
       (--ut-chat-surface, set by session.css on the phone session grid, 2026-10-12). */
    :host([composerOnly]) .chat-input-container,
    :host([composerOnly]) .quick-prompts {
      background-color: var(--ut-chat-surface, var(--color-bg-secondary));
    }
    :host([composerOnly]) .chat-input-container {
      gap: 8px;
      padding: 8px max(8px, env(safe-area-inset-right, 0px))
        calc(8px + var(--composer-safe-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px));
    }
    .composer-capsule {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      min-height: 44px;
      box-sizing: border-box;
      border: 1px solid var(--ut-composer-border, var(--color-border));
      border-radius: var(--ut-r-22);
      background: var(--ut-composer-bg, var(--color-bg-elevated));
      transition: border-color var(--dur-1, 120ms) ease;
      box-shadow: var(--ut-piece-inset);
    }
    .composer-capsule:focus-within {
      border-color: color-mix(in srgb, var(--color-primary) 60%, var(--color-border));
    }
    :host([composerOnly]) .composer-capsule .chat-input {
      /* 2026-10-12: .chat-input's flex: 1 (a 0% basis) in this column capsule kept the field at
         its 42 px min-height in WebKit whatever autoSize set: a long message showed one line,
         scrolled inside, and a tap in the text landed on the wrong line (user report, iPhone). Its
         height is its own (autoSize, up to max-height). */
      flex: 0 0 auto;
      width: 100%;
      box-sizing: border-box;
      min-height: 42px;
      padding: 10px 14px;
      border: 0;
      border-radius: var(--ut-r-22);
      background: transparent;
      box-shadow: none;
      line-height: 22px;
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
    }
    :host([composerOnly]) .composer-capsule .chat-input:focus {
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    /* The placeholder on one line, cut with an ellipsis ("Mensaje…" never wraps). */
    :host([composerOnly]) .composer-input:placeholder-shown {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer-capsule.recording .chat-input {
      display: none;
    }
    .composer-capsule chat-attachment-strip {
      padding: 6px 6px 0;
    }
    .round-button {
      position: relative;
      display: grid;
      place-items: center;
      flex: none;
      width: 44px;
      height: 44px;
      padding: 0;
      border: none;
      border-radius: var(--ut-r-circle);
      background-color: var(--ut-piece-control-fill, transparent);
      color: var(--color-text-muted);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      box-shadow: var(--ut-piece-control);
    }
    .round-button:active {
      background: var(--color-surface-hover);
    }
    .round-button[aria-expanded='true'] {
      background: var(--color-bg-tertiary);
      color: var(--color-text);
    }
    .round-button:disabled {
      color: var(--color-text-dim);
      opacity: 0.6;
    }
    :host([composerOnly]) .send-button {
      box-shadow: var(--ut-piece-control);
      transition: background-color var(--dur-1, 120ms) ease;
    }
    :host([composerOnly]) .send-button:hover:not(:disabled),
    :host([composerOnly]) .send-button:active:not(:disabled) {
      transform: none;
      box-shadow: none;
    }
    .enter-button {
      width: auto;
      min-width: 44px;
      padding: 0 6px;
      border-radius: var(--ut-r-22);
      gap: 0;
    }

    /* Recording: the capsule itself (cancel · level · time · stop); attention while it
       listens, neutral while the Mac transcribes; red only for a failure (the note). */
    .rec {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 42px;
      padding: 0 0 0 0;
    }
    .rec .round-button {
      width: 40px;
      height: 40px;
      background-color: var(--ut-piece-control-fill, transparent);
    }
    .rec .round-button::after {
      content: '';
      position: absolute;
      inset: -2px;
    }
    .rec-meter {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 3px;
      height: 24px;
      overflow: hidden;
    }
    .rec-meter span {
      flex: none;
      width: 3px;
      border-radius: var(--ut-r-2);
      background: var(--color-attention);
      transition: height 90ms linear;
    }
    .rec[data-state='transcribing'] .rec-meter span,
    .rec[data-state='starting'] .rec-meter span {
      background: var(--color-text-dim);
    }
    .rec-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.8125rem;
      color: var(--color-text-muted);
    }
    .rec-time {
      flex: none;
      padding: 0 4px;
      font: 0.8125rem/1.125rem var(--font-mono, ui-monospace, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--color-attention-text);
    }
    .rec .rec-stop {
      background: var(--color-bg-tertiary);
      color: var(--color-text);
      margin-right: 1px;
    }
    :host([composerOnly]) .dictation-note.error {
      margin: 8px max(12px, env(safe-area-inset-left, 0px)) 0;
      font-family: var(--font-ui, system-ui, sans-serif);
    }

    /* Quick replies: 36 px chips with a 44 px hit area, a fade where the row overflows, the
       pencil pinned outside the scroller. */
    :host([composerOnly]) .quick-prompts {
      gap: 0;
      padding: 4px 0 0;
      overflow: visible;
      border-top: 1px solid var(--color-border);
    }
    .qp-scroller {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px 4px max(12px, env(safe-area-inset-left, 0px));
      overflow-x: auto;
      scrollbar-width: none;
      touch-action: pan-x;
      overscroll-behavior-x: contain;
      -webkit-mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 24px), transparent);
      mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 24px), transparent);
    }
    .qp-scroller::-webkit-scrollbar {
      display: none;
    }
    :host([composerOnly]) .quick-prompt {
      position: relative;
      max-width: calc(14ch + 28px);
      min-height: 36px;
      height: 36px;
      padding: 0 14px;
      border: 0;
      border-radius: var(--ut-r-pill);
      background: var(--color-bg-tertiary);
      color: var(--color-text);
      font-family: var(--font-ui, system-ui, sans-serif);
      font-size: 0.9375rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    :host([composerOnly]) .quick-prompt::after {
      content: '';
      position: absolute;
      inset: -4px 0;
    }
    :host([composerOnly]) .quick-prompt.edit {
      flex: none;
      width: 44px;
      height: 44px;
      margin: 0 max(4px, env(safe-area-inset-right, 0px)) 0 0;
      border-radius: var(--ut-r-circle);
      background: transparent;
      color: var(--color-text-muted);
    }
    :host([composerOnly]) .quick-prompts.slim .quick-prompt:not(.edit) {
      height: 32px;
      min-height: 32px;
    }

    /* The composer's prompt: the chat's docked anatomy, floating over the terminal's bottom. */
    :host([composerOnly]) .screen-menu {
      padding: 0;
      border-top: 0;
      background: none;
    }
    /* ---- Desktop composer under the agent's chat (design spec 5.2, 2026-10-12) -------------
       One card in line with the chat's column (--ut-chat-column): attach, the field, mic and a 32 px
       Send inside it, on the chat's surface. Pointer sizes, not the phone's 44 pt targets. */
    :host([composerOnly][desktop]) {
      background-color: var(--ut-chat-canvas, var(--ut-terminal-bg, var(--color-bg)));
    }
    :host([composerOnly][desktop]) .chat-input-container {
      box-sizing: border-box;
      width: calc(100% - 32px);
      max-width: var(--ut-chat-column);
      min-height: 44px;
      margin: 0 auto 16px;
      padding: 5px 6px 5px 5px;
      gap: 4px;
      align-items: flex-end;
      border: 1px solid var(--ut-composer-border, var(--color-border));
      border-radius: var(--radius-card, 10px);
      background-color: var(--ut-composer-bg, var(--ut-well-fill, var(--color-bg-elevated)));
      transition: border-color var(--dur-1, 120ms) ease, box-shadow var(--dur-1, 120ms) ease;
    }
    :host([composerOnly][desktop]) .chat-input-container:focus-within {
      border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border));
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 40%, transparent);
    }
    :host([composerOnly][desktop]) .composer-capsule {
      min-height: 32px;
      border: 0;
      border-radius: var(--ut-piece-control-radius, 0);
      background: transparent;
    }
    :host([composerOnly][desktop]) .composer-capsule .chat-input {
      min-height: var(--ut-action-h, 32px);
      padding: 7px 6px;
      border-radius: 0;
      font-size: var(--ut-control-size, 0.875rem);
      line-height: var(--ut-control-line, 1.125rem);
    }
    :host([composerOnly][desktop]) .round-button {
      width: var(--ut-action-h, 32px);
      height: var(--ut-action-h, 32px);
      border-radius: var(--radius-ctl, 6px);
      transition: background-color var(--dur-1, 120ms) ease, color var(--dur-1, 120ms) ease;
      background-color: var(--ut-piece-control-fill, transparent);
    }
    :host([composerOnly][desktop]) .round-button:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    :host([composerOnly][desktop]) .send-button {
      width: var(--ut-action-h, 32px);
      height: var(--ut-action-h, 32px);
      border-radius: var(--radius-ctl, 6px);
    }
    :host([composerOnly][desktop]) .send-button:hover:not(:disabled) {
      background: var(--ut-primary-hover, color-mix(in oklab, var(--color-primary) 88%, var(--ut-mix-lighten)));
    }
    :host([composerOnly][desktop]) .send-button:active:not(:disabled) {
      filter: var(--ut-press-filter, brightness(0.95));
    }
    :host([composerOnly][desktop]) .slash-list,
    :host([composerOnly][desktop]) .dictation-note {
      box-sizing: border-box;
      width: calc(100% - 32px);
      max-width: var(--ut-chat-column);
      margin: 0 auto 6px;
    }
    :host([composerOnly][desktop]) .slash-list {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card, 10px);
      background: var(--color-bg-elevated);
      box-shadow: var(--shadow-e2);
    }
    :host([composerOnly][desktop]) .slash-list button {
      padding: 7px 12px;
      font-size: 0.8125rem;
      cursor: pointer;
    }
    :host([composerOnly][desktop]) .slash-list button:hover {
      background: var(--color-surface-hover);
    }
    :host([composerOnly][desktop]) .slash-list button span {
      font-size: 0.75rem;
    }
    ${promptDockStyles}

    /* Phone sheets: the + menu and the quick reply editor, bottom sheets in the top layer. */
    .sheet {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-width: none;
      max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 16px);
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: var(--ut-r-xl) var(--ut-r-xl) 0 0;
      background: var(--color-bg-elevated);
      color: var(--color-text);
      font-family: var(--font-ui, system-ui, sans-serif);
      box-shadow: var(--shadow-e3);
      overflow: hidden;
    }
    .sheet[open] {
      display: flex;
      flex-direction: column;
    }
    /* The sheet takes the focus on open (no field, no keyboard): no ring for that. */
    .sheet:focus,
    .sheet:focus-visible {
      outline: none;
    }
    .sheet::backdrop {
      background: var(--ut-overlay);
    }
    .sheet-grabber {
      flex: none;
      display: grid;
      place-items: center;
      height: 20px;
      touch-action: none;
    }
    .sheet-grabber::before {
      content: '';
      width: 36px;
      height: 5px;
      border-radius: var(--ut-r-3);
      background: var(--color-border-strong, var(--color-border-light));
    }
    .action-sheet {
      inset: auto max(8px, env(safe-area-inset-right, 0px)) calc(8px + env(safe-area-inset-bottom, 0px))
        max(8px, env(safe-area-inset-left, 0px));
      border-radius: var(--ut-r-xl);
      background: transparent;
      box-shadow: none;
      gap: 8px;
    }
    .action-group {
      display: flex;
      flex-direction: column;
      border-radius: var(--ut-r-xl);
      background: var(--color-bg-elevated);
      overflow: hidden;
      box-shadow: var(--ut-piece-raised);
    }
    .action-group[hidden] {
      display: none;
    }
    .action-group .sheet-grabber {
      height: 16px;
    }
    .action-item {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 56px;
      padding: 0 16px;
      border: 0;
      border-top: 1px solid var(--color-border);
      background-color: var(--ut-piece-control-fill, transparent);
      color: var(--color-text);
      font: inherit;
      font-size: 1.0625rem;
      text-align: start;
      box-shadow: var(--ut-piece-control);
    }
    .action-group .sheet-grabber + .action-item {
      border-top: 0;
      background-color: var(--ut-piece-control-fill, transparent);
    }
    .action-item .ut-icon {
      color: var(--color-text-muted);
    }
    .action-item:active {
      background: var(--color-surface-hover);
    }
    .action-item.cancel {
      justify-content: center;
      border-top: 0;
      color: var(--color-text-bright, var(--color-text));
      font-weight: var(--ut-fw-semibold);
    }
    .action-item[aria-expanded='true'] .ut-icon {
      color: var(--color-primary-text);
    }

    /* The quick reply editor as a content sheet: rows of handle · label over text · delete. */
    .prompt-editor.sheet {
      width: auto;
      max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 16px);
      border: 0;
      border-radius: var(--ut-r-xl) var(--ut-r-xl) 0 0;
      background: var(--color-bg-elevated);
    }
    .prompt-editor.sheet h2 {
      flex: none;
      padding: 4px 16px 2px;
      font-size: 1.0625rem;
      line-height: 22px;
      font-weight: var(--ut-fw-semibold);
      text-align: center;
    }
    .prompt-editor.sheet p {
      flex: none;
      padding: 0 16px 8px;
      font-size: 0.8125rem;
      line-height: 18px;
      text-align: center;
    }
    .prompt-editor.sheet ol {
      flex: 1 1 auto;
      min-height: 0;
      max-height: none;
      padding: 0 max(8px, env(safe-area-inset-right, 0px)) 8px max(4px, env(safe-area-inset-left, 0px));
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .prompt-editor.sheet li {
      grid-template-columns: 44px 1fr 44px;
      gap: 0 4px;
      padding: 6px 0;
      border-bottom: 1px solid var(--color-border);
    }
    .prompt-editor.sheet li.dragging {
      background: var(--color-surface-hover);
      border-radius: var(--ut-r-lg);
    }
    .prompt-editor.sheet li input {
      grid-column: 2;
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: var(--ut-r-md);
      background: transparent;
    }
    .prompt-editor.sheet li input:focus {
      border-color: var(--color-border-strong, var(--color-border));
      background: var(--color-surface);
      outline: none;
    }
    .prompt-editor.sheet li input.prompt-label {
      font-size: max(16px, 1rem);
      font-weight: var(--ut-fw-medium);
      line-height: 22px;
    }
    .prompt-editor.sheet li input.prompt-text {
      color: var(--color-text-dim);
      font-size: max(16px, 1rem);
      line-height: 20px;
    }
    .prompt-editor.sheet li button {
      position: relative;
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: var(--ut-r-circle);
    }
    .prompt-editor.sheet li .prompt-handle {
      grid-column: 1;
      grid-row: 1 / span 2;
      cursor: grab;
      touch-action: none;
    }
    .prompt-editor.sheet li .prompt-remove {
      grid-column: 3;
      grid-row: 1 / span 2;
    }
    .prompt-editor.sheet li.add-row {
      display: block;
      padding: 0;
      border-bottom: 0;
    }
    .prompt-editor.sheet .prompt-add {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 48px;
      padding: 0 12px;
      border: 0;
      background: none;
      color: var(--color-text);
      font: inherit;
      font-size: 1rem;
    }
    .prompt-editor.sheet footer {
      flex: none;
      flex-wrap: nowrap;
      align-items: center;
      gap: 8px;
      padding: 8px max(16px, env(safe-area-inset-right, 0px)) calc(8px + env(safe-area-inset-bottom, 0px))
        max(16px, env(safe-area-inset-left, 0px));
      border-top: 1px solid var(--color-border);
      background: var(--color-bg-elevated);
    }
    .prompt-editor.sheet footer button {
      min-height: 44px;
      padding: 0 16px;
      border-radius: var(--ut-r-12);
      font-size: 1rem;
      white-space: nowrap;
    }
    .prompt-editor.sheet footer .prompt-reset {
      padding: 0 4px;
      border: 0;
      background: none;
      color: var(--color-text-muted);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .prompt-editor.sheet footer .save {
      font-weight: var(--ut-fw-semibold);
    }

    .chat-input-container, .composer-capsule {
      background-image: var(--ut-well-grain, var(--ut-piece-grain));
    }
    :host([composerOnly][desktop]) .composer-capsule {
      box-shadow: var(--ut-composer-inner-relief, var(--ut-piece-inset));
    }
    /* Material paint is inherited across shadow roots; no look-specific component CSS. */
    .action-group,
    .attach-popover,
    .prompt-editor,
    .screen-menu,
    .prompt-editor li input,
    .quick-prompt,
    .send-button,
    .round-button,
    .prompt-editor footer button,
    .action-item,
    .quick-prompts {
      background-image: var(--ut-piece-grain);
      background-size: var(--ut-piece-grain-size);
      background-blend-mode: var(--ut-piece-grain-blend);
    }
  `,
  materialControlStyles,
];
