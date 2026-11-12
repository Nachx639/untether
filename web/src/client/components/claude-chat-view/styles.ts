import { css } from 'lit';
import { a11yBaseStyles } from '../../utils/a11y-base-styles.js';
import {
  materialControlStyles,
  materialSurfaceStyles,
} from '../../utils/material-surface-styles.js';
import { reducedMotionStyles } from '../../utils/reduced-motion.js';
import { promptDockStyles } from './prompt-dock.js';

/** The chat view's styles (ClaudeChatView.styles). */
export const claudeChatViewStyles = [
  reducedMotionStyles,
  materialSurfaceStyles,
  a11yBaseStyles,
  css`
    :host {
      /* Palette from the app theme (light/dark and color themes). */
      /* 2026-10-12: hairlines on --color-border and controls on the strong border (the two
         were swapped), "needs you" in the attention tokens, no hardcoded colours. */
      --chat-bg: var(--color-bg);
      --chat-panel: var(--color-bg-secondary);
      --chat-border: var(--color-border);
      --chat-border-strong: var(--color-border-strong, var(--color-border-light));
      --chat-text: var(--color-text);
      --chat-muted: var(--color-text-dim);
      --chat-bubble-in: var(--ut-chat-incoming-fill, var(--color-bg-elevated));
      --chat-bubble-out: var(--ut-chat-outgoing-fill, color-mix(in srgb, var(--color-primary) 30%, var(--color-bg-elevated)));
      --chat-chip: var(--color-bg-tertiary);
      --chat-chip-hover: var(--color-surface-hover);
      --chat-link: var(--color-primary-text);
      --chat-danger: var(--color-status-error-text);
      --chat-warn: var(--color-attention);
      --chat-warn-text: var(--color-attention-text);
      --chat-warn-bg: var(--color-attention-muted);
      --chat-success: var(--color-status-success-text);
      height: 100%;
      background: var(--chat-bg);
      color: var(--chat-text);
      font-family: var(--font-ui, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
    }
    :host {
      display: flex !important;
      flex-direction: column;
    }
    :host([unavailable]) {
      display: none !important;
    }
    .top {
      flex-shrink: 0;
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      background: var(--chat-panel);
      border-bottom: 1px solid var(--chat-border);
      box-shadow: var(--ut-piece-edge);
    }
    .title {
      flex: 1 1 auto;
      min-width: 0;
      /* Same inset on both sides so the title stays centred next to the search icon. */
      padding: 6px 36px;
      text-align: center;
      font-size: 0.75rem;
      color: var(--chat-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .search-proxy {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      margin: 0;
      opacity: 0.01;
      font-size: max(16px, 1rem);
      border: 0;
      padding: 0;
      background: transparent;
      color: transparent;
      caret-color: transparent;
    }
    .search-toggle {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      padding: 4px;
      border: none;
      background: none;
      color: var(--chat-muted);
    }
    /* These icon controls were transparent: give material grain an opaque backing, without
       changing the original look's clear, square hit areas. */
    .search-toggle, .msg-action, .search-prev, .search-next, .search-close {
      background-color: var(--ut-piece-control-fill, transparent);
      border-radius: var(--ut-piece-control-radius, 0);
    }
    /* Left of the search button and its 44 px keyboard proxy (they sat on top of each other). */
    .voice-toggle.beside-search {
      right: 50px;
    }
    /* Two icons on the right: keep the title centred and clear of both. */
    .top.two-icons .title {
      padding: 6px 78px;
    }
    .search-toggle::after {
      content: '';
      position: absolute;
      inset: -11px;
    }
    .search-bar {
      flex: 1 1 auto;
      /* Without it the bar could not shrink below the field's built-in width: on a 375 pt
         phone the close button was pushed off the right edge (2026-10-03). */
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 2px 0 8px;
    }
    .search-bar input {
      flex: 1 1 0;
      width: 0;
      min-width: 0;
      /* 32px at 16px text; taller with the system text size instead of clipping it. */
      height: 2em;
      padding: 0 10px;
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-8);
      background: var(--chat-bg);
      color: var(--chat-text);
      /* 16px keeps iOS from zooming into the field. */
      font-size: max(16px, 1rem);
      box-shadow: var(--ut-piece-inset);
    }
    /* Shadow DOM: the page's placeholder color doesn't reach here (WebKit's grey, 2.3:1). */
    .search-bar input::placeholder {
      color: var(--color-placeholder);
      opacity: 1;
    }
    .search-count {
      flex-shrink: 0;
      padding: 0 4px;
      font-size: 0.75rem;
      color: var(--chat-muted);
      font-variant-numeric: tabular-nums;
    }
    .search-bar button {
      flex-shrink: 0;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      color: var(--chat-text);
    }
    .search-bar button:disabled {
      color: var(--chat-muted);
      opacity: 0.5;
    }
    mark.hit {
      background: color-mix(in srgb, var(--chat-warn) 45%, transparent);
      color: inherit;
      border-radius: var(--ut-r-2);
    }
    mark.hit.current {
      background: var(--chat-warn);
      color: var(--color-on-fill);
    }
    .mode-row {
      flex-shrink: 0;
      display: flex;
      padding: 4px 10px 6px;
      background: var(--chat-bg);
    }
    .mode {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-pill);
      padding: 4px 10px;
      background: var(--chat-panel);
      color: var(--chat-text);
      font-size: 0.75rem;
      box-shadow: var(--ut-piece-control);
    }
    .mode span {
      color: var(--chat-muted);
      font-size: 0.6875rem;
    }
    /* Claude Code's status line beside the mode chip: one small chip per piece, a bar per
       usage percentage. Nothing is cut: what doesn't fit goes onto the next line, and the mode
       chip never wraps its own text. */
    .mode-row {
      align-items: center;
      flex-wrap: wrap;
      gap: 4px 6px;
      min-width: 0;
    }
    .mode-row .mode {
      flex-shrink: 0;
      white-space: nowrap;
    }
    .status-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-width: 0;
      color: var(--chat-muted);
      font-size: 0.6875rem;
      line-height: 1;
    }
    .status-chip {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 3px 6px;
      border-radius: var(--ut-r-pill);
      background: var(--chat-panel);
      border: 1px solid var(--chat-border);
      white-space: nowrap;
      box-shadow: var(--ut-piece-control);
    }
    .status-label {
      color: var(--chat-text);
    }
    .status-bar {
      box-shadow: var(--ut-piece-track);
      width: 16px;
      height: 4px;
      border-radius: var(--ut-r-2);
      background: var(--chat-border-strong);
      overflow: hidden;
    }
    .status-fill {
      box-shadow: var(--ut-piece-thumb);
      display: block;
      height: 100%;
      border-radius: var(--ut-r-2);
      background: var(--color-status-success);
    }
    .status-fill.mid {
      background: var(--color-attention);
    }
    .status-fill.high {
      background: var(--color-status-error);
    }
    .status-pct {
      font-variant-numeric: tabular-nums;
      color: var(--chat-text);
    }
    .status-reset {
      opacity: 0.75;
      font-size: 0.625rem;
    }
    .scroll-area {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    /* A phone on its side: a centred column at most 720 px wide. */
    :host([landscape]) .scroller {
      --chat-column-inset: max(10px, calc((100% - 720px) / 2));
      padding-left: var(--chat-column-inset);
      padding-right: var(--chat-column-inset);
    }
    /* The mode chip over the conversation's bottom left corner, in line with the column; the
       conversation ends above it. */
    .mode-row.floating {
      position: absolute;
      left: max(10px, calc((100% - 720px) / 2));
      bottom: 12px;
      z-index: 1;
      padding: 0;
      background: none;
    }
    .scroll-area.with-mode .scroller {
      padding-bottom: 48px;
    }
    .jump {
      position: absolute;
      right: 12px;
      bottom: 12px;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-circle);
      background: var(--chat-panel);
      color: var(--chat-text);
      box-shadow: var(--ut-piece-control), var(--ut-glow-2-8) color-mix(in srgb, var(--chat-bg) 60%, transparent);
    }
    .jump .badge {
      position: absolute;
      top: -6px;
      right: -4px;
      min-width: 1.82em;
      height: 1.82em;
      padding: 0 5px;
      box-sizing: border-box;
      border-radius: var(--ut-r-badge-em);
      background: var(--color-primary);
      color: var(--color-on-fill);
      font-size: 0.6875rem;
      font-weight: var(--ut-fw-semibold);
      line-height: 1.82em;
      text-align: center;
    }
    .scroller {
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      padding: 12px 10px 16px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    /* The column overflows (it scrolls); never let items shrink to fit — chips with
       overflow: hidden collapsed to a thin line. */
    .scroller > * {
      flex-shrink: 0;
    }
    .row {
      display: flex;
    }
    .row.user {
      justify-content: flex-end;
    }
    .bubble {
      position: relative;
      max-width: 85%;
      /* The bottom padding is the time's line (0.6875rem): it grows with the text size. */
      padding: 6px 9px calc(0.6875rem * 1.6);
      border-radius: var(--ut-r-lg);
      font-size: 0.9375rem;
      line-height: 1.38;
      overflow-wrap: anywhere;
      box-shadow: var(--ut-piece-raised), var(--shadow-e1);
    }
    .row.user .bubble {
      background: var(--chat-bubble-out);
      border-top-right-radius: var(--ut-r-3);
    }
    .row.assistant .bubble {
      background: var(--chat-bubble-in);
      border-top-left-radius: var(--ut-r-3);
    }
    .row.first {
      margin-top: 8px;
    }
    /* Room for the action icons (left) and the time (right) under a one-word answer. */
    .row.assistant .bubble {
      min-width: max(116px, 7.25rem);
    }
    /* And for the time under a one-character message ("2"), which wrapped a character per
       line in a bubble narrower than it (2026-10-03). */
    .row.user .bubble {
      min-width: max(84px, 5.25rem);
    }
    .row.assistant .bubble.actions-2 {
      min-width: 160px;
    }
    .row.assistant .bubble.actions-3 {
      min-width: 204px;
    }
    /* Icons 26px apart so their 44px hit areas meet without overlapping. */
    .msg-actions {
      position: absolute;
      left: 8px;
      bottom: 2px;
      display: flex;
      gap: 26px;
    }
    .msg-action {
      position: relative;
      display: flex;
      padding: 2px;
      border: none;
      background: none;
      color: var(--chat-muted);
    }
    .msg-action.active {
      color: var(--chat-link);
      opacity: 1;
    }
    /* The small buttons keep their look but get a finger-sized (44px) hit area. */
    .msg-action::after,
    .copy-code::after,
    .stop::after,
    .mode::after,
    .waiting button::after {
      content: '';
      position: absolute;
    }
    .msg-action::after {
      inset: -8px -13px -14px;
    }
    .copy-code::after {
      inset: -11px -6px;
    }
    .stop::after,
    .mode::after,
    .waiting button::after {
      inset: -8px -4px;
    }
    .copy-code,
    .stop,
    .mode,
    .waiting button {
      position: relative;
    }
    .li {
      display: block;
      padding-inline-start: 1.1em;
      text-indent: -1.1em;
      margin-block: 3px;
    }
    .h {
      display: block;
      margin: 10px 0 2px;
      font-weight: var(--ut-fw-bold);
      line-height: 1.3;
    }
    .prose:first-child > .h:first-child {
      margin-top: 0;
    }
    .h1 {
      font-size: 1.15em;
    }
    .h2 {
      font-size: 1.07em;
    }
    .quote {
      display: block;
      margin-block: 2px;
      padding-inline-start: 8px;
      border-inline-start: 3px solid var(--chat-border);
      opacity: 0.85;
    }
    /* A run of prose (markdown.ts). No box of its own, except in the desktop's wide column. */
    .prose {
      display: contents;
    }
    .hr {
      display: block;
      margin: 8px 0;
      border-top: 1px solid var(--chat-border);
    }
    .table-wrap {
      max-width: 100%;
      overflow-x: auto;
      margin: 6px 0;
    }
    .table-wrap table {
      border-collapse: collapse;
      font-size: 0.88em;
      line-height: 1.35;
    }
    /* A table needs the room: its bubble may take the whole width of the chat. */
    .bubble:has(.table-wrap) {
      max-width: 100%;
    }
    .table-wrap th,
    .table-wrap td {
      border: 1px solid var(--chat-border);
      padding: 3px 6px;
      vertical-align: top;
      text-align: start;
      /* The bubble's "anywhere" counts every letter as a break point when sizing columns:
         short columns were squeezed to one letter per line. Whole words; a long token can
         still break, and a table too wide for the bubble scrolls. */
      overflow-wrap: break-word;
    }
    .table-wrap th {
      font-weight: var(--ut-fw-semibold);
      background: color-mix(in srgb, var(--chat-text) 8%, transparent);
    }
    .copy-msg.copied,
    .copy-code.copied {
      color: var(--chat-success);
    }
    .code-block {
      display: flex;
      flex-direction: column;
      min-width: 160px;
    }
    .copy-code {
      align-self: flex-end;
      margin: 2px 0 -2px;
      padding: 2px 8px;
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-md);
      background: var(--chat-panel);
      color: var(--chat-muted);
      font-size: 0.6875rem;
    }
    .copy-code.copied::after {
      content: ' ✓';
    }
    .time {
      position: absolute;
      right: 8px;
      bottom: 3px;
      font-size: 0.6875rem;
      color: var(--chat-muted);
      white-space: nowrap;
    }
    /* On the accent-tinted bubble the dim grey fell to 3.6:1 (2.6:1 in dark, cyber or gold):
       its time, icons and links take the bubble's text color, softened. */
    .row.user .time,
    .row.user .msg-action {
      color: color-mix(in srgb, var(--chat-text) 82%, var(--chat-bubble-out));
    }
    .row.user .bubble a {
      color: inherit;
    }
    /* A message just sent, until the transcript has it: a little faded, a clock by its time.
       Same size as the transcript's bubble that replaces it, so nothing moves. */
    .row.user .bubble {
      transition: opacity 0.2s ease;
    }
    .row[data-send='sending'] .bubble {
      opacity: 0.7;
    }
    .sending-icon {
      margin-inline-start: 3px;
      vertical-align: -1px;
    }
    .send-note {
      align-self: flex-end;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-block: 2px 4px;
      padding-inline: 4px;
      font-size: 0.75rem;
      color: var(--chat-muted);
    }
    .send-note.failed {
      color: var(--chat-danger);
    }
    .send-note button {
      position: relative;
      border: none;
      background: none;
      padding: 2px 4px;
      color: var(--chat-link);
      font: inherit;
      font-weight: var(--ut-fw-semibold);
    }
    .send-note button::after {
      content: '';
      position: absolute;
      inset: -12px -8px;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      .row.user .bubble {
        transition: none;
      }
    }
    .attachment {
      display: block;
      max-width: 100%;
      max-height: 260px;
      margin: 2px 0 6px;
      border-radius: var(--ut-r-8);
      object-fit: cover;
    }
    .tool-detail .read-image {
      margin: 6px 10px;
      max-width: calc(100% - 20px);
      object-fit: contain;
    }
    .attachment.placeholder {
      width: 200px;
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--chat-chip);
      color: var(--chat-muted);
    }
    .bubble a {
      color: var(--chat-link);
      text-decoration: underline;
      overflow-wrap: anywhere;
    }
    .bubble code {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 0.8125rem;
      /* A tint of the text colour: light grey on a light theme, lighter than a dark bubble
         on a dark one (a fixed 25 % black was a heavy mid-grey in light mode). */
      background: color-mix(in srgb, var(--chat-text) 10%, transparent);
      border-radius: var(--ut-r-sm);
      padding: 1px 4px;
    }
    /* Code and command output stay left-to-right even in RTL languages. */
    .bubble pre,
    .bubble code,
    .tool-detail pre {
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
    }
    .bubble pre {
      margin: 6px 0 2px;
      padding: 8px;
      background: color-mix(in srgb, var(--chat-text) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--chat-text) 12%, transparent);
      border-radius: var(--ut-r-md);
      overflow-x: auto;
      white-space: pre;
    }
    .bubble pre code {
      background: none;
      padding: 0;
      font-size: 0.75rem;
    }
    .day {
      align-self: center;
      margin: 10px 0 2px;
      padding: 3px 10px;
      border-radius: var(--ut-r-8);
      background: var(--chat-chip);
      color: var(--chat-muted);
      font-size: 0.75rem;
      box-shadow: var(--ut-piece-edge);
    }
    .tool {
      align-self: center;
      max-width: 90%;
      margin: 2px 0;
      padding: 3px 10px;
      border-radius: var(--ut-r-8);
      background: var(--chat-chip);
      color: var(--chat-muted);
      font: 0.75rem/1.4 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tool.note {
      font-family: inherit;
      color: var(--chat-text);
      background: var(--chat-chip);
    }
    button.tool {
      border: none;
      cursor: pointer;
      padding-top: 6px;
      padding-bottom: 6px;
    }
    button.tool:disabled {
      cursor: default;
    }
    .tool.open {
      background: var(--chat-chip-hover);
    }
    .tool.error strong {
      color: var(--chat-danger);
    }
    .tool-detail {
      align-self: stretch;
      margin: 0 6px 4px;
      border-radius: var(--ut-r-8);
      background: var(--chat-panel);
      overflow: hidden;
    }
    .tool-detail pre {
      margin: 0;
      padding: 8px 10px;
      font: 0.75rem/1.4 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--chat-text);
      max-height: 16rem;
      overflow-y: auto;
    }
    .tool-detail pre.cmd {
      color: var(--chat-link);
      border-bottom: 1px solid var(--chat-border);
    }
    .tool-detail pre.err {
      color: var(--chat-danger);
    }
    .tool-detail .diff {
      padding: 6px 0;
      font: 0.75rem/1.45 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      max-height: 20rem;
      overflow-y: auto;
      border-bottom: 1px solid var(--chat-border);
      /* Code stays left-to-right even in RTL languages. */
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
    }
    .tool-detail .diff:last-child {
      border-bottom: none;
    }
    .diff .dl {
      /* Hanging indent: a wrapped line continues after the sign column. */
      padding: 0 10px 0 calc(4px + 1.3em);
      text-indent: -1.3em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--chat-text);
    }
    .diff .sign {
      display: inline-block;
      width: 1.3em;
      text-indent: 0;
      text-align: center;
      opacity: 0.7;
      user-select: none;
    }
    .diff .del {
      background: color-mix(in srgb, var(--color-status-error) 16%, transparent);
    }
    .diff .add {
      background: color-mix(in srgb, var(--color-status-success) 18%, transparent);
    }
    .diff .ctx {
      opacity: 0.7;
    }
    .diff .file {
      padding-left: 10px;
      text-indent: 0;
      font-weight: var(--ut-fw-semibold);
      color: var(--chat-link);
    }
    .diff .file:not(:first-child) {
      margin-top: 6px;
    }
    .diff .gap {
      text-align: center;
      text-indent: 0;
      padding-left: 10px;
      opacity: 0.6;
    }
    .tool strong {
      color: var(--chat-link);
      font-weight: var(--ut-fw-semibold);
    }
    .busy-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    .busy-row .typing {
      margin-top: 0;
    }
    .busy-row .activity {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.8125rem;
      color: var(--chat-muted);
      font-variant-numeric: tabular-nums;
    }
    /* Claude replied; background agents still run: a quiet line, not the typing dots. */
    .background-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 0.8125rem;
      color: var(--chat-muted);
    }
    .background-dot {
      width: 7px;
      height: 7px;
      border-radius: var(--ut-r-circle);
      border: 1.5px solid var(--chat-muted);
      flex: none;
    }
    .stop {
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-pill);
      padding: 8px 14px;
      background: var(--chat-panel);
      color: var(--chat-text);
      font-size: 0.8125rem;
      box-shadow: var(--ut-piece-control);
    }
    .stop:active {
      background: var(--chat-border-strong);
    }
    .typing {
      display: inline-flex;
      gap: 4px;
      padding: 10px 12px;
      background: var(--chat-bubble-in);
      border-radius: var(--ut-r-lg);
      border-top-left-radius: var(--ut-r-3);
      margin-top: 8px;
      align-self: flex-start;
    }
    .typing span {
      width: 7px;
      height: 7px;
      border-radius: var(--ut-r-circle);
      background: var(--chat-muted);
      animation: blink 1.2s infinite ease-in-out;
    }
    .typing span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .typing span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes blink {
      0%,
      80%,
      100% {
        opacity: 0.3;
        transform: translateY(0);
      }
      40% {
        opacity: 1;
        transform: translateY(-3px);
      }
    }
    /* Reduced motion: the typing dots only fade, slowly; they still say Claude is working
       (!important: over reducedMotionStyles, which stops every other animation). */
    @media (prefers-reduced-motion: reduce) {
      .typing span {
        animation-duration: 2.4s !important;
        animation-iteration-count: infinite !important;
      }
      @keyframes blink {
        0%,
        80%,
        100% {
          opacity: 0.3;
        }
        40% {
          opacity: 1;
        }
      }
    }
    .question {
      align-self: flex-start;
      max-width: 85%;
      margin-top: 8px;
      padding: 8px;
      border-radius: var(--ut-r-lg);
      border-top-left-radius: var(--ut-r-3);
      background: var(--chat-bubble-in);
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-shadow: var(--ut-piece-raised);
    }
    .question-text {
      padding: 2px 4px 4px;
      font-size: 0.9375rem;
    }
    .question-detail {
      padding: 6px 8px;
      border-radius: var(--ut-r-md);
      background: var(--chat-panel);
      color: var(--chat-muted);
      font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
      font-size: 0.75rem;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .question button {
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-8);
      padding: 9px 12px;
      background: var(--chat-panel);
      color: var(--chat-link);
      font-size: 0.9375rem;
      text-align: center;
      /* A path in an option has no spaces to wrap at: it ran past the edge (2026-10-03, SE). */
      overflow-wrap: anywhere;
    }
    .question button.link {
      border: none;
      background: none;
      color: var(--chat-muted);
      font-size: 0.8125rem;
      padding: 4px;
      min-height: 44px;
    }
    .question button:active {
      background: var(--chat-border-strong);
    }
    .question button:disabled {
      opacity: 0.55;
    }
    .question-note {
      padding: 2px 4px;
      font-size: 0.8125rem;
      color: var(--chat-warn-text);
    }
    .waiting {
      align-self: center;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      padding: 8px 10px 8px 12px;
      border-radius: var(--ut-r-lg);
      background: var(--chat-warn-bg);
      color: var(--chat-text);
      font-size: 0.8125rem;
      box-shadow: var(--ut-piece-raised);
    }
    .waiting button {
      border: none;
      border-radius: var(--ut-r-8);
      padding: 6px 10px;
      background: var(--chat-warn);
      color: var(--color-on-fill);
      font-weight: var(--ut-fw-semibold);
      font-size: 0.8125rem;
    }
    .read-only-note {
      padding: 2px 4px;
      font-size: 0.8125rem;
      color: var(--chat-muted);
      box-shadow: var(--ut-piece-raised);
    }
    .waiting.read-only {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }
    .waiting.read-only .read-only-note {
      padding: 0;
    }
    .offline {
      flex-shrink: 0;
      padding: 6px 12px;
      text-align: center;
      font-size: 0.75rem;
      color: var(--chat-text);
      background: var(--chat-warn-bg);
      border-bottom: 1px solid var(--chat-border);
    }
    .empty {
      margin: auto;
      text-align: center;
      color: var(--chat-muted);
      font-size: 0.875rem;
      padding: 24px;
      box-shadow: var(--ut-piece-raised);
    }
    .mode .ut-icon {
      color: var(--chat-muted);
    }
    .stop .ut-icon {
      flex: none;
    }
    .stop {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    /* ---- Phone addendum (phone-spec §3.5-3.7, 2026-10-12) ----------------------------------
       [phone] is reflected while the screen is a phone (isPhoneScreen: touch, short side under
       600, the CSS phone gate), so a desktop window and the read-only Mac view keep the look
       above. Chrome budget: no title bar; mode and status in one 32 pt row that scrolls
       sideways; prompt, busy strip or nothing docked over the composer. */
    /* The user's bubble is neutral, no accent tint (surface-hover in dark, bg-tertiary in
       light: the same mix of text over the page works out to both). */
    :host([phone]) {
      --chat-bubble-out: var(--ut-chat-outgoing-fill, color-mix(in srgb, var(--color-text) 9%, var(--color-bg)));
    }
    :host([phone]) .mode-row.phone-row {
      position: relative;
      flex-wrap: nowrap;
      align-items: center;
      height: 32px;
      gap: 0;
      padding: 0;
      background: var(--chat-bg);
      border-bottom: 1px solid var(--chat-border);
    }
    :host([phone][kbd]) .mode-row.phone-row {
      display: none;
    }
    .chips {
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px 0 max(12px, env(safe-area-inset-left, 0px));
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      overscroll-behavior-x: contain;
      touch-action: pan-x;
      -webkit-mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 24px), transparent);
      mask-image: linear-gradient(to right, var(--ut-mask-opaque) calc(100% - 24px), transparent);
    }
    .chips::-webkit-scrollbar {
      display: none;
    }
    :host([phone]) .chips .mode,
    :host([phone]) .chips .status-chip {
      flex-shrink: 0;
      height: 24px;
      box-sizing: border-box;
      padding: 0 8px;
      border-radius: var(--ut-r-pill);
      font-size: 0.75rem;
      line-height: 16px;
      white-space: nowrap;
      gap: 4px;
    }
    :host([phone]) .chips .mode {
      border: 1px solid var(--chat-border-strong);
      background: var(--chat-chip);
      color: var(--chat-text);
      font-weight: var(--ut-fw-medium);
    }
    :host([phone]) .chips .mode::after {
      inset: -10px -4px;
    }
    :host([phone]) .chips .status-line {
      flex-wrap: nowrap;
      font-size: 0.75rem;
      gap: 6px;
    }
    :host([phone]) .chips .status-chip {
      background: transparent;
      border-color: var(--chat-border);
    }
    :host([phone]) .chips .status-reset {
      font-size: 0.6875rem;
    }
    .row-search {
      position: relative;
      flex: none;
      display: grid;
      place-items: center;
      width: 44px;
      height: 32px;
      padding: 0;
      border: none;
      border-left: 1px solid var(--chat-border);
      background: none;
      color: var(--color-text-muted);
    }
    .row-search::after {
      content: '';
      position: absolute;
      inset: -6px 0;
    }
    .mode-row.phone-row .search-proxy {
      right: 0;
      height: 32px;
    }

    /* Bubbles: 16/22 text, 18 px corners with a 4 px tail, the time inline at the end. */
    :host([phone]) .scroller {
      padding: 12px max(12px, env(safe-area-inset-right, 0px)) 12px
        max(12px, env(safe-area-inset-left, 0px));
    }
    :host([phone][landscape]) .scroller {
      padding-left: var(--chat-column-inset);
      padding-right: var(--chat-column-inset);
    }
    /* The floating mode chip's reserve: the phone padding above (same specificity, later)
       cut it to 12px and the chip sat on the last bubble's actions (2026-10-12, landscape). */
    :host([phone]) .scroll-area.with-mode .scroller {
      padding-bottom: 48px;
    }
    /* With the keyboard up the mode chip goes (phone spec 4.3), and its reserve with it. */
    :host([phone][kbd]) .mode-row.floating {
      display: none;
    }
    :host([phone][kbd]) .scroll-area.with-mode .scroller {
      padding-bottom: 12px;
    }
    :host([phone]) .bubble {
      padding: 8px 12px;
      border-radius: var(--ut-r-18);
      font-size: 1rem;
      line-height: 22px;
      box-shadow: var(--ut-piece-raised);
    }
    :host([phone]) .row.user .bubble {
      border-top-right-radius: var(--ut-r-sm);
      min-width: 0;
    }
    :host([phone]) .row.assistant .bubble {
      border: 1px solid var(--chat-border);
      border-top-left-radius: var(--ut-r-sm);
      min-width: 0;
    }
    :host([phone]) .row.assistant .bubble.with-actions {
      min-width: 150px;
    }
    :host([phone]) .row.user .time,
    :host([phone]) .row.user .msg-action {
      color: var(--chat-muted);
    }
    .time-inline {
      float: inline-end;
      position: relative;
      top: 6px;
      margin-inline-start: 10px;
      font-size: 0.6875rem;
      line-height: 16px;
      color: var(--chat-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .time-inline .sending-icon {
      vertical-align: -1px;
    }
    .md::after {
      content: '';
      display: block;
      clear: both;
    }
    :host([phone]) .msg-actions {
      position: static;
      display: flex;
      gap: 0;
      margin: 4px -8px -6px;
    }
    :host([phone]) .msg-action {
      width: 44px;
      height: 32px;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    :host([phone]) .msg-action::after {
      inset: -6px 0;
    }
    .msg-menu {
      position: absolute;
      z-index: 3;
      min-width: 200px;
      padding: 4px;
      border-radius: var(--ut-r-xl);
      background: var(--color-bg-elevated);
      box-shadow: var(--ut-piece-raised), var(--shadow-e2);
      display: flex;
      flex-direction: column;
    }
    .msg-menu button {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 44px;
      padding: 0 12px;
      border: none;
      border-radius: var(--ut-r-lg);
      background: none;
      color: var(--chat-text);
      font: inherit;
      font-size: 1rem;
      text-align: start;
    }
    .msg-menu button .ut-icon {
      color: var(--color-text-muted);
    }
    .msg-menu button:active {
      background: var(--chat-chip-hover);
    }

    /* Tool rows: in the assistant's column, a verb and its target, folded into "N pasos". */
    :host([phone]) .tool,
    :host([phone]) .steps {
      align-self: flex-start;
      max-width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 32px;
      margin: 0;
      padding: 4px 10px 4px 8px;
      border-radius: var(--ut-r-lg);
      background: transparent;
      color: var(--color-text-muted);
      font: 0.8125rem/1.125rem var(--font-ui, system-ui, sans-serif);
      text-align: start;
    }
    :host([phone]) .tool.note {
      color: var(--chat-text);
      background: var(--chat-chip);
    }
    :host([phone]) .tool.open,
    :host([phone]) .tool:active,
    :host([phone]) .steps:active {
      background: var(--chat-chip);
    }
    :host([phone]) .tool .ut-icon,
    :host([phone]) .steps .ut-icon {
      flex: none;
      color: var(--chat-muted);
    }
    .tool-verb {
      flex: none;
      font-weight: var(--ut-fw-medium);
    }
    .tool-target {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--chat-muted);
    }
    .tool-target.mono {
      font: 0.75rem/1rem var(--font-mono, ui-monospace, monospace);
    }
    :host([phone]) .tool.error .tool-verb {
      color: var(--chat-danger);
    }
    .steps {
      border: none;
      cursor: pointer;
    }
    .steps .chev {
      display: inline-flex;
      transition: transform var(--dur-1, 120ms) ease;
    }
    .steps[aria-expanded='true'] .chev {
      transform: rotate(90deg);
    }
    :host([phone]) .tool-detail {
      margin: 0 0 4px;
      border: 1px solid var(--chat-border);
    }

    /* The "now" dock over the composer: the prompt, the busy strip, or nothing. */
    .dock {
      flex-shrink: 0;
      position: relative;
      z-index: 1;
      background: var(--chat-bg);
    }
    .dock-busy {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 44px;
      padding: 0 4px 0 max(16px, env(safe-area-inset-left, 0px));
      border-top: 1px solid var(--chat-border);
      box-shadow: var(--ut-piece-edge);
      background-color: var(--ut-piece-control-fill, transparent);
    }
    .dock-busy .typing {
      align-self: center;
      margin: 0;
      padding: 0;
      background: none;
    }
    .dock-busy .typing span {
      width: 6px;
      height: 6px;
    }
    .dock-busy .activity {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.8125rem;
      line-height: 18px;
      color: var(--color-text-muted);
    }
    .dock-busy .elapsed {
      flex: none;
      font: 0.75rem/1rem var(--font-mono, ui-monospace, monospace);
      font-variant-numeric: tabular-nums;
      color: var(--chat-muted);
    }
    .dock-busy .stop {
      flex: none;
      height: 36px;
      margin: 4px max(8px, env(safe-area-inset-right, 0px)) 4px 0;
      padding: 0 12px;
      border: 1px solid var(--chat-border-strong);
      border-radius: var(--ut-r-pill);
      background: transparent;
      color: var(--chat-text);
      font: inherit;
      font-size: 0.875rem;
      font-weight: var(--ut-fw-medium);
    }
    .dock-busy .stop::after {
      inset: -4px -4px;
    }
    /* ---- Desktop chat mode (design spec 5.2, 2026-10-12) ------------------------------------
       [desktop] is set by the session view off a phone: the conversation is a centred column
       (--ut-chat-column: the whole area, 720 px with "Chat width: comfortable") with desktop
       type, tool rows and the dock in the phone's anatomy at desktop sizes. Neutral user
       bubbles: no orange tint (orange budget, spec 2.3). */
    :host([desktop]) {
      --chat-column-inset: max(16px, calc((100% - var(--ut-chat-column)) / 2));
      --chat-bubble-out: var(--ut-chat-outgoing-fill, color-mix(in srgb, var(--color-text) 9%, var(--color-bg)));
      background: var(--ut-chat-canvas, var(--ut-terminal-bg, var(--chat-bg)));
      --chat-bg: var(--ut-chat-canvas, var(--ut-terminal-bg, var(--color-bg)));
    }
    :host([desktop]) .top {
      background: var(--chat-bg);
    }
    :host([desktop]) .title {
      font-size: 0.75rem;
      line-height: 1rem;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    :host([desktop]) .scroller {
      padding: 20px var(--chat-column-inset) 16px;
      gap: 6px;
    }
    :host([desktop]) .bubble {
      max-width: var(--ut-chat-bubble-max);
      padding-left: 12px;
      padding-right: 12px;
      padding-top: 8px;
      border-radius: var(--ut-r-12);
      font-size: 0.875rem;
      line-height: 1.5;
      box-shadow: var(--ut-piece-raised);
    }
    /* 2026-11-11: no measure on running text; the bubble grows with the column up to
       --ut-chat-bubble-max, each on its own side (not 76 ch pinned to the left). */
    :host([desktop]) .row.user .bubble {
      border-top-right-radius: var(--ut-r-sm);
    }
    :host([desktop]) .row.assistant .bubble {
      border: 1px solid var(--chat-border);
      border-top-left-radius: var(--ut-r-sm);
    }
    :host([desktop]) .row.user .time,
    :host([desktop]) .row.user .msg-action {
      color: var(--chat-muted);
    }
    :host([desktop]) .tool,
    :host([desktop]) .steps {
      align-self: flex-start;
      max-width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      margin: 0;
      padding: 3px 10px 3px 8px;
      border-radius: var(--radius-ctl, 6px);
      background: transparent;
      color: var(--color-text-muted);
      font: 0.8125rem/1.125rem var(--font-ui, system-ui, sans-serif);
      text-align: start;
      cursor: pointer;
    }
    :host([desktop]) .tool:disabled {
      cursor: default;
    }
    :host([desktop]) .tool.note {
      color: var(--chat-text);
      background: var(--chat-chip);
    }
    :host([desktop]) .tool.open,
    :host([desktop]) .tool:hover:not(:disabled),
    :host([desktop]) .steps:hover {
      background: var(--chat-chip);
    }
    :host([desktop]) .tool .ut-icon,
    :host([desktop]) .steps .ut-icon {
      flex: none;
      color: var(--chat-muted);
    }
    :host([desktop]) .tool.error .tool-verb {
      color: var(--chat-danger);
    }
    :host([desktop]) .tool-detail {
      margin: 0 0 4px;
      border: 1px solid var(--chat-border);
    }
    /* The mode row and the dock line up with the column. */
    :host([desktop]) .mode-row {
      padding: 4px var(--chat-column-inset) 8px;
    }
    :host([desktop]) .jump {
      right: var(--chat-column-inset);
    }
    :host([desktop]) .dock {
      padding: 4px var(--chat-column-inset) 8px;
    }
    :host([desktop]) .dock .pd {
      padding: 12px 14px 12px 12px;
      border: 1px solid var(--color-border);
      border-left: 3px solid var(--color-attention);
      border-radius: var(--radius-card, 10px);
    }
    :host([desktop]) .pd-question {
      font-size: 0.875rem;
    }
    :host([desktop]) .pd-option {
      min-height: 40px;
      padding: 6px 12px 6px 8px;
      border-radius: var(--radius-ctl, 6px);
      font-size: 0.875rem;
      line-height: 1.25rem;
      transition: background-color var(--dur-1, 120ms) ease, border-color var(--dur-1, 120ms) ease;
    }
    :host([desktop]) .pd-option:hover:not(:disabled):not(.primary) {
      background: var(--color-surface-hover);
      border-color: var(--chat-border-strong);
    }
    :host([desktop]) .pd-option.primary:hover:not(:disabled) {
      background: color-mix(in oklab, var(--color-primary) 88%, var(--ut-mix-lighten));
    }
    :host([desktop]) .pd-link::after {
      inset: -4px -4px;
    }
    :host([desktop]) .dock-busy {
      height: 40px;
      padding: 0 4px 0 14px;
      border: 1px solid var(--chat-border);
      border-radius: var(--radius-card, 10px);
      background-color: var(--ut-piece-control-fill, transparent);
    }
    :host([desktop]) .dock-busy .stop {
      height: 30px;
      margin: 0;
      border-radius: var(--radius-ctl, 6px);
      font-size: 0.8125rem;
    }
    :host([desktop]) .dock-busy .stop:hover {
      background: var(--chat-chip);
    }
    ${promptDockStyles}

    /* Material paint is inherited across shadow roots; no look-specific component CSS. */
    .bubble,
    .msg-menu,
    .question,
    .waiting,
    .empty,
    .read-only-note,
    .search-bar input,
    .mode,
    .stop,
    .jump,
    .status-chip,
    .top,
    .dock-busy,
    .day {
      background-image: var(--ut-piece-grain);
      background-size: var(--ut-piece-grain-size);
      background-blend-mode: var(--ut-piece-grain-blend);
    }
  `,
  materialControlStyles,
];
