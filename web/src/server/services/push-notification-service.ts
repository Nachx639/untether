/**
 * PushNotificationService - Simplified push notification system
 *
 * This simplified service provides:
 * - Basic subscription storage
 * - Simple notification sending without user tracking or preferences
 */

import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type webpush from 'web-push';
import type { NotificationPreferences } from '../../types/config.js';
import { createLogger } from '../utils/logger.js';
import type { VapidManager } from '../utils/vapid-manager.js';
import { type AttentionView, decideAttention } from './agent-attention-policy.js';
import type { EventInput } from './event-log.js';

const logger = createLogger('push-notification-service');

/**
 * Simplified push subscription data structure
 */
export interface PushSubscription {
  id: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  subscribedAt: string;
  isActive: boolean;
}

/**
 * Generic notification payload
 */
export interface NotificationPayload {
  type: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  actions?: Array<{
    action: string;
    title: string;
  }>;
  data?: Record<string, unknown>;
}

/**
 * Send notification result
 */
export interface SendNotificationResult {
  success: boolean;
  sent: number;
  failed: number;
  errors: string[];
  /** Why nothing was sent, when it was skipped on purpose. */
  skipped?: 'preferences' | 'muted' | 'on-screen' | 'held' | 'seen' | 'no-subscriptions';
}

/**
 * Simplified push notification service
 */
/** How long the push service keeps an undelivered notification (phone offline). */
const PUSH_TTL_SECONDS = 60 * 60;
/** Per-subscription network timeout for one push request. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Which Settings switch governs each push type. Types not listed (Claude/Codex/Gemini
 * finished or waiting, task finished or missed, tests) are always sent.
 */
export const NOTIFICATION_PREFERENCE_FOR_TYPE: Record<string, keyof NotificationPreferences> = {
  'session-start': 'sessionStart',
  'session-exit': 'sessionExit',
  // A non-zero exit is usually a session the user killed: same switch as a normal exit.
  'session-error': 'sessionExit',
  'command-finished': 'commandCompletion',
  'command-error': 'commandError',
  bell: 'bell',
  // 'preview-ready' (`ut open`) has no switch of its own, like the agent pushes: asked for
  // explicitly, it still honours mute and "session on screen".
};

/** A bell push for a session is held this long, to see if an agent notification covers it. */
export const BELL_HOLD_MS = 5_000;
/** At most one bell push per session in this window. */
export const BELL_THROTTLE_MS = 60_000;
/**
 * A held push found on disk at start whose time came longer ago than this is dropped, not
 * sent: the server was down, and what it said may no longer be true.
 */
export const HELD_PUSH_STALE_MS = 10 * 60_000;
/** A semantic (Claude/Codex/Gemini) push this close to a bell makes the bell redundant. */
const SEMANTIC_WINDOW_MS = 10_000;

export class PushNotificationService {
  private lastSemanticAt = new Map<string, number>();
  private lastBellAt = new Map<string, number>();
  private pendingBells = new Map<string, NodeJS.Timeout>();

  private vapidManager: VapidManager;
  private subscriptions = new Map<string, PushSubscription>();
  private initialized = false;
  private isSessionMuted: (sessionId: string) => boolean = () => false;
  private isTypeAllowed: (type: string) => boolean = () => true;
  private attentionView: AttentionView = {
    isSessionViewed: () => false,
    wasSeenSince: () => false,
    isAnyClientActive: () => false,
  };
  /** Important pushes waiting to be seen in a client (agent-attention-policy.ts), by tag. */
  private heldPushes = new Map<
    string,
    { timer: NodeJS.Timeout; payload: NotificationPayload; heldSince: number; sendAt: number }
  >();
  /**
   * The held pushes on disk (2026-11-02): a restart within the hold lost them (shutdown sends
   * them, but a dev restart or a crash never got there). Loaded and held again at start.
   */
  private readonly heldFile: string;
  private isPreviewViewed: (previewId: string) => boolean = () => false;
  private readonly subscriptionsFile: string;
  /**
   * Sends started by a timer (held pushes, bells) that nobody awaits. Shutdown and tests wait
   * for them: one still writing subscriptions.json made a test's temp-dir removal fail with
   * ENOTEMPTY under load (2026-11-02).
   */
  private background = new Set<Promise<unknown>>();

