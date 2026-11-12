/**
 * The project connector (2026-10-31, bakery's hub: «pedir arreglos desde dentro de la app y
 * ver las respuestas»): an external app's agents talk to ONE project's orchestrator with a
 * token of their own (connector-tokens.ts), and nothing else. Off until the user makes a
 * token; the transports (connector-http.ts: HTTP and MCP) are thin layers over this.
 *
 * What a token can do, all within its project:
 * - send a message (text and a few small images): typed into the orchestrator exactly like
 *   another orchestrator's request (`ut project tell`, the same queue), marked as an external
 *   app's, the sender's claims unverified, the text quoted so it can't end or fake the
 *   envelope (shared/orchestrator-prompt.ts externalRequestMessage). Never as the user's.
 * - read the orchestrator's replies to its messages: the assistant text of the turn the
 *   message started, nothing else of the conversation (tools, other turns, task events). It
 *   is captured into messages.json as it appears, so a reply outlives the chat's window.
 * - read its tasks: id, title, state, timings, branch, the last summary or blocker line and
 *   who it waits on. Never prompts, logs or diffs. Live as events (SSE) too.
 * It never creates, sends to, merges or discards tasks, and sees no other project.
 *
 * Every use is logged in usage.log (time, channel, operation, size and hash), never the
 * content; sizes and rates are capped per token.
 */
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  type ExternalSender,
  externalRequestMessage,
  isQuietReply,
  oneLine,
} from '../../../shared/orchestrator-prompt.js';
import { TASK_FINAL_STATES, type TaskRecord } from '../../../shared/tasks.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../pty/private-perms.js';
import { redactSecrets } from '../security-sweep.js';
import type { ConnectorChannelInfo, ConnectorTokens } from './connector-tokens.js';

export const CONNECTOR_API_VERSION = 1;
/** One message's text at most (characters). */
export const MESSAGE_TEXT_MAX = 8000;
export const MESSAGE_IMAGES_MAX = 4;
/** One image at most, decoded. */
export const IMAGE_BYTES_MAX = 2 * 1024 * 1024;
/** A request body at most (base64 images included). */
export const BODY_BYTES_MAX = 12 * 1024 * 1024;
/** Claimed sender fields at most (characters each). */
export const SENDER_FIELD_MAX = 120;
/** Messages per channel: per minute and per hour. */
export const SEND_PER_MINUTE = 6;
export const SEND_PER_HOUR = 60;
/** Reads (replies, tasks, info) per channel per minute. */
export const READS_PER_MINUTE = 120;
/** Live event streams open at once per channel. */
export const STREAMS_PER_CHANNEL = 3;
/** A reply's text at most (characters). */
export const REPLY_TEXT_MAX = 8000;
/** Messages kept per channel (their replies with them). */
const MESSAGES_KEPT = 300;
/** A message whose turn never showed up in the chat stops being looked for after this. */
const LOOK_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Final tasks listed (newest first) with ?all. */
const FINAL_TASKS_MAX = 50;
const USAGE_LOG_MAX = 2 * 1024 * 1024;

const IMAGE_TYPES: Record<string, { ext: string; magic: (bytes: Buffer) => boolean }> = {
  'image/png': {
    ext: 'png',
    magic: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  'image/jpeg': {
    ext: 'jpg',
    magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/gif': {
    ext: 'gif',
    magic: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  },
  'image/webp': {
    ext: 'webp',
    magic: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
export const IMAGE_MIME_TYPES = Object.keys(IMAGE_TYPES);

export type ConnectorErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad-request'
  | 'not-found'
  | 'too-large'
  | 'invalid-image'
  | 'rate-limited'
  | 'no-orchestrator'
  | 'unavailable';

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly retryAfterSec?: number
  ) {
    super(message);
  }
}

export const CONNECTOR_HTTP_STATUS: Record<ConnectorErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  'bad-request': 400,
  'not-found': 404,
  'too-large': 413,
  'invalid-image': 422,
  'rate-limited': 429,
  'no-orchestrator': 409,
  unavailable: 503,
};

