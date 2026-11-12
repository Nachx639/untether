/**
 * Input diagnostics on the server (2026-11-11): what devices measure about their keyboard and
 * terminal while the mode is on (shared/input-diagnostics.ts). Each batch is checked field by
 * field (numbers and fixed words only), written to the server log as `[FE] input-diag` lines
 * (read with ./scripts/utlog.sh or /logs) and kept as JSON lines for the summary `ut diag input`
 * prints. The file is bounded: past `maxBytes` it becomes `input.1.jsonl` (one older file kept).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DIAG_AGENTS,
  DIAG_GAP_STUCK_MS,
  DIAG_KEYBOARD_SOURCES,
  DIAG_MAX_RECORDS_PER_BATCH,
  DIAG_MAX_UA_LENGTH,
  DIAG_SCROLL_PLACES,
  type DiagAgent,
  type DiagContext,
  type DiagKeyboardRecord,
  type DiagRecord,
  percentile,
} from '../../shared/input-diagnostics.js';

export const INPUT_DIAG_FILE = 'input.jsonl';
export const INPUT_DIAG_OLDER_FILE = 'input.1.jsonl';

/** A record as kept: with the device's browser, cut short. */
export type StoredDiagRecord = DiagRecord & { ua: string };

export class DiagInputError extends Error {}

const WORD = /^[a-z0-9][a-z0-9._/-]{0,39}$/;

function num(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new DiagInputError('not a number');
  return Math.round(Math.min(max, Math.max(0, value)) * 10) / 10;
}

function word(value: unknown): string {
  if (typeof value !== 'string' || !WORD.test(value)) throw new DiagInputError('not a word');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DiagInputError('not an allowed value');
  }
  return value as T;
}

function context(raw: Record<string, unknown>): DiagContext {
  return { agent: oneOf(raw.agent, DIAG_AGENTS), net: word(raw.net), look: word(raw.look) };
}

const MAX_PX = 20_000;
const MAX_MS = 600_000;
const MAX_COUNT = 1_000_000;

/** One record rebuilt from its known fields; anything else it carried is dropped. */
function cleanRecord(raw: unknown): DiagRecord {
  if (!raw || typeof raw !== 'object') throw new DiagInputError('not a record');
  const r = raw as Record<string, unknown>;
  const at = num(r.at, Number.MAX_SAFE_INTEGER);
  switch (r.kind) {
    case 'kbd':
      return {
        kind: 'kbd',
        at,
        src: oneOf(r.src, DIAG_KEYBOARD_SOURCES),
        ih: num(r.ih, MAX_PX),
        vvh: num(r.vvh, MAX_PX),
        vvt: num(r.vvt, MAX_PX),
        w: num(r.w, MAX_PX),
        base: num(r.base, MAX_PX),
        safari: num(r.safari, MAX_PX),
        baseline: num(r.baseline, MAX_PX),
        applied: num(r.applied, MAX_PX),
        edit: num(r.edit, 1),
      };
    case 'gap':
      return {
        kind: 'gap',
        id: num(r.id, Number.MAX_SAFE_INTEGER),
        at,
        ...context(r),
        ms: num(r.ms, 24 * 3_600_000),
        px: num(r.px, MAX_PX),
        open: num(r.open, 1),
      };
    case 'keys':
      return {
        kind: 'keys',
        at,
        ...context(r),
        n: num(r.n, MAX_COUNT),
        p50: num(r.p50, MAX_MS),
        p95: num(r.p95, MAX_MS),
        max: num(r.max, MAX_MS),
      };
    case 'scroll':
      return {
        kind: 'scroll',
        at,
        ...context(r),
        where: oneOf(r.where, DIAG_SCROLL_PLACES),
        frames: num(r.frames, MAX_COUNT),
        p50: num(r.p50, MAX_MS),
        p95: num(r.p95, MAX_MS),
        slow: num(r.slow, MAX_COUNT),
      };
    case 'open':
      return { kind: 'open', at, ...context(r), ms: num(r.ms, MAX_MS) };
    case 'ws':
      return { kind: 'ws', at, ...context(r), ms: num(r.ms, 24 * 3_600_000) };
    default:
      throw new DiagInputError('unknown kind');
  }
}

