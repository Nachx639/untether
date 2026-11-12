/** Settings of the Mac's own terminal sessions shown in Untether. */

import type { MacOpenMode } from '../../shared/mac-sessions.js';

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface MacSessionsConfig {
  /**
   * "On this Mac" in the phone's list: the tmux sessions on the user's own tmux servers and the
   * agents running outside Untether. Missing = on. UNTETHER_MAC_SESSIONS=0|1 and
   * --no-mac-sessions override it (services/mac-sessions/settings.ts).
   */
  macSessions?: boolean;

  /** What a tap on a tmux session there opens. Missing = 'control' (ready to type). */
  macSessionsOpenMode?: MacOpenMode;

  /** Also list agents with no terminal, or a Claude not started from its CLI (an SDK bot). */
  macSessionsIncludeHeadless?: boolean;

  /**
   * Absolute folders (`~` allowed) whose tmux sessions and agents are not listed, below them
   * included. UNTETHER_MAC_SESSIONS_HIDE_IN adds to it; UNTETHER_MAC_SESSIONS_ONLY_IN's
   * folders are listed even when hidden here.
   */
  macSessionsHideIn?: string[];
}
