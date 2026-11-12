import type { BufferCell } from '../../shared/terminal-text-formatter.js';
import {
  decodeWsV3Frame,
  decodeWsV3ResizePayload,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  VIEWING_REFRESH_MS,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import { fetchAuthConfig } from '../utils/auth-config.js';
import { getClientId } from '../utils/client-id.js';
import { inputDiagnostics } from '../utils/input-diagnostics.js';
import { createLogger } from '../utils/logger.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { authClient } from './auth-client.js';

const logger = createLogger('terminal-socket-client');

const PING_INTERVAL_MS = 20000;
/** Two missed pongs: the server answers every PING, so silence means the socket is dead. */
const PONG_TIMEOUT_MS = 2 * PING_INTERVAL_MS + 5000;
/** Answer expected after coming back to the foreground before the socket is replaced. */
const PROBE_TIMEOUT_MS = 4000;
/**
 * The same answer, when a session is opened meanwhile. User report 2026-10-14: «Cargando
 * historial» after unlocking the phone. A session opened right away subscribed on a socket
 * that was already dead, and waited the whole 4 s probe before a new socket replayed its
 * history. A live socket answers the ping within a round trip.
 */
export const PROBE_OPENING_TIMEOUT_MS = 1500;
/**
 * A socket still CONNECTING after this is dead: after a Wi-Fi ↔ cellular switch the
 * handshake can hang with no close ever coming, and nothing retried it (2026-10-20 review).
 */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Typed input older than this when the socket comes back is dropped, not replayed. */
export const OFFLINE_INPUT_MAX_AGE_MS = 30_000;
/** Most recent typed input kept while offline; older bytes beyond it are dropped. */
export const OFFLINE_INPUT_MAX_BYTES = 64 * 1024;
/**
 * Without a tap, key, scroll or wheel for this long the page is not being looked at: a
 * session left open on an unattended screen must not hold back the phone's pushes.
 */
export const VIEWING_IDLE_MS = 120_000;
/** SEEN frames from interaction events (not a change of keys) at most this often. */
export const SEEN_MIN_GAP_MS = 5_000;
/**
 * Interaction events read what the page shows at most this often (scroll and wheel fire at
 * frame rate, and each read walks and measures the DOM); the last one of a burst still reads,
 * so something scrolled into view counts as seen.
 */
export const SEEN_READ_GAP_MS = 250;
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

type QueuedFrame = {
  frame: Uint8Array;
  type: WsV3MessageType | undefined;
  sessionId: string;
  queuedAt: number;
  /** A RESIZE that claims the size (a key, a tap): the only kind worth sending late. */
  claim?: boolean;
};

export type { BufferCell } from '../../shared/terminal-text-formatter.js';

export interface BufferSnapshot {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
}

type Subscription = {
  wantStdout: boolean;
  wantSnapshots: boolean;
  wantEvents: boolean;
  onStdout?: (data: Uint8Array) => void;
  onSnapshot?: (snapshot: BufferSnapshot) => void;
  onEvent?: (data: unknown) => void;
  onError?: (message: string) => void;
};

type SessionSubs = {
  subs: Set<Subscription>;
  flags: number;
};

/** The server's close code for a token it does not accept (/ws). */
export const WS_TOKEN_INVALID_CODE = 4401;
/** Failed connects (never opened) before the token is checked with the server. */
const TOKEN_CHECK_AFTER_FAILURES = 3;

export class TerminalSocketClient {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private tokenWaitTimer: number | null = null;
  private pingInterval: number | null = null;
  private probeTimer: number | null = null;
  private connectTimer: number | null = null;
  /** When the socket now CONNECTING was created. */
  private connectStartedAt = 0;
  private probeSentAt = 0;
  /**
   * Subscription frames held while the socket is being probed (latest per session): sent once
   * it answers; a new socket subscribes every session anyway. Their history replay would only
   * go into a dead socket.
   */
  private heldSubscriptionFrames = new Map<string, Uint8Array>();
  private lastInboundAt = 0;
  private isConnected = false;
  private connectionStateHandlers: Set<(connected: boolean) => void> = new Set();
  private tokenRejectedHandlers = new Set<() => void>();

  private initialized = false;
  private noAuthMode: boolean | null = null;

  private sessions = new Map<string, SessionSubs>();
  /** Session the session view shows; reported only while someone is looking at the page. */
  private viewingSessionId: string | null = null;
  private pageHidden = false;
  /** What the current socket was last told about the viewed session. */
  private sentViewing: string | null = null;
  /** What the current socket was last told about the session on the visible page (PRESENT). */
  private sentPresent: string | null = null;
  /** Last tap, key, scroll or wheel (or coming back to the page). */
  private lastInteractionAt = 0;
  /** Repeats the VIEWING frame while a session is shown: the server forgets it otherwise. */
  private viewingTimer: number | null = null;
  /** Reads what the page shows that a push may be about (setSeenSource). */
  private seenSource: (() => string[]) | null = null;
  /** Repeats the SEEN frame while a source is set. */
  private seenTimer: number | null = null;
  private lastSeenSent = '';
  private lastSeenSentAt = 0;
  private lastSeenReadAt = 0;
  private seenReadTimer: number | null = null;
  private messageQueue: QueuedFrame[] = [];
  private encoder = new TextEncoder();

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;

    // Back from the background with the socket down: reconnect now instead of waiting out
    // the backoff (up to 30 s after a long sleep), so the terminal is live when you look.
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // iOS may skip visibilitychange when Safari is closed or the tab discarded.
    window.addEventListener('pagehide', this.handlePageHide);
    window.addEventListener('pageshow', this.handlePageShow);
    // A frozen page (Chrome's lifecycle) runs nothing, so it can't keep saying it is viewed.
    document.addEventListener('freeze', this.handlePageHide);
    document.addEventListener('resume', this.handlePageShow);
    // Another window or app in front: nobody is looking at this page.
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('focus', this.handleFocus);
    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, this.handleInteraction, { capture: true, passive: true });
    }

    await this.checkNoAuthMode();
    setTimeout(() => this.connect(), 100);
  }

  private readonly handlePageHide = () => {
    this.pageHidden = true;
    this.sendViewing();
  };

  private readonly handlePageShow = () => {
    this.pageHidden = false;
    this.lastInteractionAt = Date.now();
    this.sendViewing();
  };

  private readonly handleBlur = () => {
    this.sendViewing();
  };

  private readonly handleFocus = () => {
    this.lastInteractionAt = Date.now();
    this.sendViewing();
  };

  private readonly handleInteraction = () => {
    this.lastInteractionAt = Date.now();
    // Only says something when this ends an idle spell (or nothing was claimed yet).
    // Scroll and wheel fire this at frame rate: the seen keys are read at most every
    // SEEN_READ_GAP_MS (2026-11-10: each event walked and measured the DOM).
    this.sendViewing(false, true);
  };

  private readonly handleVisibilityChange = () => {
    // Locking the phone or switching apps hides the page: stop claiming to watch, so the
    // server sends pushes again. Coming back counts as looking.
    if (document.visibilityState === 'visible') this.lastInteractionAt = Date.now();
    this.sendViewing();
    if (document.visibilityState !== 'visible') return;
    if (this.reconnectTimer) {
      this.forceReconnect();
      return;
    }
    // A handshake begun before the lock or the network switch may never finish: start over
    // rather than wait out the connect timeout.
    const socket = this.ws;
    if (
      socket?.readyState === WebSocket.CONNECTING &&
      Date.now() - this.connectStartedAt >= PROBE_OPENING_TIMEOUT_MS
    ) {
      this.dropDeadSocket(socket);
      return;
    }
    // After a lock or a Wi-Fi ↔ cellular switch the socket often still says OPEN while
    // its TCP connection is gone: nothing arrives and the terminal looks frozen. Ask.
    this.probeConnection();
  };

  private probeConnection() {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.probeTimer) return;
    this.probeSentAt = Date.now();
    this.sendPing();
    this.armProbe(socket, PROBE_TIMEOUT_MS);
  }

  private armProbe(socket: WebSocket, delay: number) {
    const sentAt = this.probeSentAt;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      if (this.ws === socket && this.lastInboundAt < sentAt) this.dropDeadSocket(socket);
      else this.endProbe();
    }, delay);
  }

  /** The socket answered: the probe is over and held subscriptions go out. */
  private endProbe() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const held = [...this.heldSubscriptionFrames.values()];
    this.heldSubscriptionFrames.clear();
    for (const frame of held) this.safeSend(frame);
  }

  /** Abandon a socket that stopped answering and reconnect right away. */
  private dropDeadSocket(socket: WebSocket) {
    if (this.ws !== socket) return;
    logger.warn('v3 socket stopped answering, reconnecting');
    this.ws = null;
    this.isConnecting = false;
    this.clearConnectTimer();
    this.stopPingPong();
    this.setConnected(false);
    try {
      socket.close();
    } catch {
      // already gone
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  private async checkNoAuthMode(): Promise<void> {
    try {
      // Shares the app's own request at startup (utils/auth-config.ts).
      const config = await fetchAuthConfig();
      if (config) {
        this.noAuthMode = config.noAuth === true;
      }
    } catch (error) {
      logger.warn('Failed to check auth config:', error);
      this.noAuthMode = false;
    }
  }

  private isNoAuthMode(): boolean {
    return this.noAuthMode === true;
  }

  private connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    const currentUser = authClient.getCurrentUser();
    const token = currentUser?.token;

    if (!token && !this.isNoAuthMode()) {
      logger.debug('No auth token available yet, postponing v3 socket connect');
      // One poll at a time (2026-11-10: every external connect() added a parallel 500 ms loop).
      if (this.tokenWaitTimer === null) {
        this.tokenWaitTimer = window.setTimeout(() => {
          this.tokenWaitTimer = null;
          if (this.initialized && !this.ws) this.connect();
        }, 500);
      }
      return;
    }

    this.isConnecting = true;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/ws`;
    if (token) wsUrl += `?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';
      // Capture this socket instance so late-firing handlers from a previous socket
      // can't clobber a newer one (e.g. when reconnecting after iOS background).
      const socket = this.ws;
      let opened = false;
      this.connectStartedAt = Date.now();
      this.clearConnectTimer();
      this.connectTimer = window.setTimeout(() => {
        this.connectTimer = null;
        if (this.ws === socket && socket.readyState === WebSocket.CONNECTING) {
          this.dropDeadSocket(socket);
        }
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (this.ws !== socket) return;
        opened = true;
        this.isConnecting = false;
        this.clearConnectTimer();
        this.reconnectAttempts = 0;
        this.lastInboundAt = Date.now();
        this.setConnected(true);
        this.startPingPong();
        this.sentViewing = null; // a new socket starts with nothing viewed
        this.lastSeenSent = '';
        this.sentPresent = null;
        this.sendViewing();

        // Flush queued frames
        const queued = this.trimOfflineQueue(this.messageQueue);
        this.messageQueue = [];
        for (const item of queued) this.safeSend(item.frame);

        // Re-subscribe all sessions (aggregate flags)
        for (const [sessionId, info] of this.sessions) {
          const payload = encodeWsV3SubscribePayload({ flags: info.flags });
          this.safeSend(encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload }));
        }
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.lastInboundAt = Date.now();
        if (this.probeTimer || this.heldSubscriptionFrames.size > 0) this.endProbe();
        if (event.data instanceof ArrayBuffer) {
          this.handleBinary(event.data);
        }
      };

      socket.onerror = (error) => {
        logger.debug('v3 socket error', error);
      };

      socket.onclose = (event?: CloseEvent) => {
        // Only react if this is still the active socket. A stale onclose (from a
        // socket we already replaced) must not null out the new reference.
        if (this.ws !== socket) return;
        this.isConnecting = false;
        this.clearConnectTimer();
        this.stopPingPong();
        this.setConnected(false);
        this.ws = null;
        // The server refused the token (close 4401): retrying can't work, sign in again
        // (2026-10-20: a phone with a dead token retried every 30 s all day).
        if (event?.code === WS_TOKEN_INVALID_CODE) {
          this.tokenRejected();
          return;
        }
        // Refused before opening (an HTTP 401 on the upgrade shows as 1006): after a few,
        // ask the server whether the token is still good.
        if (!opened && token && this.reconnectAttempts >= TOKEN_CHECK_AFTER_FAILURES) {
          void this.checkTokenThenReconnect();
          return;
        }
        this.scheduleReconnect();
      };
    } catch (error) {
      logger.error('failed to create v3 websocket', error);
      this.isConnecting = false;
      this.setConnected(false);
      this.scheduleReconnect();
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Force an immediate reconnection attempt, bypassing the exponential backoff.
   * Used when the page is restored from the iOS/Safari bfcache (pageshow.persisted),
   * where the old socket is typically dead but timers were frozen while backgrounded.
   * If the current socket is genuinely OPEN it is left alone (ping/pong will catch a
   * dead one); otherwise we reset backoff and reconnect now.
   */
  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    this.isConnecting = false;
    this.connect();
  }

  /**
   * Close the socket on logout (2026-10-20: it stayed open with the old token behind the login
   * screen, and forceReconnect() on re-login kept that OPEN socket). Timers stop and queued
   * frames are dropped; the subscriptions stay, so a later connect (with the new token, once
   * someone logs in) subscribes the open views again.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingPong();
    this.heldSubscriptionFrames.clear();
    this.messageQueue = [];
    this.reconnectAttempts = 0;
    this.isConnecting = false;
    this.clearConnectTimer();
    const socket = this.ws;
    // Null first, so the socket's onclose is stale and schedules no reconnect.
    this.ws = null;
    this.setConnected(false);
    if (socket) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
  }

  /** Called once when the server rejected the token: stop reconnecting, back to the login. */
  onTokenRejected(handler: () => void): () => void {
    this.tokenRejectedHandlers.add(handler);
    return () => this.tokenRejectedHandlers.delete(handler);
  }

  private tokenRejected(): void {
    logger.warn('v3 socket: token rejected, not reconnecting');
    this.disconnect();
    for (const handler of this.tokenRejectedHandlers) {
      try {
        handler();
      } catch (error) {
        logger.debug('token rejected handler error', error);
      }
    }
  }

  private async checkTokenThenReconnect(): Promise<void> {
    const valid = await authClient.verifyToken().catch(() => true);
    if (!valid) {
      this.tokenRejected();
      return;
    }
    this.scheduleReconnect();
  }

  onConnectionStateChange(handler: (connected: boolean) => void): () => void {
    this.connectionStateHandlers.add(handler);
    return () => this.connectionStateHandlers.delete(handler);
  }

  private setConnected(connected: boolean) {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    inputDiagnostics.socketState(connected);
    for (const handler of this.connectionStateHandlers) {
      try {
        handler(connected);
      } catch (error) {
        logger.debug('connection state handler error', error);
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPingPong() {
    if (this.pingInterval) return;
    this.pingInterval = window.setInterval(() => {
      // 2026-10-02: pings went out but nobody checked for the pong, so a half-open
      // socket (network switch, NAT timeout) froze the terminal until a reload.
      const socket = this.ws;
      if (socket && Date.now() - this.lastInboundAt > PONG_TIMEOUT_MS) {
        this.dropDeadSocket(socket);
        return;
      }
      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  private sendPing() {
    this.sendFrame(
      encodeWsV3Frame({ type: WsV3MessageType.PING, payload: this.encoder.encode('ping') })
    );
  }

  private stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    // A new socket subscribes every session on open.
    this.heldSubscriptionFrames.clear();
  }

  private safeSend(buffer: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(payload).set(buffer);
      this.ws.send(payload);
    } else {
      const frame = decodeWsV3Frame(buffer);
      const claim =
        frame?.type === WsV3MessageType.RESIZE &&
        decodeWsV3ResizePayload(frame.payload)?.claim === true;
      this.messageQueue.push({
        frame: buffer,
        type: frame?.type,
        sessionId: frame?.sessionId ?? '',
        queuedAt: Date.now(),
        claim,
      });
      this.messageQueue = this.trimOfflineQueue(this.messageQueue);
      if (this.initialized && !this.ws) this.connect();
    }
  }

  /**
   * 2026-10-02: the offline queue was never trimmed, so a phone that came back after an
   * hour replayed every old keystroke into the session (and every intermediate resize).
   * Keep typed input from the last 30 s, at most 64 KB of it (newest first), and only
   * the last resize per session; pings are pointless on a new socket. Any other frame is kept
   * whatever its age.
   */
  private trimOfflineQueue(queue: QueuedFrame[]): QueuedFrame[] {
    const now = Date.now();
    const lastSizeIndex = new Map<string, number>();
    queue.forEach((item, index) => {
      if (item.type === WsV3MessageType.RESIZE) {
        lastSizeIndex.set(item.sessionId, index);
      }
    });

    let inputBytes = 0;
    let inputFull = false;
    const keep = Array.from({ length: queue.length }, () => false);
    for (let index = queue.length - 1; index >= 0; index--) {
      const item = queue[index];
      switch (item.type) {
        case WsV3MessageType.PING:
          break;
        case WsV3MessageType.RESIZE:
          // Only a recent claim: a screen's own resize is sent again by the page when it
          // matters, and a late one replayed on reconnect resized the session under whoever
          // used it meanwhile (user report 2026-10-14).
          keep[index] =
            lastSizeIndex.get(item.sessionId) === index &&
            item.claim === true &&
            now - item.queuedAt <= OFFLINE_INPUT_MAX_AGE_MS;
          break;
        case WsV3MessageType.INPUT_TEXT:
        case WsV3MessageType.INPUT_KEY:
          // Walking newest to oldest: once the budget is spent, nothing older is kept,
          // so the kept input is one contiguous recent stretch.
          if (inputFull || now - item.queuedAt > OFFLINE_INPUT_MAX_AGE_MS) break;
          if (inputBytes + item.frame.byteLength > OFFLINE_INPUT_MAX_BYTES) {
            inputFull = true;
            break;
          }
          inputBytes += item.frame.byteLength;
          keep[index] = true;
          break;
        default:
          keep[index] = true;
      }
    }
    if (keep.every(Boolean)) return queue;
    const dropped = keep.filter((k) => !k).length;
    logger.debug(`dropped ${dropped} stale frame(s) queued while offline`);
    return queue.filter((_, index) => keep[index]);
  }

  private sendFrame(buffer: Uint8Array) {
    this.safeSend(buffer);
  }

  /**
   * Subscription changes only matter to the socket they are sent on: a new socket starts
   * with no subscriptions and `onopen` subscribes every session with its current flags.
   * 2026-10-02: queuing them too made a reconnect send SUBSCRIBE twice per session, and
   * the server answered each with a full history replay.
   */
  private sendSubscriptionFrame(buffer: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.probeTimer) {
      // Under probe: hold it, and give the socket less time to answer (see
      // PROBE_OPENING_TIMEOUT_MS).
      const sessionId = decodeWsV3Frame(buffer)?.sessionId ?? '';
      this.heldSubscriptionFrames.delete(sessionId);
      this.heldSubscriptionFrames.set(sessionId, buffer);
      const remaining = this.probeSentAt + PROBE_OPENING_TIMEOUT_MS - Date.now();
      this.armProbe(this.ws, Math.max(0, remaining));
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.safeSend(buffer);
    } else if (this.initialized && !this.ws) {
      this.connect();
    }
  }

  subscribe(
    sessionId: string,
    opts: {
      stdout?: boolean;
      snapshots?: boolean;
      events?: boolean;
      onStdout?: (data: Uint8Array) => void;
      onSnapshot?: (snapshot: BufferSnapshot) => void;
      onEvent?: (data: unknown) => void;
      onError?: (message: string) => void;
    }
  ): () => void {
    if (!this.initialized) this.initialize();

    const subscription: Subscription = {
      wantStdout: opts.stdout === true,
      wantSnapshots: opts.snapshots === true,
      wantEvents: opts.events === true,
      onStdout: opts.onStdout,
      onSnapshot: opts.onSnapshot,
      onEvent: opts.onEvent,
      onError: opts.onError,
    };

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { subs: new Set(), flags: 0 };
      this.sessions.set(sessionId, session);
    }

    session.subs.add(subscription);
    this.updateSessionFlagsAndNotify(sessionId);

    return () => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.subs.delete(subscription);
      if (s.subs.size === 0) {
        this.sessions.delete(sessionId);
        this.sendSubscriptionFrame(
          encodeWsV3Frame({ type: WsV3MessageType.UNSUBSCRIBE, sessionId })
        );
      } else {
        this.updateSessionFlagsAndNotify(sessionId);
      }
    };
  }

  private updateSessionFlagsAndNotify(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    let flags = 0;
    for (const sub of s.subs) {
      if (sub.wantStdout) flags |= WsV3SubscribeFlags.Stdout;
      if (sub.wantSnapshots) flags |= WsV3SubscribeFlags.Snapshots;
      if (sub.wantEvents) flags |= WsV3SubscribeFlags.Events;
    }

    if (flags === s.flags) return;
    s.flags = flags;
    const payload = encodeWsV3SubscribePayload({ flags });
    this.sendSubscriptionFrame(
      encodeWsV3Frame({ type: WsV3MessageType.SUBSCRIBE, sessionId, payload })
    );
  }

  /**
   * Tell the server which session this page shows (null: none), so it holds back pushes
   * about it while someone is looking. Re-sent on every new socket and every
   * VIEWING_REFRESH_MS while looked at; never queued.
   */
  setViewingSession(sessionId: string | null): void {
    this.viewingSessionId = sessionId || null;
    if (!this.initialized) void this.initialize();
    // Opening a session is looking at it.
    if (this.viewingSessionId) this.lastInteractionAt = Date.now();
    if (this.viewingSessionId && this.viewingTimer === null) {
      this.viewingTimer = window.setInterval(() => this.sendViewing(true), VIEWING_REFRESH_MS);
    } else if (!this.viewingSessionId && this.viewingTimer !== null) {
      clearInterval(this.viewingTimer);
      this.viewingTimer = null;
    }
    this.sendViewing();
  }

  /** Clear the viewed session if it is still `sessionId` (a newer view may own it). */
  clearViewingSession(sessionId: string): void {
    if (this.viewingSessionId === sessionId) this.setViewingSession(null);
  }

  /**
   * Someone is looking at this page: visible, focused, and touched, typed in or scrolled
   * within VIEWING_IDLE_MS. A page left open on a locked Mac or behind another window is not
   * (2026-10-03: "Claude finished" skipped as "on screen" while the phone app was closed).
   */
  private isLookedAt(): boolean {
    return (
      !this.pageHidden &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      Date.now() - this.lastInteractionAt < VIEWING_IDLE_MS
    );
  }

  /**
   * Where to read what this page shows that a push may be about: the attention strip's
   * confirmations and tasks that need the user, as server/services/agent-attention-policy.ts
   * keys, only those on screen now. While the page is looked at, the server takes them as seen
   * and an important push held for them is not sent to the phone; with none, the frame still
   * says someone is looking. Read at every send, so a list hidden without a re-render stops
   * counting.
   */
  setSeenSource(source: (() => string[]) | null): void {
    this.seenSource = source;
    if (source && this.seenTimer === null) {
      this.seenTimer = window.setInterval(() => this.sendSeen(true), VIEWING_REFRESH_MS);
    } else if (!source && this.seenTimer !== null) {
      clearInterval(this.seenTimer);
      this.seenTimer = null;
    }
    this.sendSeen();
  }

  /** The seen source may show other keys now (its view re-rendered). */
  seenMayHaveChanged(): void {
    this.sendSeen();
  }

  /**
   * Report the seen keys while looked at: when they changed, on `refresh`, else at most every
   * SEEN_MIN_GAP_MS (interaction events call this often).
   */
  private sendSeen(refresh = false, throttled = false) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.seenSource) return;
    if (!this.isLookedAt()) return;
    if (throttled) {
      const wait = SEEN_READ_GAP_MS - (Date.now() - this.lastSeenReadAt);
      if (wait > 0) {
        this.seenReadTimer ??= window.setTimeout(() => {
          this.seenReadTimer = null;
          this.sendSeen();
        }, wait);
        return;
      }
    }
    this.lastSeenReadAt = Date.now();
    let keys: string[];
    try {
      keys = [...new Set(this.seenSource().filter(Boolean))].sort();
    } catch {
      return;
    }
    // No keys still goes out (empty): the page is looked at, so an important push arriving
    // now waits for it to show up (2026-11-02 review: the list with nothing pending counted as
    // nobody about, and the first confirmation went to the phone at once).
    const text = keys.join('\n');
    const now = Date.now();
    if (!refresh && text === this.lastSeenSent && now - this.lastSeenSentAt < SEEN_MIN_GAP_MS) {
      return;
    }
    this.lastSeenSent = text;
    this.lastSeenSentAt = now;
    this.safeSend(
      encodeWsV3Frame({ type: WsV3MessageType.SEEN, payload: this.encoder.encode(text) })
    );
  }

  /** Report what is viewed when it changed; `refresh` repeats a viewed session anyway. */
  private sendViewing(refresh = false, throttleSeen = false) {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.sendPresent(refresh);
    this.sendSeen(false, throttleSeen);
    const viewing = this.isLookedAt() ? this.viewingSessionId : null;
    if (viewing === this.sentViewing && !(refresh && viewing)) return;
    this.sentViewing = viewing;
    this.safeSend(
      encodeWsV3Frame({
        type: WsV3MessageType.VIEWING,
        sessionId: viewing ?? '',
        payload: this.encoder.encode(getClientId()),
      })
    );
  }

  /**
   * Report the session on this page while the page is visible, whether or not it is focused or
   * was touched lately (PRESENT): the server gives a Mac-window session's size back to its
   * window once the owning page has been gone a while (user report 2026-10-14: the Mac window
   * stayed at a locked phone's width). Sent from the same events as VIEWING, synchronously in
   * visibilitychange (the last code iOS runs before freezing the page); never queued.
   */
  private sendPresent(refresh = false) {
    const present =
      !this.pageHidden && document.visibilityState === 'visible' ? this.viewingSessionId : null;
    if (present === this.sentPresent && !(refresh && present)) return;
    this.sentPresent = present;
    this.safeSend(
      encodeWsV3Frame({
        type: WsV3MessageType.PRESENT,
        sessionId: present ?? '',
        payload: this.encoder.encode(getClientId()),
      })
    );
  }

  sendInputText(sessionId: string, text: string): boolean {
    if (!sessionId) return false;
    inputDiagnostics.keySent(text.length);
    const payload = this.encoder.encode(text);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.INPUT_TEXT, sessionId, payload }));
    return true;
  }

  sendInputKey(sessionId: string, key: string): boolean {
    if (!sessionId) return false;
    // A named key ("enter", "escape") is one key whatever its name's length.
    inputDiagnostics.keySent(1);
    const payload = this.encoder.encode(key);
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.INPUT_KEY, sessionId, payload }));
    return true;
  }

  /**
   * This page's size for the session; `claim` when the user used it (a key, a tap, opening it),
   * which makes this page the owner of the size (server/pty/size-owner.ts).
   */
  resize(sessionId: string, cols: number, rows: number, claim = false): boolean {
    if (!sessionId) return false;
    const payload = encodeWsV3ResizePayload(cols, rows, { claim, clientId: getClientId() });
    this.sendFrame(encodeWsV3Frame({ type: WsV3MessageType.RESIZE, sessionId, payload }));
    return true;
  }

  private handleBinary(data: ArrayBuffer) {
    const frame = decodeWsV3Frame(new Uint8Array(data));
    if (!frame) return;

    const session = this.sessions.get(frame.sessionId);
    const globalEvents = frame.sessionId !== '' ? this.sessions.get('') : null;

    if (frame.type === WsV3MessageType.STDOUT) {
      if (!session) return;
      inputDiagnostics.outputArrived(frame.sessionId);
      const bytes = frame.payload;
      for (const sub of session.subs) {
        if (sub.wantStdout) sub.onStdout?.(bytes);
      }
      return;
    }

    if (frame.type === WsV3MessageType.EVENT) {
      let obj: unknown = null;
      try {
        obj = JSON.parse(new TextDecoder().decode(frame.payload));
      } catch {
        obj = new TextDecoder().decode(frame.payload);
      }

      if (session) {
        for (const sub of session.subs) {
          if (sub.wantEvents) sub.onEvent?.(obj);
        }
      }

      if (globalEvents) {
        for (const sub of globalEvents.subs) {
          if (sub.wantEvents) sub.onEvent?.(obj);
        }
      }
      return;
    }

    if (frame.type === WsV3MessageType.ERROR) {
      let message = new TextDecoder().decode(frame.payload);
      try {
        const parsed = JSON.parse(message) as { message?: string };
        if (parsed?.message) message = parsed.message;
      } catch {
        // ignore
      }

      if (session) {
        for (const sub of session.subs) sub.onError?.(message);
      }
      if (globalEvents) {
        for (const sub of globalEvents.subs) sub.onError?.(message);
      }
      return;
    }

    if (frame.type === WsV3MessageType.SNAPSHOT_VT) {
      if (!session) return;
      // Decoded on a microtask as before. A static import (terminal-renderer has no imports,
      // so there is no cycle): the dynamic one made esbuild code splitting move the renderer
      // into a separate chunk the main bundle had to fetch before starting.
      queueMicrotask(() => {
        try {
          const payload = frame.payload;
          // TerminalRenderer expects ArrayBuffer (not SharedArrayBuffer). Copy to detach.
          const copy = new Uint8Array(payload.byteLength);
          copy.set(payload);
          const snapshot = TerminalRenderer.decodeBinaryBuffer(copy.buffer);
          for (const sub of session.subs) {
            if (sub.wantSnapshots) sub.onSnapshot?.(snapshot);
          }
        } catch (error) {
          logger.error('failed to decode snapshot', error);
        }
      });
    }
  }
}

export const terminalSocketClient = new TerminalSocketClient();
