/**
 * The installed Mac app catches up by itself (2026-11-11, the user: "I should not have to keep
 * an eye on these things"). With the `autoUpdateInstalledApp` setting on, and only when this
 * server is a development server the installed app started from a checkout, an app that is
 * behind its sources (installed-app.ts) is rebuilt and replaced without anyone asking:
 *
 * - built signed with mac/scripts/build.sh in a worktree of its own with its own node_modules
 *   (2026-11-11: that script, run in the checkout the server runs from, rebuilt authenticate-pam
 *   for the embedded Node and the server could not load it), in a check slot, and never started
 *   while the Mac is over its load threshold;
 * - swapped at a quiet moment (no check running, no task just prepared, checked or merged, no
 *   agent at work in the last `quietSec`), by a helper that is not a child of the app being closed
 *   (web/scripts/app-swap-helper.cjs): copy of the old app, signature checked before anything
 *   changes, the server must answer afterwards, else the old app goes back;
 * - at most once every `everyHours`, with the changes of a burst of merges taken together
 *   (the head must have stood still for `settleMin`);
 * - the phone hears one line AFTER it: "Untether updated itself to <commit>", or that it could
 *   not and why. The server that started the swap dies with the old app, so the helper leaves
 *   its result in a file and the next server tells it (`afterRestart`).
 *
 * A build that is ready never waits unseen (2026-11-11, its first real run: built at 05:46 and
 * still not swapped at 11:05, held by a task that had waited four hours at a permission prompt,
 * and nothing said so): what the updater is doing is always one line (`status`, in `ut status`
 * and `ut doctor`), and a build waiting longer than `waitNoticeHours` is told to the phone once,
 * with what holds it.
 *
 * Everything outside is handed in (the app, git, the build, the helper's start), so the tests
 * run it with doubles and a folder that plays /Applications.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BuildInfo } from '../build-info.js';
import type { AppLag, RunningApp } from './installed-app.js';

export interface AppUpdateSettings {
  /** No agent turn seen for this long before the app is swapped. */
  quietSec: number;
  /** At most one attempt (a build, a swap) in this long. */
  everyHours: number;
  /** The checkout's head must be this old: a burst of merges is one update. */
  settleMin: number;
  /** A build ready and still not swapped after this long is told to the phone, once. */
  waitNoticeHours: number;
}

export const DEFAULT_APP_UPDATE: AppUpdateSettings = {
  quietSec: 120,
  everyHours: 6,
  settleMin: 10,
  waitNoticeHours: 2,
};

export function appUpdateFrom(value?: Partial<AppUpdateSettings>): AppUpdateSettings {
  const number = (given: unknown, fallback: number, min: number, max: number) =>
    typeof given === 'number' && Number.isFinite(given)
      ? Math.min(max, Math.max(min, given))
      : fallback;
  return {
    quietSec: number(value?.quietSec, DEFAULT_APP_UPDATE.quietSec, 10, 3600),
    everyHours: number(value?.everyHours, DEFAULT_APP_UPDATE.everyHours, 0.25, 168),
    settleMin: number(value?.settleMin, DEFAULT_APP_UPDATE.settleMin, 0, 240),
    waitNoticeHours: number(value?.waitNoticeHours, DEFAULT_APP_UPDATE.waitNoticeHours, 0.25, 48),
  };
}

/** What the helper leaves behind (web/scripts/app-swap-helper.cjs `finish`). */
export interface SwapResult {
  outcome: 'updated' | 'refused' | 'rolled-back' | 'broken';
  reason?: string;
  detail?: string;
  commit: string;
  previousCommit?: string;
  at: string;
}

export interface SwapPlan {
  appPath: string;
  newAppPath: string;
  backupPath: string;
  resultPath: string;
  logPath: string;
  commit: string;
  previousCommit?: string;
  /** The process group of the server the app runs: ended if it outlives its app. */
  serverGroup?: number;
  quit: string[];
  open: string[];
  healthUrl: string;
  codesign?: string;
  timeouts?: { quitMs?: number; orphanMs?: number; healthMs?: number; pollMs?: number };
}

