/**
 * Keeps file routes from hanging on folders macOS privacy (TCC) hasn't cleared yet.
 *
 * User report (2026-10-14): after a fresh install of the Mac app, listing Downloads and the new
 * "search the Mac" never answered (the request hung until the client gave up) while health,
 * sessions and path completions were instant. The server runs as a child of Untether.app, so
 * macOS treats it as a new app: reading Desktop, Documents, Downloads, iCloud Drive or a
 * removable/network volume waits on a privacy prompt that nobody may be there to answer.
 *
 * Two layers:
 *  - Protected folders are probed once in a child process (killed after the deadline) before
 *    the server itself touches them, so a stuck read never ties up the server's own fs threads.
 *    The verdict is cached; a blocked folder answers at once and is re-probed in the
 *    background at most once at a time.
 *  - Every guarded call also races a timer, so anything else that stalls answers with a
 *    structured error instead of hanging.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

export type FolderAccessErrorKind = 'permission-pending' | 'permission-denied';
export type ProbeVerdict = 'ok' | FolderAccessErrorKind;

/** Stable key the client translates ('downloads' -> «Descargas»); 'other' uses `folder`. */
export type FolderPlace = 'downloads' | 'desktop' | 'documents' | 'icloud' | 'volume' | 'other';

export interface BlockedFolder {
  error: FolderAccessErrorKind;
  /** Display name of the folder (no path, no file names). */
  folder: string;
  place: FolderPlace;
}

export class FolderAccessError extends Error {
  readonly kind: FolderAccessErrorKind;
  readonly folder: string;
  readonly place: FolderPlace;
  constructor(blocked: BlockedFolder) {
    super(`${blocked.error}: ${blocked.folder}`);
    this.name = 'FolderAccessError';
    this.kind = blocked.error;
    this.folder = blocked.folder;
    this.place = blocked.place;
  }
  toJSON(): BlockedFolder {
    return { error: this.kind, folder: this.folder, place: this.place };
  }
}

export const FOLDER_ACCESS_TIMEOUT_MS = 4000;
const BLOCKED_TTL_MS = 15_000;
const OK_TTL_MS = 10 * 60_000;

interface ProtectedRoot {
  root: string;
  folder: string;
  place: FolderPlace;
}

interface RootState {
  verdict: ProbeVerdict;
  at: number;
}

export interface FolderAccessGuardOptions {
  home?: string;
  /** Run the protected-folder probe (macOS only by default). */
  protectFolders?: boolean;
  timeoutMs?: number;
  blockedTtlMs?: number;
  okTtlMs?: number;
  /** Checks that `dir` can be listed; tests swap in a fake. */
  probe?: (dir: string, timeoutMs: number) => Promise<ProbeVerdict>;
  /** One line per folder whose state changes (no file names). */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Lists `dir` in a separate process; a stuck read is killed with it (SIGKILL at the deadline).
 *
 * Verifier fix (2026-10-14): the first version ran `process.execPath -e <script>`. In the Mac
 * app's Release build the server is a single executable (node SEA), whose execPath is the
 * untether binary itself and which ignores node flags: every probe would have started a whole
 * second server instead of reading the folder. On macOS the probe now runs /bin/ls (macOS
 * privacy charges a child to the same app, so it sees the same prompt); node -e is only used
 * where execPath really is node.
 */
export function probeInChildProcess(dir: string, timeoutMs: number): Promise<ProbeVerdict> {
  const useLs = process.platform === 'darwin' || !/^node$/i.test(path.basename(process.execPath));
  if (useLs && process.platform !== 'darwin' && !existsSync('/bin/ls')) {
    return Promise.resolve('ok');
  }
  const command = useLs ? '/bin/ls' : process.execPath;
  const args = useLs
    ? ['-f', '-1', dir]
    : [
        '-e',
        "const fs=require('fs');try{const d=fs.opendirSync(process.argv[1]);d.readSync();d.closeSync();}" +
          'catch(e){process.stderr.write(String(e&&e.code));process.exit(1)}',
        dir,
      ];
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (verdict: ProbeVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(verdict);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
    } catch {
      // Couldn't tell: let the real call decide, under its timer.
      resolve('ok');
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('permission-pending');
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString();
    });
    child.on('error', () => finish('ok'));
    child.on('close', (code) => {
      if (code === 0) return finish('ok');
      if (/Operation not permitted|Permission denied|EPERM|EACCES/i.test(stderr)) {
        return finish('permission-denied');
      }
      // Missing folder or an odd error: let the real call decide, under its timer.
      finish('ok');
    });
  });
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

