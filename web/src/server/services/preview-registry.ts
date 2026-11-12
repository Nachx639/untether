/**
 * Dev-server previews as persistent items (2026-10-03). They used to belong to the session
 * that announced them and vanished when it ended or was restarted (new session id), so
 * the user had to open them again. Now there is one entry per loopback port (dev servers are
 * per port), kept in `previews.json` next to the control dir (~/.untether/previews.json;
 * a QA server with UNTETHER_CONTROL_DIR=~/.untether-qa/control gets its own file).
 *
 * Entries come from `ut open`, from dev-server URLs announced in a session's output, or
 * are added by hand; each of those upserts by port and brings the entry to the top. The
 * originating session is only a link. The health monitor (preview-health.ts) marks each
 * port live/down and records when it last answered; unpinned entries down for more than
 * 7 days are removed, pinned ones never.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PreviewPort, PreviewSource } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('preview-registry');

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))(\/[^\s'"<>)\]]*)?/gi;
/**
 * What a dev server prints RIGHT BEFORE its URL: "➜  Local:   http://…", "Local URL:", "url:",
 * "Listening on", "Uvicorn running on", "Server running at", "ready on", "available at",
 * "Starting development server at", "Started development server:", "open your browser on",
 * "Serving HTTP on … port 8000 (http://…)". It has to be next to the URL: anywhere else on the
 * line wasn't enough on 2026-10-03, when a `curl http://127.0.0.1:4020/api/previews` in a Claude
 * session (a TUI: its rows run together once the cursor moves are stripped) was registered as
 * a preview of Untether itself.
 */
