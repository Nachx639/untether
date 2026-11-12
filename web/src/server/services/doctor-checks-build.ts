/**
 * The doctor's checks of what Untether is built from: native modules, the installed CLI and
 * the forwarder.
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { type BuildInfo, describeBuild, isOlderBuild, missingCommands } from '../build-info.js';
import { execFileAsync, MINUTE, processAlive } from './doctor-checks-shared.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/**
 * node-pty's spawn-helper (2026-10-20: `pnpm update` relinked node-pty without its build and
 * every new session failed with "posix_spawnp failed"). Healed by rebuilding it.
 */
export function nativePtyCheck(deps: {
  helperPath: () => string | null;
  rebuild: () => Promise<void>;
  exists?: (file: string) => boolean;
  /** An app build at work in this checkout (appBuildRunning): nothing is rebuilt meanwhile. */
  building?: () => AppBuildMark | undefined;
}): DoctorCheck {
  const exists = deps.exists ?? fs.existsSync;
  return {
    id: 'native-pty',
    async run() {
      const helper = deps.helperPath();
      if (!helper || exists(helper)) return [];
      const finding: DoctorFinding = {
        key: 'native-pty:spawn-helper-missing',
        check: 'native-pty',
        severity: 'critical',
        problem: "node-pty's spawn-helper is missing: no new session can start",
      };
      // 2026-11-12: rebuilt here in the middle of a release whose build was rebuilding it too.
      const build = deps.building?.();
      if (build) {
        return [
          {
            ...finding,
            problem: `${finding.problem}; an app build is at work in this checkout (pid ${build.pid}): not rebuilt until it ends`,
          },
        ];
      }
      try {
        await deps.rebuild();
      } catch (error) {
        return [{ ...finding, problem: `${finding.problem}; rebuilding it failed: ${error}` }];
      }
      return exists(helper)
        ? [{ ...finding, healed: 'node-pty rebuilt' }]
        : [{ ...finding, problem: `${finding.problem}; a rebuild did not bring it back` }];
    },
  };
}

export interface AppBuildMark {
  pid: number;
  /** When the build started, epoch ms. */
  since: number;
}

/** The mark mac/scripts/build-web-frontend.sh keeps in web/ while it runs: "<pid> <epoch s>". */
export const APP_BUILD_MARK = '.app-build-running';
/** A mark older than this is a leftover (a build takes minutes; with the custom Node, ~1 h). */
export const APP_BUILD_MARK_MAX_MS = 3 * 60 * MINUTE;

/**
 * The app build at work in `webDir`, when its mark is there, its process lives and it is not
 * a leftover. While one runs, the doctor rebuilds no native module of that checkout: the two
 * would write the same files (2026-11-12).
 */
export function appBuildRunning(
  webDir: string,
  deps: { now?: () => number; alive?: (pid: number) => boolean } = {}
): AppBuildMark | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(webDir, APP_BUILD_MARK), 'utf8');
  } catch {
    return undefined;
  }
  const [pid, startedSeconds] = text.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(startedSeconds)) return undefined;
  const since = startedSeconds * 1000;
  const age = (deps.now ?? Date.now)() - since;
  if (age > APP_BUILD_MARK_MAX_MS || age < -MINUTE) return undefined;
  return (deps.alive ?? processAlive)(pid) ? { pid, since } : undefined;
}

/** The bundle identifier of the released app (mac/Untether/version.xcconfig). */
export const UNTETHER_BUNDLE_ID = 'com.nachx639.untether';
/** Where the one Untether macOS should know lives. */
export const INSTALLED_APP_PATHS = ['/Applications/Untether.app'];

/** The paths of the bundles `lsregister -dump` lists under a bundle identifier. */
export function registeredAppPaths(dump: string, identifier: string): string[] {
  const paths = new Set<string>();
  for (const block of dump.split(/^-{20,}$/m)) {
    const id = block.match(/^identifier:\s+(\S+)/m)?.[1];
    if (id !== identifier) continue;
    const found = block.match(/^path:\s+(.+?)(?: \(0x[0-9a-f]+\))?\s*$/m)?.[1];
    if (found) paths.add(found);
  }
  return [...paths];
}

