/**
 * The stable tmux copy (2026-10-31, opt-in, macOS).
 *
 * Symptom: macOS holds the shield tmux server (its own launchd job, so its own responsible
 * process) responsible for every access a shielded session makes to protected folders, so the
 * user gave tmux Full Disk Access. Homebrew's tmux is signed ad hoc (Identifier=tmux-<hash>,
 * no Team), so every `brew upgrade tmux` gives it a new identity and macOS forgets the
 * permission; the server ran /opt/homebrew/bin/tmux, a link to the Cellar version.
 *
 * With a signing identity of the user's chosen in Settings (none by default: the installed
 * tmux, as before), Untether keeps its own copy of the installed tmux, ~/.untether/bin/tmux,
 * signed with that identity and a fixed identifier (dev.untether.tmux), so its designated
 * requirement (identifier + certificate) stays the same across tmux versions and the
 * permission stays. Every Untether tmux call runs the copy (findTmuxBinary). When the
 * installed tmux changes, the doctor renews the copy with the same signature:
 *
 * - The copy in use is never written over: a new file is written, signed, checked and renamed
 *   onto it. Running tmux servers keep the binary they loaded (the old inode).
 * - A new tmux whose client can't talk to the running shield server (a protocol change) is
 *   not switched to while that server runs; the copy stays on the old version until then.
 * - A signing failure (identity gone, keychain locked, the user's "Deny") is not retried until
 *   the installed tmux or the identity changes, or the setting is saved again: never a prompt
 *   in a loop.
 * - Leftovers (2026-10-31, the user: no rubbish from the move): a renewal's temporary file or
 *   a record's .tmp left by a server that died mid-way (tsx watch restarts it) is removed on
 *   the next refresh; the folder only ever holds `tmux` and `tmux.json`, whose fields are
 *   fixed (it never grows). macOS keeps the old tmux in Full Disk Access, which Untether can't
 *   remove: once no Untether tmux server runs anything but the copy, the user is told once
 *   (`leftover`, stableTmuxCheck) that they can remove it, never again.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('stable-tmux');

/** The fixed code signing identifier of the copy: its permission follows it across versions. */
export const STABLE_TMUX_IDENTIFIER = 'dev.untether.tmux';

/** A signing identity: a certificate's SHA-1 (what Settings saves) or its name. */
export function isValidSigningIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: an identity never has them
    !/[\x00-\x1f\x7f]/.test(value) &&
    !value.startsWith('-')
  );
}

export function stableTmuxDir(home: string = os.homedir()): string {
  return path.join(home, '.untether', 'bin');
}

