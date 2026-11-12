/**
 * The connector's tokens (2026-10-31, bakery's hub asked to send requests to its
 * orchestrator from inside the app): one token per channel, each fixed to ONE project.
 *
 * - Made and revoked by the owner of this Untether (`ut project connector add|revoke`, the
 *   signed-in app). From an agent or a script a new token is handed out at once but stays
 *   inactive until the user approves it on the phone (task-commands.ts, 'connector-add').
 * - Only a SHA-256 of each secret is stored, in tokens.json (folder 0700, file 0600): a copy
 *   of the file lets nobody in. A presented token is hashed and compared in constant time.
 * - A token's project follows the folder when it is renamed or moved (ProjectSettings
 *   followers), like every other store keyed by project.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../pty/private-perms.js';

/** "utc_<id>_<secret>": the id finds the record, the secret proves it. */
export const TOKEN_PREFIX = 'utc_';
const TOKEN_PATTERN = /^utc_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** A channel's name: what the orchestrator sees as the app's name. */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Channels per project at most. */
export const CHANNELS_PER_PROJECT_MAX = 10;

/** What a token may do; all of them, for now, and nothing else exists. */
export const CONNECTOR_PERMISSIONS = [
  'messages:send',
  'messages:read',
  'tasks:read',
  'tasks:events',
] as const;
export type ConnectorPermission = (typeof CONNECTOR_PERMISSIONS)[number];

export interface ConnectorChannel {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
  /** Who made it: 'user' (the app or the owner's approval) or the session that asked. */
  createdBy: string;
  /** Inactive until the user approved it (made by an agent or a script). */
  active: boolean;
  /** The confirmation that activates it, while it waits. */
  confirmationId?: string;
  permissions: ConnectorPermission[];
  lastUsedAt?: string;
  uses: number;
  /** sha256 of the whole token, hex. */
  hash: string;
}

/** A channel as listed: never its hash. */
export type ConnectorChannelInfo = Omit<ConnectorChannel, 'hash'>;

export class ConnectorTokenError extends Error {
  constructor(
    readonly code: 'bad-request' | 'not-found' | 'busy',
    message: string
  ) {
    super(message);
  }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest();

export function publicChannel(channel: ConnectorChannel): ConnectorChannelInfo {
  const { hash: _hash, ...info } = channel;
  return info;
}

export class ConnectorTokens {
  private channels: ConnectorChannel[] = [];
  private loadedMtime = -1;
  /** When each channel's use was last written (touch). */
  private readonly touchSavedAt = new Map<string, number>();