/** A copy that is safe to take out of LaunchServices unasked: a build product or a leftover. */
function disposableApp(appPath: string, exists: (file: string) => boolean): boolean {
  return (
    !exists(appPath) ||
    /\/DerivedData\/|\/mac\/build\/|\/\.build\/|^\/(private\/)?(tmp|var\/folders)\//.test(appPath)
  );
}

/**
 * Untether registered in LaunchServices anywhere but /Applications (2026-11-12: macOS told the
 * user "Untether is damaged and can't be opened" while the installed app was intact. Opened by
 * bundle identifier, it had picked one of the other copies it knew: unsigned build products in
 * mac/build and DerivedData, and the toy bundles of the release tests in the temporary
 * folder). Build products and leftovers nothing runs from are unregistered here; any other
 * copy (one the user keeps somewhere) is only told.
 */
export function registeredAppsCheck(deps: {
  /** Paths registered under Untether's identifier (registeredAppPaths of a dump). */
  registered: () => Promise<string[]>;
  unregister: (appPath: string) => Promise<void>;
  /** Whether a process runs from inside the bundle. */
  runningFrom: (appPath: string) => Promise<boolean>;
  installed?: string[];
  exists?: (file: string) => boolean;
  now?: () => number;
  /** The dump is tens of megabytes: read this often at most. */
  everyMs?: number;
}): DoctorCheck {
  const installed = new Set(deps.installed ?? INSTALLED_APP_PATHS);
  const exists = deps.exists ?? fs.existsSync;
  const now = deps.now ?? Date.now;
  const everyMs = deps.everyMs ?? 30 * MINUTE;
  let lastAt = Number.NEGATIVE_INFINITY;
  let last: DoctorFinding[] = [];
  return {
    id: 'registered-apps',
    async run() {
      if (now() - lastAt < everyMs) return last.filter((finding) => !finding.healed);
      lastAt = now();
      const findings: DoctorFinding[] = [];
      for (const appPath of await deps.registered()) {
        if (installed.has(appPath)) continue;
        const finding: DoctorFinding = {
          key: `registered-apps:${appPath}`,
          check: 'registered-apps',
          severity: 'warning',
          problem: `macOS (LaunchServices) knows another Untether at ${appPath}: it may open that one in place of the installed app ("Untether is damaged and can't be opened")`,
        };
        if (!disposableApp(appPath, exists)) {
          findings.push({
            ...finding,
            problem: `${finding.problem}. It is not a build product: remove it, or unregister it with lsregister -u`,
          });
          continue;
        }
        if (exists(appPath) && (await deps.runningFrom(appPath))) {
          findings.push({
            ...finding,
            problem: `${finding.problem}. Something runs from it: left as it is`,
          });
          continue;
        }
        try {
          await deps.unregister(appPath);
          findings.push({ ...finding, healed: 'unregistered from LaunchServices' });
        } catch (error) {
          findings.push({
            ...finding,
            problem: `${finding.problem}; unregistering it failed: ${error}`,
          });
        }
      }
      last = findings;
      return findings;
    },
  };
}

export const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** The real dependencies of registeredAppsCheck (macOS only: nothing registered elsewhere). */
export function launchServices(): Pick<
  Parameters<typeof registeredAppsCheck>[0],
  'registered' | 'unregister' | 'runningFrom'
> {
  return {
    registered: async () => {
      if (process.platform !== 'darwin' || !fs.existsSync(LSREGISTER)) return [];
      const { stdout } = await execFileAsync(LSREGISTER, ['-dump'], {
        timeout: 2 * MINUTE,
        maxBuffer: 512 * 1024 * 1024,
      });
      return registeredAppPaths(String(stdout), UNTETHER_BUNDLE_ID);
    },
    unregister: async (appPath) => {
      await execFileAsync(LSREGISTER, ['-u', appPath], { timeout: MINUTE });
    },
    runningFrom: async (appPath) => {
      const { stdout } = await execFileAsync('ps', ['-axo', 'comm='], {
        timeout: MINUTE,
        maxBuffer: 16 * 1024 * 1024,
      });
      return String(stdout)
        .split('\n')
        .some((command) => command.trim().startsWith(`${appPath}/`));
    },
  };
}

