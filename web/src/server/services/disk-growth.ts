/**
 * What is filling the disk, for the doctor's low-disk finding.
 *
 * 2026-11-01 22:22: the Mac fell to ~1 GB free because claude-mem's Chroma index
 * (~/.claude-mem/chroma/<id>/link_lists.bin) grew to 81 GB; the doctor said only "1 GB free" and
 * someone had to go and find it. Now the finding names the folders that grew most in the last
 * hours and the big files written lately, under $HOME, /private/tmp, /private/var/folders and
 * Docker's disk images.
 *
 * Never a walk of the whole disk each time (this Mac's $HOME alone takes ~170 s): the roots are
 * split into units (each folder right under a root, a root's own files, each disk image) and a
 * scan step measures the units not measured yet, then the longest unmeasured, until its time
 * budget; the next step goes on from there. Each unit keeps its last day's measurements, so a
 * folder's growth is its unit's latest measurement against an earlier one. Steps run only while
 * the disk is low or nearly (see diskCheck). Folders macOS guards with a privacy prompt
 * (Desktop, Documents, Mail, other apps' containers, …) are never entered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export interface DiskScanFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** One unit measured whole at `at`. */
export interface UnitMeasure {
  at: number;
  bytes: number;
  /** Folders in it (the unit too), down to `depth` under its root, of at least minDirBytes. */
  dirs: Record<string, number>;
  /** Files of at least minFileBytes, with their mtime. */
  bigFiles: DiskScanFile[];
}

export interface DiskUnit {
  /** It appeared after its root had been listed before: new since then (it grew from 0). */
  newSince?: number;
  /** Its last measurement cut by the hard limit: the step goes to other units first next time. */
  triedAt?: number;
  measures: UnitMeasure[];
}

export interface DiskGrowthState {
  /** When each root was first listed. */
  roots: Record<string, number>;
  units: Record<string, DiskUnit>;
}

export interface ScanTargets {
  roots: string[];
  /** Single files measured as units of their own (Docker's disk image). */
  files: string[];
  /** Folders not entered (privacy-guarded ones). */
  skip: (dir: string) => boolean;
}

export interface ScanStepOptions extends ScanTargets {
  /** No new unit starts after this long. */
  budgetMs: number;
  /** A unit still being measured is given up after this long in all. */
  hardMs: number;
  depth?: number;
  minDirBytes?: number;
  minFileBytes?: number;
  now?: () => number;
}

/** Folders under $HOME that macOS guards with a privacy prompt: never read by the doctor. */
const PRIVATE_HOME_DIRS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Movies',
  'Music',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
  'Library/Containers',
  'Library/Group Containers',
  'Library/CloudStorage',
  'Library/Mobile Documents',
  'Library/Calendars',
  'Library/Reminders',
  'Library/Application Support/AddressBook',
  'Library/Application Support/CallHistoryDB',
  'Library/Application Support/MobileSync',
  'Library/Application Support/com.apple.TCC',
  '.Trash',
];