const LEAD = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${[
    'local(?:\\s+url)?\\s*:?',
    'network\\s*:',
    'loopback\\s*:',
    'url\\s*:',
    '(?:listening|running|ready|serving|available|waiting|started|live)\\s+(?:at|on)',
    'started\\s+(?:[\\p{L}-]+\\s+)?server(?:\\s+(?:at|on))?\\s*:?',
    'server\\s+(?:address\\s*:|(?:(?:is\\s+)?(?:running|started|listening|available)\\s+)?(?:at|on))',
    'open\\s+your\\s+browser\\s+(?:at|on)',
    'port\\s+\\d{2,5}\\s*\\(',
    '[➜→]',
  ].join('|')})\\s*[\\[(<]?\\s*$`,
  'iu'
);
/** A line that is just the URL (Gatsby, Jupyter): only bullets/box drawing/a [tag] before it… */
const ONLY_DECORATION_BEFORE = /^[\s>•·*\-–—|│┃┆➜→⎿]*(?:\[[^\]]{1,40}\]\s*)?$/u;
/** …and nothing after it but punctuation or a "(note)". */
const ONLY_NOTE_AFTER = /^[\s.,;:]*(?:\([^)]*\))?[\s|│┃]*$/u;

/** Unpinned previews whose dev server has been down this long are removed. */
export const PREVIEW_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A preview the user deleted stays deleted for the session that announced it this long: that
 * session printing the same URL again doesn't bring it back.
 */
export const PREVIEW_DISMISS_MS = PREVIEW_STALE_MS;
const MAX_DISMISSED = 200;
/** At most this many previews; the oldest unpinned one makes room. */
export const MAX_PREVIEWS = 50;
/** A live preview's "last seen" is written to disk at most this often (it changes every check). */
const SEEN_PERSIST_MS = 10 * 60 * 1000;
const SAVE_DELAY_MS = 200;
const CUSTOM_NAME_MAX = 80;

/** Dev-server ports announced in a chunk of terminal output (escape codes removed). */
export function detectPreviewPorts(text: string): Array<{ port: number; url: string }> {
  const found: Array<{ port: number; url: string }> = [];
  const plain = text.replace(ANSI, '');
  for (const line of plain.split(/\r?\n|\r/)) {
    for (const match of line.matchAll(LOCAL_URL)) {
      const at = match.index ?? 0;
      const announced =
        LEAD.test(line.slice(Math.max(0, at - 60), at)) ||
        (ONLY_DECORATION_BEFORE.test(line.slice(0, at)) &&
          ONLY_NOTE_AFTER.test(line.slice(at + match[0].length)));
      if (!announced) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
      if (found.some((entry) => entry.port === port)) continue;
      found.push({ port, url: match[0].replace(/[.,;:]+$/, '') });
    }
  }
  return found;
}

/**
 * A local URL in terminal output names a page only some of the time: an agent running
 * `curl localhost:3000/api/items` or printing a `/feed.ics` link would make the preview open
 * raw data. Such paths are not taken; the preview keeps its page (or `/`).
 */
export function detectedPagePath(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const pathname = target.split(/[?#]/)[0] ?? '';
  if (/^\/(api|graphql|trpc|rpc|_next|__)(\/|$)/i.test(pathname)) return undefined;
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  if (extension && !['html', 'htm', 'php'].includes(extension)) return undefined;
  return target;
}

/** `ut open` argument: "5173", ":5173", "localhost:5173/x", "http://127.0.0.1:5173/x". */
export function parseOpenTarget(value: string): { port: number; path: string } | null {
  const text = value.trim();
  const bare = /^:?(\d{2,5})(\/.*)?$/.exec(text);
  if (bare) return { port: Number(bare[1]), path: bare[2] || '/' };
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return { port, path: `${url.pathname}${url.search}${url.hash}` || '/' };
  } catch {
    return null;
  }
}

/**
 * `~/.untether/control` → `~/.untether/previews.json`, `~/.untether-qa/control` →
 * `~/.untether-qa/previews.json`: each control dir its own file. A control dir not named
 * "control" (a throwaway `mktemp -d /tmp/vtg.XXXX`) keeps it inside, so test servers never
 * share a /tmp/previews.json.
 */
export function previewsFileFor(controlDir: string): string {
  const dir = path.resolve(controlDir);
  return path.basename(dir) === 'control'
    ? path.join(path.dirname(dir), 'previews.json')
    : path.join(dir, 'previews.json');
}

/**
 * Ids start with a letter: the app's view is `/preview/<id>`, and `/preview/<digits>…` is
 * the old proxy path the main origin answers with 404.
 */
export const PREVIEW_ID_RE = /^p[a-z0-9]{6,20}$/;
export const isPreviewId = (value: unknown): value is string =>
  typeof value === 'string' && PREVIEW_ID_RE.test(value);

export function newPreviewId(): string {
  let id = 'p';
  for (const byte of randomBytes(8)) id += (byte % 36).toString(36);
  return id;
}

/** What previews.json keeps for each preview. */
export interface PreviewRecord {
  id: string;
  port: number;
  /** Page inside the app that `ut open` / the announced URL named. */
  path: string;
  /** The app's page <title> (health check). */
  title?: string;
  /** Name given by the user (Rename); wins over the title. */
  customName?: string;
  createdAt: number;
  /** Last time its dev server answered. */
  lastSeenAt?: number;
  /** Last `ut open`, announcement or manual add: the list's order. */
  lastOpenedAt: number;
  /** The session that opened or announced it last: just a link, it may be gone. */
  sessionId?: string;
  sessionName?: string;
  pinned: boolean;
  source: PreviewSource;
}

export interface PreviewOpenEvent {
  id: string;
  sessionId: string;
  port: number;
  path: string;
}

export interface PreviewRegistryOptions {
  /** previews.json; null/undefined keeps the registry in memory (tests). */
  file?: string | null;
  now?: () => number;
  /** Debounce of disk writes (0 writes at once). */
  saveDelayMs?: number;
}

function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || !value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

/** A record read from disk, or null when it isn't one we wrote. */
function readRecord(raw: unknown): PreviewRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const port = Number(r.port);
  if (!isPreviewId(r.id) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const createdAt = num(r.createdAt) ?? Date.now();
  return {
    id: r.id,
    port,
    path: normalizePath(r.path),
    title: str(r.title),
    customName: str(r.customName),
    createdAt,
    lastSeenAt: num(r.lastSeenAt),
    lastOpenedAt: num(r.lastOpenedAt) ?? createdAt,
    sessionId: str(r.sessionId),
    sessionName: str(r.sessionName),
    pinned: r.pinned === true,
    source: r.source === 'ut-open' || r.source === 'manual' ? r.source : 'detected',
  };
}

export class PreviewRegistry extends EventEmitter {
  private entries = new Map<string, PreviewRecord>();
  /** Last chars of the previous chunk: a URL can be split across two PTY writes. */
  private tails = new Map<string, string>();
  /**
   * Previews the user deleted, by `port:sessionId` → when (persisted). 2026-10-03: tmux redraws
   * the whole screen when a shielded session re-attaches after a restart, and Claude Code
   * re-renders its history on a resize (the phone keyboard): both re-announced deleted
   * previews, which came back after every deploy.
   */
  private dismissed = new Map<string, number>();
  /** Latest health check per port (not persisted: checked again right after a start). */
  private health = new Map<number, { up: boolean; title?: string }>();
  private seenSavedAt = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | null = null;
  private sessionNameOf: (sessionId: string) => string | undefined = () => undefined;
  /** Why a port can't be a preview (Untether's own ports, denied ones), or null. */
  private portError: (port: number) => string | null = () => null;
  /** Checks a newly announced port before it becomes an entry (is it Untether?). */
  private vetNewPort: ((port: number) => Promise<boolean>) | null = null;
  /** Ports being checked right now (each chunk also re-reads the previous one's tail). */
  private vetting = new Set<number>();
  private readonly file: string | null;
  private readonly now: () => number;

  constructor(private options: PreviewRegistryOptions = {}) {
    super();
    this.file = options.file ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Names entries after their session when they are announced or opened. */
  setSessionNames(nameOf: (sessionId: string) => string | undefined): void {
    this.sessionNameOf = nameOf;
  }

  /**
   * Ports that are never previews: Untether's own (main + preview origin), any other
   * Untether server found on this Mac, UNTETHER_PREVIEW_DENY_PORTS. Announcements of
   * them are ignored and `upsert` refuses them (2026-10-03: a `curl` to 4020 in a session's
   * output became a preview of Untether itself).
   */
  setPortFilter(portError: (port: number) => string | null): void {
    this.portError = portError;
  }

  /**
   * Newly announced ports wait for this check before they become entries: a session that
   * starts an Untether server prints "running on http://localhost:4030" like any dev server,
   * and only an answer from the port tells them apart. Ports already listed skip it.
   */
  setNewPortVetter(vet: (port: number) => Promise<boolean>): void {
    this.vetNewPort = vet;
  }

  /**
   * Removes entries whose port the filter refuses (kept from before the filter, or a port
   * found to be Untether later). Returns what was removed.
   */
  removeRefused(): Array<{ id: string; port: number; reason: string }> {
    const removed: Array<{ id: string; port: number; reason: string }> = [];
    for (const entry of Array.from(this.entries.values())) {
      const reason = this.portError(entry.port);
      if (!reason) continue;
      this.remove(entry.id);
      removed.push({ id: entry.id, port: entry.port, reason });
      logger.log(`removed preview ${entry.id} of port ${entry.port}: ${reason}`);
    }
    return removed;
  }

  // ---- persistence ----------------------------------------------------------------------

  /**
   * Reads previews.json. A file that isn't valid JSON is kept aside as
   * `previews.json.corrupt-<time>` and the registry starts empty.
   */
  load(): { loaded: number; corrupt: boolean } {
    if (!this.file) return { loaded: 0, corrupt: false };
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { loaded: 0, corrupt: false };
    }
    let list: unknown;
    try {
      const parsed = JSON.parse(text) as { previews?: unknown };
      list = parsed?.previews;
      if (!Array.isArray(list)) throw new Error('no previews array');
    } catch (error) {
      const backup = `${this.file}.corrupt-${this.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch {
        // Unreadable and unmovable: the next save replaces it.
      }
      logger.warn(`previews.json was not valid (${error}); kept as ${backup}, starting empty`);
      return { loaded: 0, corrupt: true };
    }
    this.entries.clear();
    for (const raw of list as unknown[]) {
      const record = readRecord(raw);
      if (!record || this.byPort(record.port)) continue;
      this.entries.set(record.id, record);
    }
    this.dismissed.clear();
    const dismissed = (JSON.parse(text) as { dismissed?: unknown }).dismissed;
    if (Array.isArray(dismissed)) {
      for (const item of dismissed as Array<Record<string, unknown>>) {
        const { port, sessionId, at } = item ?? {};
        if (typeof port !== 'number' || typeof sessionId !== 'string' || typeof at !== 'number') {
          continue;
        }
        if (this.now() - at < PREVIEW_DISMISS_MS) this.dismissed.set(`${port}:${sessionId}`, at);
      }
    }
    return { loaded: this.entries.size, corrupt: false };
  }

  /** Writes previews.json atomically (temp file + rename): a crash never leaves half a file. */
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const dismissed = [...this.dismissed].map(([key, at]) => {
      const split = key.indexOf(':');
      return { port: Number(key.slice(0, split)), sessionId: key.slice(split + 1), at };
    });
    const body = `${JSON.stringify({ version: 1, previews: this.all(), dismissed }, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn(`could not save previews.json: ${error}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // never written
      }
    }
  }

  /** Pending changes to disk now (shutdown). */
  flush(): void {
    if (this.saveTimer) this.save();
  }

  private scheduleSave(): void {
    if (!this.file) return;
    const delay = this.options.saveDelayMs ?? SAVE_DELAY_MS;
    if (delay <= 0) {
      this.save();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), delay);
    this.saveTimer.unref?.();
  }

  private changed(id: string): void {
    this.scheduleSave();
    this.emit('changed', id);
  }

  // ---- queries --------------------------------------------------------------------------

  /** Every preview, the most recently opened first. */
  all(): PreviewRecord[] {
    return [...this.entries.values()]
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map((entry) => ({ ...entry }));
  }

  get(id: string): PreviewRecord | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  byPort(port: number): PreviewRecord | undefined {
    for (const entry of this.entries.values()) if (entry.port === port) return entry;
    return undefined;
  }

  /** Every registered port (the health monitor checks only these). */
  ports(): number[] {
    return [...this.entries.values()].map((entry) => entry.port);
  }

  stateOf(port: number): 'live' | 'down' | undefined {
    const health = this.health.get(port);
    return health ? (health.up ? 'live' : 'down') : undefined;
  }

  /** The previews a session opened or announced last (its preview chips), newest first. */
  forSession(sessionId: string): PreviewPort[] {
    return this.all()
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => {
        const state = this.stateOf(entry.port);
        const title = entry.customName || entry.title;
        return {
          id: entry.id,
          port: entry.port,
          source: entry.source,
          at: entry.lastOpenedAt,
          ...(state ? { state } : {}),
          ...(title ? { title } : {}),
        };
      });
  }

  // ---- changes --------------------------------------------------------------------------

  /**
   * One entry per port: a new announcement or `ut open` of a known port updates its session
   * and page and brings it to the top. Returns the entry and whether it was created.
   */
  upsert(
    port: number,
    info: { path?: string; sessionId?: string; source: PreviewSource }
  ): { entry: PreviewRecord; created: boolean } {
    // Callers check first (and answer the user); this is the last line of defense.
    const refused = this.portError(port);
    if (refused) throw new Error(`Port ${port} can't be a preview: ${refused}`);
    const now = this.now();
    const sessionName = info.sessionId ? this.sessionNameOf(info.sessionId) : undefined;
    const existing = this.byPort(port);
    if (existing) {
      const otherSession = info.sessionId !== undefined && info.sessionId !== existing.sessionId;
      const otherPath = info.path !== undefined && normalizePath(info.path) !== existing.path;
      // The same session announcing it again (a redraw, a re-render, its dev server restarting)
      // doesn't move it to the top: only another session, `ut open` or opening it by hand do.
      const repeat = info.source === 'detected' && !otherSession;
      if (!repeat) existing.lastOpenedAt = now;
      if (info.path !== undefined) existing.path = normalizePath(info.path);
      if (info.source !== 'detected') existing.source = info.source;
      if (info.sessionId !== undefined) {
        existing.sessionId = info.sessionId;
        if (sessionName) existing.sessionName = sessionName;
      }
      // Another session's dev server on the same port is probably another app: read its
      // title again.
      if (otherSession) {
        existing.title = undefined;
        this.health.delete(port);
      }
      if (otherSession || otherPath || info.source !== 'detected') this.changed(existing.id);
      else if (!repeat) this.scheduleSave();
      return { entry: { ...existing }, created: false };
    }
    let id = newPreviewId();
    while (this.entries.has(id)) id = newPreviewId();
    const entry: PreviewRecord = {
      id,
      port,
      path: normalizePath(info.path),
      createdAt: now,
      lastOpenedAt: now,
      pinned: false,
      source: info.source,
      ...(info.sessionId ? { sessionId: info.sessionId } : {}),
      ...(sessionName ? { sessionName } : {}),
    };
    this.entries.set(id, entry);
    this.evictOverflow();
    this.changed(id);
    return { entry: { ...entry }, created: true };
  }

  private evictOverflow(): void {
    if (this.entries.size <= MAX_PREVIEWS) return;
    const unpinned = this.all().filter((entry) => !entry.pinned);
    while (this.entries.size > MAX_PREVIEWS && unpinned.length) {
      const oldest = unpinned.pop();
      if (oldest) this.remove(oldest.id);
    }
  }

  trackOutput(sessionId: string, data: string): void {
    // Cheap pre-check: most output never mentions a local URL.
    const tail = this.tails.get(sessionId) ?? '';
    const text = tail + data;
    this.tails.set(sessionId, data.slice(-200));
    if (!/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]/.test(text)) return;
    for (const { port, url } of detectPreviewPorts(text)) {
      if (this.portError(port) || this.isDismissed(port, sessionId)) continue;
      const path = detectedPagePath(parseOpenTarget(url)?.path);
      const register = () => {
        if (!this.portError(port)) this.upsert(port, { sessionId, source: 'detected', path });
      };
      if (this.vetNewPort && !this.byPort(port)) {
        if (this.vetting.has(port)) continue;
        this.vetting.add(port);
        this.vetNewPort(port)
          .then(
            (ok) => ok && register(),
            () => register()
          )
          .finally(() => this.vetting.delete(port));
      } else {
        register();
      }
    }
  }

  /** The session ended: its output buffer goes, its previews stay. */
  forgetSessionOutput(sessionId: string): void {
    this.tails.delete(sessionId);
  }

  /** `ut open`: remember the port and ask viewers to show it. */
  open(sessionId: string, port: number, path = '/'): PreviewOpenEvent {
    this.clearDismissals(port);
    const { entry } = this.upsert(port, { sessionId, source: 'ut-open', path });
    const event = { id: entry.id, sessionId, port, path: normalizePath(path) };
    this.emit('open', event);
    return event;
  }

  /** "+ Add preview" in the list: a port or a localhost URL, no session. */
  addManual(port: number, path = '/'): PreviewRecord {
    this.clearDismissals(port);
    return this.upsert(port, { source: 'manual', path }).entry;
  }

  /** Pin/unpin and rename (an empty name goes back to the page title). */
  update(
    id: string,
    patch: { pinned?: boolean; customName?: string | null }
  ): PreviewRecord | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (patch.pinned !== undefined) entry.pinned = patch.pinned;
    if (patch.customName !== undefined) {
      const name = (patch.customName ?? '').trim().slice(0, CUSTOM_NAME_MAX);
      if (name) entry.customName = name;
      else delete entry.customName;
    }
    this.changed(id);
    return { ...entry };
  }

  /**
   * The user deleted a preview: it goes, and the session that announced it can't bring it back
   * by printing the URL again. `ut open` and "+ Añadir vista previa" still can.
   */
  dismiss(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.sessionId) {
      this.dismissed.set(`${entry.port}:${entry.sessionId}`, this.now());
      while (this.dismissed.size > MAX_DISMISSED) {
        const oldest = this.dismissed.keys().next().value;
        if (oldest === undefined) break;
        this.dismissed.delete(oldest);
      }
    }
    return this.remove(id);
  }

  private isDismissed(port: number, sessionId: string): boolean {
    const at = this.dismissed.get(`${port}:${sessionId}`);
    return at !== undefined && this.now() - at < PREVIEW_DISMISS_MS;
  }

  /** Opened on purpose: earlier deletions of this port no longer hold it back. */
  private clearDismissals(port: number): void {
    for (const key of Array.from(this.dismissed.keys())) {
      if (key.startsWith(`${port}:`)) this.dismissed.delete(key);
    }
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.health.delete(entry.port);
    this.seenSavedAt.delete(id);
    this.changed(id);
    return true;
  }

  /** Result of a health check; true when it changed what rows show. */
  setHealth(port: number, up: boolean, title?: string): boolean {
    const entry = this.byPort(port);
    const before = this.health.get(port);
    const nextTitle = title ?? before?.title ?? entry?.title;
    this.health.set(port, { up, title: nextTitle });
    const stateChanged = before?.up !== up;
    let titleChanged = false;
    if (entry) {
      const now = this.now();
      if (up) entry.lastSeenAt = now;
      if (title && title !== entry.title) {
        entry.title = title;
        titleChanged = true;
      }
      const lastSaved = this.seenSavedAt.get(entry.id) ?? 0;
      if (stateChanged || titleChanged || (up && now - lastSaved > SEEN_PERSIST_MS)) {
        this.seenSavedAt.set(entry.id, now);
        this.scheduleSave();
      }
    }
    return stateChanged || titleChanged;
  }

  knownTitle(port: number): string | undefined {
    return this.health.get(port)?.title ?? this.byPort(port)?.title;
  }

  /**
   * Unpinned previews whose dev server is down now and hasn't answered for more than
   * PREVIEW_STALE_MS are removed. Only after a check said "down": an Untether that was off
   * for a week doesn't drop previews that come back with it.
   */
  cleanup(now = this.now()): string[] {
    const removed: string[] = [];
    for (const entry of this.all()) {
      if (entry.pinned || this.stateOf(entry.port) !== 'down') continue;
      if (now - (entry.lastSeenAt ?? entry.createdAt) <= PREVIEW_STALE_MS) continue;
      this.remove(entry.id);
      removed.push(entry.id);
    }
    return removed;
  }
}

/** How long "Preview ready" waits for a screen on the session to switch to the preview. */
export const PREVIEW_PUSH_DELAY_MS = 1500;

/** The preview's own view in the app: where "Preview ready" takes you. */
export function previewViewPath(id: string, path = '/'): string {
  const base = `/preview/${encodeURIComponent(id)}`;
  return path && path !== '/' ? `${base}?path=${encodeURIComponent(path)}` : base;
}

/** "Preview ready" push; tapping it opens the preview's own view (previewViewPath). */
export function previewReadyPush(event: PreviewOpenEvent, where: string) {
  return {
    type: 'preview-ready',
    title: `👀 Preview ready · ${where}`,
    body: `localhost:${event.port}${event.path === '/' ? '' : event.path}`,
    tag: `untether-preview-${event.id}`,
    actions: [
      { action: 'view-session', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    data: {
      type: 'preview-ready',
      id: event.id,
      sessionId: event.sessionId,
      port: event.port,
      path: event.path,
      where,
      url: previewViewPath(event.id, event.path),
    },
  };
}
