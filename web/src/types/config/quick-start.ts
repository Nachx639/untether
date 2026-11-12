/** The quick start commands of the new-session screen. */

export interface QuickStartCommand {
  name?: string; // Optional display name (can include emoji), if empty uses command
  command: string; // The actual command to execute
}

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface QuickStartConfig {
  quickStartCommands: QuickStartCommand[];
}

export const DEFAULT_QUICK_START_COMMANDS: QuickStartCommand[] = [
  { name: '✨ codex', command: 'codex' },
  { name: '✨ claude', command: 'claude' },
  { name: '✨ auggie', command: 'auggie' },
  { command: 'gemini3' },
  { command: 'opencode 4' },
  { command: 'zsh' },
  { command: 'node' },
];