export type Exec = (
  file: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const realExec: Exec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options?.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

interface CopyRecord {
  /** The installed tmux it was copied from (resolved) and that file's sha256. */
  sourcePath: string;
  sourceSha256: string;
  version: string;
  identity: string;
  /** Designated requirement after signing: what macOS remembers the permission by. */
  requirement: string;
  team?: string;
  signedAt: string;
}

interface StableTmuxRecord {
  copy?: CopyRecord;
  /** The last signing that failed: not tried again for the same tmux and identity. */
  failed?: { sourceSha256: string; identity: string; at: string; error: string };
  /** A newer tmux waiting for the running shield server to end (protocol). */
  deferred?: { sourceSha256: string; version: string; at: string };
  /**
   * The tmux Untether ran before the copy (2026-10-31): its Full Disk Access entry stays in
   * System Settings. `toldAt`: the user was told they can remove it; never told again.
   */
  leftover?: { binary: string; since: string; toldAt?: string };
}

/** A renewal's temporary copy and a record's temporary file, with the pid that wrote them. */
const TEMPORARY = /^(?:\.tmux\.new-(\d+)-[0-9a-f]+|tmux\.json\.(\d+)\.tmp)$/;
/** Older than this, a temporary file is left over whoever wrote it (signing times out at 2 min). */
const TEMPORARY_STALE_MS = 10 * 60 * 1000;

export type StableTmuxStatus =
  | { state: 'off' }
  | { state: 'no-source' }
  | { state: 'current'; bin: string; version: string }
  | { state: 'renewed'; bin: string; version: string; from?: string; reason: string }
  | { state: 'deferred'; bin: string | null; version: string; running?: string }
  | { state: 'failed'; bin: string | null; error: string; identity: string };

export interface StableTmuxDeps {
  /** Folder of the copy (~/.untether/bin). */
  dir: string;
  /** The identity chosen in Settings, or undefined (off). */
  identity: () => string | undefined;
  /** The installed tmux (findInstalledTmux). */
  source: () => string | null;
  /** Use this binary for every tmux call (null: the installed one). */
  activate: (bin: string | null) => void;
  /**
   * Whether the running shield tmux server answers a client of this binary (null: none runs).
   * Missing: no check.
   */
  serverAnswers?: (bin: string) => Promise<boolean | null>;
  exec?: Exec;
  now?: () => number;
}

export class StableTmux {
  private readonly exec: Exec;
  private readonly now: () => number;
  private refreshing?: Promise<StableTmuxStatus>;
  private last?: StableTmuxStatus;

  constructor(private readonly deps: StableTmuxDeps) {
    this.exec = deps.exec ?? realExec;
    this.now = deps.now ?? Date.now;
  }

  get bin(): string {
    return path.join(this.deps.dir, 'tmux');
  }

  private get recordPath(): string {
    return path.join(this.deps.dir, 'tmux.json');
  }

  get lastStatus(): StableTmuxStatus | undefined {
    return this.last;
  }

  /**
   * At server start, before anything runs tmux: use the copy when it was signed for the
   * identity in Settings (refresh() then checks it fully).
   */
  activateIfReady(): void {
    const identity = this.deps.identity();
    const copy = this.readRecord().copy;
    const ready = !!identity && copy?.identity === identity && isFile(this.bin);
    this.deps.activate(ready ? this.bin : null);
  }

  /** Forget a failed signing (the user saved the setting again: try once more). */
  clearFailure(): void {
    const record = this.readRecord();
    if (!record.failed) return;
    delete record.failed;
    this.writeRecord(record);
  }

  /**
   * An Untether tmux server runs `binary`, not the copy: the tmux whose Full Disk Access entry
   * is left over once it ends. Nothing once the user was told (never twice).
   */
  noteOldTmux(binary: string): void {
    const record = this.readRecord();
    if (record.leftover?.toldAt || record.leftover?.binary === binary) return;
    record.leftover = { binary, since: this.stamp() };
    this.writeRecord(record);
  }

  /** The old tmux the user still has to hear about (null: none, or told already). */
  oldTmuxToTell(): string | null {
    const leftover = this.readRecord().leftover;
    return leftover && !leftover.toldAt ? leftover.binary : null;
  }

  markOldTmuxTold(): void {
    const record = this.readRecord();
    if (!record.leftover || record.leftover.toldAt) return;
    record.leftover.toldAt = this.stamp();
    this.writeRecord(record);
  }

  /** Check the copy against the installed tmux and the setting; renew it when needed. */
  refresh(): Promise<StableTmuxStatus> {
    this.refreshing ??= this.doRefresh()
      .then((status) => {
        this.last = status;
        return status;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StableTmuxStatus> {
    this.removeLeftoverTemporaries();
    const identity = this.deps.identity();
    if (!identity) {
      this.deps.activate(null);
      return { state: 'off' };
    }
    const source = this.deps.source();
    const sourcePath = source ? realpathOrNull(source) : null;
    if (!sourcePath) {
      // Without the installed tmux its libraries may be gone too: the copy isn't trusted.
      this.deps.activate(null);
      return { state: 'no-source' };
    }
    const sourceSha256 = sha256(sourcePath);
    const record = this.readRecord();
    const copy = record.copy;
    const copyGood = copy ? await this.copyWorks(copy) : false;

    let reason: string;
    if (!copy || !isFile(this.bin)) reason = 'no copy yet';
    else if (copy.identity !== identity) reason = 'the signing identity changed';
    else if (!copyGood) reason = 'the copy lost its signature or no longer runs';
    else if (copy.sourceSha256 !== sourceSha256) reason = 'the installed tmux changed';
    else {
      if (record.deferred || record.failed) {
        delete record.deferred;
        delete record.failed;
        this.writeRecord(record);
      }
      this.deps.activate(this.bin);
      return { state: 'current', bin: this.bin, version: copy.version };
    }

    // What runs meanwhile: the old copy while it is good for this identity, else the installed.
    const fallback = copyGood && copy?.identity === identity ? this.bin : null;

    if (record.failed?.sourceSha256 === sourceSha256 && record.failed.identity === identity) {
      this.deps.activate(fallback);
      return { state: 'failed', bin: fallback, error: record.failed.error, identity };
    }

    // A newer tmux the running shield server can't talk to waits until that server ends
    // (asked with the installed binary itself: nothing is signed for it meanwhile).
    if (copyGood && fallback && this.deps.serverAnswers) {
      const withNew = await this.deps.serverAnswers(sourcePath);
      if (withNew === false && (await this.deps.serverAnswers(fallback)) === true) {
        const version = await this.version(sourcePath).catch(() => 'new');
        if (record.deferred?.sourceSha256 !== sourceSha256) {
          record.deferred = { sourceSha256, version, at: this.stamp() };
          this.writeRecord(record);
          logger.warn(
            `tmux ${version} can't talk to the running shield tmux server (${copy?.version}): the stable copy stays on ${copy?.version} until that server ends`
          );
        }
        this.deps.activate(fallback);
        return { state: 'deferred', bin: fallback, version, running: copy?.version };
      }
    }

    const tmp = path.join(
      this.deps.dir,
      `.tmux.new-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(sourcePath, tmp);
      fs.chmodSync(tmp, 0o755);
      await this.exec(
        'codesign',
        [
          '--force',
          '--sign',
          identity,
          '--identifier',
          STABLE_TMUX_IDENTIFIER,
          '--timestamp=none',
          tmp,
        ],
        // A keychain dialog nobody answers ends here, as a failure that isn't retried.
        { timeout: 120_000 }
      );
      const signed = await this.readSignature(tmp);
      if (signed.identifier !== STABLE_TMUX_IDENTIFIER) {
        throw new Error(`codesign left identifier ${signed.identifier ?? 'none'}`);
      }
      if (!signed.requirement) throw new Error('codesign gave no designated requirement');
      const version = await this.version(tmp);

      // Never written over: the new file takes the copy's name in one step.
      fs.renameSync(tmp, this.bin);
      const next: StableTmuxRecord = {
        // The first copy replaces the installed tmux, which may hold Full Disk Access.
        ...(record.leftover
          ? { leftover: record.leftover }
          : copy
            ? {}
            : { leftover: { binary: source ?? sourcePath, since: this.stamp() } }),
        copy: {
          sourcePath,
          sourceSha256,
          version,
          identity,
          requirement: signed.requirement,
          ...(signed.team ? { team: signed.team } : {}),
          signedAt: this.stamp(),
        },
      };
      this.writeRecord(next);
      if (copy && copy.identity === identity && copy.requirement !== signed.requirement) {
        logger.warn(
          `the stable tmux copy's designated requirement changed (${copy.requirement} → ${signed.requirement}): macOS may ask for its permissions again`
        );
      }
      this.deps.activate(this.bin);
      logger.log(
        `stable tmux copy ${this.bin} is now tmux ${version} (${reason}), signed as ${STABLE_TMUX_IDENTIFIER}`
      );
      return {
        state: 'renewed',
        bin: this.bin,
        version,
        ...(copy ? { from: copy.version } : {}),
        reason,
      };
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      const message = describe(error);
      record.failed = { sourceSha256, identity, at: this.stamp(), error: message };
      this.writeRecord(record);
      logger.warn(`could not make the stable tmux copy (${reason}): ${message}`);
      this.deps.activate(fallback);
      return { state: 'failed', bin: fallback, error: message, identity };
    }
  }

  /**
   * Temporary files a server that died mid-renewal left in the folder (2026-10-31): this
   * process's own (refreshes run one at a time, so none is in progress), a dead process's, or
   * any older than a signing could take. Another live server's fresh one is left alone.
   */
  private removeLeftoverTemporaries(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = TEMPORARY.exec(name);
      if (!match) continue;
      const file = path.join(this.deps.dir, name);
      const pid = Number(match[1] ?? match[2]);
      try {
        const old = this.now() - fs.statSync(file).mtimeMs > TEMPORARY_STALE_MS;
        if (pid !== process.pid && isAlive(pid) && !old) continue;
        fs.rmSync(file, { force: true });
        logger.log(`removed ${file}, left over by a renewal that did not finish`);
      } catch {
        // Gone meanwhile.
      }
    }
  }

  /** The copy still has the signature it was given and runs. */
  private async copyWorks(copy: CopyRecord): Promise<boolean> {
    if (!isFile(this.bin)) return false;
    try {
      await this.exec('codesign', ['--verify', '--strict', `-R=${copy.requirement}`, this.bin]);
      await this.version(this.bin);
      return true;
    } catch {
      return false;
    }
  }

  private async readSignature(
    file: string
  ): Promise<{ identifier?: string; team?: string; requirement?: string }> {
    // codesign -d prints to stderr.
    const details = await this.exec('codesign', ['-d', '--verbose=2', file]);
    const text = `${details.stdout}\n${details.stderr}`;
    const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
    const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
    const req = await this.exec('codesign', ['-d', '-r-', file]);
    const requirement = /designated => (.+)$/m.exec(`${req.stdout}\n${req.stderr}`)?.[1]?.trim();
    return {
      ...(identifier ? { identifier } : {}),
      ...(team && team !== 'not set' ? { team } : {}),
      ...(requirement ? { requirement } : {}),
    };
  }

  private async version(bin: string): Promise<string> {
    const { stdout } = await this.exec(bin, ['-V'], { timeout: 10_000 });
    const version = stdout.trim().replace(/^tmux\s+/, '');
    if (!version) throw new Error(`${bin} -V printed nothing`);
    return version;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private readRecord(): StableTmuxRecord {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.recordPath, 'utf8')) as StableTmuxRecord;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeRecord(record: StableTmuxRecord): void {
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.recordPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.recordPath);
    } catch (error) {
      logger.warn(`could not save ${this.recordPath}: ${describe(error)}`);
    }
  }
}