export class FolderAccessGuard {
  private readonly home: string;
  private readonly roots: ProtectedRoot[];
  private readonly timeoutMs: number;
  private readonly blockedTtlMs: number;
  private readonly okTtlMs: number;
  private readonly probe: (dir: string, timeoutMs: number) => Promise<ProbeVerdict>;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly states = new Map<string, RootState>();
  private readonly probing = new Map<string, Promise<ProbeVerdict>>();
  /** Folders (outside the protected list) whose call timed out, with when. */
  private readonly stalled = new Map<string, number>();

  constructor(options: FolderAccessGuardOptions = {}) {
    this.home = path.resolve(options.home ?? os.homedir());
    this.timeoutMs = options.timeoutMs ?? FOLDER_ACCESS_TIMEOUT_MS;
    this.blockedTtlMs = options.blockedTtlMs ?? BLOCKED_TTL_MS;
    this.okTtlMs = options.okTtlMs ?? OK_TTL_MS;
    this.probe = options.probe ?? probeInChildProcess;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    const protect = options.protectFolders ?? process.platform === 'darwin';
    this.roots = protect
      ? [
          { root: path.join(this.home, 'Downloads'), folder: 'Downloads', place: 'downloads' },
          { root: path.join(this.home, 'Desktop'), folder: 'Desktop', place: 'desktop' },
          { root: path.join(this.home, 'Documents'), folder: 'Documents', place: 'documents' },
          {
            root: path.join(this.home, 'Library', 'Mobile Documents'),
            folder: 'iCloud Drive',
            place: 'icloud',
          },
        ]
      : [];
  }

  get deadlineMs(): number {
    return this.timeoutMs;
  }

  /** The protected folder `target` is in (or is), or null. */
  protectedRootOf(target: string): ProtectedRoot | null {
    const abs = path.resolve(target);
    for (const root of this.roots) {
      if (abs === root.root || abs.startsWith(root.root + path.sep)) return root;
    }
    if (this.roots.length > 0 && abs.startsWith('/Volumes/')) {
      const name = abs.split('/')[2];
      if (name) return { root: `/Volumes/${name}`, folder: name, place: 'volume' };
    }
    return null;
  }

  /** Protected folders strictly inside `dir` (worth probing before walking `dir`). */
  protectedRootsUnder(dir: string): ProtectedRoot[] {
    const abs = path.resolve(dir);
    return this.roots.filter((root) => root.root.startsWith(abs + path.sep));
  }

  /** Cached verdict for the protected folder of `target`, without waiting. */
  peek(target: string): ProbeVerdict | 'unknown' | 'unprotected' {
    const root = this.protectedRootOf(target);
    if (!root) return 'unprotected';
    const state = this.freshState(root);
    if (!state) {
      void this.probeRoot(root);
      return 'unknown';
    }
    if (state.verdict !== 'ok') void this.reprobeLater(root);
    return state.verdict;
  }

  /** The blocked description of `target`'s folder if it can't be read now; null when fine. */
  async check(target: string): Promise<BlockedFolder | null> {
    const root = this.protectedRootOf(target);
    if (!root) {
      const stalledFolder = this.stalledFolderOf(target);
      return stalledFolder
        ? { error: 'permission-pending', folder: stalledFolder, place: 'other' }
        : null;
    }
    const state = this.freshState(root);
    let verdict: ProbeVerdict;
    if (state) {
      verdict = state.verdict;
      if (verdict !== 'ok') void this.reprobeLater(root);
    } else {
      verdict = await this.probeRoot(root);
    }
    return verdict === 'ok' ? null : { error: verdict, folder: root.folder, place: root.place };
  }