interface UpdaterState {
  /** When the last attempt (build or swap) started: the "once every X hours" clock. */
  lastAttemptAt?: number;
  /** A build going on: found at start, the server that ran it was restarted under it. */
  building?: { head: string; since: number };
  /** A build ready to be swapped in. */
  built?: { commit: string; appPath: string; at: number };
  /** The helper is at it (this server is about to die with the app). */
  swapping?: { commit: string; since: number };
  /** The head an attempt failed on: not tried again until the head moves. */
  failed?: { head: string; reason: string; at: number };
  /** The commit the last swap installed: an app that still looks behind it is not rebuilt. */
  updatedTo?: string;
  /** The built commit whose long wait the phone was told about (once per build). */
  waitTold?: string;
}

/** What the updater is doing, in one line (`ut status`, `ut doctor`). */
export interface AppUpdateStatus {
  state:
    | 'off'
    | 'no-app'
    | 'not-looked'
    | 'up-to-date'
    | 'building'
    | 'built-waiting'
    | 'swapping'
    | 'failed'
    | 'held';
  text: string;
}

export type AppUpdateFailure =
  | 'build'
  | 'signing'
  | 'keychain'
  | 'signature'
  | 'signer'
  | 'permission'
  | 'app-did-not-quit'
  | 'no-answer'
  | 'broken'
  | 'helper-lost'
  | 'other';

export interface AppUpdateNotice {
  ok: boolean;
  commit: string;
  failure?: AppUpdateFailure;
  /** Not a failure: a build is ready and has waited long for a quiet moment; `text` says on what. */
  waiting?: boolean;
  /** One English line: what happened and, when it failed or waits, why. */
  text: string;
}

export interface InstalledAppUpdaterDeps {
  enabled: () => boolean;
  settings?: () => AppUpdateSettings;
  /** The installed app this development server runs under; none: nothing is ever done. */
  app: () => Promise<RunningApp | undefined>;
  appBuild: (appPath: string) => Promise<BuildInfo | undefined>;
  lag: (commit: string) => Promise<AppLag | undefined>;
  /** The Mac is over its load threshold or short of memory. */
  loadHigh: () => boolean;
  /** A build of a previous server is still running in the build's worktree. */
  buildRunning?: () => boolean;
  /** Runs `task` in a check slot (the shared limiter). */
  inCheckSlot: <T>(task: () => Promise<T>) => Promise<T>;
  /** Builds the signed app of `commit` (worktree of its own); the bundle it made. */
  build: (commit: string) => Promise<{ appPath: string }>;
  /**
   * Why this is not a quiet moment, or null. Real activity only (a check running, an agent at
   * work a moment ago): never a state that can last for hours.
   */
  busy: () => string | null;
  /** Starts the helper, detached, on the plan file. */
  startHelper: (planPath: string) => void;
  /** The plan's parts only the server knows (commands, health URL, this server's process group). */
  swapCommands: (app: RunningApp) => Pick<SwapPlan, 'quit' | 'open' | 'healthUrl' | 'serverGroup'>;
  notify: (notice: AppUpdateNotice) => void;
  /** Where the state, the plan, the result, the helper's log and the old app's copy live. */
  dir: string;
  now?: () => number;
  log?: (message: string) => void;
}

const HOUR = 60 * 60 * 1000;
/** A swap whose helper left no result after this long is taken for lost. */
export const SWAP_LOST_MS = 20 * 60 * 1000;

/** "3 h 12 min", "8 min". */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

/** Why a build failed, from its output: the signing troubles the user can do something about. */
export function buildFailure(output: string): AppUpdateFailure {
  if (
    /errSecInternalComponent|User interaction is not allowed|errSecAuthFailed|unlock-keychain|keychain.*(locked|denied)/i.test(
      output
    )
  ) {
    return 'keychain';
  }
  if (
    /No signing identity found|no identity found|Code signature verification failed|code object is not signed|resource envelope is obsolete|No signing certificate|requires a development team/i.test(
      output
    )
  ) {
    return 'signing';
  }
  return 'build';
}

