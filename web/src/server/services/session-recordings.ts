/**
 * Session recordings (casts, CONTROL_DIR/<id>/stdout) bounded on disk, for live and finished
 * sessions alike.
 *
 * 2026-11-01 (measured): CONTROL_DIR held 4.7 GB in 245 folders. Live casts were already cut by
 * the doctor once they used 256 MB of disk (doctor-checks-storage.ts bigCastsCheck), but each kept up
 * to that, and finished sessions kept theirs whole: 135 sessions finished in the last two days
 * used 3.1 GB, while reconnecting only ever replays the last 16 MB (CAST_REPLAY_MAX_BYTES).
 *
 * Live casts ("rotation"): once one uses more than `rotateBytes` of disk, its old middle is
 * punched out by the forwarder (native/ut-fwd/src/cast_compact.rs), keeping its header and its
 * last `keepBytes`, more than any replay reads. Offsets and the apparent size never change, so
 * the writer and every reader following the file go on. What the punched part set and the tail
 * no longer says is written into the end of the hole as a snapshot: the terminal size and the
 * DEC modes (mouse reporting, bracketed paste…) in effect where the tail starts, as two
 * ordinary cast events. Readers that look back for a resize (findLastResizeBefore), scan the
 * modes (scanCastModeSequences) or replay from before the tail find them there. The screen
 * itself is rebuilt from the tail, as every replay already does.
 *
 * Finished sessions: once one ended more than `days` ago, its cast is rewritten to its header,
 * a notice and the last few hundred KB of output, so it still opens on its last screen. The
 * session.json (title, ids, the Claude conversation "Reanudar Claude" resumes) stays, and so
 * does the folder. Suspended sessions, shielded ones that may come back and those an open task
 * or an orchestrator needs are never touched; running ones never are.
 */
import * as fs from 'fs';
import { CellFlags, type GhosttyCell, type GhosttyTerminal } from 'ghostty-web';
import * as path from 'path';
import type { Session } from '../../shared/types.js';
import {
  CAST_REPLAY_MAX_BYTES,
  findLastResizeBefore,
  findNextLineStart,
  forEachCastLine,
  forEachCastLineBytes,
  readCastHeaderLine,
  scanCastModeSequences,
} from '../utils/cast-tail.js';
import { createLogger } from '../utils/logger.js';
import { decModesToSequence, trackDecModes } from '../utils/terminal-modes.js';
import { createHeadlessTerminal } from './terminal-manager.js';

const logger = createLogger('session-recordings');

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Disk a live cast may use before it is rotated (config recordings.rotateMB). */
export const DEFAULT_ROTATE_BYTES = 64 * MB;
/** Days after which a finished session's recording is trimmed (config recordings.finishedDays). */
export const DEFAULT_FINISHED_DAYS = 2;
/** Disk use of CONTROL_DIR the doctor warns about (config recordings.controlWarnGB). */
export const DEFAULT_CONTROL_WARN_BYTES = 3 * 1024 * MB;
/** Output a trimmed finished recording keeps: enough for its last screen. */
export const FINISHED_KEEP_BYTES = 512 * 1024;
/** The sidecar where the last snapshot of a rotated cast is noted (see rotateCast). */
export const ROTATION_STATE_FILE = 'stdout.rotation.json';

export interface RecordingSettings {
  rotateMB?: number;
  finishedDays?: number;
  controlWarnGB?: number;
}

/**
 * What a cast rotated at `rotateBytes` keeps: half of it, never less than a whole replay
 * (CAST_REPLAY_MAX_BYTES) plus room, nor more than what triggers the next rotation.
 */
export function rotationLimits(settings: RecordingSettings | undefined): {
  rotateBytes: number;
  keepBytes: number;
} {
  const minRotate = 2 * (CAST_REPLAY_MAX_BYTES + 8 * MB);
  const wanted = settings?.rotateMB;
  const rotateBytes =
    typeof wanted === 'number' && Number.isFinite(wanted) && wanted > 0
      ? Math.max(minRotate, Math.round(wanted * MB))
      : DEFAULT_ROTATE_BYTES;
  return { rotateBytes, keepBytes: Math.floor(rotateBytes / 2) };
}

/** A session finished less than this ago may still be looked at: never trimmed for size. */
const FINISHED_MIN_AGE_MS = 60 * 60 * 1000;

