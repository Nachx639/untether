/**
 * "+ Añadir vista previa" offers the web servers listening on this Mac (2026-10-03): from the
 * phone you shouldn't have to remember that the dev server is on 5180. lsof names this
 * user's TCP listeners on loopback or on every interface (port, process, working folder); a
 * quick GET / keeps the ones that answer HTTP and reads their page <title>. Ports the
 * previews refuse (Untether's own, UNTETHER_PREVIEW_DENY_PORTS, other Untether
 * servers, below 1024) and ports already saved as previews are left out.
 *
 * macOS only: anywhere else, or when lsof fails, the list is empty and the sheet offers just
 * "Otro puerto o URL…" (the port typed by hand, as before).
 */
import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreviewCandidate } from '../../shared/types.js';
import { extractTitle } from './preview-health.js';
import { UNTETHER_SERVER_HEADER } from './preview-proxy.js';

const LSOF = '/usr/sbin/lsof';
const LSOF_TIMEOUT_MS = 2000;
export const PROBE_TIMEOUT_MS = 400;
const PROBE_MAX_BYTES = 32 * 1024;
const TITLE_MAX = 60;
/** Items in the sheet, lowest ports first. */
export const MAX_CANDIDATES = 20;

/**
 * Not dev servers, though they answer HTTP: the system's ephemeral range (a tool's internal
 * port, a local agent gateway's helpers on 56002 and 57980) and infrastructure processes
 * (cloudflared's metrics on :20241). Listed on the Mac on 2026-10-03; still reachable through
 * "Otro puerto o URL…".
 */
const EPHEMERAL_PORTS_FROM = 49152;
const NOT_DEV_SERVERS = new Set([
  'cloudflared',
  'rapportd',
  'ControlCenter',
  'logioptionsplus_agent',
  'idb_companion',
]);
/** Ports probed per scan, lowest first (apps' helper sockets sit on high random ports). */
const MAX_PROBES = 64;
/** Opening the sheet again within this long reuses the last scan. */
export const CANDIDATES_CACHE_MS = 3000;

/** A TCP listener of this user, as lsof reports it. */
export interface PortListener {
  port: number;
  pid: number;
  /** Command name ("node", "Python"; lsof cuts it at 31 characters). */
  command: string;
  /** Where it answers: 127.0.0.1, or ::1 when it listens only there (Vite on "localhost"). */
  host: string;
  /** Last part of the process's working directory, when that says something. */
  folder?: string;
}

/** A server that answered HTTP: its page title, or that it is an Untether server. */
export interface ProbeAnswer {
  title?: string;
  untether?: boolean;
  /**
   * Answers HTTP but has no page at `/` (an API: a JSON 404, 2026-10-23 the Atlas bridge on
   * 8787 opened as `{"error":{"code":"not_found"}}`): not offered.
   */
  noPage?: boolean;
}

/**
 * lsof's name for a listening socket's address → the loopback address that reaches it.
 * Anything else (a LAN or link-local address) can't be previewed: the proxy connects to
 * 127.0.0.1 or ::1 only. lsof writes the wildcard as "*" for IPv4 and IPv6 alike.
 */
const LOOPBACK = new Map([
  ['*', '127.0.0.1'],
  ['0.0.0.0', '127.0.0.1'],
  ['127.0.0.1', '127.0.0.1'],
  ['[::]', '::1'],
  ['[::1]', '::1'],
]);

/** `lsof -F pcn` output → its loopback and wildcard listeners, in lsof's order. */
export function parseLsofListeners(output: string): PortListener[] {
  const listeners: PortListener[] = [];
  let pid = 0;
  let command = '';
  for (const line of output.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) {
      pid = Number(value);
      command = '';
    } else if (line.startsWith('c')) {
      command = value;
    } else if (line.startsWith('n')) {
      const match = /^(.+):(\d{1,5})$/.exec(value);
      const host = match ? LOOPBACK.get(match[1]) : undefined;
      const port = Number(match?.[2]);
      if (host && Number.isInteger(pid) && pid > 0 && port > 0 && port <= 65535) {
        listeners.push({ port, pid, command, host });
      }
    }
  }
  return listeners;
}

/** `lsof -d cwd -F n` output → pid → working directory. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** "~/Projects/shop" → "shop"; nothing for "/" or the home folder (daemons, `nohup` from ~). */
function folderOf(cwd: string | undefined, home: string): string | undefined {
  if (!cwd || cwd === '/' || path.resolve(cwd) === path.resolve(home)) return undefined;
  return path.basename(cwd) || undefined;
}

/**
 * lsof's output, '' when it couldn't run or timed out. Exit status 1 still comes with output:
 * lsof also uses it for "a pid I was asked about is gone" (it exited between two calls).
 */
function runLsof(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      LSOF,
      args,
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(!error || error.code === 1 ? String(stdout) : '')
    );
  });
}

export interface ListListenersOptions {
  /** Runs lsof with these arguments and resolves its output ('' when it failed). */
  run?: (args: string[]) => Promise<string>;
  platform?: NodeJS.Platform;
  uid?: number;
  home?: string;
}

/**
 * This user's TCP listeners on loopback or every interface, each with its process's folder:
 * `lsof -nP -iTCP -sTCP:LISTEN -a -u <uid>`, then one `lsof -d cwd` for all their pids.
 * Empty anywhere but macOS, and when lsof fails.
 */
