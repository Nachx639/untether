/**
 * Input diagnostics (2026-11-11). Untether is used in Chrome on iOS, which no simulator has, so
 * the phone itself says what it measures. While the mode is on this module samples and sends to
 * the server, in batches (POST /api/diag/input → the server log and `ut diag input`):
 *
 * - the soft keyboard: on every visualViewport / resize / focus change, innerHeight, the visual
 *   viewport, the height each of the two ways of computing the keyboard gives and the one the
 *   layout ended up with;
 * - key latency: ms from a key leaving for the session to the first frame after its echo arrived;
 * - scrolling in the terminal and in the list: frame durations while the gesture lasts;
 * - opening a session: ms to the first frame after its terminal got output;
 * - WebSocket reconnections and how long each was down; the connection type when known.
 *
 * Numbers and fixed words only: never what was typed or what the screen shows.
 *
 * Two ways in:
 * - `live`: Settings → Advanced → Input diagnostics, or `?kbdebug=1`. Also paints one small line
 *   on screen with the keyboard's numbers and sends every few seconds. Ends with the next reload
 *   (it is only in memory; the address keeps `?kbdebug=1` on if it is still there).
 * - `kept`: "Keep on" in Settings, remembered on this device. No line on screen, one batch a
 *   minute: it can stay on for days.
 *
 * Off (the default) every hook returns at its first line and nothing is listened to.
 */
import {
  DIAG_MAX_RECORDS_PER_BATCH,
  DIAG_MAX_UA_LENGTH,
  DIAG_SLOW_FRAME_MS,
  type DiagAgent,
  type DiagBatch,
  type DiagContext,
  type DiagKeyboardRecord,
  type DiagKeyboardSource,
  type DiagRecord,
  type DiagScrollPlace,
  estimateKeyboardHeight,
  percentile,
} from '../../shared/input-diagnostics.js';
import { authClient } from '../services/auth-client.js';
import { Z_INDEX } from './constants.js';
import { softKeyboardTarget } from './soft-keyboard.js';

export type DiagMode = 'off' | 'live' | 'kept';

export const DIAG_KEEP_STORAGE_KEY = 'untether.inputDiagnostics.keep';
export const DIAG_MODE_CHANGED_EVENT = 'untether-input-diagnostics-changed';
export const DIAG_LINE_ID = 'input-diagnostics-line';
export const DIAG_ENDPOINT = '/api/diag/input';

/** Batches leave this often: with the line on screen someone is reading the log right now. */
const LIVE_FLUSH_MS = 3_000;
const KEPT_FLUSH_MS = 60_000;
/** Keyboard samples kept per batch when nobody is watching (a keyboard opening fires dozens). */
const KEPT_KEYBOARD_SAMPLES = 40;
/** A key with no output after this long had no echo (a password prompt): not a latency. */
const KEY_ECHO_TIMEOUT_MS = 5_000;
/** Longer than a key (a paste, a composer message): not measured as one. */
const KEY_MAX_LENGTH = 8;
/** A scroll gesture is over after this long without a scroll, wheel or touchmove. */
const SCROLL_IDLE_MS = 200;
const OPEN_TIMEOUT_MS = 30_000;
/** How often the applied keyboard gap is compared with the focus (see DiagGapRecord). */
export const GAP_POLL_MS = 250;
const MAX_SAMPLES = 2_000;

/** What the session view knows about the keyboard that the viewport alone does not tell. */
export interface KeyboardProbe {
  /** The tallest visual viewport seen at this width (the keyboard-down height). */
  baseline: number;
  /** The height the layout uses now. */
  applied: number;
}

interface Bucket {
  context: DiagContext;
  keys: number[];
  scroll: Record<DiagScrollPlace, number[]>;
}

type Clock = () => number;

/** How the device reaches the Mac, from the address it uses: no lookups, nothing asked. */
export function networkKind(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')) {
    return 'local';
  }
  if (host.endsWith('.ts.net')) return 'tailscale';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    // 100.64.0.0/10: Tailscale's addresses.
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'lan';
    return 'internet';
  }
  if (host.endsWith('.local') || !host.includes('.')) return 'lan';
  return 'internet';
}

