import { getLocale, type MessageKey, t } from '../../i18n/index.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import type { IconName } from '../icons.js';
import { openImageLightbox } from '../image-lightbox.js';

/** Bash → terminal, Edit → pencil…: the icon of a tool row on a phone. */
export const TOOL_ICONS: Record<string, IconName> = {
  Bash: 'terminal',
  Edit: 'pencil',
  MultiEdit: 'pencil',
  Write: 'pencil',
  NotebookEdit: 'pencil',
  Read: 'fileText',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'external',
  WebSearch: 'external',
  Task: 'sparkles',
  Agent: 'sparkles',
  TodoWrite: 'list',
  AskUserQuestion: 'chat',
};

/** activity.* keys with a {target}: the verb alone is the key's text without it. */
const TOOL_VERB_KEYS: Record<string, MessageKey> = {
  Bash: 'activity.running',
  Edit: 'activity.editing',
  MultiEdit: 'activity.editing',
  Write: 'activity.editing',
  NotebookEdit: 'activity.editing',
  Read: 'activity.reading',
  Grep: 'activity.searching',
  Glob: 'activity.searching',
  WebFetch: 'activity.browsing',
  WebSearch: 'activity.browsing',
  Task: 'activity.agent',
  Agent: 'activity.agent',
};

/** "Ejecutando", "Editando", "Leyendo"…, from the activity wording; an unknown tool is its name. */
export function toolVerb(tool: string | undefined): string {
  const name = tool ?? '';
  const key = TOOL_VERB_KEYS[name];
  if (key) {
    const verb = t(key, { target: '' })
      .split('')
      .join('')
      .replace(/[\s:：·]+$/u, '')
      .trim();
    if (verb) return verb;
  }
  if (name === 'TodoWrite') return t('activity.todos');
  return name.startsWith('mcp__') ? name.split('__').pop() || name : name;
}

/** A path, a command or a file name reads in mono; a sentence ("List files") does not. */
export function looksLikeData(text: string): boolean {
  return !/\s/.test(text.trim()) || /[/\\`$|&<>=]/.test(text);
}

/** 24 h clock in the app's language (en keeps its am/pm). */
export function formatTime(timestamp?: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const locale = getLocale();
  try {
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(locale === 'en' ? { hour12: true } : { hourCycle: 'h23' as const }),
    });
  } catch {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

/** A run of bubbles: the same sender, each under five minutes after the one before. */
export const RUN_GAP_MS = 5 * 60_000;

/** Tap a sent image to see it full screen (pointerup: iOS can eat a first tap's click). */
export function openOnTap(url: string) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerup') {
      // A scroll of the conversation that started on the image ends here too: not a tap.
      if (endsADrag(e as PointerEvent)) return;
      swallowNextClick();
    }
    openImageLightbox(url, t('chat.attachedImage'));
  };
}

/** A file path Claude can read as an image. */
const READ_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;

export function isReadImage(message: { tool?: string; detail?: string }): boolean {
  return message.tool === 'Read' && READ_IMAGE.test(message.detail ?? '');
}

const UPLOADED_IMAGE = /\S*\/uploads\/([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|heic|heif))/gi;

/** Split images uploaded through Untether out of a message: their paths become thumbnails. */
export function extractUploadedImages(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const rest = text
    .replace(UPLOADED_IMAGE, (_path, name: string) => {
      images.push(name);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: rest, images };
}

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday" or a short date, for the separators between days of a long chat. */
export function formatDay(date: Date, now = new Date()): string {
  if (localDayKey(date) === localDayKey(now)) return t('chat.today');
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDayKey(date) === localDayKey(yesterday)) return t('chat.yesterday');
  return date.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