/** A batch as the server keeps it. Throws DiagInputError on anything it does not know. */
export function cleanDiagBatch(raw: unknown): StoredDiagRecord[] {
  if (!raw || typeof raw !== 'object') throw new DiagInputError('not a batch');
  const { ua, records } = raw as { ua?: unknown; records?: unknown };
  if (typeof ua !== 'string') throw new DiagInputError('no user agent');
  if (!Array.isArray(records) || records.length > DIAG_MAX_RECORDS_PER_BATCH) {
    throw new DiagInputError('too many records');
  }
  // Printable ASCII only: it goes to a log line.
  const browser = ua.replace(/[^\x20-\x7e]/g, '').slice(0, DIAG_MAX_UA_LENGTH);
  return records.map((record) => ({ ...cleanRecord(record), ua: browser }));
}

/** The browser of a user agent in a word or two: "Chrome iOS", "Safari iOS", "Chrome"… */
export function browserName(ua: string): string {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
  const name = /CriOS/.test(ua)
    ? 'Chrome'
    : /FxiOS|Firefox/.test(ua)
      ? 'Firefox'
      : /EdgiOS|Edg\//.test(ua)
        ? 'Edge'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'other';
  return ios ? `${name} iOS` : /Android/.test(ua) ? `${name} Android` : name;
}

/** The log line of a record: "kbd src=vv-resize ih=664 vvh=327 … · Chrome iOS". */
export function diagLogLine(record: StoredDiagRecord): string {
  const { kind, at: _at, ua, ...fields } = record;
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  return `${kind} ${parts.join(' ')} · ${browserName(ua)}`;
}

export interface InputDiagStoreOptions {
  dir: string;
  /** The file rotates past this size (default 4 MB: weeks of a phone left measuring). */
  maxBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
  onError?: (message: string) => void;
}

interface Stat {
  /** Minutes (or events) measured, and what they add up to. */
  samples: number;
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface DiagGroupSummary {
  name: string;
  /** Key presses: minutes measured, keys, median of the minutes' p50 and p95, the worst. */
  keys: Stat | null;
  /** Scroll frames by place; `slowPct`: frames over 50 ms, in percent. */
  scroll: Partial<Record<'terminal' | 'list', Stat & { slowPct: number }>>;
  /** Session opens: how many, median and p95 ms to the first paint. */
  open: Stat | null;
}

export interface DiagSummary {
  since: string;
  until: string;
  records: number;
  browsers: string[];
  byAgent: DiagGroupSummary[];
  byNetwork: DiagGroupSummary[];
  byLook: DiagGroupSummary[];
  /** WebSocket reconnections: how many, median and longest time down (ms). */
  reconnections: { count: number; p50: number; max: number };
  /** Keyboard samples: how many, how many where the two ways disagree by over 20 px, the last. */
  keyboard: {
    samples: number;
    disagree: number;
    last: (DiagKeyboardRecord & { ua: string }) | null;
  };
  /**
   * The keyboard's gap applied with nothing editable focused: how many times, how many lasted
   * over DIAG_GAP_STUCK_MS (not a keyboard closing), the longest (ms) and its height (px).
   */
  gaps: { count: number; stuck: number; longest: number; longestPx: number };
}

/**
 * Gap stretches as the device saw them: a long one leaves in several batches (`open`), each
 * with the time since the batch before, so the pieces of one stretch (same browser, same `id`)
 * are added up. Never by browser alone: tabs and phones share one.
 */
function gapStretches(rows: StoredDiagRecord[]): Array<{ ms: number; px: number }> {
  const stretches: Array<{ ms: number; px: number }> = [];
  const running = new Map<string, { ms: number; px: number }>();
  for (const row of rows) {
    if (row.kind !== 'gap') continue;
    const key = `${row.ua}|${row.id}`;
    const current = running.get(key) ?? { ms: 0, px: 0 };
    current.ms += row.ms;
    current.px = Math.max(current.px, row.px);
    if (row.open) {
      running.set(key, current);
    } else {
      running.delete(key);
      stretches.push(current);
    }
  }
  return [...stretches, ...running.values()];
}

const median = (values: number[]) => percentile(values, 0.5);

function groupSummary(name: string, records: StoredDiagRecord[]): DiagGroupSummary {
  const keys = records.filter((r) => r.kind === 'keys');
  const opens = records.filter((r) => r.kind === 'open');
  const scroll: DiagGroupSummary['scroll'] = {};
  for (const where of DIAG_SCROLL_PLACES) {
    const rows = records.filter((r) => r.kind === 'scroll' && r.where === where) as Array<
      Extract<StoredDiagRecord, { kind: 'scroll' }>
    >;
    if (!rows.length) continue;
    const frames = rows.reduce((sum, r) => sum + r.frames, 0);
    const slow = rows.reduce((sum, r) => sum + r.slow, 0);
    scroll[where] = {
      samples: rows.length,
      count: frames,
      p50: median(rows.map((r) => r.p50)),
      p95: median(rows.map((r) => r.p95)),
      max: Math.max(...rows.map((r) => r.p95)),
      slowPct: frames ? Math.round((slow / frames) * 1000) / 10 : 0,
    };
  }
  return {
    name,
    keys: keys.length
      ? {
          samples: keys.length,
          count: keys.reduce((sum, r) => sum + r.n, 0),
          p50: median(keys.map((r) => r.p50)),
          p95: median(keys.map((r) => r.p95)),
          max: Math.max(...keys.map((r) => r.max)),
        }
      : null,
    scroll,
    open: opens.length
      ? {
          samples: opens.length,
          count: opens.length,
          p50: median(opens.map((r) => r.ms)),
          p95: percentile(
            opens.map((r) => r.ms),
            0.95
          ),
          max: Math.max(...opens.map((r) => r.ms)),
        }
      : null,
  };
}

function grouped(
  records: StoredDiagRecord[],
  by: keyof DiagContext,
  order: readonly string[] = []
): DiagGroupSummary[] {
  const groups = new Map<string, StoredDiagRecord[]>();
  for (const record of records) {
    if (record.kind === 'kbd' || record.kind === 'ws' || record.kind === 'gap') continue;
    const name = record[by];
    groups.set(name, [...(groups.get(name) ?? []), record]);
  }
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, rows]) => groupSummary(name, rows));
}

