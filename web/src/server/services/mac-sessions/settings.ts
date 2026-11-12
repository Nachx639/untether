/**
 * Mac Sessions settings: whether "On this Mac" is listed and its API served, what a tap on a
 * tmux session opens, and whether agents without a terminal are listed.
 *
 * The switch can be forced when the server starts, and Settings then shows it locked:
 * --no-mac-sessions turns it off, UNTETHER_MAC_SESSIONS=0|1 turns it off or on. Otherwise
 * config.json's `macSessions` decides, and a missing one means on (CLI > env > config >
 * default). Only macOS and Linux list anything: elsewhere there is no process and tmux
 * discovery, and an HQ server has no sessions of its own.
 *
 * Folders to hide come from config.json's `macSessionsHideIn` plus UNTETHER_MAC_SESSIONS_HIDE_IN
 * (comma-separated, like UNTETHER_MAC_SESSIONS_ONLY_IN); a leading `~` is the home folder.
 */
import * as os from 'os';
import * as path from 'path';
import type { MacOpenMode } from '../../../shared/mac-sessions.js';
import type { UntetherConfig } from '../../../types/config.js';

export const MAC_SESSIONS_CLI_FLAG = '--no-mac-sessions';
export const MAC_SESSIONS_ENV = 'UNTETHER_MAC_SESSIONS';
export const MAC_SESSIONS_HIDE_IN_ENV = 'UNTETHER_MAC_SESSIONS_HIDE_IN';

/** How the server was started; tests pass their own env and platform. */
export interface MacSessionsStartOptions {
  /** Started with --no-mac-sessions. */
  cliDisabled?: boolean;
  hqMode?: boolean;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface MacSessionsSettings {
  /** The switch: forced at start (see lockedBy), else config.json; missing means on. */
  on: boolean;
  /** What forced the switch, as Settings names it ("UNTETHER_MAC_SESSIONS=0"). */
  lockedBy?: string;
  /** False off macOS and Linux and in HQ mode: nothing to list, and Settings hides the switch. */
  supported: boolean;
  /** Listed and served: the switch is on where it is supported. */
  enabled: boolean;
  reason?: 'disabled' | 'unsupported' | 'hq';
  openMode: MacOpenMode;
  includeHeadless: boolean;
  /** Absolute folders whose items are not listed (config plus env, `~` expanded); unset if none. */
  hideIn?: string[];
}

export type MacSessionsConfig = Pick<
  UntetherConfig,
  'macSessions' | 'macSessionsOpenMode' | 'macSessionsIncludeHeadless' | 'macSessionsHideIn'
>;

/** A list of folders as the env variables take them: comma-separated, blanks ignored. */
export function folderList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((folder) => folder.trim())
    .filter(Boolean);
}

/** `~` and `~/x` as the home folder; anything else that isn't absolute is dropped. */
function absoluteFolder(folder: string, home: string): string | undefined {
  const expanded =
    folder === '~' ? home : folder.startsWith('~/') ? path.join(home, folder.slice(2)) : folder;
  return path.isAbsolute(expanded) ? expanded : undefined;
}

function hiddenFolders(config: MacSessionsConfig, env: Record<string, string | undefined>) {
  const home = os.homedir();
  const folders = [
    ...(config.macSessionsHideIn ?? []),
    ...folderList(env[MAC_SESSIONS_HIDE_IN_ENV]),
  ]
    .map((folder) => absoluteFolder(folder.trim(), home))
    .filter((folder): folder is string => folder !== undefined);
  return [...new Set(folders)];
}

/** The env variable as a forced value; unset or not a yes/no word forces nothing. */
function envSwitch(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return undefined;
}

function offReason(
  on: boolean,
  options: MacSessionsStartOptions
): MacSessionsSettings['reason'] | undefined {
  if (options.hqMode) return 'hq';
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return 'unsupported';
  return on ? undefined : 'disabled';
}

export function macSessionsSettings(
  config: MacSessionsConfig,
  options: MacSessionsStartOptions = {}
): MacSessionsSettings {
  const env = options.env ?? process.env;
  const forced = envSwitch(env[MAC_SESSIONS_ENV]);
  let on = config.macSessions !== false;
  let lockedBy: string | undefined;
  if (options.cliDisabled) {
    on = false;
    lockedBy = MAC_SESSIONS_CLI_FLAG;
  } else if (forced !== undefined) {
    on = forced;
    lockedBy = `${MAC_SESSIONS_ENV}=${forced ? '1' : '0'}`;
  }
  const reason = offReason(on, options);
  const hideIn = hiddenFolders(config, env);
  return {
    on,
    ...(lockedBy ? { lockedBy } : {}),
    supported: reason !== 'hq' && reason !== 'unsupported',
    enabled: reason === undefined,
    ...(reason ? { reason } : {}),
    openMode: config.macSessionsOpenMode === 'watch' ? 'watch' : 'control',
    includeHeadless: config.macSessionsIncludeHeadless === true,
    ...(hideIn.length > 0 ? { hideIn } : {}),
  };
}