  /**
   * Runs `fn` (an fs call on `target`) once the folder is cleared, with a hard deadline.
   * Throws FolderAccessError when the folder is blocked, the call stalls, or fails EPERM/EACCES.
   */
  async run<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const blocked = await this.check(target);
    if (blocked) throw new FolderAccessError(blocked);
    return this.withDeadline(target, fn);
  }

  /**
   * Only the deadline and the EPERM/EACCES mapping, without probing first: for calls that
   * don't read inside a protected folder (stat of the folder itself while listing its parent).
   */
  async withDeadline<T>(target: string, fn: () => Promise<T>): Promise<T> {
    // Verifier fix (2026-10-14): something that already stalled answers at once instead of
    // making every listing of its parent wait the full deadline again (and pile up one more
    // stuck call each time).
    const stalledFolder = this.stalledFolderOf(target);
    if (stalledFolder) {
      const root = this.protectedRootOf(target);
      throw new FolderAccessError(
        root
          ? { error: 'permission-pending', folder: root.folder, place: root.place }
          : { error: 'permission-pending', folder: stalledFolder, place: 'other' }
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new FolderAccessError(this.markStalled(target)));
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([fn(), timeout]);
    } catch (error) {
      if (error instanceof FolderAccessError) throw error;
      if (isPermissionError(error)) {
        throw new FolderAccessError(
          this.markDenied(target, (error as NodeJS.ErrnoException).code === 'EPERM')
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probes the protected folders at or under `dir`, waiting at most `maxWaitMs` for answers
   * (a probe still running keeps going in the background and its folder counts as blocked).
   */
  async settleUnder(dir: string, maxWaitMs: number): Promise<void> {
    const roots = [...this.protectedRootsUnder(dir)];
    const own = this.protectedRootOf(dir);
    if (own) roots.push(own);
    const pending: Promise<unknown>[] = [];
    for (const root of roots) {
      const state = this.freshState(root);
      if (state) {
        if (state.verdict !== 'ok') this.reprobeLater(root);
        continue;
      }
      pending.push(this.probeRoot(root));
    }
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, maxWaitMs));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  /** True when `target` can be read in-process right now (known-good or unprotected). */
  isReadable(target: string): boolean {
    const root = this.protectedRootOf(target);
    if (!root) return this.stalledFolderOf(target) === null;
    return this.freshState(root)?.verdict === 'ok';
  }

  /** The blocked description for `target` without waiting ('permission-pending' if unknown). */
  describeBlocked(target: string): BlockedFolder | null {
    const root = this.protectedRootOf(target);
    if (!root) {
      const folder = this.stalledFolderOf(target);
      return folder ? { error: 'permission-pending', folder, place: 'other' } : null;
    }
    const verdict = this.freshState(root)?.verdict;
    if (verdict === 'ok') return null;
    return { error: verdict ?? 'permission-pending', folder: root.folder, place: root.place };
  }

  private freshState(root: ProtectedRoot): RootState | null {
    const state = this.states.get(root.root);
    if (!state) return null;
    const ttl = state.verdict === 'ok' ? this.okTtlMs : this.blockedTtlMs;
    // A blocked verdict stays until a probe says otherwise; it is only re-probed after the TTL.
    if (state.verdict === 'ok' && this.now() - state.at > ttl) return null;
    return state;
  }

  private reprobeLater(root: ProtectedRoot): void {
    const state = this.states.get(root.root);
    if (!state || this.now() - state.at < this.blockedTtlMs) return;
    void this.probeRoot(root);
  }

  private probeRoot(root: ProtectedRoot): Promise<ProbeVerdict> {
    const inFlight = this.probing.get(root.root);
    if (inFlight) return inFlight;
    const raw = this.probe(root.root, this.timeoutMs).catch((): ProbeVerdict => 'ok');
    // Verifier fix (2026-10-14): a probe whose child can't even be killed must not keep the
    // request waiting forever; answer pending after the deadline, and keep the probe "in
    // flight" (no second child) until it really ends.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<ProbeVerdict>((resolve) => {
      timer = setTimeout(() => resolve('permission-pending'), this.timeoutMs + 1000);
      timer.unref?.();
    });
    const answer = Promise.race([raw, backstop]).then((verdict) => {
      clearTimeout(timer);
      this.setVerdict(root, verdict);
      return verdict;
    });
    void raw.then((verdict) => {
      if (this.probing.get(root.root) !== answer) return;
      this.probing.delete(root.root);
      this.setVerdict(root, verdict);
    });
    this.probing.set(root.root, answer);
    return answer;
  }

  private setVerdict(root: ProtectedRoot, verdict: ProbeVerdict): void {
    const previous = this.states.get(root.root)?.verdict;
    this.states.set(root.root, { verdict, at: this.now() });
    if (previous === verdict) return;
    if (verdict === 'permission-pending') {
      this.log(
        `macOS privacy: reading ${root.folder} is waiting for a permission prompt; ` +
          'requests answer permission-pending until it is allowed'
      );
    } else if (verdict === 'permission-denied') {
      this.log(
        `macOS privacy: reading ${root.folder} is not allowed (Full Disk Access / Files and Folders)`
      );
    } else if (previous) {
      this.log(`macOS privacy: ${root.folder} can be read again`);
    }
  }

  /**
   * Verifier fix (2026-10-14): only EPERM (what macOS privacy answers) marks the whole protected
   * folder denied; an ordinary EACCES on one item inside Downloads (a root-owned file) must not
   * lock every request out of Downloads.
   */
  private markDenied(target: string, wholeFolder: boolean): BlockedFolder {
    const root = this.protectedRootOf(target);
    if (root && wholeFolder) {
      this.setVerdict(root, 'permission-denied');
      return { error: 'permission-denied', folder: root.folder, place: root.place };
    }
    return { error: 'permission-denied', folder: this.displayName(target), place: 'other' };
  }

  private markStalled(target: string): BlockedFolder {
    const root = this.protectedRootOf(target);
    if (root) {
      this.setVerdict(root, 'permission-pending');
      // The folder itself stalling (a stat, not a read inside it) is not a privacy prompt
      // the root probe would see: remember the item too, so withDeadline answers at once.
      if (path.resolve(target) === root.root) this.stalled.set(root.root, this.now());
      return { error: 'permission-pending', folder: root.folder, place: root.place };
    }
    const dir = path.resolve(target);
    const folder = this.displayName(dir);
    if (!this.stalledFolderOf(dir)) {
      this.log(`file access: reading ${folder} did not answer in ${this.timeoutMs} ms`);
    }
    this.stalled.set(dir, this.now());
    return { error: 'permission-pending', folder, place: 'other' };
  }

  /**
   * A folder (or a parent of `target`) that stalled, by display name.
   *
   * Verifier fix (2026-10-14): the entry used to simply expire after the TTL, so the next request
   * ran the same in-process call again; each stuck call keeps one of libuv's 4 fs threads, and a
   * few rounds froze every file read of the server. Now, after the TTL, the folder is re-checked
   * in a child process (one at a time) and only cleared when that answers.
   */
  private stalledFolderOf(target: string): string | null {
    const abs = path.resolve(target);
    for (const [dir, at] of this.stalled) {
      if (abs !== dir && !abs.startsWith(dir + path.sep)) continue;
      if (this.now() - at > this.blockedTtlMs) this.reprobeStalled(dir);
      return this.stalled.has(dir) ? this.displayName(dir) : null;
    }
    return null;
  }

  private reprobeStalled(dir: string): void {
    if (this.probing.has(dir)) return;
    const raw = this.probe(dir, this.timeoutMs).catch((): ProbeVerdict => 'ok');
    const marker = raw.then((verdict) => verdict);
    this.probing.set(dir, marker);
    void raw.then((verdict) => {
      this.probing.delete(dir);
      if (verdict === 'ok') {
        this.stalled.delete(dir);
        // A protected folder already logs its own recovery.
        if (!this.protectedRootOf(dir))
          this.log(`file access: ${this.displayName(dir)} answers again`);
      } else {
        this.stalled.set(dir, this.now());
      }
    });
  }

  private displayName(target: string): string {
    const abs = path.resolve(target);
    if (abs === this.home) return '~';
    return path.basename(abs) || abs;
  }
}
