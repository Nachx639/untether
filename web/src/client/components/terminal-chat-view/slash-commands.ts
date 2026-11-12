import type { MessageKey } from '../../i18n/index.js';

/** Claude Code slash commands offered while typing "/" in the phone composer. */
const SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/clear', 'slash.clear'],
  ['/compact', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/resume', 'slash.resume'],
  ['/context', 'slash.context'],
  ['/cost', 'slash.cost'],
  ['/usage', 'slash.usage'],
  ['/rewind', 'slash.rewind'],
  ['/review', 'slash.review'],
  ['/init', 'slash.init'],
  ['/memory', 'slash.memory'],
  ['/agents', 'slash.agents'],
  ['/mcp', 'slash.mcp'],
  ['/permissions', 'slash.permissions'],
  ['/config', 'slash.config'],
  ['/status', 'slash.status'],
  ['/export', 'slash.export'],
  ['/help', 'slash.help'],
];

/** OpenAI Codex slash commands, offered instead when the session runs Codex. */
const CODEX_SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/new', 'slash.clear'],
  ['/compact', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/approvals', 'codex.slash.approvals'],
  ['/review', 'codex.slash.review'],
  ['/diff', 'codex.slash.diff'],
  ['/resume', 'slash.resume'],
  ['/status', 'slash.status'],
  ['/init', 'codex.slash.init'],
  ['/mcp', 'slash.mcp'],
];

/**
 * Gemini CLI slash commands, offered instead when the session runs Gemini (names checked
 * against the CLI's built-in command list, google-gemini/gemini-cli main, 2026-10-02).
 */
const GEMINI_SLASH_COMMANDS: Array<[string, MessageKey]> = [
  ['/clear', 'slash.clear'],
  ['/compress', 'slash.compact'],
  ['/model', 'slash.model'],
  ['/chat', 'gemini.slash.chat'],
  ['/resume', 'slash.resume'],
  ['/memory', 'gemini.slash.memory'],
  ['/stats', 'gemini.slash.stats'],
  ['/tools', 'gemini.slash.tools'],
  ['/mcp', 'slash.mcp'],
  ['/settings', 'gemini.slash.settings'],
  ['/init', 'gemini.slash.init'],
  ['/help', 'slash.help'],
  ['/quit', 'gemini.slash.quit'],
];

/** The slash commands to offer for the agent a session runs. */
export function slashCommandsFor(agent: string | undefined): Array<[string, MessageKey]> {
  if (agent === 'codex') return CODEX_SLASH_COMMANDS;
  if (agent === 'gemini') return GEMINI_SLASH_COMMANDS;
  return SLASH_COMMANDS;
}