export function finishedDays(settings: RecordingSettings | undefined): number {
  const days = settings?.finishedDays;
  return typeof days === 'number' && Number.isFinite(days) && days >= 0
    ? days
    : DEFAULT_FINISHED_DAYS;
}

export function controlWarnBytes(settings: RecordingSettings | undefined): number {
  const gb = settings?.controlWarnGB;
  return typeof gb === 'number' && Number.isFinite(gb) && gb > 0
    ? Math.round(gb * 1024 * MB)
    : DEFAULT_CONTROL_WARN_BYTES;
}

/** A file's real disk use: a punched cast keeps its apparent size. */
export function diskBytes(file: string): number {
  return fs.statSync(file).blocks * 512;
}

/** The terminal state where a cast's tail starts: what a snapshot writes. */
export interface CastSnapshot {
  /** The line start the state holds at. */
  offset: number;
  /** The cast time (seconds) of the line there, for the snapshot events. */
  time: number;
  /** "COLSxROWS" in effect there, if known. */
  size: string | null;
  modes: Record<string, boolean>;
  /**
   * The screen there, drawn again (with the last scrollback lines before it) as output that
   * starts with a clear: see castScreenAt. Empty when it could not be rebuilt.
   */
  screen: string;
}

/** The sidecar of a rotated cast: where its last snapshot was written (see rotateCast). */
interface RotationState {
  /** The cast's header line: another header means another recording. */
  header: string;
  /** Offset of the snapshot's first event line. */
  snapshotAt: number;
  size: string | null;
}

function readRotationState(file: string): RotationState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), ROTATION_STATE_FILE), 'utf8')
    ) as Partial<RotationState>;
    if (typeof parsed.header !== 'string' || typeof parsed.snapshotAt !== 'number') return null;
    return {
      header: parsed.header,
      snapshotAt: parsed.snapshotAt,
      size: typeof parsed.size === 'string' ? parsed.size : null,
    };
  } catch {
    return null;
  }
}