/** What the records between two times say, by agent, by network and by interface style. */
export function summarizeDiag(
  records: StoredDiagRecord[],
  since: number,
  until: number
): DiagSummary {
  const rows = records.filter((r) => r.at >= since && r.at <= until);
  const sockets = rows.filter((r) => r.kind === 'ws');
  const keyboard = rows.filter((r) => r.kind === 'kbd');
  const gaps = gapStretches(rows);
  const longestGap = gaps.reduce((worst, gap) => (gap.ms > worst.ms ? gap : worst), {
    ms: 0,
    px: 0,
  });
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    records: rows.length,
    browsers: [...new Set(rows.map((r) => browserName(r.ua)))].sort(),
    byAgent: grouped(rows, 'agent', DIAG_AGENTS as readonly DiagAgent[]),
    byNetwork: grouped(rows, 'net'),
    byLook: grouped(rows, 'look'),
    reconnections: {
      count: sockets.length,
      p50: median(sockets.map((r) => r.ms)),
      max: sockets.length ? Math.max(...sockets.map((r) => r.ms)) : 0,
    },
    keyboard: {
      samples: keyboard.length,
      disagree: keyboard.filter((r) => Math.abs(r.safari - r.baseline) > 20).length,
      last: keyboard.length ? keyboard[keyboard.length - 1] : null,
    },
    gaps: {
      count: gaps.length,
      stuck: gaps.filter((gap) => gap.ms > DIAG_GAP_STUCK_MS).length,
      longest: longestGap.ms,
      longestPx: longestGap.px,
    },
  };
}

const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;

function groupLines(title: string, groups: DiagGroupSummary[]): string[] {
  if (!groups.length) return [];
  const lines = [title];
  for (const group of groups) {
    const parts: string[] = [];
    if (group.keys) {
      parts.push(
        `keys ${group.keys.count} (p50 ${ms(group.keys.p50)}, p95 ${ms(group.keys.p95)}, max ${ms(group.keys.max)})`
      );
    }
    for (const where of DIAG_SCROLL_PLACES) {
      const s = group.scroll[where];
      if (s) {
        parts.push(
          `${where} scroll ${s.count} frames (p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, ${s.slowPct} % over 50 ms)`
        );
      }
    }
    if (group.open) {
      parts.push(
        `opens ${group.open.count} (p50 ${ms(group.open.p50)}, p95 ${ms(group.open.p95)})`
      );
    }
    lines.push(`  ${group.name.padEnd(14)} ${parts.join(' · ') || 'nothing measured'}`);
  }
  return lines;
}

