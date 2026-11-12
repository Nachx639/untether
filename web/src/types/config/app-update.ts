/** Settings of the installed app's own update. */

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface AppUpdateConfig {
  /**
   * The installed Mac app is rebuilt and replaced by itself when it is behind its sources
   * (2026-11-11, installed-app-updater.ts); only when the app runs this server as a
   * development server from a checkout. Missing = off.
   */
  autoUpdateInstalledApp?: boolean;

  /**
   * How that update paces itself: no agent at work for `quietSec` (default 120) before the app
   * is swapped, at most one attempt every `everyHours` (default 6), the sources standing still
   * for `settleMin` (default 10) so a burst of merges is one update, and a build ready and still
   * not swapped after `waitNoticeHours` (default 2) told to the phone once, with what holds it.
   */
  appUpdate?: {
    quietSec?: number;
    everyHours?: number;
    settleMin?: number;
    waitNoticeHours?: number;
  };
}