function writeRotationState(file: string, state: RotationState): void {
  const target = path.join(path.dirname(file), ROTATION_STATE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** The time field of the cast line starting at `offset` (0 when unreadable). */
function lineTime(file: string, offset: number): number {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(48);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const match = buffer.toString('latin1', 0, read).match(/^\[(\d+(?:\.\d+)?)\s*,/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The terminal size and DEC modes in effect at `offset` (a line start) of the cast. The modes
 * are read from the last snapshot this module wrote, when the sidecar names one before
 * `offset` (it holds every mode set before it), else from the start of the cast.
 */
export async function castSnapshotAt(
  file: string,
  offset: number,
  header: string
): Promise<CastSnapshot> {
  const previous = readRotationState(file);
  const from =
    previous && previous.header === header && previous.snapshotAt < offset
      ? previous.snapshotAt
      : 0;
  const modes: Record<string, boolean> = {};
  await scanCastModeSequences(file, from, offset, (sequence) => trackDecModes(modes, sequence));
  let size = await findLastResizeBefore(file, offset);
  if (!size && previous && previous.header === header) size = previous.size;
  // The screen from the last snapshot, which drew the one before, else from the start: every
  // byte still on disk before the cut counts (review 2026-11-01: from a replay window only, a
  // header drawn once before it was lost). The chain makes each rotation replay what was
  // written since the last one; a cast's first rotation replays it whole, holes an older
  // compaction left read as NULs and skipped.
  let screen = '';
  try {
    const started = Date.now();
    screen = await castScreenAt(file, header, from, offset);
    if (Date.now() - started > 2000) {
      logger.log(
        `rebuilt the screen of ${file} from ${Math.round((offset - from) / MB)} MB in ${Date.now() - started} ms`
      );
    }
  } catch (error) {
    logger.warn(`could not rebuild the screen of ${file} at ${offset}:`, error);
  }
  return { offset, time: lineTime(file, offset), size, modes, screen };
}

/** Scrollback a snapshot draws again above its screen, at most. */
const SNAPSHOT_SCROLLBACK_LINES = 500;
const SNAPSHOT_SCROLLBACK_BYTES = MB;
const REPLAY_WRITE_CHARS = 256 * 1024;

/**
 * The screen at `to` of the cast, rebuilt in a headless terminal from the events in [from, to)
 * (`from` a line start), as output to write on a fresh terminal of the same size: a reset of
 * the style, a clear, the last scrollback lines, the screen's rows and the cursor. On the
 * alternate screen only that screen, entered first. The review of 2026-11-01: a TUI's static
 * parts (a header drawn once, a pane redrawn only in part) may lie before the tail a rotation
 * keeps, and replaying the tail alone would leave them blank.
 */
export async function castScreenAt(
  file: string,
  header: string,
  from: number,
  to: number
): Promise<string> {
  let cols = 80;
  let rows = 24;
  try {
    const parsed = JSON.parse(header) as { width?: number; height?: number };
    if (parsed.width && parsed.width > 0) cols = parsed.width;
    if (parsed.height && parsed.height > 0) rows = parsed.height;
  } catch {
    // Default size.
  }
  const sizeAtStart = await findLastResizeBefore(file, from);
  const parseSize = (dimensions: string | null) => dimensions?.match(/^(\d+)x(\d+)$/);
  const start = parseSize(sizeAtStart);
  if (start) {
    cols = Number(start[1]);
    rows = Number(start[2]);
  }
  const terminal = await createHeadlessTerminal(cols, rows);
  try {
    let output: string[] = [];
    let chars = 0;
    const flush = () => {
      if (chars === 0) return;
      terminal.write(output.join(''));
      output = [];
      chars = 0;
    };
    await forEachCastLine(file, from, to, (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!Array.isArray(event) || typeof event[2] !== 'string') return;
      if (event[1] === 'o') {
        output.push(event[2]);
        chars += event[2].length;
        if (chars >= REPLAY_WRITE_CHARS) flush();
      } else if (event[1] === 'r') {
        const size = parseSize(event[2]);
        if (!size) return;
        flush();
        terminal.resize(Number(size[1]), Number(size[2]));
      }
    });
    flush();
    return serializeScreen(terminal);
  } finally {
    terminal.free();
  }
}

/** The SGR parameters ("0;1;38;2;r;g;b") that give a cell its style; colours as RGB. */
function sgrOf(cell: GhosttyCell, defaultFg: number, defaultBg: number): string {
  const parts = ['0'];
  if (cell.flags & CellFlags.BOLD) parts.push('1');
  if (cell.flags & CellFlags.FAINT) parts.push('2');
  if (cell.flags & CellFlags.ITALIC) parts.push('3');
  if (cell.flags & CellFlags.UNDERLINE) parts.push('4');
  if (cell.flags & CellFlags.BLINK) parts.push('5');
  if (cell.flags & CellFlags.INVERSE) parts.push('7');
  if (cell.flags & CellFlags.INVISIBLE) parts.push('8');
  if (cell.flags & CellFlags.STRIKETHROUGH) parts.push('9');
  const fg = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
  const bg = (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
  if (fg !== defaultFg) parts.push(`38;2;${cell.fg_r};${cell.fg_g};${cell.fg_b}`);
  if (bg !== defaultBg) parts.push(`48;2;${cell.bg_r};${cell.bg_g};${cell.bg_b}`);
  return parts.join(';');
}

/**
 * A terminal's screen (and last scrollback) as output that draws it again: see castScreenAt.
 * It ends with the cursor where it was and the style (SGR) the app had set there (review
 * 2026-11-01: a tail that goes on writing in a colour set before the cut would otherwise come
 * out plain). That style is read by printing one character with it once the rest is read, so
 * the terminal is left changed: it is only for this.
 */
export function serializeScreen(terminal: GhosttyTerminal): string {
  terminal.update();
  const colors = terminal.getColors() as
    | {
        foreground?: { r: number; g: number; b: number };
        background?: { r: number; g: number; b: number };
      }
    | undefined;
  const rgb = (color?: { r: number; g: number; b: number }) =>
    color ? (color.r << 16) | (color.g << 8) | color.b : -1;
  const defaultFg = rgb(colors?.foreground);
  const defaultBg = rgb(colors?.background);
  const cols = terminal.cols;
  const rows = terminal.rows;

  const style = (cell: GhosttyCell) => sgrOf(cell, defaultFg, defaultBg);
  const plain = '0';
  /** One row's cells as text with SGR, trailing default blanks left out. */
  const rowText = (cells: GhosttyCell[] | null, grapheme?: (col: number) => string | null) => {
    if (!cells) return '';
    const pieces: string[] = [];
    let current = plain;
    let pendingBlanks = 0;
    for (let col = 0; col < Math.min(cols, cells.length); col++) {
      const cell = cells[col];
      if (!cell || cell.width === 0) continue;
      const cellStyle = style(cell);
      const char =
        cell.codepoint === 0
          ? ' '
          : (cell.grapheme_len > 1 && grapheme?.(col)) || String.fromCodePoint(cell.codepoint);
      if (char === ' ' && cellStyle === plain) {
        pendingBlanks += 1;
        continue;
      }
      if (pendingBlanks > 0) {
        if (current !== plain) {
          pieces.push('\x1b[0m');
          current = plain;
        }
        pieces.push(' '.repeat(pendingBlanks));
        pendingBlanks = 0;
      }
      if (cellStyle !== current) {
        pieces.push(`\x1b[${cellStyle}m`);
        current = cellStyle;
      }
      pieces.push(char);
    }
    if (current !== plain) pieces.push('\x1b[0m');
    return pieces.join('');
  };

  const viewport = terminal.getViewport();
  const screenRows: string[] = [];
  for (let row = 0; row < rows; row++) {
    screenRows.push(
      rowText(viewport.slice(row * cols, (row + 1) * cols), (col) =>
        terminal.getGraphemeString(row, col)
      )
    );
  }
  const cursor = terminal.getCursor();
  const alternate = terminal.isAlternateScreen();

  // The last scrollback lines, newest kept first when over the budget (none for the alternate
  // screen, which has none of its own).
  const scrollback: string[] = [];
  let bytes = 0;
  const length = alternate ? 0 : terminal.getScrollbackLength();
  for (let line = length - 1; line >= 0 && scrollback.length < SNAPSHOT_SCROLLBACK_LINES; line--) {
    const text = rowText(terminal.getScrollbackLine(line));
    bytes += text.length + 2;
    if (bytes > SNAPSHOT_SCROLLBACK_BYTES) break;
    scrollback.unshift(text);
  }

  // The pen: a character printed now takes it. Last, once everything else was read.
  terminal.write('\x1b[1;1HX');
  terminal.update();
  const penCell = terminal.getViewport()[0];
  const pen = penCell ? `\x1b[${style(penCell)}m` : '';
  const placeCursor = `\x1b[${cursor.y + 1};${cursor.x + 1}H${pen}`;

  if (alternate) {
    const drawn = screenRows.map((text, row) => (text ? `\x1b[${row + 1};1H${text}` : ''));
    return `\x1b[0m\x1b[?1049h\x1b[H\x1b[2J${drawn.join('')}${placeCursor}`;
  }
  // From the top of a cleared screen, every line written: the scrollback ones scroll off the
  // top into history and the screen's rows end on the screen as they were.
  return `\x1b[0m\x1b[H\x1b[2J${[...scrollback, ...screenRows].join('\r\n')}${placeCursor}`;
}

/**
 * The snapshot as cast bytes, to go right before a hole's end: a newline ends the hole's
 * "line" (readers drop a line a hole is in), then a resize, the screen drawn again and an
 * output event restoring the modes, then one NUL, so readers drop the cut line the tail starts with as they would after
 * any hole. Returns the bytes and the offset of the first event within them.
 */
export function snapshotBytes(snapshot: CastSnapshot): { bytes: Buffer; eventsAt: number } {
  const time = Number.isFinite(snapshot.time) ? snapshot.time : 0;
  const lines: string[] = [];
  if (snapshot.size) lines.push(JSON.stringify([time, 'r', snapshot.size]));
  if (snapshot.screen) lines.push(JSON.stringify([time, 'o', snapshot.screen]));
  // Every tracked mode the cast set, on or off: a client replaying from here learns them all.
  const modes = decModesToSequence(snapshot.modes);
  if (modes) lines.push(JSON.stringify([time, 'o', modes]));
  if (lines.length === 0) return { bytes: Buffer.alloc(0), eventsAt: 0 };
  return {
    bytes: Buffer.concat([
      Buffer.from('\n'),
      Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
      Buffer.from([0]),
    ]),
    eventsAt: 1,
  };
}

/**
 * Writes `bytes` so they end at `holeEnd`, only if every byte there reads as NUL (inside the
 * hole). Never touches anything else: a miscomputed hole leaves the cast as it was.
 */
export function writeIntoHole(file: string, holeStart: number, holeEnd: number, bytes: Buffer) {
  const at = holeEnd - bytes.length;
  if (bytes.length === 0 || at <= holeStart) return false;
  const fd = fs.openSync(file, 'r+');
  try {
    const current = Buffer.alloc(bytes.length);
    const read = fs.readSync(fd, current, 0, current.length, at);
    if (read !== current.length || current.some((byte) => byte !== 0)) return false;
    const before = fs.fstatSync(fd);
    fs.writeSync(fd, bytes, 0, bytes.length, at);
    // The modification time is the session's last output (session lists, activity): put it
    // back unless the writer appended meanwhile.
    const after = fs.fstatSync(fd);
    if (after.size === before.size) fs.futimesSync(fd, before.atime, before.mtime);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** What the forwarder reported for one cast (cast_compact.rs Report), or why it failed. */
export interface CompactResult {
  error?: string;
  /** Length of the range punched, from the first block after the header. */
  punched?: number;
}

/**
 * `untether-fwd --compact-cast` over some casts: each keeps its last `keepBytes`, or, given
 * `holeEnd`, everything from there (`--compact-cast-until`).
 */
export type CastCompactor = (
  files: string[],
  capBytes: number,
  keepBytes: number,
  holeEnd?: number
) => Promise<Map<string, CompactResult>>;

function blockSize(file: string): number {
  try {
    return Math.max(512, Number(fs.statfsSync(file).bsize) || 4096);
  } catch {
    return 4096;
  }
}

/** A cast about to be rotated: where its hole will start and end, and its state there. */
interface RotationPlan {
  file: string;
  header: string;
  holeStart: number;
  /** Where the hole ends (block aligned): the forwarder is told to end it exactly there. */
  holeEnd: number;
  snapshot: CastSnapshot;
}

async function planRotation(file: string, keepBytes: number): Promise<RotationPlan | null> {
  const headerLine = await readCastHeaderLine(file);
  if (!headerLine) return null;
  const size = fs.statSync(file).size;
  const block = blockSize(file);
  const holeStart = Math.ceil(headerLine.end / block) * block;
  const holeEnd = Math.floor(Math.max(0, size - keepBytes) / block) * block;
  if (holeEnd <= holeStart + block) return null;
  // The first whole line of the tail: readers drop the cut one before it.
  const tailStart = await findNextLineStart(file, holeEnd, size);
  const snapshot = await castSnapshotAt(file, tailStart, headerLine.line);
  return {
    file,
    header: headerLine.line,
    holeStart,
    holeEnd,
    snapshot,
  };
}

/**
 * Rotates the live casts in `files` (each already over the cap): plans each one's snapshot,
 * has the forwarder punch each hole to end exactly where its snapshot was taken (review
 * 2026-11-01: ended `keep` before a size read later, a writer appending in between moved it
 * past the snapshot, whose state was then older than the tail), writes the snapshots into the
 * holes. A cast that could not be planned is compacted keeping its last `keepBytes`, without a
 * snapshot. Returns the forwarder's results.
 */
export async function rotateCasts(
  files: string[],
  capBytes: number,
  keepBytes: number,
  compact: CastCompactor,
  log?: (message: string) => void
): Promise<Map<string, CompactResult>> {
  const plans = new Map<string, RotationPlan>();
  for (const file of files) {
    try {
      const plan = await planRotation(file, keepBytes);
      if (plan) plans.set(file, plan);
    } catch (error) {
      log?.(`could not read the state of ${file} before rotating it: ${error}`);
    }
  }
  const results = new Map<string, CompactResult>();
  const unplanned = files.filter((file) => !plans.has(file));
  if (unplanned.length > 0) {
    for (const [file, result] of await compact(unplanned, capBytes, keepBytes)) {
      results.set(file, result);
    }
  }
  for (const [file, plan] of plans) {
    for (const [name, result] of await compact([file], capBytes, keepBytes, plan.holeEnd)) {
      results.set(name, result);
    }
    const result = results.get(file);
    if (!result || result.error || !result.punched) continue;
    if (plan.holeStart + result.punched !== plan.holeEnd) {
      log?.(
        `left the snapshot out of ${file}: its hole ended at ${plan.holeStart + result.punched}, not ${plan.holeEnd}`
      );
      continue;
    }
    const { bytes, eventsAt } = snapshotBytes(plan.snapshot);
    try {
      if (writeIntoHole(file, plan.holeStart, plan.holeEnd, bytes)) {
        writeRotationState(file, {
          header: plan.header,
          snapshotAt: plan.holeEnd - bytes.length + eventsAt,
          size: plan.snapshot.size,
        });
      } else if (bytes.length > 0) {
        log?.(`left the snapshot out of ${file}: the end of its hole is not empty`);
      }
    } catch (error) {
      log?.(`could not write the snapshot into ${file}: ${error}`);
    }
  }
  return results;
}

/**
 * Rewrites a finished session's cast to its header (sized as the terminal last was), a notice
 * and the complete lines of its last `keepBytes`, atomically (a reader that has it open goes
 * on with the old file). Its modification time stays: it is when the session last wrote.
 * Returns the disk bytes freed.
 */
export async function trimFinishedCast(
  file: string,
  keepBytes: number,
  notice: string
): Promise<number> {
  const before = fs.statSync(file);
  const beforeDisk = before.blocks * 512;
  const headerLine = await readCastHeaderLine(file);
  if (!headerLine) return 0;
  const tailFrom = Math.max(headerLine.end, before.size - keepBytes);
  const tailStart =
    tailFrom === headerLine.end
      ? headerLine.end
      : await findNextLineStart(file, tailFrom, before.size);
  const size = tailStart > headerLine.end ? await findLastResizeBefore(file, tailStart) : null;
  let header = headerLine.line;
  if (size) {
    try {
      const parsed = JSON.parse(header) as Record<string, unknown>;
      const [width, height] = size.split('x').map(Number);
      header = JSON.stringify({ ...parsed, width, height });
    } catch {
      // Not JSON: kept as it was.
    }
  }
  const time = lineTime(file, tailStart);
  const temporary = `${file}.trim.${process.pid}`;
  const out = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeSync(out, `${header}\n`);
    fs.writeSync(out, `${JSON.stringify([time, 'o', `\x1b[2m${notice}\x1b[0m\r\n`])}\n`);
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (pending.length === 0) return;
      fs.writeSync(out, Buffer.concat(pending));
      pending.length = 0;
      pendingBytes = 0;
    };
    // Whole lines only, holes dropped (forEachCastLineBytes), each line written as read.
    await forEachCastLineBytes(file, tailStart, before.size, (line) => {
      pending.push(Buffer.from(line), Buffer.from('\n'));
      pendingBytes += line.length + 1;
      if (pendingBytes >= MB) flush();
    });
    flush();
  } catch (error) {
    fs.closeSync(out);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(out);
  // A writer came back meanwhile (it was not finished after all): leave its cast alone.
  if (fs.statSync(file).size !== before.size) {
    fs.rmSync(temporary, { force: true });
    return 0;
  }
  fs.utimesSync(temporary, before.atime, before.mtime);
  fs.renameSync(temporary, file);
  fs.rmSync(path.join(path.dirname(file), ROTATION_STATE_FILE), { force: true });
  return Math.max(0, beforeDisk - diskBytes(file));
}

export interface FinishedRecordingsOptions {
  controlPath: string;
  listSessions: () => Session[];
  settings: () => RecordingSettings | undefined;
  /** Never trimmed while this says so (sessions of open tasks and of orchestrators). */
  keep?: (session: Session) => boolean;
  now?: () => number;
}

/** When a session finished: the latest of its output and its session.json (written on exit). */
export function sessionFinishedAt(session: Session, controlPath: string): number {
  const times = [Date.parse(session.lastModified), Date.parse(session.startedAt)];
  try {
    times.push(fs.statSync(path.join(controlPath, session.id, 'session.json')).mtimeMs);
  } catch {
    // Gone already: the listing's times decide.
  }
  const valid = times.filter((time) => Number.isFinite(time));
  return valid.length > 0 ? Math.max(...valid) : Number.NaN;
}

/** Why a finished session's recording is left whole, or null when it may be trimmed. */
export function finishedRecordingKeepReason(
  session: Session,
  keep?: (session: Session) => boolean
): string | null {
  if (session.status !== 'exited') return 'running';
  if (session.suspended) return 'suspended';
  // A shielded session whose tmux was lost or whose restore failed may come back on the next
  // start and go on writing this cast.
  if (session.shieldEnd === 'restore-failed' || session.shieldEnd === 'tmux-lost') {
    return 'shielded, may come back';
  }
  if (keep?.(session)) return 'needed by a task or an orchestrator';
  return null;
}

/**
 * Trims the recordings of sessions finished more than `finishedDays` ago (see the file
 * comment). Returns the ids trimmed and the disk freed.
 */
export async function trimFinishedRecordings(
  options: FinishedRecordingsOptions
): Promise<{ trimmed: string[]; freedBytes: number }> {
  const days = finishedDays(options.settings());
  const trimmed: string[] = [];
  let freedBytes = 0;
  if (days <= 0) return { trimmed, freedBytes };
  const now = (options.now ?? Date.now)();
  const cutoff = now - days * DAY_MS;
  // Finished long enough ago to be done with (an hour), not kept, and still worth trimming.
  const candidates: { id: string; finished: number; file: string; bytes: number }[] = [];
  for (const session of options.listSessions()) {
    if (!session.id || finishedRecordingKeepReason(session, options.keep)) continue;
    const finished = sessionFinishedAt(session, options.controlPath);
    if (!Number.isFinite(finished) || finished > now - FINISHED_MIN_AGE_MS) continue;
    const file = path.join(options.controlPath, session.id, 'stdout');
    let bytes: number;
    try {
      bytes = diskBytes(file);
    } catch {
      continue;
    }
    // Already trimmed (or small anyway): nothing to win.
    if (bytes <= FINISHED_KEEP_BYTES + 256 * 1024) continue;
    candidates.push({ id: session.id, finished, file, bytes });
  }
  // Oldest first: past finishedDays always; younger ones only while finished recordings take
  // more than half of controlWarnGB (2026-11-02: a night of tasks left 3.2 GB of finished
  // recordings under 2 days old and the doctor warned about it with nothing to do but wait).
  candidates.sort((a, b) => a.finished - b.finished);
  const budget = controlWarnBytes(options.settings()) / 2;
  let pending = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of candidates) {
    const aged = entry.finished <= cutoff;
    if (!aged && pending <= budget) break;
    try {
      const freed = await trimFinishedCast(
        entry.file,
        FINISHED_KEEP_BYTES,
        aged
          ? `[Untether: older output of this session was removed ${days} day(s) after it finished]`
          : '[Untether: older output of this session was removed to keep the disk use in bounds]'
      );
      pending -= entry.bytes;
      if (freed > 0) {
        trimmed.push(entry.id);
        freedBytes += freed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`could not trim the recording of ${entry.id}:`, error);
      }
    }
  }
  if (trimmed.length > 0) {
    logger.log(
      `trimmed the recordings of ${trimmed.length} finished session(s), ${Math.round(freedBytes / MB)} MB freed`
    );
  }
  return { trimmed, freedBytes };
}

/** What uses CONTROL_DIR's disk, per entry (a session folder, uploads, a state file). */
export interface ControlDirUsage {
  totalBytes: number;
  entries: { name: string; bytes: number }[];
}

function treeBytes(target: string, depth = 0): number {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return stat.blocks * 512;
  let bytes = stat.blocks * 512;
  if (depth > 4) return bytes;
  for (const entry of fs.readdirSync(target)) {
    try {
      bytes += treeBytes(path.join(target, entry), depth + 1);
    } catch {
      // Gone meanwhile.
    }
  }
  return bytes;
}

/** Real disk use of CONTROL_DIR, biggest entries first. */
export function controlDirUsage(controlDir: string): ControlDirUsage {
  const entries: { name: string; bytes: number }[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(controlDir);
  } catch {
    return { totalBytes: 0, entries };
  }
  for (const name of names) {
    try {
      entries.push({ name, bytes: treeBytes(path.join(controlDir, name)) });
    } catch {
      // Gone meanwhile.
    }
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries };
}
