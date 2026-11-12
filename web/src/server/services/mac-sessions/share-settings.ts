/**
 * "Share with phone" settings (shared/mac-share.ts): whether an idle agent in a Terminal or
 * iTerm2 tab can be closed there and reopened through ut, and how the line is typed.
 *
 * Off unless turned on. The switch can be forced when the server starts, and Settings then
 * shows it locked: --no-mac-share turns it off, UNTETHER_MAC_SHARE=0|1 turns it off or on.
 * Otherwise config.json's `macShare` decides (CLI > env > config > default). Even when on, it
 * only works on macOS (Terminal and iTerm2 are scripted with AppleScript), with "On this Mac"
 * listing, with a login (it acts on processes and windows the user didn't open in Untether),
 * and never in HQ mode.
 */
import * as path from 'path';
import {
  MAC_SHARE_START_TIMEOUT_SEC,
  type MacShareLauncher,
  type MacShareOffReason,
} from '../../../shared/mac-share.js';
import type { UntetherConfig } from '../../../types/config.js';
import {
  type MacSessionsConfig,
  type MacSessionsStartOptions,
  macSessionsSettings,
} from './settings.js';

export const MAC_SHARE_CLI_FLAG = '--no-mac-share';
export const MAC_SHARE_ENV = 'UNTETHER_MAC_SHARE';

/** Bounds of macShareStartTimeoutSec, also enforced by the config schema. */
export const MAC_SHARE_START_TIMEOUT_MIN_SEC = 5;
export const MAC_SHARE_START_TIMEOUT_MAX_SEC = 300;

/** How the server was started: Mac Sessions' options plus this feature's own. */
export interface MacShareStartOptions extends MacSessionsStartOptions {
  /** Started with --no-mac-share. */
  shareCliDisabled?: boolean;
  /** Started with --no-auth. */
  noAuth?: boolean;
}

export interface MacShareSettings {
  /** The switch: forced at start (see lockedBy), else config.json; missing means off. */
  on: boolean;
  /** What forced the switch, as Settings names it ("UNTETHER_MAC_SHARE=1"). */
  lockedBy?: string;
  /** False off macOS and in HQ mode: Settings hides the switch. */
  supported: boolean;
  /** Offered and served: on, supported, Mac Sessions listing, and a login. */
  enabled: boolean;
  reason?: MacShareOffReason;
  launcher: MacShareLauncher;
  /** An absolute ut to type instead of the bare `ut`. */
  utPath?: string;
  /** Answer the exact trust dialog of the same folder (rule in the share job). */
  autoTrust: boolean;
  startTimeoutSec: number;
}

export type MacShareConfig = MacSessionsConfig &
  Pick<
    UntetherConfig,
    | 'macShare'
    | 'macShareLauncher'
    | 'macShareUtPath'
    | 'macShareAutoTrust'
    | 'macShareStartTimeoutSec'
  >;

/** The env variable as a forced value; unset or not a yes/no word forces nothing. */
function envSwitch(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return undefined;
}

function offReason(
  on: boolean,
  config: MacShareConfig,
  options: MacShareStartOptions
): MacShareOffReason | undefined {
  if (options.hqMode) return 'hq';
  if ((options.platform ?? process.platform) !== 'darwin') return 'unsupported';
  if (!on) return 'disabled';
  if (!macSessionsSettings(config, options).enabled) return 'mac-sessions-off';
  if (options.noAuth) return 'no-auth';
  return undefined;
}

function startTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return MAC_SHARE_START_TIMEOUT_SEC;
  return Math.min(
    MAC_SHARE_START_TIMEOUT_MAX_SEC,
    Math.max(MAC_SHARE_START_TIMEOUT_MIN_SEC, value)
  );
}

export function macShareSettings(
  config: MacShareConfig,
  options: MacShareStartOptions = {}
): MacShareSettings {
  const forced = envSwitch((options.env ?? process.env)[MAC_SHARE_ENV]);
  let on = config.macShare === true;
  let lockedBy: string | undefined;
  if (options.shareCliDisabled) {
    on = false;
    lockedBy = MAC_SHARE_CLI_FLAG;
  } else if (forced !== undefined) {
    on = forced;
    lockedBy = `${MAC_SHARE_ENV}=${forced ? '1' : '0'}`;
  }
  const reason = offReason(on, config, options);
  const utPath = config.macShareUtPath;
  return {
    on,
    ...(lockedBy ? { lockedBy } : {}),
    supported: reason !== 'hq' && reason !== 'unsupported',
    enabled: reason === undefined,
    ...(reason ? { reason } : {}),
    launcher: config.macShareLauncher === 'shell' ? 'shell' : 'ut',
    ...(typeof utPath === 'string' && path.isAbsolute(utPath) ? { utPath } : {}),
    autoTrust: config.macShareAutoTrust !== false,
    startTimeoutSec: startTimeout(config.macShareStartTimeoutSec),
  };
}
