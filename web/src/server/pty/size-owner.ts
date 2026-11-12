/**
 * Who owns a session's PTY size: one page (by its id, client-id.ts) or, for a session running
 * in a Mac Terminal window (`ut`, fwd_), that window.
 *
 * User report (2026-10-14): a Mac-window session went back and forth between the phone's and
 * the window's width while only the phone was in use. Each change of size made Claude Code
 * repaint its screen, and the part that did not fit stayed in the history as a second copy,
 * broken at the other width. Pages took the size on being shown again, on focus, on a
 * rotation, on a reconnect; a phone's keyboard, a page left open on the desktop and the
 * window's own focus reports each resized it in turns.
 *
 * Now every page sends its size and the server decides: only the owner's own screen changes
 * (keyboard, rotation) resize the PTY, and the owner changes only through deliberate use: a
 * page's claim (a key, typed or pasted text, a tap, opening the session from the app) or the
 * Mac window resizing the PTY itself (typed into, or resized by the user), which shows up in
 * the session's recording as a size the server did not ask for (noteStreamSize). A page that
 * is not the owner never resizes; it shows the owner's width scaled to its own.
 *
 * The window gets its size back when the owning page leaves the session for a minute
 * (client size-give-back.ts) or is away (hidden, locked, disconnected) for
 * SIZE_AWAY_GIVE_BACK_MS (awayGiveBackDecision, decided on the server since a locked phone runs
 * no timers). Coming back takes it again only with a deliberate use of the page.
 */

/** The owner for a Mac window's own size (a fwd_ session). */
export const WINDOW_OWNER = 'window';
/** The owner after a resize from a client without an id (a native app, an older page). */
export const ANONYMOUS_OWNER = 'anonymous';

/** A size the server sent within this long is taken for its own when it shows up in the stream. */
export const SIZE_ECHO_MS = 5000;
/** Sizes sent kept for that check. */
const SIZE_ECHO_KEEP = 4;

export type SizeRequestSkip = 'window-owns' | 'other-client-owns';

export interface SizeRequest {
  /** The page asking (client-id.ts); none from a native app or an internal caller. */
  clientId?: string | null;
  /** A deliberate claim of the size (WS_V3_RESIZE_CLAIM). */
  claim?: boolean;
}

/**
 * Whether a resize is applied. `owner`: the current one (null: none yet; a fwd_ session starts
 * owned by its window). `ownerViewing`: the owning page shows the session on a visible page now
 * (a page that went away hands the size to the next one that resizes while it shows the
 * session).
 */
export function sizeRequestDecision(input: {
  forwarded: boolean;
  owner: string | null;
  clientId: string | null;
  claim: boolean;
  ownerViewing: boolean;
  /**
   * The sender shows the session on a visible page now. A page that does not (a desktop tab
   * left open behind other windows, re-laid out on a display wake) never takes the size over
   * from an owner that went away, only from no owner at all.
   */
  senderViewing?: boolean;
}): { apply: true; owner: string } | { apply: false; reason: SizeRequestSkip } {
  const sender = input.clientId || ANONYMOUS_OWNER;
  if (!input.clientId || input.claim) return { apply: true, owner: sender };
  const owner = input.owner ?? (input.forwarded ? WINDOW_OWNER : null);
  if (owner === null || owner === sender || owner === ANONYMOUS_OWNER) {
    return { apply: true, owner: sender };
  }
  if (owner === WINDOW_OWNER) return { apply: false, reason: 'window-owns' };
  if (!input.ownerViewing && input.senderViewing !== false) return { apply: true, owner: sender };
  return { apply: false, reason: 'other-client-owns' };
}

/** Why a leaving page's size give-back was not sent (see sizeGiveBackDecision). */
export type SizeGiveBackSkip = 'viewed-elsewhere' | 'not-owner' | 'own-pty';

/**
 * Whether a page that left a session's view (or, from the server's sweep, went away: see
 * awayGiveBackDecision) gives the PTY its terminal's size back: only the owner, and only while
 * no other page shows the session. After that the window owns it.
 */
export function sizeGiveBackDecision(input: {
  owner: string | null;
  clientId: string | null;
  viewedElsewhere: boolean;
}): SizeGiveBackSkip | null {
  if (input.viewedElsewhere) return 'viewed-elsewhere';
  if (!input.clientId || input.owner !== input.clientId) return 'not-owner';
  return null;
}

