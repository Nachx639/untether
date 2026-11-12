/** Settings of sharing a Mac terminal with the phone. */

import type { MacShareLauncher } from '../../shared/mac-share.js';

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface MacShareConfig {
  /**
   * "Share with phone": an idle agent in a Terminal or iTerm2 tab can be closed there and
   * reopened in the same tab through ut. Missing = off. UNTETHER_MAC_SHARE=0|1 and
   * --no-mac-share override it (services/mac-sessions/share-settings.ts).
   */
  macShare?: boolean;

  /** What is typed to reopen it: `ut <agent> …` (default) or the shell's own command. */
  macShareLauncher?: MacShareLauncher;

  /** An absolute path to type instead of the bare `ut`. Edited by hand in config.json. */
  macShareUtPath?: string;

  /** Answer the reopened agent's trust dialog for the folder it already ran in. Missing = on. */
  macShareAutoTrust?: boolean;

  /** How long the reopened agent has to show up through ut, in seconds. Missing = 30. */
  macShareStartTimeoutSec?: number;
}