/** Rebuilds node-pty with the repository's own script (web/scripts/ensure-native-modules.js). */
export function rebuildNativeModules(webDir: string): () => Promise<void> {
  return async () => {
    await execFileAsync(
      process.execPath,
      [path.join(webDir, 'scripts', 'ensure-native-modules.js')],
      {
        cwd: webDir,
        timeout: 5 * MINUTE,
      }
    );
  };
}

/**
 * The installed CLI behind the running server (2026-10-31: the server ran in development from
 * the repo and knew `ut project connector`; the `ut` in PATH ran the app's bundled CLI from
 * 2026-10-24 and an agent got "unknown command"). Each `untether` a shell's `ut` may run (next
 * to the `ut` in PATH, the installed apps') is read from its bytes, never run; one older than
 * the server is a warning when it lacks commands the server knows, else a note in the history.
 * Not healed: rebuilding and reinstalling the app is the user's (signing, a running app). Told
 * once per installed build.
 */
export function cliBuildCheck(deps: {
  server: () => BuildInfo;
  installed: () => Array<{ path: string; via: string }>;
  read: (binary: string) => Promise<BuildInfo | undefined>;
}): DoctorCheck {
  return {
    id: 'cli-build',
    async run() {
      const server = deps.server();
      const findings: DoctorFinding[] = [];
      for (const { path: binary, via } of deps.installed()) {
        const cli = await deps.read(binary);
        if (!cli || !isOlderBuild(cli, server)) continue;
        const missing = missingCommands(cli, server);
        const alternative = server.cli
          ? `; until then agents can run the server's own CLI: ${server.cli} task|project …`
          : '';
        findings.push({
          key: `cli-build:${binary}:${cli.commit}`,
          check: 'cli-build',
          severity: missing.length ? 'warning' : 'info',
          problem: `${via}, ${binary}, is ${describeBuild(cli)}, older than the running server (${describeBuild(server)})${missing.length ? ` and does not know: ${missing.join(', ')}` : ''}. Not a code bug: rebuild and reinstall the Untether app${server.dev ? ' from the checkout the server runs from' : ''}${alternative}`,
        });
      }
      return findings;
    },
  };
}

/** The newest file of a ut-fwd source tree (src/**, Cargo.toml, Cargo.lock), or none. */
export function newestForwarderSource(
  sourceDir: string
): { file: string; mtimeMs: number } | undefined {
  let newest: { file: string; mtimeMs: number } | undefined;
  const consider = (file: string) => {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) {
        newest = { file, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Gone or unreadable: not a source.
    }
  };
  consider(path.join(sourceDir, 'Cargo.toml'));
  consider(path.join(sourceDir, 'Cargo.lock'));
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) consider(full);
    }
  };
  walk(path.join(sourceDir, 'src'));
  return newest;
}

/** Whether cargo or rustup is where build-fwd-rust.js looks for it (PATH, CARGO_HOME, ~/.cargo). */
export function rustToolchainFound(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...(env.CARGO_HOME ? [path.join(env.CARGO_HOME, 'bin')] : []),
    ...(env.HOME ? [path.join(env.HOME, '.cargo', 'bin')] : []),
  ];
  return dirs.some((dir) =>
    ['cargo', 'rustup'].some((name) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  );
}

/**
 * The hash of a ut-fwd source tree (src/**, Cargo.toml, Cargo.lock): sha256 over each file's
 * path (relative, `/`-separated) and contents, in path order. The same as
 * web/scripts/fwd-source-hash.js, which build-fwd-rust.js uses to write `<binary>.source-hash`
 * next to each forwarder it builds (a test keeps both in step).
 */
export function forwarderSourceHash(sourceDir: string): string {
  const files: string[] = [];
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    try {
      if (fs.statSync(path.join(sourceDir, name)).isFile()) files.push(name);
    } catch {
      // Not there: not part of the hash.
    }
  }
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(sourceDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk('src');
  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    const body = fs.readFileSync(path.join(sourceDir, ...rel.split('/')));
    hash.update(`${rel}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest('hex');
}

/** The source hash recorded next to a forwarder binary by the build that wrote it, if any. */
export function readForwarderSourceHash(binary: string): string | undefined {
  try {
    return fs.readFileSync(`${binary}.source-hash`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeForwarderSourceHash(binary: string, sourceHash: string): void {
  const file = `${binary}.source-hash`;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${sourceHash}\n`);
  fs.renameSync(temp, file);
}

