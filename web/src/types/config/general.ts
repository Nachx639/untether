/** Settings of Untether as a whole: where projects live, how the interface looks. */

import type { AvatarIcons } from '../../shared/model-providers.js';

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface GeneralConfig {
  version: number;

  repositoryBasePath?: string;

  /**
   * Replaces the app's marks in the avatars (opt-in): each value is one emoji, an app icon name
   * or the name of an image in ~/.untether/icons, like a provider's `icon`. A missing key or
   * image keeps the app's mark; a session on a provider never uses these.
   */
  avatarIcons?: AvatarIcons;

  /**
   * Interface style for every client with no choice of its own (shared/looks.ts); unset = each
   * device's own, Original by default. Opt-in; a bad value is dropped.
   */
  look?: string;

  /**
   * The parent folder the user last picked for a new project («Nuevo proyecto», 2026-10-24):
   * where the sheet's «Dónde» browser starts next time. Only a starting point; never a default
   * a project is made in without the user picking it.
   */
  newProjectParent?: string;

  /**
   * QA: the web client logs one "scrollperf:" line per touch scroll of the terminal to this
   * server's log, as ?scrollperf in the page's URL does (the installed PWA has no address bar
   * to add it to). Edited by hand in config.json; off unless true.
   */
  scrollPerf?: boolean;

  /**
   * Experiment (2026-10-04): in the iPhone home-screen app, the phone session layout follows
   * the page iOS scrolled for the chat composer instead of staying position: fixed, which
   * WebKit painted higher than it laid it out (a band under the composer). Edited by hand in
   * config.json, read live; off unless true. See session-view/chat-keyboard-fix.ts.
   */
  chatKeyboardFix?: boolean;

  /**
   * Experiment, iteration 3 (2026-10-04): in the iPhone home-screen app, the first tap on the
   * chat composer shortens the session layout to above the coming keyboard before the field
   * takes the focus, so iOS has nothing to scroll. Edited by hand in config.json, read live;
   * off unless true, and wins over chatKeyboardFix. See session-view/chat-keyboard-fix2.ts.
   */
  chatKeyboardFix2?: boolean;

  /**
   * Experiment, iteration 4 (2026-10-04): while the chat composer has the focus on a phone, the
   * page is held as tall as the visible area and its scroll at 0, and the other fields are made
   * inert (iOS's ↑ ↓ bar). Edited by hand in config.json, read live; off unless true, and wins
   * over chatKeyboardFix and chatKeyboardFix2. See session-view/chat-keyboard-fix3.ts.
   */
  chatKeyboardFix3?: boolean;
}