const FAILURE_TEXT: Record<AppUpdateFailure, string> = {
  build: 'the build failed',
  signing: 'the build could not be signed (no usable signing certificate)',
  keychain: 'the keychain did not let the build be signed (locked, or it needs your OK once)',
  signature: "the new build's signature is not valid",
  signer:
    'the new build is signed by someone else than the installed app, and macOS would ask every permission again',
  permission: 'macOS did not allow replacing the app (App Management or the folder’s permissions)',
  'app-did-not-quit': 'the app did not quit',
  'no-answer': 'the server did not answer with the new app, so the previous one is back',
  broken: 'the server answers with neither the new app nor the previous one: open Untether by hand',
  'helper-lost': 'the helper that swaps the app left no result',
  other: 'something unexpected',
};

export function failureText(failure: AppUpdateFailure, detail?: string): string {
  const first = detail
    ?.split('\n')
    .find((line) => line.trim())
    ?.trim();
  return `Untether could not update itself: ${FAILURE_TEXT[failure]}${first ? ` (${first.slice(0, 160)})` : ''}`;
}

function swapFailure(result: SwapResult): AppUpdateFailure {
  if (result.outcome === 'broken') return 'broken';
  if (result.outcome === 'rolled-back') return 'no-answer';
  const known: AppUpdateFailure[] = ['signature', 'signer', 'permission', 'app-did-not-quit'];
  return known.find((reason) => reason === result.reason) ?? 'other';
}

export class InstalledAppUpdater {
  private state: UpdaterState = {};
  private building?: Promise<void>;
  private held?: string;
  private scheduled = false;
  private report: AppUpdateStatus = { state: 'not-looked', text: 'not looked at yet' };
  private readonly now: () => number;