/** Where a full disk usually comes from, and Docker's disk images (read as single files). */
export function defaultScanTargets(home = os.homedir()): ScanTargets {
  const guarded = new Set(PRIVATE_HOME_DIRS.map((rel) => path.join(home, rel)));
  return {
    roots: ['/private/tmp', '/private/var/folders', home],
    files: [
      path.join(home, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw'),
      path.join(home, '.orbstack/data/data.img'),
      path.join(home, '.colima/_lima/colima/diffdisk'),
    ],
    skip: (dir) => guarded.has(dir),
  };
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

function lastOf<T>(list: T[] | undefined): T | undefined {
  return list?.[list.length - 1];
}

/** A root's own files are a unit of their own, named so. */
const OWN_FILES = '/.';

function under(root: string, dir: string): boolean {
  return dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * One scan step: lists the roots (new units noted), then measures units (real disk use,
 * blocks × 512; links not followed; other volumes not entered), never measured first, then the
 * longest unmeasured, until `budgetMs`; a unit not done by `hardMs` is dropped for this step.
 * Yields to the event loop as it goes. Changes `state` in place.
 */
export async function scanStep(state: DiskGrowthState, options: ScanStepOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const start = now();
  const soft = start + options.budgetMs;
  const hard = start + options.hardMs;
  const depth = options.depth ?? 4;
  const minDir = options.minDirBytes ?? 100 * MB;
  const minFile = options.minFileBytes ?? GB;
  let ops = 0;

  // Units now: the roots' folders, their own files, the disk images.
  const units: { key: string; root?: string; dev?: number; kind: 'dir' | 'files' | 'file' }[] = [];
  for (const file of options.files) units.push({ key: file, kind: 'file' });
  for (const root of options.roots) {
    let entries: fs.Dirent[];
    let dev: number;
    try {
      dev = fs.lstatSync(root).dev;
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const listedBefore = state.roots[root] !== undefined;
    state.roots[root] ??= start;
    const add = (key: string, kind: 'dir' | 'files') => {
      units.push({ key, root, dev, kind });
      if (!state.units[key]) {
        state.units[key] = { measures: [], ...(listedBefore ? { newSince: start } : {}) };
      }
    };
    add(`${root}${OWN_FILES}`, 'files');
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory() && !options.skip(full)) add(full, 'dir');
    }
  }
  const seen = new Set(units.map((unit) => unit.key));
  for (const key of Object.keys(state.units)) {
    if (!seen.has(key)) delete state.units[key];
  }

  const measureFile = (file: string, stat: fs.Stats, into: UnitMeasure) => {
    const bytes = stat.blocks * 512;
    if (bytes >= minFile) into.bigFiles.push({ path: file, bytes, mtimeMs: stat.mtimeMs });
    return bytes;
  };
  // false: cut by the hard limit.
  const walk = async (
    dir: string,
    level: number,
    dev: number,
    into: UnitMeasure,
    filesOnly: boolean
  ): Promise<number | false> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let bytes = 0;
    for (const entry of entries) {
      if (++ops % 500 === 0) {
        await yieldNow();
        if (now() > hard) return false;
      }
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (filesOnly && !entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && options.skip(full)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isFile()) {
        bytes += measureFile(full, stat, into);
        continue;
      }
      if (!stat.isDirectory() || stat.dev !== dev) continue;
      const sub = await walk(full, level + 1, dev, into, false);
      if (sub === false) return false;
      bytes += sub;
    }
    if (bytes >= minDir && level <= depth)
      into.dirs[filesOnly ? `${dir}${OWN_FILES}` : dir] = bytes;
    return bytes;
  };

  const lastAt = (key: string) =>
    Math.max(
      lastOf(state.units[key]?.measures)?.at ?? Number.NEGATIVE_INFINITY,
      state.units[key]?.triedAt ?? Number.NEGATIVE_INFINITY
    );
  const order = [...units].sort((a, b) => lastAt(a.key) - lastAt(b.key));
  for (const unit of order) {
    if (now() > soft) break;
    const measure: UnitMeasure = { at: now(), bytes: 0, dirs: {}, bigFiles: [] };
    if (unit.kind === 'file') {
      try {
        const stat = fs.lstatSync(unit.key);
        if (!stat.isFile()) throw new Error('not a file');
        measure.bytes = measureFile(unit.key, stat, measure);
        if (measure.bytes >= minDir) measure.dirs[unit.key] = measure.bytes;
      } catch {
        delete state.units[unit.key];
        continue;
      }
      state.units[unit.key] ??= { measures: [] };
    } else {
      const dir = unit.kind === 'files' ? (unit.root as string) : unit.key;
      const bytes = await walk(dir, 1, unit.dev as number, measure, unit.kind === 'files');
      if (bytes === false) {
        // Too big for this step: others first next time, so one giant never blocks the round.
        state.units[unit.key].triedAt = measure.at;
        break;
      }
      measure.bytes = bytes;
      delete state.units[unit.key].triedAt;
    }
    measure.bigFiles.sort((a, b) => b.bytes - a.bytes);
    keepMeasure(state.units[unit.key], measure);
  }
}

/** Measurements kept per unit: the last day's, a few. */
const KEEP_MS = 24 * 60 * 60_000;
const KEEP_MAX = 6;

function keepMeasure(unit: DiskUnit, measure: UnitMeasure): void {
  const cutoff = measure.at - KEEP_MS;
  unit.measures = [...unit.measures.filter((kept) => kept.at >= cutoff), measure].slice(-KEEP_MAX);
}

export interface DiskGrower {
  path: string;
  bytes: number;
  /** Grown by this much in `sinceMs` (folders measured before). */
  grownBytes?: number;
  sinceMs?: number;
  /** A file written lately (ms since). */
  writtenAgoMs?: number;
}

/** An earlier measurement must be at least this much older to say what grew. */
const COMPARE_MIN_AGE_MS = 20 * 60_000;

/**
 * The biggest growers: folders that grew by at least minGrowthBytes (the deepest one carrying
 * most of a parent's growth, not every folder above it), then big files written in the last
 * recentMs, largest first.
 */
export function diskGrowers(
  state: DiskGrowthState,
  now: number,
  options: { limit?: number; minGrowthBytes?: number; recentMs?: number } = {}
): DiskGrower[] {
  const limit = options.limit ?? 5;
  const minGrowth = options.minGrowthBytes ?? GB;
  const recent = options.recentMs ?? 6 * 60 * 60_000;
  const grown: DiskGrower[] = [];
  const files: DiskGrower[] = [];
  for (const unit of Object.values(state.units)) {
    const latest = lastOf(unit.measures);
    if (!latest) continue;
    const earlier = unit.measures.find((measure) => latest.at - measure.at >= COMPARE_MIN_AGE_MS);
    const fromNothing =
      !earlier && unit.newSince !== undefined && latest.at - unit.newSince <= KEEP_MS;
    if (earlier || fromNothing) {
      for (const [dir, bytes] of Object.entries(latest.dirs) as [string, number][]) {
        // Under the reporting size then (the unit was measured whole), or new.
        const before = earlier ? (earlier.dirs[dir] ?? 0) : 0;
        if (bytes - before >= minGrowth) {
          grown.push({
            path: dir,
            bytes,
            grownBytes: bytes - before,
            sinceMs: latest.at - (earlier ? earlier.at : (unit.newSince as number)),
          });
        }
      }
    }
    for (const file of latest.bigFiles) {
      if (now - file.mtimeMs <= recent) {
        files.push({
          path: file.path,
          bytes: file.bytes,
          writtenAgoMs: Math.max(0, now - file.mtimeMs),
        });
      }
    }
  }
  // A folder whose growth is mostly one of its subfolders' is that subfolder's.
  const deepest = grown.filter(
    (parent) =>
      !grown.some(
        (child) =>
          child.path !== parent.path &&
          under(parent.path, child.path) &&
          (child.grownBytes ?? 0) >= 0.8 * (parent.grownBytes ?? 0)
      )
  );
  deepest.sort((a, b) => (b.grownBytes ?? 0) - (a.grownBytes ?? 0));
  files.sort((a, b) => b.bytes - a.bytes);
  const out: DiskGrower[] = deepest.slice(0, limit);
  for (const file of files) {
    if (out.length >= limit) break;
    if (!out.some((entry) => entry.path === file.path)) out.push(file);
  }
  return out;
}

function shortPath(file: string, home: string): string {
  return home && under(home, file) ? `~${file.slice(home.length)}` : file;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** "~/.claude-mem/chroma/abc +80.2 GB in 3 h (81.2 GB); ~/x/big.bin 80.0 GB, written 2 min ago". */
export function describeGrowers(growers: DiskGrower[], home = os.homedir()): string {
  return growers
    .map((entry) => {
      const where = shortPath(entry.path, home);
      const size = `${(entry.bytes / GB).toFixed(1)} GB`;
      if (entry.grownBytes !== undefined) {
        return `${where} +${(entry.grownBytes / GB).toFixed(1)} GB in ${ago(entry.sinceMs ?? 0)} (${size})`;
      }
      return `${where} ${size}, written ${ago(entry.writtenAgoMs ?? 0)} ago`;
    })
    .join('; ');
}

/** While nearly low, a step at most this often (45 s each). */
export const BASELINE_EVERY_MS = 30 * 60_000;

export interface DiskGrowthWatchDeps {
  /** JSON of the measurements (none: kept in memory only). */
  statePath?: string;
  /** One scan step on the state (tests pass their own). */
  step?: (state: DiskGrowthState, mode: 'baseline' | 'low') => Promise<void>;
  now?: () => number;
  home?: string;
}

/**
 * The doctor's measurements: `baseline` while the disk is nearly low (a 45 s step at most every
 * 30 min, so a full round of $HOME takes a few hours), `describe` when it is low (a longer step
 * at once, 2 min and up to 4 for a folder under way, then what grew).
 */
export class DiskGrowthWatch {
  private state: DiskGrowthState = { roots: {}, units: {} };
  private lastStep = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly deps: DiskGrowthWatchDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private async step(mode: 'baseline' | 'low'): Promise<void> {
    this.lastStep = this.now();
    if (this.deps.step) await this.deps.step(this.state, mode);
    else {
      await scanStep(this.state, {
        ...defaultScanTargets(this.deps.home),
        budgetMs: mode === 'low' ? 120_000 : 45_000,
        hardMs: mode === 'low' ? 240_000 : 120_000,
        now: this.now,
      });
    }
    this.save();
  }

  /** When the long step of a low disk last ran (describe). */
  private lowStepAt: number | undefined;

  /** The disk is nearly low: measure on, to have something to compare with later. */
  async baseline(): Promise<void> {
    if (this.now() - this.lastStep < BASELINE_EVERY_MS) return;
    await this.step('baseline');
  }

  /** The disk is low: measure now, then what grew (empty when nothing big is found). */
  async describe(): Promise<string> {
    // Measured again only now and then (2026-11-10): the doctor asks on every pass while the
    // disk stays low, and each long step is 2-4 minutes of lstat that held back every check
    // after it, for a text that is told once.
    if (this.lowStepAt === undefined || this.now() - this.lowStepAt >= BASELINE_EVERY_MS) {
      await this.step('low');
      this.lowStepAt = this.now();
    }
    return describeGrowers(diskGrowers(this.state, this.now()), this.deps.home);
  }

  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DiskGrowthState> & {
        lastStep?: number;
      };
      if (stored.units && typeof stored.units === 'object') {
        this.state = { roots: stored.roots ?? {}, units: stored.units };
      }
      if (typeof stored.lastStep === 'number') this.lastStep = stored.lastStep;
    } catch {
      // None yet, or unreadable: start clean.
    }
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.state, lastStep: this.lastStep }));
      fs.renameSync(tmp, file);
    } catch {
      // A lost measurement only means the next finding names fewer growers.
    }
  }
}