/**
 * How long the page owning a Mac-window session's size may be away (hidden: phone locked, app
 * in the background, another tab or session; or disconnected) before the size goes back to the
 * window. User report (2026-10-14): a phone locked for a long time kept the Mac window drawn at
 * the phone's width. Above the hub's VIEWING_STALE_MS (60 s) and its heartbeat drop (~50 s), so
 * a reconnect or a short lock never gives it back.
 */
export const SIZE_AWAY_GIVE_BACK_MS = 90_000;

/**
 * Whether the server gives a Mac-window session's size back to its window because the page
 * that owns it has been away for SIZE_AWAY_GIVE_BACK_MS. `awayMs`: null when the server knows
 * nothing about that page (a server restart, a client that does not report its presence),
 * which never gives it back. Not while another page really looks at the session.
 */
export function awayGiveBackDecision(input: {
  forwarded: boolean;
  owner: string | null;
  awayMs: number | null;
  viewedElsewhere: boolean;
}): boolean {
  if (!input.forwarded) return false;
  const owner = input.owner;
  if (owner === null || owner === WINDOW_OWNER || owner === ANONYMOUS_OWNER) return false;
  if (input.awayMs === null || input.awayMs < SIZE_AWAY_GIVE_BACK_MS) return false;
  return !input.viewedElsewhere;
}

interface SizeState {
  owner: string | null;
  sent: Array<{ cols: number; rows: number; at: number }>;
  /** Bytes of the session's recording already checked for sizes (see noteStreamSize). */
  castOffset: number | null;
  /** The size the PTY has, as far as the server knows (sent, or seen in the recording). */
  current: { cols: number; rows: number } | null;
}

/** Per-session owners and the sizes the server sent, to tell its own echoes from the window's. */
export class SizeOwners {
  private states = new Map<string, SizeState>();

  constructor(private now: () => number = Date.now) {}

  private state(sessionId: string): SizeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { owner: null, sent: [], castOffset: null, current: null };
      this.states.set(sessionId, state);
    }
    return state;
  }

  owner(sessionId: string): string | null {
    return this.states.get(sessionId)?.owner ?? null;
  }

  setOwner(sessionId: string, owner: string | null): void {
    this.state(sessionId).owner = owner;
  }

  /** The server sent this size to the PTY. */
  noteSent(sessionId: string, cols: number, rows: number): void {
    const state = this.state(sessionId);
    state.current = { cols, rows };
    state.sent.push({ cols, rows, at: this.now() });
    if (state.sent.length > SIZE_ECHO_KEEP)
      state.sent.splice(0, state.sent.length - SIZE_ECHO_KEEP);
  }

  /**
   * The session's recording says the PTY now has this size. One the server did not just ask
   * for (nor last asked for) was set by the Mac window: the window owns the size. Returns
   * whether the owner changed.
   */
  noteStreamSize(sessionId: string, cols: number, rows: number): boolean {
    const state = this.state(sessionId);
    const now = this.now();
    const last = state.sent[state.sent.length - 1];
    const ours =
      (last && last.cols === cols && last.rows === rows) ||
      state.sent.some((s) => s.cols === cols && s.rows === rows && now - s.at <= SIZE_ECHO_MS);
    // A late echo of an older request: the PTY ends at the last size sent, kept as current.
    if (ours) return false;
    state.current = { cols, rows };
    if (state.owner === null || state.owner === WINDOW_OWNER) return false;
    state.owner = WINDOW_OWNER;
    return true;
  }

  /** The size the PTY was found at when the server first looked (no owner change). */
  seedSize(sessionId: string, cols: number, rows: number): void {
    const state = this.state(sessionId);
    if (!state.current) state.current = { cols, rows };
  }

  /** The PTY's size as far as the server knows; null when it does not. */
  currentSize(sessionId: string): { cols: number; rows: number } | null {
    return this.states.get(sessionId)?.current ?? null;
  }

  castOffset(sessionId: string): number | null {
    return this.states.get(sessionId)?.castOffset ?? null;
  }

  setCastOffset(sessionId: string, offset: number): void {
    this.state(sessionId).castOffset = offset;
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Sessions whose size a page owns (SizeOwners keeps one state per session seen). */
  pageOwned(): Array<{ sessionId: string; owner: string }> {
    const out: Array<{ sessionId: string; owner: string }> = [];
    for (const [sessionId, state] of this.states) {
      const owner = state.owner;
      if (owner && owner !== WINDOW_OWNER && owner !== ANONYMOUS_OWNER) {
        out.push({ sessionId, owner });
      }
    }
    return out;
  }
}