export interface ConnectorImageInput {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface ConnectorSendInput {
  text: unknown;
  images?: unknown;
  from?: unknown;
}

export interface ConnectorReply {
  /** Per channel, increasing: the cursor of GET /replies. */
  seq: number;
  messageId: string;
  at: string;
  text: string;
}

type MessageState = 'queued' | 'delivered' | 'answered';

interface StoredMessage {
  id: string;
  channelId: string;
  repoPath: string;
  at: string;
  bytes: number;
  sha256: string;
  images: number;
  state: MessageState;
  deliveredAt?: string;
  /** The orchestrator's turn for it is over (the next prompt came, or Claude went idle). */
  done: boolean;
  replies: Array<ConnectorReply & { chatId: string }>;
}

interface StoredState {
  seq: Record<string, number>;
  messages: StoredMessage[];
}

export interface ConnectorMessageView {
  id: string;
  at: string;
  state: MessageState;
  deliveredAt?: string;
  done: boolean;
  replies: ConnectorReply[];
}

/** A task as the connector shows it: no prompt, log or diff. */
export interface ConnectorTaskView {
  id: string;
  title: string;
  state: TaskRecord['state'];
  stateSince: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  branch?: string;
  baseBranch?: string;
  /** Who it waits on now: the user, the project's orchestrator, or nobody. */
  waitingOn: 'user' | 'orchestrator' | null;
  blocker?: { kind: string; message: string };
  /** The agent's last summary, or the last line Untether told about it. */
  lastNote?: string;
  timings: Array<{
    phase: string;
    round: number;
    startedAt: string;
    finishedAt?: string;
    outcome?: string;
  }>;
}

/** One message of the orchestrator's chat (session-chat.ts shape, what is used of it). */
export interface ConnectorChatMessage {
  id: string;
  role: string;
  text: string;
  timestamp?: string;
}

export interface ConnectorServiceDeps {
  tokens: ConnectorTokens;
  /** Where messages.json and usage.log live (0700). */
  dir: string;
  /** Where images go (control/uploads, like the app's uploads). */
  uploadsDir: string;
  /** Types the request into the project's orchestrator (its queue); false when none runs. */
  relay: (repoPath: string, text: string) => boolean;
  /** The project's orchestrator session, if one runs. */
  orchestratorSession: (repoPath: string) => string | undefined;
  /** That session's chat (claude-chat.ts). */
  chat: (
    sessionId: string
  ) => Promise<{ available: boolean; status?: string; messages: readonly ConnectorChatMessage[] }>;
  /** Every task; null when tasks are off. */
  tasks: () => readonly TaskRecord[] | null;
  /** A task's project (normalized), as task-commands.ts finds it. */
  taskRepo: (task: TaskRecord) => string | undefined;
  now?: () => number;
  log?: (message: string) => void;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Sliding-window counters per key. */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}

  /** null when allowed (and counted), else seconds until it would be. */
  take(key: string, limits: ReadonlyArray<{ max: number; windowMs: number }>): number | null {
    const now = this.now();
    const longest = Math.max(...limits.map((limit) => limit.windowMs));
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < longest);
    for (const { max, windowMs } of limits) {
      const inWindow = list.filter((at) => now - at < windowMs);
      if (inWindow.length >= max) {
        this.hits.set(key, list);
        return Math.max(1, Math.ceil((inWindow[0] + windowMs - now) / 1000));
      }
    }
    list.push(now);
    this.hits.set(key, list);
    return null;
  }
}

export class ConnectorService {
  private readonly limiter: RateLimiter;
  private state: StoredState = { seq: {}, messages: [] };
  private streams = new Map<string, number>();
  private scanning: Promise<void> | null = null;

  constructor(private readonly deps: ConnectorServiceDeps) {
    this.limiter = new RateLimiter(() => this.now());
    this.load();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get statePath(): string {
    return path.join(this.deps.dir, 'messages.json');
  }

  get usageLogPath(): string {
    return path.join(this.deps.dir, 'usage.log');
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as StoredState;
      this.state = {
        seq: parsed.seq && typeof parsed.seq === 'object' ? parsed.seq : {},
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch {
      this.state = { seq: {}, messages: [] };
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.chmodSync(this.deps.dir, PRIVATE_DIR_MODE);
  }

  private save(): void {
    this.ensureDir();
    // Messages of channels that are gone go with them; each channel keeps its newest.
    const live = new Set(this.deps.tokens.list().map((channel) => channel.id));
    const kept: StoredMessage[] = [];
    const counts = new Map<string, number>();
    for (const message of [...this.state.messages].reverse()) {
      if (!live.has(message.channelId)) continue;
      const count = counts.get(message.channelId) ?? 0;
      if (count >= MESSAGES_KEPT) continue;
      counts.set(message.channelId, count + 1);
      kept.unshift(message);
    }
    this.state.messages = kept;
    this.state.seq = Object.fromEntries(
      Object.entries(this.state.seq).filter(([channelId]) => live.has(channelId))
    );
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: PRIVATE_FILE_MODE });
    fs.renameSync(tmp, this.statePath);
  }

  /** One line per use: never the content (2026-10-31 request: time, channel, size, hash). */
  private usage(
    channel: ConnectorChannelInfo | null,
    op: string,
    status: number,
    extra: { bytes?: number; sha256?: string; messageId?: string } = {}
  ): void {
    try {
      this.ensureDir();
      const file = this.usageLogPath;
      try {
        if (fs.statSync(file).size > USAGE_LOG_MAX) fs.renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
      const line = {
        at: new Date(this.now()).toISOString(),
        channel: channel?.name ?? null,
        channelId: channel?.id ?? null,
        op,
        status,
        ...extra,
      };
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: PRIVATE_FILE_MODE });
    } catch (error) {
      this.deps.log?.(`connector: usage log failed: ${error}`);
    }
  }

