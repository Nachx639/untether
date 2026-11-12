/**
 * The app's icon set (design spec 3.1, 2026-10-12): 16 px, 1.75 stroke, currentColor, Lucide
 * geometry, aria-hidden (the button around it carries the name). No emoji in chrome.
 *
 *   html`<button class="ut-icon-btn" aria-label=${t('header.files')}>${icon('files')}</button>`
 *   agentGlyph(agentKind(session))
 */
import { html, type SVGTemplateResult, svg, type TemplateResult } from 'lit';
import type { Session } from '../../shared/types.js';
import { isAIAssistantSession } from '../utils/ai-sessions.js';

const PATHS = {
  search: svg`<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`,
  plus: svg`<path d="M12 5v14M5 12h14"/>`,
  x: svg`<path d="M18 6 6 18M6 6l12 12"/>`,
  more: svg`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`,
  chevronDown: svg`<path d="m6 9 6 6 6-6"/>`,
  chevronRight: svg`<path d="m9 18 6-6-6-6"/>`,
  chevronLeft: svg`<path d="m15 18-6-6 6-6"/>`,
  check: svg`<path d="M20 6 9 17l-5-5"/>`,
  alert: svg`<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>`,
  info: svg`<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>`,
  sidebar: svg`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>`,
  folder: svg`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  folderOpen: svg`<path d="m6 14 1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-1.9 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"/>`,
  gitBranch: svg`<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
  terminal: svg`<path d="m4 17 6-6-6-6M12 19h8"/>`,
  terminalStack: svg`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 10 3 2-3 2M12 14h4"/><path d="M2 8h20"/>`,
  settings: svg`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  bell: svg`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  sun: svg`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
  moon: svg`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
  monitor: svg`<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  history: svg`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>`,
  files: svg`<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>`,
  fileText: svg`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>`,
  grid: svg`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
  list: svg`<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>`,
  keyboard: svg`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>`,
  chat: svg`<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>`,
  send: svg`<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>`,
  pencil: svg`<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>`,
  trash: svg`<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`,
  restart: svg`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
  external: svg`<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
  shield: svg`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
  lock: svg`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  command: svg`<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>`,
  sparkles: svg`<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/>`,
  copy: svg`<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  clock: svg`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  // Phone addendum (phone-spec §7, 2026-10-12).
  pin: svg`<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
  pinOff: svg`<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>`,
  bellOff: svg`<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M8.67 3.24A6 6 0 0 1 18 8c0 2.4.33 4.2.8 5.6"/><path d="m2 2 20 20"/>`,
  shieldOff: svg`<path d="m2 2 20 20"/><path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71"/><path d="M9.31 3.84A13 13 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.8 9.8 0 0 1-.08 1.26"/>`,
  clipboard: svg`<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>`,
  image: svg`<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>`,
  stop: svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`,
  // Suspended sessions (2026-10-31): paused, and "don't suspend" (a lit lamp, awake).
  pause: svg`<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>`,
  zap: svg`<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>`,
  mic: svg`<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>`,
  volume2: svg`<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>`,
  eye: svg`<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>`,
  sunMoon: svg`<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>`,
  palette: svg`<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>`,
  arrowUp: svg`<path d="M12 19V5M5 12l7-7 7 7"/>`,
  arrowDown: svg`<path d="M12 5v14M19 12l-7 7-7-7"/>`,
  grip: svg`<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>`,
  cornerDownLeft: svg`<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>`,
  messageSquare: svg`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  plug: svg`<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
  circleCheck: svg`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
} satisfies Record<string, SVGTemplateResult>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** An icon at `size` px (16 by default). */
export function icon(name: IconName, size = 16): TemplateResult {
  return html`<svg
    class="ut-icon"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >${PATHS[name]}</svg>`;
}

export type AgentKind = 'claude' | 'codex' | 'shell';

/** A sunburst mark (drawn, not the ✳ character: iOS renders that as a green emoji). */
export const CLAUDE_MARK = html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
  <path d="M12 3.5v6M12 14.5v6M3.5 12h6M14.5 12h6M6 6l4.2 4.2M13.8 13.8L18 18M18 6l-4.2 4.2M10.2 13.8L6 18" />
</svg>`;
export const CODEX_MARK = html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
</svg>`;
export const GEMINI_MARK = html`<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
  <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" />
</svg>`;

/** Which agent a session runs: claude, codex, or a plain shell/command. */
export function agentKind(session: Pick<Session, 'command'>): AgentKind {
  const commands = Array.isArray(session.command) ? session.command : [session.command];
  const base = (commands[0] ?? '').split('/').pop()?.toLowerCase() ?? '';
  if (!isAIAssistantSession(session as Session)) return 'shell';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('claude')) return 'claude';
  // Another assistant (or a wrapper as the first word): look at every word.
  const words = commands.map((word) => word?.split('/').pop()?.toLowerCase() ?? '');
  if (words.some((word) => word.startsWith('claude'))) return 'claude';
  if (words.some((word) => word.startsWith('codex'))) return 'codex';
  return 'shell';
}

/** The agent's 16 px glyph: Claude's sunburst (the phone's mark), a "Cx" monogram, a prompt. */
export function agentGlyph(kind: AgentKind, size = 16): TemplateResult {
  switch (kind) {
    case 'claude':
      return html`<span
        class="ut-agent-glyph"
        style="width:${size}px;height:${size}px"
        aria-hidden="true"
        >${CLAUDE_MARK}</span
      >`;
    case 'codex':
      return html`<span
        class="ut-agent-glyph ut-agent-glyph--codex"
        style="width:${size}px;height:${size}px"
        aria-hidden="true"
        >Cx</span
      >`;
    default:
      return html`<span
        class="ut-agent-glyph"
        style="width:${size}px;height:${size}px"
        aria-hidden="true"
        >${icon('terminal', size)}</span
      >`;
  }
}