/** "tailscale/4g": the way to the Mac and, when the browser tells (not on iOS), the connection. */
export function networkLabel(hostname: string, connection: unknown): string {
  const kind = networkKind(hostname);
  const info = connection as { type?: unknown; effectiveType?: unknown } | null | undefined;
  const type = [info?.type, info?.effectiveType].find(
    (value): value is string => typeof value === 'string' && /^[a-z0-9-]{1,12}$/.test(value)
  );
  return type ? `${kind}/${type}` : kind;
}

/** Whether the address asks for the mode (`?kbdebug=1`). */
export function addressAsksForDiagnostics(search: string): boolean {
  return new URLSearchParams(search).get('kbdebug') === '1';
}

/**
 * The line on screen, short enough for a phone: "ih 327 vv 327+0 max 664 | s 0 b 337 = 337"
 * (innerHeight, visual viewport + its offset, the tallest viewport seen; the keyboard by
 * innerHeight minus viewport (s), by the tallest viewport (b), and the one applied).
 */
export function keyboardLine(record: DiagKeyboardRecord): string {
  return (
    `ih ${record.ih} vv ${record.vvh}+${record.vvt} max ${record.base}` +
    ` | s ${record.safari} b ${record.baseline} = ${record.applied}`
  );
}

const round = (value: number) => Math.round(value * 10) / 10;

export class InputDiagnostics {
  private live = false;
  private kept = false;
  private listening = false;
  private records: DiagRecord[] = [];
  private buckets = new Map<string, Bucket>();
  private agent: DiagAgent = 'none';
  private probe: (() => KeyboardProbe | null) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private line: HTMLElement | null = null;
  private keptKeyboardSamples = 0;

  private pendingKeys: number[] = [];
  private echoFrame = false;
  private opening: { sessionId: string; at: number } | null = null;
  private socketDownAt: number | null = null;
  private socketWasUp = false;

  private scrollPlace: DiagScrollPlace | null = null;
  private scrollLastEvent = 0;
  private scrollLastFrame = 0;
  private keyboardFrame = false;
  private keyboardSource: DiagKeyboardSource = 'start';
  private gapTimer: ReturnType<typeof setInterval> | null = null;
  /** The gap with nothing editable focused that is there now: when it began, its tallest. */
  private gap: { id: number; startedAt: number; since: number; px: number } | null = null;

  constructor(private readonly now: Clock = () => performance.now()) {}

  get mode(): DiagMode {
    return this.live ? 'live' : this.kept ? 'kept' : 'off';
  }

  get isLive(): boolean {
    return this.live;
  }

  get isKept(): boolean {
    return this.kept;
  }

  /** Reads the address and this device's "keep on"; called once as the app starts. */
  start(): void {
    let kept = false;
    try {
      kept = localStorage.getItem(DIAG_KEEP_STORAGE_KEY) === '1';
    } catch {
      // Storage blocked: only the live mode is available.
    }
    this.kept = kept;
    this.live = addressAsksForDiagnostics(window.location.search);
    this.apply();
  }

  /** The switch in Settings: with the line on screen, until the next reload. */
  setLive(on: boolean): void {
    if (this.live === on) return;
    this.live = on;
    this.apply();
  }

  /** "Keep on": remembered on this device, no line on screen. */
  setKept(on: boolean): void {
    try {
      if (on) localStorage.setItem(DIAG_KEEP_STORAGE_KEY, '1');
      else localStorage.removeItem(DIAG_KEEP_STORAGE_KEY);
    } catch {
      // Storage blocked: it lasts until the reload.
    }
    if (this.kept === on) return;
    this.kept = on;
    this.apply();
  }

  /** The session view's own keyboard numbers, while a session is open. */
  setKeyboardProbe(probe: (() => KeyboardProbe | null) | null): void {
    this.probe = probe;
  }

  /** Who is in the session on screen (`none` on the list). */
  setAgent(agent: DiagAgent): void {
    this.agent = agent;
  }

