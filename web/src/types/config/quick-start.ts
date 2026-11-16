/** The quick start commands of the new-session screen. */
import { AGENT_IDS, AGENTS } from '../../shared/agents.js';

export interface QuickStartCommand {
  name?: string; // Optional display name (can include emoji), if empty uses command
  command: string; // The actual command to execute
}

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface QuickStartConfig {
  quickStartCommands: QuickStartCommand[];
}

export const DEFAULT_QUICK_START_COMMANDS: QuickStartCommand[] = [
  ...AGENT_IDS.map((id) => ({ name: AGENTS[id].label, command: AGENTS[id].executable })),
  { name: '✨ auggie', command: 'auggie' },
  { command: 'opencode 4' },
  { command: 'zsh' },
  { command: 'node' },
];
