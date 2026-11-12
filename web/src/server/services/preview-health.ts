/**
 * Health of the registered dev servers (2026-10-03): every ~10 s, only for the ports in the
 * preview registry, a TCP connect to 127.0.0.1/::1. When a port answers for the first time
 * (or again after being down: it may be another app now), one GET / reads its page <title>
 * (the row's name). Rows then show "caída" when the dev server stops, and the preview view
 * says so instead of a blank frame. After each round, unpinned previews down for more than
 * 7 days are removed (PreviewRegistry.cleanup).
 *
 * That same GET recognizes another Untether server by its UNTETHER_SERVER_HEADER: the
 * port is reported (onUntether) and its row removed, never previewed (2026-10-03).
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { every } from '../utils/periodic-loop.js';
import { UNTETHER_SERVER_HEADER } from './preview-proxy.js';
import type { PreviewRegistry } from './preview-registry.js';

export const PREVIEW_HEALTH_INTERVAL_MS = 10_000;
const TITLE_TIMEOUT_MS = 1500;
const TITLE_MAX_BYTES = 64 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

/** `&amp;`, `&#8212;`, `&#x2014;` in one pass ("&amp;lt;" is "&lt;"); others stay as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** `<title>My app</title>` → "My app" (entities and whitespace tidied, at most `max` chars). */
export function extractTitle(html: string, max = 80): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!match) return undefined;
  const text = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max).trimEnd() : undefined;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 127.0.0.1 or ::1, whichever answers now (no cache: this is the health check). */
export async function probeLoopback(port: number): Promise<string | null> {
  for (const host of ['127.0.0.1', '::1']) if (await connects(host, port)) return host;
  return null;
}

/**
 * Does an Untether server answer on this loopback port? One quick GET / reading only the
 * headers; false when nothing answers in time (a dev server that isn't up yet is not one).
 */
export function isUntetherServer(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', headers: { host: `localhost:${port}` } },
      (res) => {
        resolve(Boolean(res.headers[UNTETHER_SERVER_HEADER]));
        res.resume();
        req.destroy();
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** Thrown away by check(): the port is an Untether server, not a dev server. */
export const UNTETHER = Symbol('untether');

function fetchTitle(host: string, port: number): Promise<string | undefined | typeof UNTETHER> {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/', headers: { accept: 'text/html', host: `localhost:${port}` } },
      (res) => {
        if (res.headers[UNTETHER_SERVER_HEADER]) {
          res.resume();
          req.destroy();
          resolve(UNTETHER);
          return;
        }
        if (!/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
          res.resume();
          resolve(undefined);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          const title = extractTitle(body);
          if (title || body.length > TITLE_MAX_BYTES) {
            resolve(title);
            req.destroy();
          }
        });
        res.on('end', () => resolve(extractTitle(body)));
        res.on('error', () => resolve(undefined));
      }
    );
    req.setTimeout(TITLE_TIMEOUT_MS, () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
  });
}

export interface PreviewHealthOptions {
  registry: PreviewRegistry;
  /** Is anything listening on this loopback port? (default: TCP connect to 127.0.0.1 / ::1) */
  probe?: (port: number) => Promise<string | null>;
  title?: (host: string, port: number) => Promise<string | undefined | typeof UNTETHER>;
  /** The port answered as an Untether server: its row goes, and it is never previewed. */
  onUntether?: (port: number) => void;
  /** Called when a row's live/down state or title changed (to refresh the lists). */
  onChange?: () => void;
  intervalMs?: number;
}

export class PreviewHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private options: PreviewHealthOptions) {}

  start(): void {
    if (this.timer) return;
    // Right away: after a restart the rows don't wait 10 s to say live/down.
    void this.checkAll();
    this.timer = every(
      'preview health',
      () => this.checkAll(),
      this.options.intervalMs ?? PREVIEW_HEALTH_INTERVAL_MS
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One port now (the view's Retry, a fresh `ut open`). True when it answers. */
  async check(port: number): Promise<boolean> {
    const registry = this.options.registry;
    const probe = this.options.probe ?? probeLoopback;
    const host = await probe(port);
    let title: string | undefined;
    // Read the title the first time it answers, and when it comes back (another app?).
    if (host && (!registry.knownTitle(port) || registry.stateOf(port) !== 'live')) {
      const page = await (this.options.title ?? fetchTitle)(host, port);
      if (page === UNTETHER) {
        this.options.onUntether?.(port);
        return false;
      }
      title = page;
    }
    // Removed meanwhile: don't bring its health back.
    if (!registry.ports().includes(port)) return host !== null;
    if (registry.setHealth(port, host !== null, title)) this.options.onChange?.();
    return host !== null;
  }

  async checkAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.options.registry.ports().map((port) => this.check(port)));
      if (this.options.registry.cleanup().length) this.options.onChange?.();
    } finally {
      this.running = false;
    }
  }
}