  /**
   * The channel of a bearer token, or 401. Failed attempts are logged (no token in the log)
   * and rate limited all together.
   */
  authenticate(authorization: string | undefined, op: string): ConnectorChannelInfo {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
    const channel = this.deps.tokens.authenticate(match?.[1]);
    if (!channel) {
      this.usage(null, op, 401);
      const wait = this.limiter.take('bad-auth', [{ max: 30, windowMs: 60_000 }]);
      if (wait !== null) {
        throw new ConnectorError('rate-limited', 'Too many bad tokens; try again later', wait);
      }
      throw new ConnectorError('unauthorized', 'Missing, unknown or revoked token');
    }
    this.deps.tokens.touch(channel.id);
    return channel;
  }

  private read(channel: ConnectorChannelInfo, op: string): void {
    const wait = this.limiter.take(`read:${channel.id}`, [
      { max: READS_PER_MINUTE, windowMs: 60_000 },
    ]);
    if (wait !== null) {
      this.usage(channel, op, 429);
      throw new ConnectorError('rate-limited', `At most ${READS_PER_MINUTE} reads a minute`, wait);
    }
    this.usage(channel, op, 200);
  }

  /** The channel still exists and is active (a live stream ends when it is revoked). */
  stillValid(channel: ConnectorChannelInfo): boolean {
    return this.deps.tokens.list().some((entry) => entry.id === channel.id && entry.active);
  }

  info(channel: ConnectorChannelInfo) {
    this.read(channel, 'info');
    return {
      name: 'untether-connector',
      apiVersion: CONNECTOR_API_VERSION,
      channel: { id: channel.id, name: channel.name },
      project: {
        name: path.basename(channel.repoPath),
        orchestrator: this.deps.orchestratorSession(channel.repoPath) ? 'running' : 'none',
      },
      permissions: channel.permissions,
      limits: {
        textMax: MESSAGE_TEXT_MAX,
        imagesMax: MESSAGE_IMAGES_MAX,
        imageBytesMax: IMAGE_BYTES_MAX,
        imageTypes: IMAGE_MIME_TYPES,
        bodyBytesMax: BODY_BYTES_MAX,
        sendPerMinute: SEND_PER_MINUTE,
        sendPerHour: SEND_PER_HOUR,
        readsPerMinute: READS_PER_MINUTE,
      },
    };
  }

  private sender(from: unknown): ExternalSender {
    if (from === undefined || from === null) return {};
    if (typeof from !== 'object' || Array.isArray(from)) {
      throw new ConnectorError('bad-request', 'from must be an object {agent, onBehalfOf, room}');
    }
    const out: ExternalSender = {};
    for (const key of ['agent', 'onBehalfOf', 'room'] as const) {
      const value = (from as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > SENDER_FIELD_MAX) {
        throw new ConnectorError(
          'bad-request',
          `from.${key} must be a string of at most ${SENDER_FIELD_MAX} characters`
        );
      }
      if (value.trim()) out[key] = value;
    }
    return out;
  }