  constructor(private readonly deps: InstalledAppUpdaterDeps) {
    this.now = deps.now ?? Date.now;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file('state.json'), 'utf8')) as UpdaterState;
    } catch {
      // No attempt yet.
    }
    if (this.state.building) {
      // The server restarted under its own build (a development server reloads with every
      // merge): that was not an attempt, the next look builds again.
      delete this.state.building;
      delete this.state.lastAttemptAt;
      this.save();
    }
  }

  private file(name: string): string {
    return path.join(this.deps.dir, name);
  }

  private save(): void {
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const temp = `${this.file('state.json')}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file('state.json'));
    } catch (error) {
      this.deps.log?.(`app update state could not be saved: ${error}`);
    }
  }

  /** Why the update is waiting (the doctor's app-build says it); undefined when it is not. */
  heldBy(): string | undefined {
    return this.held;
  }

  /** What the updater is doing, as of its last look (one a minute). */
  status(): AppUpdateStatus {
    return this.report;
  }

  /** The end of a look: what `status` says, and why the update waits when it does. */
  private rest(
    state: AppUpdateStatus['state'],
    text: string,
    held?: string,
    scheduled = false
  ): void {
    this.report = { state, text };
    this.held = held;
    this.scheduled = scheduled;
  }

  /**
   * Whether the update is on its way (a next attempt is scheduled or going on) and whether the
   * last attempt failed: the doctor's app-build stays a note while it is and it did not.
   */
  schedule(): { scheduled: boolean; lastFailed: boolean; everyHours: number } {
    return {
      scheduled: this.scheduled,
      lastFailed: this.state.failed !== undefined,
      everyHours: (this.deps.settings?.() ?? DEFAULT_APP_UPDATE).everyHours,
    };
  }

  /** Resolves when the build going on (if any) has ended (tests). */
  async settled(): Promise<void> {
    await this.building;
  }

  /**
   * What a swap started by the previous server came to: told to the phone once, whatever the
   * setting says now. Called when a server starts.
   */
  afterRestart(): void {
    let result: SwapResult | undefined;
    try {
      result = JSON.parse(fs.readFileSync(this.file('result.json'), 'utf8')) as SwapResult;
    } catch {
      // No swap ended since the last look.
    }
    if (!result) {
      const swapping = this.state.swapping;
      if (swapping && this.now() - swapping.since > SWAP_LOST_MS) this.swapLost(swapping.commit);
      return;
    }
    fs.rmSync(this.file('result.json'), { force: true });
    fs.rmSync(this.file('plan.json'), { force: true });
    delete this.state.swapping;
    delete this.state.built;
    delete this.state.waitTold;
    if (result.outcome === 'updated') {
      delete this.state.failed;
      this.state.updatedTo = result.commit;
      this.save();
      this.deps.notify({
        ok: true,
        commit: result.commit,
        text: `Untether updated itself to ${result.commit}`,
      });
      return;
    }
    const failure = swapFailure(result);
    this.state.failed = { head: result.commit, reason: failure, at: this.now() };
    this.save();
    this.deps.notify({
      ok: false,
      commit: result.commit,
      failure,
      text: failureText(failure, result.detail),
    });
  }

  private swapLost(commit: string): void {
    delete this.state.swapping;
    delete this.state.built;
    this.state.failed = { head: commit, reason: 'helper-lost', at: this.now() };
    this.save();
    this.deps.notify({
      ok: false,
      commit,
      failure: 'helper-lost',
      text: failureText('helper-lost'),
    });
  }

  /** One look: builds when the app is behind, swaps when a build is ready and all is quiet. */
  async tick(): Promise<void> {
    this.held = undefined;
    const swapping = this.state.swapping;
    if (swapping) {
      // The helper is at it, or ended while this server stayed up (it refused before closing
      // the app): its result is told like after a restart.
      this.rest('swapping', `replacing the app with ${swapping.commit}`);
      if (fs.existsSync(this.file('result.json')) || this.now() - swapping.since > SWAP_LOST_MS) {
        this.afterRestart();
        const failed = this.state.failed;
        if (failed) this.rest('failed', `failed on ${failed.head}: ${failed.reason}`);
      }
      return;
    }
    if (!this.deps.enabled()) {
      this.rest('off', 'off (the autoUpdateInstalledApp setting)');
      return;
    }
    const building = this.state.building;
    if (this.building) {
      this.rest(
        'building',
        building
          ? `building ${building.head} for ${spanText(this.now() - building.since)}`
          : 'building'
      );
      return;
    }
    const app = await this.deps.app();
    if (!app) {
      this.rest('no-app', 'nothing to update: no installed app runs this server');
      return;
    }
    const build = await this.deps.appBuild(app.appPath);
    if (!build) {
      this.rest('held', `${app.appPath} does not say which commit it was built from`);
      return;
    }
    const lag = await this.deps.lag(build.commit);
    if (!lag || lag.unknown || !lag.files.length) {
      if (this.state.built || this.state.failed || this.state.waitTold) {
        delete this.state.built;
        delete this.state.failed;
        delete this.state.waitTold;
        this.save();
      }
      this.rest(
        lag?.unknown ? 'held' : 'up-to-date',
        lag?.unknown
          ? `the app's build ${build.commit} cannot be compared with its sources`
          : `up to date (the app is build ${build.commit})`
      );
      return;
    }
    const settings = this.deps.settings?.() ?? DEFAULT_APP_UPDATE;
    const now = this.now();
    const behind = `the app is build ${build.commit}, its sources are at ${lag.head}`;
    const hold = (state: AppUpdateStatus['state'], why: string, scheduled = false) =>
      this.rest(state, `${behind}: ${why}`, why, scheduled);

    const built = this.state.built;
    if (built && fs.existsSync(path.join(built.appPath, 'Contents'))) {
      const busy = this.deps.busy();
      if (busy) {
        if (!Number.isFinite(built.at)) {
          // A state written without its time: the wait is counted from now on.
          built.at = now;
          this.save();
        }
        const waited = now - built.at;
        hold(
          'built-waiting',
          `built ${built.commit} ${spanText(waited)} ago, waiting for a quiet moment (${busy})`,
          true
        );
        if (waited > settings.waitNoticeHours * HOUR && this.state.waitTold !== built.commit) {
          this.state.waitTold = built.commit;
          this.save();
          this.deps.notify({
            ok: false,
            waiting: true,
            commit: built.commit,
            text: `Untether's update to ${built.commit} has been ready for ${spanText(waited)} and still waits for a quiet moment: ${busy}`,
          });
        }
        return;
      }
      this.rest('swapping', `replacing the app with ${built.commit}`, undefined, true);
      this.swap(app, built, build.commit);
      return;
    }
    if (built) delete this.state.built;

    if (this.state.updatedTo === lag.head) {
      // Swapped to this very commit and it still reads as older: its build says the wrong
      // commit. Rebuilding would loop; the doctor's app-build tells it.
      hold('held', `the app was already updated to ${lag.head} and still reads as older`);
      return;
    }
    if (this.state.failed?.head === lag.head) {
      hold(
        'failed',
        `the last attempt failed on ${lag.head} (${this.state.failed.reason}); it tries again when the sources move`
      );
      return;
    }
    const wait = (this.state.lastAttemptAt ?? 0) + settings.everyHours * HOUR - now;
    if (wait > 0) {
      hold(
        'held',
        `at most one attempt every ${settings.everyHours} h; the next in ${Math.ceil(wait / 60_000)} min`,
        true
      );
      return;
    }
    const headAge = lag.headDate ? now - Date.parse(lag.headDate) : Number.POSITIVE_INFINITY;
    if (headAge < settings.settleMin * 60_000) {
      hold(
        'held',
        `the sources changed less than ${settings.settleMin} min ago: waiting for them to settle`,
        true
      );
      return;
    }
    if (this.deps.loadHigh()) {
      hold('held', 'the Mac is over its load threshold: the build waits', true);
      return;
    }
    if (this.deps.buildRunning?.()) {
      hold('held', 'a build started before the last restart is still running', true);
      return;
    }
    this.rest('building', `building ${lag.head}`, undefined, true);
    this.startBuild(lag.head);
  }

  private startBuild(head: string): void {
    this.state.lastAttemptAt = this.now();
    this.state.building = { head, since: this.now() };
    this.save();
    this.deps.log?.(`app update: building ${head}`);
    this.building = this.deps
      .inCheckSlot(async () => {
        // The limiter starts a waiting run anyway after its longest wait: this one does not.
        if (this.deps.loadHigh()) throw new LoadHigh();
        return this.deps.build(head);
      })
      .then(({ appPath }) => {
        this.state.built = { commit: head, appPath, at: this.now() };
        delete this.state.failed;
        // A new build, even of a commit built before: its own long wait is told.
        delete this.state.waitTold;
        this.save();
        this.deps.log?.(`app update: built ${head} at ${appPath}`);
      })
      .catch((error: unknown) => {
        if (error instanceof LoadHigh) {
          // Not an attempt: the next look tries again once the load is down.
          delete this.state.lastAttemptAt;
          this.save();
          return;
        }
        const output = error instanceof Error ? error.message : String(error);
        const failure = buildFailure(output);
        this.state.failed = { head, reason: failure, at: this.now() };
        this.save();
        this.deps.log?.(`app update: building ${head} failed: ${output.slice(-2000)}`);
        this.deps.notify({
          ok: false,
          commit: head,
          failure,
          text: failureText(failure, lastLine(output)),
        });
      })
      .finally(() => {
        delete this.state.building;
        this.save();
        this.building = undefined;
      });
  }

  private swap(
    app: RunningApp,
    built: NonNullable<UpdaterState['built']>,
    previousCommit: string
  ): void {
    const plan: SwapPlan = {
      appPath: app.appPath,
      newAppPath: built.appPath,
      backupPath: this.file(`${path.basename(app.appPath)}.previous`),
      resultPath: this.file('result.json'),
      logPath: this.file('swap.log'),
      commit: built.commit,
      previousCommit,
      ...this.deps.swapCommands(app),
    };
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    fs.rmSync(plan.resultPath, { force: true });
    fs.writeFileSync(this.file('plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    this.state.swapping = { commit: built.commit, since: this.now() };
    this.state.lastAttemptAt = this.now();
    delete this.state.waitTold;
    this.save();
    this.deps.log?.(`app update: swapping ${app.appPath} to ${built.commit}`);
    try {
      this.deps.startHelper(this.file('plan.json'));
    } catch (error) {
      delete this.state.swapping;
      this.state.failed = { head: built.commit, reason: 'other', at: this.now() };
      this.save();
      this.rest('failed', `failed on ${built.commit}: the helper could not be started (${error})`);
      this.deps.notify({
        ok: false,
        commit: built.commit,
        failure: 'other',
        text: failureText('other', String(error)),
      });
    }
  }
}

class LoadHigh extends Error {}

function lastLine(output: string): string | undefined {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /error|fail|denied|not allowed/i.test(line));
  return lines[lines.length - 1];
}