/** The summary as `ut diag input` prints it. */
export function formatDiagSummary(summary: DiagSummary): string {
  if (!summary.records) {
    return [
      `No input diagnostics between ${summary.since} and ${summary.until}.`,
      'Turn the mode on in the device: Settings → Advanced → Input diagnostics (or add ?kbdebug=1 to the address).',
    ].join('\n');
  }
  const { keyboard, reconnections } = summary;
  const lines = [
    `Input diagnostics, ${summary.since} → ${summary.until}: ${summary.records} records · ${summary.browsers.join(', ')}`,
    'Key latency: ms from the key leaving to the first frame after its echo arrived (medians of the minutes measured).',
    ...groupLines('By agent', summary.byAgent),
    ...groupLines('By network', summary.byNetwork),
    ...groupLines('By interface style', summary.byLook),
    reconnections.count
      ? `WebSocket reconnections: ${reconnections.count} (median ${ms(reconnections.p50)} down, longest ${ms(reconnections.max)})`
      : 'WebSocket reconnections: none',
  ];
  if (keyboard.last) {
    const k = keyboard.last;
    lines.push(
      `Keyboard samples: ${keyboard.samples}, ${keyboard.disagree} where the two ways differ by over 20 px`,
      `  last (${browserName(k.ua)}, ${k.src}): innerHeight ${k.ih}, viewport ${k.vvh}+${k.vvt}, tallest ${k.base} → safari ${k.safari}, baseline ${k.baseline}, applied ${k.applied}, field ${k.edit ? 'focused' : 'not focused'}`
    );
  } else {
    lines.push('Keyboard samples: none');
  }
  const { gaps } = summary;
  lines.push(
    gaps.count
      ? `Keyboard gap with no field focused: ${gaps.count} times, ${gaps.stuck} over ${ms(DIAG_GAP_STUCK_MS)} (the gap with no keyboard); longest ${ms(gaps.longest)} at ${gaps.longestPx} px`
      : 'Keyboard gap with no field focused: never'
  );
  return lines.join('\n');
}

/** "24h", "30m", "7d", "90s" → ms; null for anything else. */
export function parseSince(text: string): number | null {
  const match = /^(\d{1,5})([smhd])$/.exec(text.trim());
  if (!match) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  return Number(match[1]) * unit;
}

export class InputDiagStore {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly onError: (message: string) => void;

  constructor(options: InputDiagStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  private get file(): string {
    return path.join(this.dir, INPUT_DIAG_FILE);
  }

  private get olderFile(): string {
    return path.join(this.dir, INPUT_DIAG_OLDER_FILE);
  }

  /**
   * Checks, logs and keeps a batch; returns how many records it kept. Throws DiagInputError.
   * Each record gets this server's time: a phone's clock can be off, and the summary asks
   * "the last 24 h" of the server's.
   */
  record(raw: unknown): number {
    const at = this.now();
    const records = cleanDiagBatch(raw).map((record) => ({ ...record, at }));
    if (!records.length) return 0;
    for (const record of records) this.log(diagLogLine(record));
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        // No file yet.
      }
      if (size >= this.maxBytes) fs.renameSync(this.file, this.olderFile);
      fs.appendFileSync(this.file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      this.onError(`input diagnostics not kept: ${error instanceof Error ? error.message : error}`);
    }
    return records.length;
  }

  /** Every record kept, oldest first; a line that does not parse is skipped. */
  read(): StoredDiagRecord[] {
    const records: StoredDiagRecord[] = [];
    for (const file of [this.olderFile, this.file]) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line) as StoredDiagRecord);
        } catch {
          // A line cut by a crash mid-write.
        }
      }
    }
    return records;
  }

  summary(sinceMs: number): DiagSummary {
    const until = this.now();
    return summarizeDiag(this.read(), until - sinceMs, until);
  }
}