  constructor(vapidManager: VapidManager, storageDir?: string) {
    this.vapidManager = vapidManager;
    storageDir ??= path.join(os.homedir(), '.untether/notifications');
    this.subscriptionsFile = path.join(storageDir, 'subscriptions.json');
    this.heldFile = path.join(storageDir, 'held-pushes.json');
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure storage directory exists
      await fs.mkdir(path.dirname(this.subscriptionsFile), { recursive: true });

      // Load existing subscriptions
      await this.loadSubscriptions();
      // Pushes a restart cut short while they were held: held again for what was left.
      await this.loadHeldPushes();

      this.initialized = true;
      logger.log('PushNotificationService initialized');
    } catch (error) {
      logger.error('Failed to initialize PushNotificationService:', error);
      throw error;
    }
  }

  /**
   * Add a new subscription
   */
  async addSubscription(endpoint: string, keys: { p256dh: string; auth: string }): Promise<string> {
    const subscriptionId = this.generateSubscriptionId(endpoint, keys);

    const subscription: PushSubscription = {
      id: subscriptionId,
      endpoint,
      keys,
      subscribedAt: new Date().toISOString(),
      isActive: true,
    };

    this.subscriptions.set(subscriptionId, subscription);
    await this.saveSubscriptions();

    logger.log(`New subscription added: ${subscriptionId}`);
    return subscriptionId;
  }

  /**
   * Remove a subscription
   */
  async removeSubscription(subscriptionId: string): Promise<boolean> {
    const existed = this.subscriptions.delete(subscriptionId);
    if (existed) {
      await this.saveSubscriptions();
      logger.log(`Subscription removed: ${subscriptionId}`);
    }
    return existed;
  }

  /**
   * Get all active subscriptions
   */
  getSubscriptions(): PushSubscription[] {
    return Array.from(this.subscriptions.values()).filter((sub) => sub.isActive);
  }

  /** Notifications about a session the user muted are dropped, whoever sends them. */
  /** Drop push types the user switched off in Settings. */
  setPreferenceFilter(filter: (type: string) => boolean): void {
    this.isTypeAllowed = filter;
  }

  /** The public event log (event-log.ts): every push but bells, as raised (sent or not). */
  private eventSink: ((event: EventInput) => void) | null = null;
  setEventSink(sink: (event: EventInput) => void): void {
    this.eventSink = sink;
  }

  setMuteFilter(isSessionMuted: (sessionId: string) => boolean): void {
    this.isSessionMuted = isSessionMuted;
  }

  /**
   * What the user's clients show (ws-v3-hub.ts): agent, bell and command pushes about a
   * session on screen are skipped, important ones wait to be seen (agent-attention-policy.ts).
   * Session start/exit and tests always go out.
   */
  setAttentionView(view: AttentionView): void {
    this.attentionView = view;
  }

  /** "Preview ready" is held back while that preview's view (/preview/<id>) is shown. */
  setPreviewViewedFilter(isPreviewViewed: (previewId: string) => boolean): void {
    this.isPreviewViewed = isPreviewViewed;
  }

  /**
   * Send notification to all subscriptions
   */
  async sendNotification(
    payload: NotificationPayload,
    heldSince?: number
  ): Promise<SendNotificationResult> {
    // Why a push was not sent, in the log (2026-10-03: "Claude finished" never reached the
    // iPhone and nothing said why). Bells ring constantly: theirs stay at debug level.
    // Once per push (a held one comes back with heldSince), its title only: bodies carry the
    // agent's words.
    if (heldSince === undefined && payload.type !== 'bell') {
      const data = payload.data ?? {};
      this.eventSink?.({
        type: 'push',
        pushType: payload.type,
        title: payload.title,
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
        taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
      });
    }
    const skip = (
      skipped: NonNullable<SendNotificationResult['skipped']>,
      why: string
    ): SendNotificationResult => {
      const line = `push ${payload.type} not sent: ${why}`;
      if (payload.type === 'bell') logger.debug(line);
      else logger.log(line);
      return { success: true, sent: 0, failed: 0, errors: [], skipped };
    };
    if (!this.isTypeAllowed(payload.type)) {
      return skip('preferences', 'turned off in the notification settings');
    }
    const sessionId = payload.data?.sessionId;
    if (typeof sessionId === 'string' && this.isSessionMuted(sessionId)) {
      return skip('muted', `session ${sessionId} is muted`);
    }
    if (typeof sessionId === 'string' && /^(claude|codex|gemini|task)-/.test(payload.type)) {
      this.lastSemanticAt.set(sessionId, Date.now());
      // The agent's own notification says more than the bell it rang for the same moment.
      const pending = this.pendingBells.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        this.pendingBells.delete(sessionId);
      }
    }

    const attention = decideAttention(payload, this.attentionView, heldSince);
    if (attention.action === 'skip') {
      return skip(heldSince === undefined ? 'on-screen' : 'seen', attention.why);
    }
    if (attention.action === 'hold') {
      this.holdUntilSeen(payload, attention.ms);
      return skip('held', `on screen in some client, sent in ${attention.ms / 1000} s unless seen`);
    }
    const previewId = payload.data?.id;
    if (
      payload.type === 'preview-ready' &&
      typeof previewId === 'string' &&
      this.isPreviewViewed(previewId)
    ) {
      return skip('on-screen', `preview ${previewId} is on screen in some client`);
    }

    if (!this.vapidManager.isEnabled()) {
      throw new Error('VAPID not properly configured');
    }

    const activeSubscriptions = this.getSubscriptions();
    if (activeSubscriptions.length === 0) {
      return skip('no-subscriptions', 'no phone or browser is subscribed');
    }

    let successful = 0;
    let failed = 0;
    let removed = false;
    const errors: string[] = [];

    const webPushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/apple-touch-icon.png',
      badge: payload.badge || '/favicon-32.png',
      tag: payload.tag || `untether-${payload.type}`,
      requireInteraction: payload.requireInteraction || false,
      actions: payload.actions || [],
      data: {
        type: payload.type,
        timestamp: new Date().toISOString(),
        ...payload.data,
      },
    });

    // Send to every subscription in parallel, each with its own timeout: one dead push
    // endpoint used to hold POST /api/push/test (and every later alert) for minutes.
    await Promise.all(
      activeSubscriptions.map(async (subscription) => {
        try {
          const webpushSubscription: webpush.PushSubscription = {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          };

          await this.vapidManager.sendNotification(webpushSubscription, webPushPayload, {
            TTL: PUSH_TTL_SECONDS,
            timeout: PUSH_TIMEOUT_MS,
          });
          successful++;

          logger.debug(`Notification sent to: ${subscription.id}`);
        } catch (error) {
          failed++;
          const errorMsg = `Failed to send to ${subscription.id}: ${error}`;
          errors.push(errorMsg);
          logger.warn(errorMsg);

          // Remove expired/invalid subscriptions
          const shouldRemove = this.shouldRemoveSubscription(error);
          if (shouldRemove) {
            removed = this.subscriptions.delete(subscription.id) || removed;
            const webPushError = error as Error & { statusCode?: number };
            logger.log(
              `Removed expired subscription: ${subscription.id} (status: ${webPushError.statusCode})`
            );
          } else {
            // Debug log for unhandled errors
            const webPushError = error as Error & { statusCode?: number };
            logger.debug(
              `Not removing subscription ${subscription.id}, error: ${error instanceof Error ? error.message : String(error)}, statusCode: ${webPushError.statusCode}`
            );
          }
        }
      })
    );

    // Only a removed subscription changes the file (2026-11-10: it was rewritten on every push).
    if (removed) await this.saveSubscriptions();

    logger.log(`Notification sent: ${successful} successful, ${failed} failed`, {
      type: payload.type,
      title: payload.title,
    });

    return {
      success: true,
      sent: successful,
      failed,
      errors,
    };
  }

  /**
   * An important push while a client may be showing it: sent after `ms` unless it was seen
   * meanwhile. A newer push under the same tag replaces the waiting one.
   */
  private holdUntilSeen(payload: NotificationPayload, ms: number, heldSince = Date.now()): void {
    const key = payload.tag || `untether-${payload.type}`;
    const previous = this.heldPushes.get(key);
    if (previous) clearTimeout(previous.timer);
    const sendAt = heldSince + ms;
    const timer = setTimeout(
      () => {
        if (this.heldPushes.get(key)?.timer !== timer) return;
        this.heldPushes.delete(key);
        this.saveHeldPushes();
        this.inBackground(
          this.sendNotification(payload, heldSince).catch((error) =>
            logger.warn(`Held ${payload.type} notification failed:`, error)
          )
        );
      },
      Math.max(0, sendAt - Date.now())
    );
    timer.unref?.();
    this.heldPushes.set(key, { timer, payload, heldSince, sendAt });
    this.saveHeldPushes();
  }

  /**
   * Drops the held pushes `matches` picks: what they announce was resolved while they waited
   * (2026-11-09: a question answered 24 s after it was asked still went to the phone at 30 s).
   */
  withdrawHeld(matches: (payload: NotificationPayload) => boolean): void {
    let dropped = false;
    for (const [key, held] of this.heldPushes) {
      if (!matches(held.payload)) continue;
      clearTimeout(held.timer);
      this.heldPushes.delete(key);
      dropped = true;
    }
    if (dropped) this.saveHeldPushes();
  }

  /** The held pushes to disk, whole and atomically (tmp + rename); none: the file goes. */
  private saveHeldPushes(): void {
    const held = [...this.heldPushes.values()].map(({ payload, heldSince, sendAt }) => ({
      payload,
      heldSince,
      sendAt,
    }));
    try {
      if (!held.length) {
        fsSync.rmSync(this.heldFile, { force: true });
        return;
      }
      fsSync.mkdirSync(path.dirname(this.heldFile), { recursive: true });
      const tmp = `${this.heldFile}.${process.pid}.tmp`;
      fsSync.writeFileSync(tmp, JSON.stringify(held), { mode: 0o600 });
      fsSync.renameSync(tmp, this.heldFile);
    } catch (error) {
      logger.warn('Could not save the held pushes:', error);
    }
  }

  private async loadHeldPushes(): Promise<void> {
    let held: Array<{ payload: NotificationPayload; heldSince: number; sendAt: number }>;
    try {
      held = JSON.parse(await fs.readFile(this.heldFile, 'utf8'));
      if (!Array.isArray(held)) return;
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of held) {
      if (!entry?.payload || !Number.isFinite(entry.heldSince) || !Number.isFinite(entry.sendAt)) {
        continue;
      }
      if (now - entry.sendAt > HELD_PUSH_STALE_MS) {
        logger.log(
          `held push ${entry.payload.type} dropped: its time passed while Untether was down`
        );
        continue;
      }
      this.holdUntilSeen(entry.payload, entry.sendAt - entry.heldSince, entry.heldSince);
    }
    this.saveHeldPushes();
  }

  /**
   * A terminal bell from a session. Claude Code and other agents ring it when they finish or
   * ask something, in bursts, so on its own it flooded the phone (~12 pushes per reply,
   * 2026-10-02). A bell is held BELL_HOLD_MS and dropped when an agent notification for the
   * same session lands around it; otherwise at most one per session per BELL_THROTTLE_MS,
   * under one tag per session so a newer one replaces the older.
   */
  queueSessionBell(sessionId: string, payload: NotificationPayload): boolean {
    const now = Date.now();
    if (now - (this.lastSemanticAt.get(sessionId) ?? 0) < SEMANTIC_WINDOW_MS) return false;
    if (now - (this.lastBellAt.get(sessionId) ?? 0) < BELL_THROTTLE_MS) return false;
    if (this.pendingBells.has(sessionId)) return false;
    this.lastBellAt.set(sessionId, now);
    const timer = setTimeout(() => {
      this.pendingBells.delete(sessionId);
      if (Date.now() - (this.lastSemanticAt.get(sessionId) ?? 0) < SEMANTIC_WINDOW_MS) return;
      this.inBackground(
        this.sendNotification({ ...payload, tag: `untether-bell-${sessionId}` }).catch((error) =>
          logger.warn(`Bell notification for ${sessionId} failed:`, error)
        )
      );
    }, BELL_HOLD_MS);
    timer.unref?.();
    this.pendingBells.set(sessionId, timer);
    return true;
  }

  /**
   * Determine if a subscription should be removed based on the error
   */
  private shouldRemoveSubscription(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    // Check for HTTP 410 Gone status (subscription expired)
    // WebPushError has a statusCode property
    const webPushError = error as Error & { statusCode?: number };
    // 404/410: the push service forgot it. Key errors are thrown by web-push before any
    // request (e.g. a p256dh that isn't a P-256 point): that subscription can never work.
    if (webPushError.statusCode === 410 || webPushError.statusCode === 404) {
      return true;
    }
    if (
      /subscription (p256dh|auth key|endpoint)|No user (public key|auth) provided|pass in a subscription/i.test(
        error.message
      )
    ) {
      return true;
    }

    // Also check message content for other error formats
    if (error.message.includes('410') || error.message.includes('Gone')) {
      return true;
    }

    // Check for other expired/invalid subscription indicators
    const errorMessage = error.message.toLowerCase();
    return (
      errorMessage.includes('invalid') ||
      errorMessage.includes('expired') ||
      errorMessage.includes('no such subscription') ||
      errorMessage.includes('unsubscribed')
    );
  }

  /**
   * Load subscriptions from file
   */
  private async loadSubscriptions(): Promise<void> {
    try {
      const data = await fs.readFile(this.subscriptionsFile, 'utf8');
      const subscriptions: PushSubscription[] = JSON.parse(data);

      this.subscriptions.clear();
      for (const subscription of subscriptions) {
        this.subscriptions.set(subscription.id, subscription);
      }

      logger.debug(`Loaded ${subscriptions.length} subscriptions`);
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') {
        logger.debug('No existing subscriptions file found');
      } else {
        // Unreadable (2026-11-10): set aside, so the next save does not write an empty list
        // over what could still be recovered by hand.
        const aside = `${this.subscriptionsFile}.bad-${Date.now()}`;
        await fs.rename(this.subscriptionsFile, aside).catch(() => {});
        logger.error(`Failed to load subscriptions (kept as ${aside}):`, error);
      }
    }
  }

  private subscriptionsSaved: Promise<void> = Promise.resolve();

  /**
   * Save subscriptions to file: whole and atomically (tmp + rename), one write at a time.
   * 2026-11-10: it was written in place, and two pushes at once could leave the shorter list
   * with the tail of the longer one: broken JSON, and the next start saved an empty list over
   * it (the phone silently stopped getting notifications).
   */
  private saveSubscriptions(): Promise<void> {
    this.subscriptionsSaved = this.subscriptionsSaved.then(async () => {
      try {
        const subscriptions = Array.from(this.subscriptions.values());
        const tmp = `${this.subscriptionsFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(subscriptions, null, 2), { mode: 0o600 });
        await fs.rename(tmp, this.subscriptionsFile);
        logger.debug(`Saved ${subscriptions.length} subscriptions`);
      } catch (error) {
        logger.error('Failed to save subscriptions:', error);
      }
    });
    return this.subscriptionsSaved;
  }

  private inBackground(work: Promise<unknown>): void {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Resolves once every send a timer started (and its subscriptions write) has finished. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled(this.background);
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    // A restart must not lose an important push nobody has seen yet: it goes now, unless seen.
    const held = [...this.heldPushes.values()];
    this.heldPushes.clear();
    for (const { timer } of held) clearTimeout(timer);
    this.saveHeldPushes();
    await Promise.all(
      held.map(({ payload, heldSince }) =>
        this.sendNotification(payload, heldSince).catch((error) =>
          logger.warn(`Held ${payload.type} notification failed at shutdown:`, error)
        )
      )
    );
    await this.settled();
    await this.saveSubscriptions();
    logger.log('PushNotificationService shutdown');
  }

  /**
   * Generate unique subscription ID
   */
  private generateSubscriptionId(endpoint: string, keys: { p256dh: string; auth: string }): string {
    try {
      const url = new URL(endpoint);
      const hash = Buffer.from(keys.p256dh).toString('base64').substring(0, 8);
      return `${url.hostname}-${hash}`;
    } catch {
      // Fallback to a hash of the entire endpoint
      return Buffer.from(endpoint).toString('base64').substring(0, 16);
    }
  }
}