  constructor(
    private readonly options: {
      /** tokens.json */
      storePath: string;
      now?: () => number;
      normalizeRepo?: (repo: string) => string;
    }
  ) {
    this.load();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private normalize(repo: string): string {
    return this.options.normalizeRepo?.(repo) ?? path.resolve(repo);
  }

  /** Read again when someone else changed the file (another server, a hand edit). */
  private load(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.options.storePath);
    } catch {
      this.channels = [];
      this.loadedMtime = -1;
      return;
    }
    if (stat.mtimeMs === this.loadedMtime) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.storePath, 'utf8')) as {
        channels?: ConnectorChannel[];
      };
      this.channels = (parsed.channels ?? []).filter(
        (entry) =>
          typeof entry?.id === 'string' &&
          typeof entry.hash === 'string' &&
          typeof entry.repoPath === 'string'
      );
    } catch {
      // A broken file lets nobody in (never a crash, never an open door).
      this.channels = [];
    }
    this.loadedMtime = stat.mtimeMs;
  }

  private save(): void {
    const dir = path.dirname(this.options.storePath);
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
    const tmp = `${this.options.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ channels: this.channels }, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(tmp, PRIVATE_FILE_MODE);
    fs.renameSync(tmp, this.options.storePath);
    this.loadedMtime = fs.statSync(this.options.storePath).mtimeMs;
  }

  list(repoPath?: string): ConnectorChannelInfo[] {
    this.load();
    const repo = repoPath ? this.normalize(repoPath) : undefined;
    return this.channels.filter((channel) => !repo || channel.repoPath === repo).map(publicChannel);
  }

  /** Any channel the listener should be open for (active ones). */
  hasActive(): boolean {
    this.load();
    return this.channels.some((channel) => channel.active);
  }

  /**
   * A new channel for `repoPath`. Returns the whole token: the only time it exists anywhere.
   * `active` false: it waits for the user's OK (activate()).
   */
  add(input: { repoPath: string; name: string; createdBy: string; active: boolean }): {
    token: string;
    channel: ConnectorChannelInfo;
  } {
    this.load();
    const name = input.name.trim().toLowerCase();
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      throw new ConnectorTokenError(
        'bad-request',
        'The name must be 1-40 lowercase letters, digits or dashes (e.g. bakery-app)'
      );
    }
    const repoPath = this.normalize(input.repoPath);
    const mine = this.channels.filter((channel) => channel.repoPath === repoPath);
    if (mine.some((channel) => channel.name === name)) {
      throw new ConnectorTokenError(
        'busy',
        `This project already has a channel "${name}": revoke it first or pick another name`
      );
    }
    if (mine.length >= CHANNELS_PER_PROJECT_MAX) {
      throw new ConnectorTokenError(
        'busy',
        `This project has ${CHANNELS_PER_PROJECT_MAX} channels already: revoke one first`
      );
    }
    const id = randomBytes(6).toString('hex');
    const token = `${TOKEN_PREFIX}${id}_${randomBytes(32).toString('base64url')}`;
    const channel: ConnectorChannel = {
      id,
      name,
      repoPath,
      createdAt: new Date(this.now()).toISOString(),
      createdBy: input.createdBy,
      active: input.active,
      permissions: [...CONNECTOR_PERMISSIONS],
      uses: 0,
      hash: hashOf(token).toString('hex'),
    };
    this.channels.push(channel);
    this.save();
    return { token, channel: publicChannel(channel) };
  }

  /** The confirmation a waiting channel is activated by. */
  setConfirmation(id: string, confirmationId: string): void {
    this.load();
    const channel = this.channels.find((entry) => entry.id === id);
    if (!channel) return;
    channel.confirmationId = confirmationId;
    this.save();
  }

  /** The user approved it. */
  activate(id: string): ConnectorChannelInfo {
    this.load();
    const channel = this.channels.find((entry) => entry.id === id);
    if (!channel) throw new ConnectorTokenError('not-found', `No connector channel ${id}`);
    channel.active = true;
    delete channel.confirmationId;
    this.save();
    return publicChannel(channel);
  }

  /** Revoke by id or by name (within `repoPath` when given): it is deleted. */
  revoke(ref: string, repoPath?: string): ConnectorChannelInfo {
    this.load();
    const repo = repoPath ? this.normalize(repoPath) : undefined;
    const matches = this.channels.filter(
      (channel) =>
        (channel.id === ref || channel.name === ref.toLowerCase()) &&
        (!repo || channel.repoPath === repo)
    );
    if (!matches.length) throw new ConnectorTokenError('not-found', `No connector channel ${ref}`);
    if (matches.length > 1) {
      throw new ConnectorTokenError(
        'bad-request',
        `Several projects have a channel "${ref}": give its id or --repo`
      );
    }
    const [channel] = matches;
    this.channels = this.channels.filter((entry) => entry !== channel);
    this.save();
    return publicChannel(channel);
  }

  /** Channels whose approval never came (the confirmation expired or was declined). */
  dropWaiting(isPending: (confirmationId: string) => boolean): ConnectorChannelInfo[] {
    this.load();
    const now = this.now();
    const dropped = this.channels.filter(
      (channel) =>
        !channel.active &&
        (channel.confirmationId
          ? !isPending(channel.confirmationId)
          : now - Date.parse(channel.createdAt) > 2 * 60_000)
    );
    if (!dropped.length) return [];
    this.channels = this.channels.filter((channel) => !dropped.includes(channel));
    this.save();
    return dropped.map(publicChannel);
  }

  /**
   * The active channel `token` belongs to, or null. The hash is compared in constant time;
   * a malformed token, an unknown id or an inactive channel answer null the same way.
   */
  authenticate(token: string | undefined): ConnectorChannelInfo | null {
    if (!token) return null;
    this.load();
    const match = TOKEN_PATTERN.exec(token);
    const presented = hashOf(token);
    // Compared against every channel's hash, so the time does not say which ids exist.
    let found: ConnectorChannel | null = null;
    for (const channel of this.channels) {
      const stored = Buffer.from(channel.hash, 'hex');
      if (stored.length !== presented.length) continue;
      if (timingSafeEqual(stored, presented) && match && match[1] === channel.id) found = channel;
    }
    return found?.active ? publicChannel(found) : null;
  }

  /** A use of `id`: its last use and count (written at most once a minute). */
  touch(id: string): void {
    this.load();
    const channel = this.channels.find((entry) => entry.id === id);
    if (!channel) return;
    const now = this.now();
    channel.uses += 1;
    channel.lastUsedAt = new Date(now).toISOString();
    // Against the last WRITE, not the last use (2026-11-10): a channel used every few seconds
    // never had a minute between two uses, so only its first use was ever saved, and after a
    // restart the doctor called a channel in daily use "unused".
    if (now - (this.touchSavedAt.get(id) ?? 0) < 60_000) return;
    this.touchSavedAt.set(id, now);
    this.save();
  }

  /** Projects renamed or moved: their channels follow (ProjectSettings follower). */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    this.load();
    let changed = 0;
    for (const { from, to } of moved) {
      const fromKey = this.normalize(from);
      for (const channel of this.channels) {
        if (channel.repoPath !== fromKey) continue;
        channel.repoPath = this.normalize(to);
        changed++;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** Projects referenced (for moved-project checks). */
  repoPaths(): string[] {
    this.load();
    return [...new Set(this.channels.map((channel) => channel.repoPath))];
  }

  get storePath(): string {
    return this.options.storePath;
  }
}