export async function listListeners(options: ListListenersOptions = {}): Promise<PortListener[]> {
  const uid = options.uid ?? process.getuid?.();
  if ((options.platform ?? process.platform) !== 'darwin' || uid === undefined) return [];
  const run = options.run ?? runLsof;
  try {
    const listeners = parseLsofListeners(
      await run(['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid), '-Fpcn'])
    );
    if (!listeners.length) return [];
    const pids = [...new Set(listeners.map((listener) => listener.pid))];
    // Without folders the list still helps: a failure here only loses them.
    const cwds = parseLsofCwds(
      await run(['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']).catch(() => '')
    );
    const home = options.home ?? os.homedir();
    return listeners.map((listener) => {
      const folder = folderOf(cwds.get(listener.pid), home);
      return folder ? { ...listener, folder } : listener;
    });
  } catch {
    return [];
  }
}

/**
 * One quick GET / (PROBE_TIMEOUT_MS for all of it): null unless the port answers HTTP in
 * time. The title comes from the first 32 KB of an HTML page; a dev server whose headers
 * arrived but whose page is still on its way is offered without one.
 */
export function probeHttp(
  port: number,
  host = '127.0.0.1',
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProbeAnswer | null> {
  return new Promise((resolve) => {
    let answered = false;
    let body = '';
    let settled = false;
    const page = (): ProbeAnswer => {
      const title = extractTitle(body, TITLE_MAX);
      return title ? { title } : {};
    };
    const finish = (answer: ProbeAnswer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const req = http.get(
      {
        host,
        port,
        path: '/',
        agent: false,
        headers: { accept: 'text/html', host: `localhost:${port}` },
      },
      (res) => {
        answered = true;
        if (res.headers[UNTETHER_SERVER_HEADER]) return finish({ untether: true });
        if (!/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
          return finish((res.statusCode ?? 0) >= 400 ? { noPage: true } : {});
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (/<\/title>/i.test(body) || body.length >= PROBE_MAX_BYTES) finish(page());
        });
        res.on('end', () => finish(page()));
        res.on('error', () => finish(page()));
      }
    );
    const timer = setTimeout(() => finish(answered ? page() : null), timeoutMs);
    req.on('error', () => finish(answered ? page() : null));
  });
}

export interface PreviewCandidateOptions {
  /** Why a port can't be previewed (range, Untether's own, denied, another Untether). */
  portError: (port: number) => string | null;
  /** Ports saved as previews already: they are in the list. */
  savedPorts: () => readonly number[];
  /** A port answered as an Untether server: it is never previewed from then on. */
  onUntetherPort?: (port: number) => void;
  listListeners?: () => Promise<PortListener[]>;
  probe?: (port: number, host: string) => Promise<ProbeAnswer | null>;
  now?: () => number;
}

/**
 * The servers "+ Añadir vista previa" offers, lowest port first, at most MAX_CANDIDATES. One
 * scan (lsof, then every allowed port probed at once) serves for CANDIDATES_CACHE_MS; a port
 * saved or refused meanwhile is still left out.
 */
export function createPreviewCandidateFinder(
  options: PreviewCandidateOptions
): () => Promise<PreviewCandidate[]> {
  const list = options.listListeners ?? (() => listListeners());
  const probe = options.probe ?? probeHttp;
  const now = options.now ?? Date.now;
  const offered = (port: number, saved: ReadonlySet<number>) =>
    port >= 1024 && port < EPHEMERAL_PORTS_FROM && !saved.has(port) && !options.portError(port);
  const answerOf = async (listener: PortListener) => {
    try {
      return await probe(listener.port, listener.host);
    } catch {
      return null;
    }
  };

  const scan = async (): Promise<PreviewCandidate[]> => {
    let all: PortListener[] = [];
    try {
      all = await list();
    } catch {
      all = [];
    }
    const saved = new Set(options.savedPorts());
    // One per port: a server on 127.0.0.1 and ::1, or workers sharing their parent's socket.
    const byPort = new Map<number, PortListener>();
    for (const listener of all) {
      if (NOT_DEV_SERVERS.has(listener.command)) continue;
      if (!byPort.has(listener.port) && offered(listener.port, saved)) {
        byPort.set(listener.port, listener);
      }
    }
    const listeners = [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, MAX_PROBES);
    const answers = await Promise.all(listeners.map(answerOf));
    const found: PreviewCandidate[] = [];
    listeners.forEach((listener, index) => {
      const answer = answers[index];
      if (!answer || answer.noPage) return;
      if (answer.untether) {
        options.onUntetherPort?.(listener.port);
        return;
      }
      found.push({
        port: listener.port,
        ...(answer.title ? { title: answer.title } : {}),
        ...(listener.command ? { process: listener.command } : {}),
        ...(listener.folder ? { folder: listener.folder } : {}),
      });
    });
    return found;
  };

  let last: { at: number; found: Promise<PreviewCandidate[]> } | null = null;
  return async () => {
    const at = now();
    if (!last || at - last.at >= CANDIDATES_CACHE_MS || at < last.at) {
      last = { at, found: scan() };
    }
    const found = await last.found;
    const saved = new Set(options.savedPorts());
    return found.filter((candidate) => offered(candidate.port, saved)).slice(0, MAX_CANDIDATES);
  };
}