  private images(images: unknown): Array<{ bytes: Buffer; ext: string }> {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw new ConnectorError('bad-request', 'images must be a list');
    if (images.length > MESSAGE_IMAGES_MAX) {
      throw new ConnectorError('too-large', `At most ${MESSAGE_IMAGES_MAX} images per message`);
    }
    return images.map((image: unknown, index) => {
      const { mimeType, data } = (image ?? {}) as Partial<ConnectorImageInput>;
      const type = typeof mimeType === 'string' ? IMAGE_TYPES[mimeType.toLowerCase()] : undefined;
      if (!type) {
        throw new ConnectorError(
          'invalid-image',
          `images[${index}]: mimeType must be one of ${IMAGE_MIME_TYPES.join(', ')}`
        );
      }
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) {
        throw new ConnectorError('invalid-image', `images[${index}]: data must be base64`);
      }
      if (Math.floor((data.length * 3) / 4) > IMAGE_BYTES_MAX + 3) {
        throw new ConnectorError(
          'too-large',
          `images[${index}]: at most ${IMAGE_BYTES_MAX} bytes per image`
        );
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > IMAGE_BYTES_MAX) {
        throw new ConnectorError(
          'too-large',
          `images[${index}]: at most ${IMAGE_BYTES_MAX} bytes per image`
        );
      }
      if (!type.magic(bytes)) {
        throw new ConnectorError(
          'invalid-image',
          `images[${index}]: its content is not a ${mimeType} image`
        );
      }
      return { bytes, ext: type.ext };
    });
  }

  /**
   * A message for the channel's orchestrator: validated, rate limited, its images saved,
   * typed in through the orchestrator's queue. Returns its id.
   */
  send(
    channel: ConnectorChannelInfo,
    input: ConnectorSendInput
  ): { messageId: string; state: MessageState } {
    const op = 'send';
    let size = 0;
    try {
      const text = typeof input?.text === 'string' ? input.text : undefined;
      if (text === undefined || !text.trim()) {
        throw new ConnectorError('bad-request', 'text is required');
      }
      if (text.length > MESSAGE_TEXT_MAX) {
        throw new ConnectorError('too-large', `text: at most ${MESSAGE_TEXT_MAX} characters`);
      }
      const sender = this.sender(input.from);
      const images = this.images(input.images);
      size = Buffer.byteLength(text) + images.reduce((sum, image) => sum + image.bytes.length, 0);
      const wait = this.limiter.take(`send:${channel.id}`, [
        { max: SEND_PER_MINUTE, windowMs: 60_000 },
        { max: SEND_PER_HOUR, windowMs: 60 * 60_000 },
      ]);
      if (wait !== null) {
        throw new ConnectorError(
          'rate-limited',
          `At most ${SEND_PER_MINUTE} messages a minute and ${SEND_PER_HOUR} an hour`,
          wait
        );
      }
      if (!this.deps.orchestratorSession(channel.repoPath)) {
        throw new ConnectorError(
          'no-orchestrator',
          `${path.basename(channel.repoPath)} has no orchestrator running: ask its owner to start one`
        );
      }
      const messageId = `m_${randomBytes(6).toString('hex')}`;
      const files = images.map((image) => {
        fs.mkdirSync(this.deps.uploadsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
        const file = path.join(
          this.deps.uploadsDir,
          `connector-${messageId}-${randomBytes(4).toString('hex')}.${image.ext}`
        );
        fs.writeFileSync(file, image.bytes, { mode: PRIVATE_FILE_MODE });
        return file;
      });
      const hash = sha256(
        Buffer.concat([Buffer.from(text), ...images.map((image) => image.bytes)])
      );
      const typed = externalRequestMessage({
        messageId,
        channel: channel.name,
        sender,
        text,
        images: files,
      });
      if (!this.deps.relay(channel.repoPath, typed)) {
        for (const file of files) fs.rmSync(file, { force: true });
        throw new ConnectorError(
          'no-orchestrator',
          `${path.basename(channel.repoPath)} has no orchestrator running: ask its owner to start one`
        );
      }
      this.state.messages.push({
        id: messageId,
        channelId: channel.id,
        repoPath: channel.repoPath,
        at: new Date(this.now()).toISOString(),
        bytes: size,
        sha256: hash,
        images: files.length,
        state: 'queued',
        done: false,
        replies: [],
      });
      this.save();
      this.usage(channel, op, 202, { bytes: size, sha256: hash, messageId });
      this.deps.log?.(
        `connector: message ${messageId} from "${channel.name}" for ${path.basename(channel.repoPath)} (${size} bytes, ${files.length} image(s), sha256 ${hash.slice(0, 16)})`
      );
      return { messageId, state: 'queued' };
    } catch (error) {
      if (error instanceof ConnectorError) {
        this.usage(channel, op, CONNECTOR_HTTP_STATUS[error.code], size ? { bytes: size } : {});
      }
      throw error;
    }
  }

  private view(message: StoredMessage): ConnectorMessageView {
    return {
      id: message.id,
      at: message.at,
      state: message.state,
      ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
      done: message.done,
      replies: message.replies.map(({ chatId: _chatId, ...reply }) => reply),
    };
  }

  /** One message of this channel with the replies seen so far. */
  async message(channel: ConnectorChannelInfo, id: string): Promise<ConnectorMessageView> {
    this.read(channel, 'message');
    await this.scan();
    const message = this.state.messages.find(
      (entry) => entry.id === id && entry.channelId === channel.id
    );
    if (!message) throw new ConnectorError('not-found', `No message ${id} on this channel`);
    return this.view(message);
  }

  /** The channel's replies after `after` (a seq), oldest first. */
  async replies(
    channel: ConnectorChannelInfo,
    after: number,
    limit = 50
  ): Promise<{ replies: ConnectorReply[]; cursor: number }> {
    this.read(channel, 'replies');
    await this.scan();
    return this.repliesAfter(channel, after, limit);
  }

  private repliesAfter(channel: ConnectorChannelInfo, after: number, limit: number) {
    const replies = this.state.messages
      .filter((message) => message.channelId === channel.id)
      .flatMap((message) => message.replies)
      .filter((reply) => reply.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map(({ chatId: _chatId, ...reply }) => reply);
    const cursor = replies.length ? replies[replies.length - 1].seq : after;
    return { replies, cursor };
  }

  /**
   * Looks in each orchestrator's chat for the turns our messages started and keeps their
   * assistant text. A message is "delivered" once its prompt is in the chat, "answered" with
   * a reply, done when the next prompt came or Claude is idle again.
   */
  scan(): Promise<void> {
    this.scanning ??= this.scanNow().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scanNow(): Promise<void> {
    const now = this.now();
    const open = this.state.messages.filter(
      (message) => !message.done && now - Date.parse(message.at) < LOOK_FOR_MS
    );
    const byRepo = new Map<string, StoredMessage[]>();
    for (const message of open) {
      byRepo.set(message.repoPath, [...(byRepo.get(message.repoPath) ?? []), message]);
    }
    let changed = false;
    for (const [repoPath, messages] of byRepo) {
      const sessionId = this.deps.orchestratorSession(repoPath);
      if (!sessionId) continue;
      const chat = await this.deps.chat(sessionId).catch(() => null);
      if (!chat?.available) continue;
      for (const message of messages) {
        if (this.capture(message, chat)) changed = true;
      }
    }
    if (changed) this.save();
  }

  private capture(
    message: StoredMessage,
    chat: { status?: string; messages: readonly ConnectorChatMessage[] }
  ): boolean {
    const marker = `Request ${message.id} from external app`;
    const start = chat.messages.findIndex(
      (entry) => entry.role === 'user' && entry.text.includes(marker)
    );
    if (start < 0) return false;
    let changed = false;
    if (message.state === 'queued') {
      message.state = 'delivered';
      message.deliveredAt = chat.messages[start].timestamp ?? new Date(this.now()).toISOString();
      changed = true;
    }
    let ended = false;
    for (const entry of chat.messages.slice(start + 1)) {
      if (entry.role === 'user') {
        ended = true;
        break;
      }
      if (entry.role !== 'assistant' || !entry.text.trim() || isQuietReply(entry.text)) continue;
      if (message.replies.some((reply) => reply.chatId === entry.id)) continue;
      const seq = (this.state.seq[message.channelId] ?? 0) + 1;
      this.state.seq[message.channelId] = seq;
      message.replies.push({
        seq,
        messageId: message.id,
        chatId: entry.id,
        at: entry.timestamp ?? new Date(this.now()).toISOString(),
        text: cut(redactSecrets(entry.text.trim()), REPLY_TEXT_MAX),
      });
      message.state = 'answered';
      changed = true;
    }
    // Idle right after the prompt went in may be Claude's status file lagging behind.
    const settled =
      message.replies.length > 0 ||
      this.now() - Date.parse(message.deliveredAt ?? message.at) > 60_000;
    if (ended || (chat.status === 'idle' && settled)) {
      message.done = true;
      changed = true;
    }
    return changed;
  }

  /** The channel's tasks (open ones; with `all`, the newest finished ones too). */
  tasks(channel: ConnectorChannelInfo, all = false): ConnectorTaskView[] {
    this.read(channel, 'tasks');
    return this.taskViews(channel, all);
  }

  private taskViews(channel: ConnectorChannelInfo, all: boolean): ConnectorTaskView[] {
    const tasks = this.deps.tasks();
    if (!tasks) throw new ConnectorError('unavailable', 'Tasks are not available here');
    const mine = tasks.filter((task) => this.deps.taskRepo(task) === channel.repoPath);
    const open = mine.filter((task) => !TASK_FINAL_STATES.includes(task.state));
    const finals = all
      ? mine
          .filter((task) => TASK_FINAL_STATES.includes(task.state))
          .sort((a, b) => Date.parse(b.stateSince) - Date.parse(a.stateSince))
          .slice(0, FINAL_TASKS_MAX)
      : [];
    return [...open, ...finals].map(taskView);
  }

  /** Changes since the last call, for a live stream: tasks changed and new replies. */
  streamer(channel: ConnectorChannelInfo): {
    poll: () => Promise<{ tasks: ConnectorTaskView[]; gone: string[]; replies: ConnectorReply[] }>;
    close: () => void;
  } {
    const open = this.streams.get(channel.id) ?? 0;
    if (open >= STREAMS_PER_CHANNEL) {
      this.usage(channel, 'events', 429);
      throw new ConnectorError(
        'rate-limited',
        `At most ${STREAMS_PER_CHANNEL} event streams at once`,
        30
      );
    }
    this.read(channel, 'events');
    this.streams.set(channel.id, open + 1);
    const seen = new Map<string, string>();
    let cursor = this.repliesAfter(channel, 0, 200).cursor;
    let closed = false;
    return {
      poll: async () => {
        await this.scan();
        let views: ConnectorTaskView[] = [];
        try {
          views = this.taskViews(channel, false);
        } catch {
          views = [];
        }
        const changed: ConnectorTaskView[] = [];
        const ids = new Set(views.map((view) => view.id));
        for (const view of views) {
          const digest = JSON.stringify(view);
          if (seen.get(view.id) === digest) continue;
          seen.set(view.id, digest);
          changed.push(view);
        }
        const gone = [...seen.keys()].filter((id) => !ids.has(id));
        for (const id of gone) seen.delete(id);
        const fresh = this.repliesAfter(channel, cursor, 200);
        cursor = fresh.cursor;
        return { tasks: changed, gone, replies: fresh.replies };
      },
      close: () => {
        if (closed) return;
        closed = true;
        const left = (this.streams.get(channel.id) ?? 1) - 1;
        if (left > 0) this.streams.set(channel.id, left);
        else this.streams.delete(channel.id);
      },
    };
  }

  /** Last use of each channel and how many messages wait (the doctor, the exposure sweep). */
  stats(): Array<ConnectorChannelInfo & { openMessages: number }> {
    return this.deps.tokens.list().map((channel) => ({
      ...channel,
      openMessages: this.state.messages.filter(
        (message) => message.channelId === channel.id && !message.done
      ).length,
    }));
  }

  /** Messages stored for a channel's moved project follow it too. */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let changed = 0;
    for (const { from, to } of moved) {
      for (const message of this.state.messages) {
        if (message.repoPath !== from) continue;
        message.repoPath = to;
        changed++;
      }
    }
    if (changed) this.save();
    return changed;
  }
}

function waitingOn(task: TaskRecord): ConnectorTaskView['waitingOn'] {
  if (task.state === 'needs_you') return 'user';
  if (task.state === 'ready')
    return task.orchestratorSessionId && !task.blocker ? 'orchestrator' : 'user';
  return null;
}

function taskView(task: TaskRecord): ConnectorTaskView {
  const note = task.summary ?? task.blocker?.message ?? task.error;
  return {
    id: task.id,
    title: cut(oneLine(task.name), 200),
    state: task.state,
    stateSince: task.stateSince,
    createdAt: task.createdAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
    waitingOn: waitingOn(task),
    ...(task.blocker
      ? {
          blocker: {
            kind: task.blocker.kind,
            message: cut(oneLine(redactSecrets(task.blocker.message)), 300),
          },
        }
      : {}),
    ...(note ? { lastNote: cut(oneLine(redactSecrets(note)), 1000) } : {}),
    timings: (task.timings ?? []).map((timing) => ({
      phase: timing.phase,
      round: timing.round,
      startedAt: timing.startedAt,
      ...(timing.finishedAt ? { finishedAt: timing.finishedAt } : {}),
      ...(timing.outcome ? { outcome: timing.outcome } : {}),
    })),
  };
}