/**
 * The once-only push (2026-10-31): every Untether tmux server runs the copy, so the old tmux's
 * Full Disk Access entry can go. English here; the phone words it in its language from
 * data.type (sw-notify-i18n.ts), with the old binary in data.detail.
 */
export function oldTmuxPermissionPush(binary: string) {
  return {
    type: 'tmux-old-permission',
    title: '🧹 You can remove the old tmux',
    body: `Untether's sessions now all run its signed tmux copy. You can remove the old tmux (${binary}) from System Settings → Privacy & Security → Full Disk Access.`,
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    tag: 'untether-tmux-old-permission',
    data: { type: 'tmux-old-permission', where: 'tmux', detail: binary },
  };
}

/** Code signing identities in the user's keychains (`security find-identity`). */
export async function listSigningIdentities(
  exec: Exec = realExec
): Promise<Array<{ hash: string; name: string }>> {
  const { stdout } = await exec('security', ['find-identity', '-v', '-p', 'codesigning'], {
    timeout: 10_000,
  });
  return parseSigningIdentities(stdout);
}

export function parseSigningIdentities(output: string): Array<{ hash: string; name: string }> {
  const identities: Array<{ hash: string; name: string }> = [];
  for (const line of output.split('\n')) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"\s*$/i.exec(line);
    if (match) identities.push({ hash: match[1].toUpperCase(), name: match[2] });
  }
  return identities;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function describe(error: unknown): string {
  const failure = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof failure?.stderr === 'string' ? failure.stderr.trim() : '';
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || message).split('\n').slice(-3).join(' ').slice(0, 300);
}
