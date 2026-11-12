import type { PromptKind } from '../../../shared/claude-prompt-text.js';
import { type MessageKey, t } from '../../i18n/index.js';
import { isIOSDevice } from '../../utils/ios-install.js';
import { createLogger } from '../../utils/logger.js';

/** The docked prompt's eyebrow: what kind of thing Claude waits for. */
export const KIND_KEYS: Record<PromptKind, MessageKey> = {
  permission: 'claudeWaiting.permission',
  plan: 'claudeWaiting.plan',
  trust: 'claudeWaiting.dialog',
  question: 'claudeWaiting.input',
};

/** How often the phone composer looks for a menu on screen. */
export const SCREEN_MENU_POLL_MS = 700;
/**
 * A menu not shown yet is read again this long after it first turns up, and shows only if the
 * second read finds the same one: the terminal's buffer passes through states that are never
 * painted (a history replay after switching back to a session), and a permission card from
 * hours before flashed over the composer for two frames (user report, 2026-10-14).
 */
export const SCREEN_MENU_CONFIRM_MS = 150;

export const logger: ReturnType<typeof createLogger> = createLogger('terminal-chat-view');

/** How long after the last hand-written key the composer leaves typing to iOS again. */
export const HAND_TYPING_MS = 2000;

/** Output kept per chat message; older text is dropped from the front. */
export const MAX_MESSAGE_LENGTH = 20_000;

/** A message on its way from the phone composer (see send). */
export interface Outgoing {
  command: string;
  /** Uploaded images' paths, shell-quoted: typed before the text, in a write of their own. */
  paths: string;
  /** performance.now() when the send began, for the chat view's timing line. */
  startedAt: number;
  /** Its bubble in the chat view: new, or the one of a message that could not be sent. */
  id?: string;
  /** The chat view has been told this attempt is on its way. */
  announced?: boolean;
  /** A retry from the chat view: the box is not where it comes from. */
  retry?: boolean;
  /** The keys that send it after the text: Enter, or a Claude Code chord (agent-chords.ts). */
  submit?: readonly string[];
}

export const ENTER_KEYS: readonly string[] = ['\r'];

/** Where an attachment comes from: the photo library, this device's files, or the Mac's. */
export type AttachSource = 'media' | 'device' | 'mac';

/** «Archivo del iPhone» / «del iPad»; elsewhere, this device (a desktop browser). */
export function deviceFileLabel(): string {
  if (/iphone|ipod/i.test(navigator.userAgent)) return t('attach.fromIphone');
  if (isIOSDevice()) return t('attach.fromIpad');
  return t('attach.fromDevice');
}

/** What the composer uses of the chat view above it (claude-chat-view.ts). */
export type ChatViewHandle = HTMLElement & {
  canSearch?: boolean;
  openSearchNow?: () => void;
};

export interface ChatMessage {
  type: 'command' | 'output' | 'error';
  content: string;
  timestamp: Date;
  id: string;
}

export interface InteractiveOption {
  label: string;
  response: string;
}