  // --- Hooks (each returns at once while the mode is off) -----------------------------------

  /** Input left for a session. Only its length is looked at, to tell a key from a paste. */
  keySent(length: number): void {
    if (!this.live && !this.kept) return;
    if (length < 1 || length > KEY_MAX_LENGTH) return;
    if (this.pendingKeys.length < 32) this.pendingKeys.push(this.now());
  }

  /** Output arrived for a session: the next frame is the one that paints it. */
  outputArrived(sessionId: string): void {
    if (!this.live && !this.kept) return;
    const opening = this.opening?.sessionId === sessionId ? this.opening : null;
    if (!opening && !this.pendingKeys.length) return;
    if (this.echoFrame) return;
    this.echoFrame = true;
    requestAnimationFrame(() => {
      this.echoFrame = false;
      const painted = this.now();
      const bucket = this.bucket();
      for (const sent of this.pendingKeys) {
        const ms = painted - sent;
        if (ms <= KEY_ECHO_TIMEOUT_MS && bucket.keys.length < MAX_SAMPLES) bucket.keys.push(ms);
      }
      this.pendingKeys = [];
      if (opening && this.opening === opening) {
        this.opening = null;
        const ms = painted - opening.at;
        if (ms <= OPEN_TIMEOUT_MS) {
          this.push({ kind: 'open', at: Date.now(), ...this.context(), ms: round(ms) });
        }
      }
    });
  }

  /** A session is being opened: the clock runs until its terminal's first painted output. */
  sessionOpening(sessionId: string): void {
    if (!this.live && !this.kept) return;
    this.opening = { sessionId, at: this.now() };
  }

  /** The terminal WebSocket went up or down. */
  socketState(connected: boolean): void {
    if (!this.live && !this.kept) return;
    if (!connected) {
      if (this.socketWasUp && this.socketDownAt === null) this.socketDownAt = this.now();
      return;
    }
    if (this.socketDownAt !== null) {
      const ms = this.now() - this.socketDownAt;
      this.push({ kind: 'ws', at: Date.now(), ...this.context(), ms: round(ms) });
    }
    this.socketDownAt = null;
    this.socketWasUp = true;
  }

  // --- Context and buckets --------------------------------------------------------------------

  private context(): DiagContext {
    const look = document.documentElement.getAttribute('data-look') ?? 'original';
    return {
      agent: this.agent,
      net: networkLabel(
        window.location.hostname,
        (navigator as Navigator & { connection?: unknown }).connection
      ),
      look: /^[a-z0-9][a-z0-9._/-]{0,39}$/.test(look) ? look : 'other',
    };
  }