function sameFileBytes(a: string, b: string): boolean {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * The forwarder the server runs against its Rust sources (2026-11-02: the server started passing
 * `--compact-cast-until` before web/native/untether-fwd was rebuilt from native/ut-fwd, and
 * recordings stopped being compacted until someone rebuilt it by hand). The binary the server
 * would use (the first candidate that exists, in the server's own order) is judged by the source
 * hash its build recorded next to it (`<binary>.source-hash`, build-fwd-rust.js): a different
 * hash is a warning with the rebuild command. Without a hash yet, mtimes decide (older than the
 * newest of src/**, Cargo.toml, Cargo.lock); a checkout or merge that only touched mtimes is not
 * a change once a hash exists. No source tree (a packaged app): nothing to compare, no finding.
 *
 * Healed when the binary is one the build writes (`rebuildTarget` or later in the candidates: the
 * env override or a bundled copy is not ours) and cargo is found. The release build takes minutes,
 * so it runs in the background (follow-up of 1d1080fa: other checks of the run waited on it): the
 * run that starts it reports "rebuilding" (info), the next run reports the result (healed, or the
 * failure as a warning). One rebuild at a time, across server processes too (a lock file next to
 * the target with the builder's pid; a dead builder's lock and temporaries are cleared). Built
 * aside and renamed over the target, so a forwarder running from the old file keeps its inode;
 * the hash goes next to it. A failed rebuild is not retried until the sources change.
 *
 * `mirrors` are the other copies the build writes (web/bin/untether-fwd, which `ut`'s forwarder
 * lookup prefers): kept byte-equal to the target, with its hash, after a rebuild and whenever the
 * target is current and a mirror differs.
 */
export function forwarderBuildCheck(deps: {
  /** The server's forwarder candidates, in the order it tries them. */
  forwarders: () => string[];
  /** Where a ut-fwd source tree may be; the first with a Cargo.toml counts. */
  sourceDirs: () => string[];
  /** The command to give the user. */
  rebuildCommand: string;
  /** The binary a rebuild replaces; heals only when it is the one used or comes before it. */
  rebuildTarget?: string;
  /** Other copies of rebuildTarget the build writes, kept in sync with it. */
  mirrors?: string[];
  /** Builds to `output` (a temporary path next to rebuildTarget); unset or false: no heal. */
  rebuild?: (output: string) => Promise<void>;
  canRebuild?: () => boolean;
  newestSource?: typeof newestForwarderSource;
  sourceHash?: (sourceDir: string) => string;
  mtimeMs?: (file: string) => number | undefined;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
}): DoctorCheck {
  const newestSource = deps.newestSource ?? newestForwarderSource;
  const sourceHash = deps.sourceHash ?? forwarderSourceHash;
  const pidAlive = deps.pidAlive ?? processAlive;
  const now = deps.now ?? Date.now;
  const mtimeMs =
    deps.mtimeMs ??
    ((file: string) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return undefined;
      }
    });
  /** The source hash a rebuild already failed on, and why. */
  let failed: { hash: string; reason: string } | undefined;
  /** The rebuild running in the background, and how it ended once it has. */
  let job:
    | {
        key: string;
        problem: string;
        hash: string;
        startedAt: number;
        sourceDir: string;
        outcome?: { ok: true; at: number } | { ok: false; reason: string };
      }
    | undefined;

  /** Why `binary` does not match the sources, or undefined when it does. */
  const staleness = (binary: string, sourceDir: string, hash: string): string | undefined => {
    const recorded = readForwarderSourceHash(binary);
    if (recorded !== undefined) {
      return recorded === hash
        ? undefined
        : `built from other sources (recorded source hash ${recorded.slice(0, 12)}, the sources now hash to ${hash.slice(0, 12)})`;
    }
    const built = mtimeMs(binary);
    if (built === undefined) return undefined;
    const newest = newestSource(sourceDir);
    if (!newest || newest.mtimeMs <= built) return undefined;
    return `older than its sources (${newest.file} changed ${new Date(newest.mtimeMs).toISOString()}, the binary was built ${new Date(built).toISOString()}, no source hash recorded yet)`;
  };

  /** Copies the target over each mirror that differs from it; the mirrors copied. */
  const syncMirrors = (target: string): string[] => {
    const targetHash = readForwarderSourceHash(target);
    const synced: string[] = [];
    for (const mirror of deps.mirrors ?? []) {
      if (mirror === target || !fs.existsSync(path.dirname(mirror))) continue;
      const mirrorHash = readForwarderSourceHash(mirror);
      const same =
        fs.existsSync(mirror) &&
        ((targetHash !== undefined && mirrorHash === targetHash) || sameFileBytes(mirror, target));
      if (!same) {
        const temp = path.join(
          path.dirname(mirror),
          `.${path.basename(mirror)}.${process.pid}.tmp`
        );
        try {
          fs.copyFileSync(target, temp);
          fs.chmodSync(temp, 0o755);
          fs.renameSync(temp, mirror);
        } catch (error) {
          fs.rmSync(temp, { force: true });
          throw error;
        }
        synced.push(mirror);
      }
      if (targetHash !== undefined && mirrorHash !== targetHash) {
        writeForwarderSourceHash(mirror, targetHash);
      }
    }
    return synced;
  };

  /*
   * The rebuild lock, across processes (AI review 2026-11-02, twice: one shared lock file that a
   * cleaner removes when its holder died can always race with a process that took it meanwhile:
   * the cleaner removes or moves a live lock). Here no process ever removes a lock another live
   * process may own: each contender creates a claim of its own, `.<binary>.rebuild.<pid>.<token>`
   * (only it creates that name, only it removes it), then lists the claims. If any other live claim
   * is there, it withdraws its own and that one builds. Of two contenders, the later lister always
   * sees the earlier claim, so at most one builds; both may withdraw, and the next pass retries.
   * A dead process's claim is removed safely: nobody can ever create that exact name again.
   */
  const claimPattern = (target: string) =>
    new RegExp(
      `^\\.${path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.rebuild\\.(\\d+)\\.[0-9a-f]+$`
    );
  /** Live processes' claims other than `mine`; dead ones are removed on the way. */
  const otherClaims = (target: string, mine?: string): number[] => {
    const pattern = claimPattern(target);
    let names: string[];
    try {
      names = fs.readdirSync(path.dirname(target));
    } catch {
      return [];
    }
    const live: number[] = [];
    for (const name of names) {
      if (name === mine) continue;
      const pid = Number(pattern.exec(name)?.[1]);
      if (!pid) continue;
      if (pid === process.pid || pidAlive(pid)) live.push(pid);
      else fs.rmSync(path.join(path.dirname(target), name), { force: true });
    }
    return live;
  };
  /** This process's claim when it is the only live one, else undefined (and none left behind). */
  const claim = (target: string): string | undefined => {
    const name = `.${path.basename(target)}.rebuild.${process.pid}.${randomBytes(6).toString('hex')}`;
    const file = path.join(path.dirname(target), name);
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    } catch {
      return undefined;
    }
    if (otherClaims(target, name).length) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    return file;
  };
  /** Temporaries a dead builder left next to the target (`.untether-fwd.<pid>.tmp`). */
  const clearDeadTemporaries = (target: string) => {
    const pattern = new RegExp(
      `^\\.${path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.tmp$`
    );
    let names: string[];
    try {
      names = fs.readdirSync(path.dirname(target));
    } catch {
      return;
    }
    for (const name of names) {
      const pid = Number(pattern.exec(name)?.[1]);
      if (pid && pid !== process.pid && !pidAlive(pid)) {
        fs.rmSync(path.join(path.dirname(target), name), { force: true });
      }
    }
  };

  const rebuilding = (target: string, problem: string, since: number, by?: number) => ({
    key: `forwarder-build-rebuilding:${target}`,
    check: 'forwarder-build',
    severity: 'info' as const,
    problem: `${problem}; rebuilding ${target} in the background${by ? ` (by process ${by})` : ''} since ${new Date(since).toISOString()}, the next doctor run tells the result`,
  });

  return {
    id: 'forwarder-build',
    async run() {
      const target = deps.rebuildTarget;
      if (job?.outcome) {
        const ended = job;
        const outcome = ended.outcome as NonNullable<typeof ended.outcome>;
        job = undefined;
        if (outcome.ok) {
          failed = undefined;
          return [
            {
              key: ended.key,
              check: 'forwarder-build',
              severity: 'warning',
              problem: ended.problem,
              healed: `rebuilt ${target} from ${ended.sourceDir} in the background (${Math.round((outcome.at - ended.startedAt) / 1000)} s)`,
            },
          ];
        }
        failed = { hash: ended.hash, reason: outcome.reason };
      }
      if (job && target) return [rebuilding(target, job.problem, job.startedAt)];

      const sourceDir = deps
        .sourceDirs()
        .find((dir) => mtimeMs(path.join(dir, 'Cargo.toml')) !== undefined);
      if (!sourceDir) return [];
      const candidates = deps.forwarders();
      const index = candidates.findIndex((candidate) => mtimeMs(candidate) !== undefined);
      if (index < 0) return [];
      const binary = candidates[index];
      const hash = sourceHash(sourceDir);
      const stale = staleness(binary, sourceDir, hash);
      if (!stale) {
        failed = undefined;
        if (!target || mtimeMs(target) === undefined || staleness(target, sourceDir, hash)) {
          return [];
        }
        return syncMirrors(target).map((mirror) => ({
          key: `forwarder-build-copy:${mirror}`,
          check: 'forwarder-build',
          severity: 'warning' as const,
          problem: `${mirror} differed from ${target}, the forwarder the build keeps it equal to`,
          healed: `copied ${target} over it`,
        }));
      }
      const problem = `the forwarder the server runs, ${binary}, is ${stale}: flags the server passes may be unknown to it (recordings, sessions). Rebuild it: ${deps.rebuildCommand}`;
      const finding: DoctorFinding = {
        key: `forwarder-build:${binary}`,
        check: 'forwarder-build',
        severity: 'warning',
        problem,
      };
      const targetIndex = target ? candidates.indexOf(target) : -1;
      const ours = targetIndex >= 0 && targetIndex <= index;
      if (!target || !ours || !deps.rebuild || !(deps.canRebuild?.() ?? true)) return [finding];
      if (failed?.hash === hash) {
        return [
          { ...finding, problem: `${problem} (the automatic rebuild failed: ${failed.reason})` },
        ];
      }
      const [holder] = otherClaims(target);
      if (holder) return [rebuilding(target, problem, now(), holder)];
      const lock = claim(target);
      if (!lock) {
        // Another process claimed it at the same time: it builds, or the next pass does.
        return [rebuilding(target, problem, now(), otherClaims(target)[0])];
      }
      clearDeadTemporaries(target);
      const output = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.tmp`
      );
      const started = {
        key: finding.key,
        problem,
        hash,
        startedAt: now(),
        sourceDir,
      } as NonNullable<typeof job>;
      job = started;
      const rebuild = deps.rebuild;
      void (async () => {
        try {
          await rebuild(output);
          fs.renameSync(output, target);
          writeForwarderSourceHash(target, hash);
          syncMirrors(target);
          started.outcome = { ok: true, at: now() };
        } catch (error) {
          const { stderr, message } = error as { stderr?: string; message?: string };
          const reason =
            String(stderr ?? '')
              .trim()
              .split('\n')
              .slice(-3)
              .join(' ') || String(message ?? error).split('\n')[0];
          fs.rmSync(output, { force: true });
          started.outcome = { ok: false, reason };
        } finally {
          fs.rmSync(lock, { force: true });
        }
      })();
      return [rebuilding(target, problem, started.startedAt)];
    },
  };
}

/** Reads each binary once per change (path, size, mtime): an app binary is ~80 MB. */
export function cachedBinaryBuild(
  read: (binary: string) => Promise<BuildInfo | undefined>,
  stat: (binary: string) => { size: number; mtimeMs: number } | undefined = (binary) => {
    try {
      return fs.statSync(binary);
    } catch {
      return undefined;
    }
  }
): (binary: string) => Promise<BuildInfo | undefined> {
  const cache = new Map<string, { stamp: string; build: BuildInfo | undefined }>();
  return async (binary) => {
    const info = stat(binary);
    if (!info) return undefined;
    const stamp = `${info.size}:${info.mtimeMs}`;
    const hit = cache.get(binary);
    if (hit?.stamp === stamp) return hit.build;
    const build = await read(binary);
    cache.set(binary, { stamp, build });
    return build;
  };
}
