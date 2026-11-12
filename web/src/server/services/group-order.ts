/**
 * The order of the home's groups the user chose (2026-11-07: dragging a group's header in the
 * sidebar or the desktop home, or «Subir» / «Bajar» in its menu), in
 * `~/.untether/group-order.json` so the phone and every browser show the same order.
 *
 * `order` holds group keys as the client groups them (a project's main folder, or a folder
 * outside git; "Otras" is never in it, it is always last). Groups that are not in it come first,
 * in their automatic order (utils/project-groups.ts withManualOrder). The keys follow renamed
 * project folders (projectSettings.followedBy, server-tasks.ts).
 *
 * `sessions` (2026-11-07, the user dragged sidebar rows up and down to reorder them) holds session
 * ids in the order the user dropped them: within a group, the ids it holds keep that order
 * among themselves and any other session (a new one) keeps its automatic place
 * (utils/project-groups.ts withManualSessionOrder). One list for every group: a session is only in one group at a time.
 *
 * `collapsed` (2026-11-10, user request: fold the projects so they do not all show open) holds the
 * groups the user folded in the phone list and the sidebar:
 * group keys as `order`, plus COLLAPSED_OTHERS for "Otras". They follow renamed folders too.
 *
 * Written atomically (temp file + rename); a file that cannot be read counts as no order and is
 * copied aside before the next write replaces it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** At most this many groups are remembered (the order is cut at the end beyond it). */
export const GROUP_ORDER_MAX = 200;
const KEY_MAX = 4096;
/** At most this many sessions are remembered (the client sends only sessions it still knows). */
export const SESSION_ORDER_MAX = 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** "Otras" (sessions outside any project) among the folded groups: it has no folder. */
export const COLLAPSED_OTHERS = '(others)';

export class GroupOrderError extends Error {}

/** A group key as the client compares it: absolute, no /private, no trailing slash. */
export function groupOrderKey(key: string): string {
  return (
    path
      .normalize(key)
      .replace(/^\/private(?=\/)/, '')
      .replace(/\/+$/, '') || '/'
  );
}

/** The order from a request body: absolute folders, each once; throws GroupOrderError. */
export function parseGroupOrder(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GroupOrderError('order must be an array of folders');
  if (value.length > GROUP_ORDER_MAX) {
    throw new GroupOrderError(`order holds at most ${GROUP_ORDER_MAX} groups`);
  }
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith('/') || entry.length > KEY_MAX) {
      throw new GroupOrderError('each group must be an absolute folder');
    }
    if ([...entry].some((char) => char < ' ' || char === '\x7f')) {
      throw new GroupOrderError('a group folder holds a control character');
    }
    const key = groupOrderKey(entry);
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

/** The folded groups from a request body: folders as parseGroupOrder, or "Otras". */
export function parseCollapsedGroups(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GroupOrderError('collapsed must be an array of folders');
  const folders = parseGroupOrder(value.filter((entry) => entry !== COLLAPSED_OTHERS));
  return value.includes(COLLAPSED_OTHERS) ? [...folders, COLLAPSED_OTHERS] : folders;
}

/** The session order from a request body: session ids, each once; throws GroupOrderError. */
export function parseSessionOrder(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GroupOrderError('order must be an array of session ids');
  if (value.length > SESSION_ORDER_MAX) {
    throw new GroupOrderError(`order holds at most ${SESSION_ORDER_MAX} sessions`);
  }
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !SESSION_ID.test(entry)) {
      throw new GroupOrderError('each session must be a session id');
    }
    if (!order.includes(entry)) order.push(entry);
  }
  return order;
}

interface SavedOrder {
  order: string[];
  sessions: string[];
  collapsed: string[];
}

export class GroupOrderStore {
  private saved: SavedOrder | null = null;

  constructor(
    private readonly file: string,
    private readonly onError?: (message: string, error?: unknown) => void
  ) {}

  private get state(): SavedOrder {
    if (!this.saved) this.saved = this.load();
    return this.saved;
  }

  /** The saved group order (empty: the automatic one). */
  get(): string[] {
    return [...this.state.order];
  }

  /** Save a new group order (validated as parseGroupOrder); returns what was saved. */
  set(value: unknown): string[] {
    const order = parseGroupOrder(value);
    this.saved = { ...this.state, order };
    this.save();
    return [...order];
  }

  /** The saved session order (empty: the automatic one). */
  getSessions(): string[] {
    return [...this.state.sessions];
  }

  /** Save a new session order (validated as parseSessionOrder); returns what was saved. */
  setSessions(value: unknown): string[] {
    const sessions = parseSessionOrder(value);
    this.saved = { ...this.state, sessions };
    this.save();
    return [...sessions];
  }

  /** The groups the user folded (empty: every group open). */
  getCollapsed(): string[] {
    return [...this.state.collapsed];
  }

  /** Save the folded groups (validated as parseCollapsedGroups); returns what was saved. */
  setCollapsed(value: unknown): string[] {
    const collapsed = parseCollapsedGroups(value);
    this.saved = { ...this.state, collapsed };
    this.save();
    return [...collapsed];
  }

  /**
   * A project folder moved: its key (and keys inside it) follow, in the order and among the
   * folded groups. Resolves to how many changed.
   */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let changed = 0;
    const follow = (keys: readonly string[]) => {
      const next: string[] = [];
      for (const key of keys) {
        let current = key;
        for (const { from, to } of moved) {
          const source = groupOrderKey(from);
          if (current === source || current.startsWith(`${source}/`)) {
            current = `${groupOrderKey(to)}${current.slice(source.length)}`;
          }
        }
        if (current !== key) changed++;
        if (!next.includes(current)) next.push(current);
      }
      return next;
    };
    const order = follow(this.state.order);
    const collapsed = follow(this.state.collapsed);
    if (changed) {
      this.saved = { ...this.state, order, collapsed };
      this.save();
    }
    return changed;
  }

  private load(): SavedOrder {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { order: [], sessions: [], collapsed: [] };
    }
    try {
      const data = JSON.parse(text) as { order?: unknown; sessions?: unknown; collapsed?: unknown };
      return {
        order: parseGroupOrder(data?.order ?? []),
        sessions: parseSessionOrder(data?.sessions ?? []),
        collapsed: parseCollapsedGroups(data?.collapsed ?? []),
      };
    } catch (error) {
      this.onError?.(
        `${path.basename(this.file)} could not be read; the automatic order is used`,
        error
      );
      try {
        fs.copyFileSync(this.file, `${this.file}.bad-${Date.now()}`);
      } catch {
        // Only a copy for the user to look at.
      }
      return { order: [], sessions: [], collapsed: [] };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...this.state })}\n`, {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      // Kept in memory; written again with the next change.
      this.onError?.(`${path.basename(this.file)} could not be written`, error);
    }
  }
}