  private bucket(): Bucket {
    const context = this.context();
    const key = `${context.agent}|${context.net}|${context.look}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { context, keys: [], scroll: { terminal: [], list: [] } };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private push(record: DiagRecord): void {
    if (this.records.length < DIAG_MAX_RECORDS_PER_BATCH) this.records.push(record);
  }

  // --- Keyboard -------------------------------------------------------------------------------

  /** One keyboard sample from the viewport as it is now. */
  measureKeyboard(src: DiagKeyboardSource): DiagKeyboardRecord {
    const vv = window.visualViewport;
    const ih = window.innerHeight;
    const vvh = vv ? vv.height : ih;
    const probe = this.probe?.() ?? null;
    return {
      kind: 'kbd',
      at: Date.now(),
      src,
      ih: round(ih),
      vvh: round(vvh),
      vvt: round(vv ? vv.offsetTop : 0),
      w: round(vv ? vv.width : window.innerWidth),
      base: round(probe?.baseline ?? 0),
      safari: round(Math.max(0, ih - vvh)),
      baseline: round(estimateKeyboardHeight(ih, vvh, probe?.baseline ?? 0)),
      applied: round(this.appliedGap()),
      edit: softKeyboardTarget() ? 1 : 0,
    };
  }

  /** The keyboard height the layout uses now: the open session's, else what <html> carries. */
  private appliedGap(): number {
    const probe = this.probe?.() ?? null;
    if (probe) return probe.applied;
    const css = Number.parseFloat(
      document.documentElement.style.getPropertyValue('--keyboard-height')
    );
    return Number.isFinite(css) ? css : 0;
  }

  /**
   * Looks for the keyboard's gap with no keyboard: a height applied while nothing editable has
   * the focus. Timed from the look that first saw it to the look that saw it gone.
   */
  checkGap(): void {
    const applied = softKeyboardTarget() ? 0 : this.appliedGap();
    if (applied > 0) {
      this.gap ??= {
        id: Math.floor(Math.random() * 1_000_000_000),
        startedAt: Date.now(),
        since: this.now(),
        px: 0,
      };
      this.gap.px = Math.max(this.gap.px, applied);
    } else if (this.gap) {
      this.pushGap(0);
      this.gap = null;
    }
  }

  private pushGap(open: number): void {
    if (!this.gap) return;
    this.push({
      kind: 'gap',
      id: this.gap.id,
      at: this.gap.startedAt,
      ...this.context(),
      ms: round(this.now() - this.gap.since),
      px: round(this.gap.px),
      open,
    });
  }

  /** After the app's own handlers ran (next frame), so `applied` is what they left. */
  private sampleKeyboardSoon(src: DiagKeyboardSource): void {
    this.keyboardSource = src;
    if (this.keyboardFrame) return;
    this.keyboardFrame = true;
    requestAnimationFrame(() => {
      this.keyboardFrame = false;
      if (!this.live && !this.kept) return;
      const record = this.measureKeyboard(this.keyboardSource);
      if (this.live) {
        this.push(record);
        this.paintLine(record);
      } else if (this.keptKeyboardSamples < KEPT_KEYBOARD_SAMPLES) {
        this.keptKeyboardSamples++;
        this.push(record);
      }
    });
  }

  private paintLine(record: DiagKeyboardRecord): void {
    if (!this.line) {
      const line = document.createElement('div');
      line.id = DIAG_LINE_ID;
      line.className = 'ut-diag-line';
      line.setAttribute('aria-hidden', 'true');
      line.style.zIndex = String(Z_INDEX.DIAG_LINE);
      document.body.appendChild(line);
      this.line = line;
    }
    this.line.textContent = keyboardLine(record);
  }

  // --- Scroll ---------------------------------------------------------------------------------

  private scrollFrame = (): void => {
    const now = this.now();
    if (this.scrollPlace === null) return;
    if (now - this.scrollLastEvent > SCROLL_IDLE_MS || (!this.live && !this.kept)) {
      this.scrollPlace = null;
      return;
    }
    const frames = this.bucket().scroll[this.scrollPlace];
    if (frames.length < MAX_SAMPLES) frames.push(now - this.scrollLastFrame);
    this.scrollLastFrame = now;
    requestAnimationFrame(this.scrollFrame);
  };

  private onScrollLike = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const place: DiagScrollPlace | null = target?.closest('session-view')
      ? 'terminal'
      : target?.closest('session-list')
        ? 'list'
        : null;
    if (!place) return;
    this.scrollLastEvent = this.now();
    if (this.scrollPlace !== null) {
      this.scrollPlace = place;
      return;
    }
    this.scrollPlace = place;
    this.scrollLastFrame = this.scrollLastEvent;
    requestAnimationFrame(this.scrollFrame);
  };

  // --- Listening and sending ------------------------------------------------------------------

  private onViewportResize = () => this.sampleKeyboardSoon('vv-resize');
  private onViewportScroll = () => this.sampleKeyboardSoon('vv-scroll');
  private onWindowResize = () => this.sampleKeyboardSoon('resize');
  private onFocusIn = () => this.sampleKeyboardSoon('focusin');
  private onFocusOut = () => this.sampleKeyboardSoon('focusout');
  private onOrientation = () => this.sampleKeyboardSoon('orientation');
  private onHidden = () => {
    if (document.hidden) void this.flush(true);
  };

  private apply(): void {
    const on = this.live || this.kept;
    // Turned off with a gap there: it ends here, in the batch stopListening() sends.
    if (!on && this.gap) {
      this.pushGap(0);
      this.gap = null;
    }
    if (on && !this.listening) this.listen();
    if (!on && this.listening) this.stopListening();
    if (!this.live && this.line) {
      this.line.remove();
      this.line = null;
    }
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = on
      ? setInterval(() => void this.flush(), this.live ? LIVE_FLUSH_MS : KEPT_FLUSH_MS)
      : null;
    if (this.gapTimer) clearInterval(this.gapTimer);
    this.gapTimer = on ? setInterval(() => this.checkGap(), GAP_POLL_MS) : null;
    if (on) this.sampleKeyboardSoon('start');
    window.dispatchEvent(new CustomEvent(DIAG_MODE_CHANGED_EVENT, { detail: { mode: this.mode } }));
  }

  private listen(): void {
    this.listening = true;
    const passive = { passive: true, capture: true } as const;
    window.visualViewport?.addEventListener('resize', this.onViewportResize);
    window.visualViewport?.addEventListener('scroll', this.onViewportScroll);
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onOrientation);
    document.addEventListener('focusin', this.onFocusIn);
    document.addEventListener('focusout', this.onFocusOut);
    document.addEventListener('visibilitychange', this.onHidden);
    for (const type of ['scroll', 'wheel', 'touchmove']) {
      document.addEventListener(type, this.onScrollLike, passive);
    }
  }

  private stopListening(): void {
    this.listening = false;
    window.visualViewport?.removeEventListener('resize', this.onViewportResize);
    window.visualViewport?.removeEventListener('scroll', this.onViewportScroll);
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onOrientation);
    document.removeEventListener('focusin', this.onFocusIn);
    document.removeEventListener('focusout', this.onFocusOut);
    document.removeEventListener('visibilitychange', this.onHidden);
    for (const type of ['scroll', 'wheel', 'touchmove']) {
      document.removeEventListener(type, this.onScrollLike, { capture: true });
    }
    void this.flush();
    this.pendingKeys = [];
    this.opening = null;
    this.scrollPlace = null;
  }

  /** The minute's keys and scroll frames as records, then everything waiting, as one batch. */
  takeBatch(): DiagBatch | null {
    const at = Date.now();
    for (const bucket of this.buckets.values()) {
      if (bucket.keys.length) {
        this.push({
          kind: 'keys',
          at,
          ...bucket.context,
          n: bucket.keys.length,
          p50: round(percentile(bucket.keys, 0.5)),
          p95: round(percentile(bucket.keys, 0.95)),
          max: round(Math.max(...bucket.keys)),
        });
      }
      for (const where of ['terminal', 'list'] as const) {
        const frames = bucket.scroll[where];
        if (!frames.length) continue;
        this.push({
          kind: 'scroll',
          at,
          ...bucket.context,
          where,
          frames: frames.length,
          p50: round(percentile(frames, 0.5)),
          p95: round(percentile(frames, 0.95)),
          slow: frames.filter((ms) => ms > DIAG_SLOW_FRAME_MS).length,
        });
      }
    }
    this.buckets.clear();
    this.keptKeyboardSamples = 0;
    // One still there leaves with what it has lasted so far; the next batch carries the rest.
    if (this.gap) {
      this.pushGap(1);
      this.gap = { ...this.gap, startedAt: Date.now(), since: this.now() };
    }
    if (!this.records.length) return null;
    const records = this.records;
    this.records = [];
    return { ua: navigator.userAgent.slice(0, DIAG_MAX_UA_LENGTH), records };
  }

  /** Sends what is waiting. A batch the server did not take is dropped: measures, not data. */
  async flush(leaving = false): Promise<void> {
    const batch = this.takeBatch();
    if (!batch) return;
    try {
      await fetch(DIAG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify(batch),
        keepalive: leaving,
      });
    } catch {
      // Offline or the server restarting: the next minute measures again.
    }
  }
}

export const inputDiagnostics = new InputDiagnostics();
