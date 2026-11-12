/**
 * What a project exposes while it runs (2026-10-26, «que el barrido mire también lo que corre,
 * no solo el código»; shared/security.ts EXPOSURE_SECTION). Nothing here knows how any one
 * project is deployed: it is all discovered.
 *
 * - The surface: what in the repository (compose, Dockerfiles, Kubernetes, Helm, launchd,
 *   systemd, Fly, Vercel, Netlify, Workers, serverless, tunnels, proxies, published apps and
 *   packages) and in what runs (its containers, its listening processes) makes the project
 *   reachable. With none, the sweep never gets an exposure round.
 * - The universal deterministic checks, every check of the sweep: the project's processes
 *   listening beyond loopback, its containers published beyond loopback, privileged, on the host
 *   network or holding the Docker socket.
 * - The facts an exposure round's agent reads: Untether itself runs a fixed list of read-only
 *   commands (READ_ONLY_PROBES, nothing else can run) and hands their output, secrets masked and
 *   container environments left out, to the agent, who runs nothing.
 * - The provider connectors (Tailscale first): a credential the user names, read-only API calls,
 *   findings only told.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ConnectorProvider,
  ExposureFinding,
  SecurityConnector,
  SecuritySeverity,
} from '../../shared/security.js';
import { type RunResult, run } from '../utils/exec-file.js';

const PROBE_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 15_000;
const TAILSCALE_API = 'https://api.tailscale.com/api/v2';
/** A device not seen for this long is told about (never removed). */
export const DEVICE_STALE_DAYS = 60;
/** Auth keys looked up one by one when the list carries no details. */
const KEYS_LOOKUP_MAX = 30;
/** The facts an exposure round's agent gets, at most (each part has its own cap too). */
export const FACTS_MAX = 24_000;
const PART_MAX = 4_000;
const IMAGE_HISTORY_MAX = 1_500;
const HISTORY_COMMITS = 300;
const HISTORY_HITS_MAX = 20;

const PIDS = /^\d{1,10}(,\d{1,10})*$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** An image name as compose and docker print it: never an option, no spaces. */
const IMAGE = /^[A-Za-z0-9][\w./:@-]{0,254}$/;

/** Exactly these arguments. */
const exactly =
  (...want: string[]) =>
  (rest: readonly string[]) =>
    rest.length === want.length && want.every((arg, index) => rest[index] === arg);

/**
 * The only commands Untether runs to look at what a project exposes (2026-10-26): each one
 * reads, none changes anything. Every argument is fixed or checked against a strict pattern
 * (2026-10-26 review: a prefix let `docker -H …`, `git log --ext-diff`, `-c …` or any extra
 * option through); `probe` refuses any other argv.
 */
export const READ_ONLY_PROBES: ReadonlyArray<{
  argv: readonly string[];
  rest: (rest: readonly string[]) => boolean;
}> = [
  { argv: ['docker', 'ps'], rest: exactly('-q', '--no-trunc') },
  {
    argv: ['docker', 'inspect'],
    rest: (rest) => rest.length > 0 && rest.every((arg) => CONTAINER_ID.test(arg)),
  },
  {
    argv: ['docker', 'history', '--no-trunc', '--format', '{{.CreatedBy}}'],
    rest: (rest) => rest.length === 1 && IMAGE.test(rest[0]),
  },
  { argv: ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], rest: exactly() },
  {
    argv: ['lsof', '-a', '-d', 'cwd', '-Fpn', '-p'],
    rest: (rest) => rest.length === 1 && PIDS.test(rest[0]),
  },
  {
    argv: ['ps', '-ww', '-o', 'pid=,command=', '-p'],
    rest: (rest) => rest.length === 1 && PIDS.test(rest[0]),
  },
  { argv: ['ps', '-axww', '-o', 'pid=,command='], rest: exactly() },
  { argv: ['launchctl', 'list'], rest: exactly() },
  { argv: ['tailscale', 'serve', 'status', '--json'], rest: exactly() },
  { argv: ['tailscale', 'funnel', 'status', '--json'], rest: exactly() },
  { argv: ['cloudflared', 'tunnel', 'list'], rest: exactly() },
  { argv: ['flyctl', 'status'], rest: exactly() },
  {
    argv: ['kubectl', 'get', 'services,ingresses', '--all-namespaces', '-o', 'wide'],
    rest: exactly(),
  },
  { argv: ['gh', 'repo', 'view', '--json', 'nameWithOwner,visibility,isFork'], rest: exactly() },
  { argv: ['git', 'ls-files', '-z'], rest: exactly() },
  {
    // --no-textconv and --no-ext-diff: no diff driver of the repository's config runs.
    argv: ['git', 'log', '--all', '-p', '--no-color', '--no-ext-diff', '--no-textconv'],
    rest: (rest) =>
      rest.length === 2 && /^-n\d{1,5}$/.test(rest[0]) && rest[1] === '--format=@@@ %h',
  },
];

/** An argv READ_ONLY_PROBES allows: its fixed part, then only what its pattern accepts. */
export function probeAllowed(program: string, args: readonly string[]): boolean {
  return READ_ONLY_PROBES.some(({ argv: [name, ...prefix], rest }) => {
    if (name !== program || args.length < prefix.length) return false;
    return prefix.every((arg, index) => args[index] === arg) && rest(args.slice(prefix.length));
  });
}

/** How a probe runs (tests record the programs' output instead). */
export type ProbeRunner = (program: string, args: string[], cwd: string) => Promise<RunResult>;

const EXTRA_BIN_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(os.homedir(), '.orbstack/bin'),
  path.join(os.homedir(), '.docker/bin'),
  path.join(os.homedir(), '.fly/bin'),
  '/Applications/Docker.app/Contents/Resources/bin',
  '/usr/sbin',
  '/usr/bin',
  '/bin',
];

function findBin(program: string): string | null {
  // Only absolute PATH entries (2026-10-26 review): "." or a relative one could resolve to a
  // program inside the project being looked at.
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter((dir) => path.isAbsolute(dir)),
    ...EXTRA_BIN_DIRS,
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not there.
    }
  }
  return null;
}

/** The real runner: only READ_ONLY_PROBES, a program not installed answers 127. */
export const runProbe: ProbeRunner = async (program, args, cwd) => {
  if (!probeAllowed(program, args)) {
    return { code: 126, stdout: '', stderr: 'not a read-only probe', spawnError: 'EPERM' };
  }
  const bin = findBin(program);
  if (!bin) return { code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' };
  return run(bin, args, cwd, PROBE_TIMEOUT_MS);
};

// --- helpers ----------------------------------------------------------------------------------

const SEVERITY_RANK: Record<SecuritySeverity, number> = { high: 3, medium: 2, low: 1 };

export function sortExposureFindings(findings: ExposureFinding[]): ExposureFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.key.localeCompare(b.key)
  );
}

/** `file` is `dir` or inside it. */
export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Docker Desktop shows a bind's host folder as /host_mnt/Users/…: the Mac's own path. */
function hostPath(source: string): string {
  return source.replace(/^\/host_mnt(?=\/)/, '');
}

function loopbackHost(ip: string | undefined): boolean {
  const host = (ip ?? '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function cap(text: string, max = PART_MAX): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut)` : text;
}

// --- the surface ------------------------------------------------------------------------------

/** Paths that make a project reachable, and what each one is. */
const SURFACE_RULES: Array<[RegExp, string]> = [
  [/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i, 'Docker Compose'],
  [/(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/, 'container image'],
  [/(^|\/)(Chart\.ya?ml)$/, 'Helm'],
  [
    /(^|\/)(kustomization\.ya?ml)$|(^|\/)(k8s|kubernetes|kube|manifests)\/.+\.ya?ml$/i,
    'Kubernetes',
  ],
  [/\.(service|socket)$/, 'systemd'],
  [/(^|\/)launch(d|agents?|daemons?)\/.+\.plist$|(^|\/)[\w.-]*launchd[\w.-]*\.plist$/i, 'launchd'],
  [/(^|\/)fly\.toml$/, 'Fly.io'],
  [/(^|\/)vercel\.json$/, 'Vercel'],
  [/(^|\/)netlify\.toml$/, 'Netlify'],
  [/(^|\/)wrangler\.(toml|json|jsonc)$/, 'Cloudflare Workers'],
  [/(^|\/)serverless\.ya?ml$/, 'serverless functions'],
  [/(^|\/)Procfile$/, 'Procfile'],
  [/(^|\/)(app|render|amplify)\.ya?ml$|(^|\/)railway\.(json|toml)$/, 'hosted app'],
  [/(^|\/)firebase\.json$|(^|\/)supabase\/config\.toml$/, 'backend as a service'],
  [/\.tf$/, 'Terraform'],
  [/(^|\/)(cloudflared|ngrok|frpc)[\w.-]*\.(ya?ml|ini|toml|json)$|(^|\/)cloudflared\//i, 'tunnel'],
  [/(^|\/)[^/]*tailscale[^/]*(\/|$)/i, 'Tailscale'],
  [/(^|\/)(Caddyfile|nginx[\w.-]*\.conf|traefik[\w.-]*\.ya?ml|haproxy\.cfg)$/i, 'reverse proxy'],
  [/(^|\/)\.github\/workflows\/[^/]*(deploy|release|publish)[^/]*\.ya?ml$/i, 'deploy workflow'],
  [/(^|\/)eas\.json$|(^|\/)AndroidManifest\.xml$/, 'mobile app'],
  [/\.xcodeproj\/project\.pbxproj$/, 'Apple app'],
  [/(^|\/)(electron-builder\.[\w]+|forge\.config\.[\w]+|tauri\.conf\.json)$/, 'desktop app'],
];

/**
 * What in the repository makes it reachable ("Docker Compose (compose.yaml)"), one per kind.
 * `read` gives a tracked file's text: a package.json not marked private is a published package.
 */
export function surfaceFrom(
  files: readonly string[],
  read?: (file: string) => string | null
): string[] {
  const found = new Map<string, string>();
  for (const file of files) {
    // Documentation names things it does not set up (docs/tailscale_ios.md, 2026-10-26).
    if (/\.(md|mdx|rst|txt|adoc)$/i.test(file) || /(^|\/)docs?\//i.test(file)) continue;
    for (const [rule, label] of SURFACE_RULES) {
      if (!found.has(label) && rule.test(file)) found.set(label, file);
    }
  }
  if (read) {
    for (const file of files.filter((each) => /(^|\/)package\.json$/.test(each)).slice(0, 20)) {
      try {
        const manifest = JSON.parse(read(file) ?? 'null') as { name?: unknown; private?: unknown };
        if (manifest && typeof manifest.name === 'string' && manifest.private !== true) {
          if (!found.has('published package')) found.set('published package', file);
        }
      } catch {
        // Not JSON: not a package.
      }
    }
  }
  return [...found].map(([label, file]) => `${label} (${file})`);
}

// --- Docker -------------------------------------------------------------------------------------

export interface DockerPortBinding {
  HostIp?: string;
  HostPort?: string;
}

/** `docker inspect`, only the fields read (Config.Env never is). */
export interface DockerContainer {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; User?: string; Labels?: Record<string, string> | null };
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    CapAdd?: string[] | null;
    PortBindings?: Record<string, DockerPortBinding[] | null> | null;
  };
  NetworkSettings?: { Ports?: Record<string, DockerPortBinding[] | null> | null };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

/** The containers compose started from the repository (its working_dir or files inside it). */
export function projectContainers(containers: DockerContainer[], repo: string): DockerContainer[] {
  return containers.filter((container) => {
    const labels = container.Config?.Labels ?? {};
    const dir = labels['com.docker.compose.project.working_dir'];
    if (dir && isInside(hostPath(dir), repo)) return true;
    return (labels['com.docker.compose.project.config_files'] ?? '')
      .split(',')
      .filter(Boolean)
      .some((file) => isInside(hostPath(file), repo));
  });
}

function containerNames(container: DockerContainer) {
  const labels = container.Config?.Labels ?? {};
  const name = (container.Name ?? container.Id ?? '?').replace(/^\//, '');
  return {
    name,
    project: labels['com.docker.compose.project'] ?? '',
    service: labels['com.docker.compose.service'] ?? name,
    files: (labels['com.docker.compose.project.config_files'] ?? '').split(',').filter(Boolean),
  };
}

function publishedPorts(container: DockerContainer) {
  const ports = container.NetworkSettings?.Ports ?? container.HostConfig?.PortBindings ?? {};
  return Object.entries(ports ?? {}).flatMap(([port, bindings]) =>
    (bindings ?? [])
      .filter((binding) => !!binding?.HostPort)
      .map((binding) => ({
        port,
        ip: binding.HostIp || '0.0.0.0',
        hostPort: binding.HostPort ?? '',
      }))
  );
}

/**
 * The universal container checks (pure): published beyond loopback, privileged, the host
 * network, the Docker socket. Everything else about containers is the agent's to judge.
 */
export function containerFindings(containers: DockerContainer[], repo: string): ExposureFinding[] {
  const out: ExposureFinding[] = [];
  for (const container of containers) {
    const { name, project, service, files } = containerNames(container);
    const file = files
      .map((each) => path.relative(repo, hostPath(each)))
      .find((each) => !each.startsWith('..'));
    const add = (what: string, title: string, detail: string, fix: string) =>
      out.push({
        key: `container:${project || '-'}/${service}:${what}`,
        source: 'container',
        severity: 'high',
        title: `${service}: ${title}`,
        detail,
        fix,
        fixable: true,
        ...(file ? { file } : {}),
      });
    for (const { port, ip, hostPort } of publishedPorts(container)) {
      if (loopbackHost(ip)) continue;
      add(
        `port:${hostPort}:${ip}`,
        `port ${hostPort} published on ${ip} (${port})`,
        `Anyone on the Mac's networks reaches ${port} of ${name}, not only the Mac itself.`,
        `Publish it on loopback ("127.0.0.1:${hostPort}:${port.split('/')[0]}") unless it must be reachable`
      );
    }
    if (container.HostConfig?.Privileged) {
      add(
        'privileged',
        'runs privileged',
        'A privileged container can take over its host and every other container.',
        'Remove privileged; add only the capabilities it needs'
      );
    }
    if (container.HostConfig?.NetworkMode === 'host') {
      add(
        'network-host',
        'uses the host network',
        'Every port it opens is open on the host, with no publishing rule in between.',
        'Use its own network and publish only the ports needed, on 127.0.0.1'
      );
    }
    const sock = (container.Mounts ?? []).find(
      (mount) =>
        /(^|\/)docker\.sock$/.test(mount.Source ?? '') ||
        /(^|\/)docker\.sock$/.test(mount.Destination ?? '')
    );
    if (sock) {
      add(
        'docker-sock',
        `mounts the Docker socket (${sock.Destination ?? sock.Source})`,
        'Whoever controls the container controls Docker: any container, any host folder.',
        'Remove the Docker socket mount, or put a proxy that allows only what it needs'
      );
    }
  }
  return out;
}

// --- listening processes ----------------------------------------------------------------------

export interface Listener {
  pid: number;
  command: string;
  /** As lsof prints it: "*", "127.0.0.1", "[::1]", "[::]", "192.168.1.5". */
  address: string;
  port: number;
}

export interface ProcessInfo {
  pid: number;
  cwd?: string;
  args?: string;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`: one Listener per process and address. */
export function parseLsof(output: string): Listener[] {
  const out: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let command = '';
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && pid) {
      const match = /^(.*):(\d+)$/.exec(value.split('->')[0]);
      if (!match) continue;
      const key = `${pid} ${match[1]} ${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, command, address: match[1], port: Number(match[2]) });
    }
  }
  return out;
}

/** `ps -o pid=,command=` lines. */
export function parsePs(output: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2]);
  }
  return out;
}

/** `lsof -a -d cwd -Fpn -p …` */
export function parseCwd(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function mentionsRepo(args: string, repo: string): boolean {
  let at = args.indexOf(repo);
  while (at >= 0) {
    const next = args[at + repo.length];
    if (next === undefined || next === '/' || /\s|["']/.test(next)) return true;
    at = args.indexOf(repo, at + 1);
  }
  return false;
}

/** The listeners of the project's processes (cwd or arguments inside the repository). */
export function projectListeners(
  listeners: Listener[],
  processes: ProcessInfo[],
  options: { repo: string; selfPid?: number }
): Listener[] {
  const byPid = new Map(processes.map((info) => [info.pid, info]));
  return listeners.filter((listener) => {
    if (listener.pid === options.selfPid) return false;
    const info = byPid.get(listener.pid);
    return !!(
      (info?.cwd && isInside(info.cwd, options.repo)) ||
      (info?.args && mentionsRepo(info.args, options.repo))
    );
  });
}

/** The project's processes listening beyond loopback (pure). */
export function listenerFindings(listeners: Listener[]): ExposureFinding[] {
  const out = new Map<string, ExposureFinding>();
  for (const listener of listeners) {
    if (loopbackHost(listener.address)) continue;
    const everywhere = ['*', '0.0.0.0', '[::]', '::'].includes(listener.address);
    const key = `listener:${listener.command}:${listener.port}`;
    if (out.has(key)) continue;
    out.set(key, {
      key,
      source: 'listener',
      severity: everywhere ? 'high' : 'medium',
      title: `${listener.command} listens on ${listener.address}:${listener.port}`,
      detail: everywhere
        ? 'It answers on every network the Mac is on (Wi-Fi, VPN), not only on the Mac itself.'
        : `It answers on ${listener.address}, beyond the Mac itself.`,
      fix: 'Bind it to 127.0.0.1 (its host or listen address) unless it must be reachable',
      fixable: true,
    });
  }
  return [...out.values()];
}

// --- what runs, read once per check -----------------------------------------------------------

export interface RunningState {
  /** Tracked files of the repository. */
  files: string[];
  containers: DockerContainer[];
  listeners: Listener[];
  errors: string[];
}

/** The repository's files, its containers and its listeners (each part failing on its own). */
export async function readRunning(
  repo: string,
  probe: ProbeRunner = runProbe,
  selfPid = process.pid
): Promise<RunningState> {
  const errors: string[] = [];
  const listed = await probe('git', ['ls-files', '-z'], repo);
  const files = listed.code === 0 ? listed.stdout.split('\0').filter(Boolean) : [];

  let containers: DockerContainer[] = [];
  const ids = await probe('docker', ['ps', '-q', '--no-trunc'], os.homedir());
  if (ids.code === 0) {
    const list = ids.stdout
      .split('\n')
      .map((id) => id.trim())
      .filter((id) => /^[0-9a-f]{12,64}$/.test(id));
    if (list.length) {
      const inspect = await probe('docker', ['inspect', ...list], os.homedir());
      try {
        containers = projectContainers(JSON.parse(inspect.stdout) as DockerContainer[], repo);
      } catch {
        errors.push(`docker inspect: ${inspect.stderr.trim().slice(0, 200) || 'unreadable'}`);
      }
    }
  } else if (!ids.spawnError && files.some((file) => /compose|Dockerfile/i.test(file))) {
    // Installed but not answering, in a project that uses it: worth saying.
    errors.push(`docker ps: ${ids.stderr.trim().slice(0, 200) || `exit ${ids.code}`}`);
  }

  let listeners: Listener[] = [];
  const lsof = await probe('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], os.homedir());
  // lsof exits 1 when some processes could not be read: its output stands.
  if (lsof.spawnError) errors.push('lsof: unavailable');
  else {
    const open = parseLsof(lsof.stdout);
    const pids = [...new Set(open.map((listener) => listener.pid))];
    if (pids.length) {
      const list = pids.join(',');
      const [cwd, ps] = await Promise.all([
        probe('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', list], os.homedir()),
        probe('ps', ['-ww', '-o', 'pid=,command=', '-p', list], os.homedir()),
      ]);
      const cwds = parseCwd(cwd.stdout);
      const args = parsePs(ps.stdout);
      listeners = projectListeners(
        open,
        pids.map((pid) => ({ pid, cwd: cwds.get(pid), args: args.get(pid) })),
        { repo, selfPid }
      );
    }
  }
  return { files, containers, listeners, errors };
}

/** What runs, as surface lines ("running: 3 containers (api, db, web)"). */
export function runningSurface(state: Pick<RunningState, 'containers' | 'listeners'>): string[] {
  const out: string[] = [];
  if (state.containers.length) {
    const names = state.containers.map((container) => containerNames(container).service);
    out.push(`running containers (${[...new Set(names)].slice(0, 8).join(', ')})`);
  }
  const listening = state.listeners.map(
    (listener) => `${listener.command} ${listener.address}:${listener.port}`
  );
  if (listening.length) out.push(`listening (${[...new Set(listening)].slice(0, 8).join(', ')})`);
  return out;
}

// --- the facts of an exposure round -----------------------------------------------------------

const TUNNEL_PROCESS =
  /\b(ngrok|cloudflared|frpc|bore|localtunnel|lt\s+--port|tailscale\s+(serve|funnel))\b/;

function containerFacts(containers: DockerContainer[], home: string): string {
  const shown = (source: string) => {
    const host = hostPath(source);
    return home && isInside(host, home) ? `~${host.slice(home.length)}` : host;
  };
  return containers
    .map((container) => {
      const { name, service } = containerNames(container);
      const ports = publishedPorts(container).map(
        ({ port, ip, hostPort }) => `${ip}:${hostPort}->${port}`
      );
      const mounts = (container.Mounts ?? []).map(
        (mount) =>
          `${mount.Type}:${mount.Source ? shown(mount.Source) : '?'}->${mount.Destination ?? '?'}${mount.RW === false ? ':ro' : ':rw'}`
      );
      return [
        `- ${service} (${name}) image=${container.Config?.Image ?? '?'} user=${container.Config?.User || 'root'} network=${container.HostConfig?.NetworkMode ?? '?'}${container.HostConfig?.Privileged ? ' PRIVILEGED' : ''}`,
        `  cap_add=${(container.HostConfig?.CapAdd ?? []).join(',') || '-'} ports=${ports.join(', ') || '-'}`,
        `  mounts=${mounts.join(', ') || '-'}`,
      ].join('\n');
    })
    .join('\n');
}

/** Committed secrets in the recent history: where and what kind, never the value. */
export function historySecrets(log: string, redact: (text: string) => string): string[] {
  const out: string[] = [];
  let commit = '';
  let file = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@@ ')) commit = line.slice(4).trim();
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++') && redact(line) !== line) {
      const hit = `${commit} ${file}`;
      if (!out.includes(hit)) out.push(hit);
      if (out.length >= HISTORY_HITS_MAX) break;
    }
  }
  return out;
}

/**
 * The read-only facts an exposure round's agent reads (READ_ONLY_PROBES only, chosen by the
 * surface): the project's containers (no environment), the build steps of their images, its
 * listeners, its launchd jobs, tunnels running, the providers' CLIs that are installed and
 * logged in, the repository's visibility, secrets in the recent history (by place). Masked.
 */
export async function exposureFacts(
  repo: string,
  state: RunningState & { surface: string[] },
  options: { redact: (text: string) => string; probe?: ProbeRunner; home?: string }
): Promise<string> {
  const probe = options.probe ?? runProbe;
  const home = (options.home ?? os.homedir()).replace(/\/+$/, '');
  const has = (label: string) => state.surface.some((line) => line.startsWith(label));
  const parts: string[] = [];
  const add = (title: string, body: string, max = PART_MAX) => {
    if (body.trim()) parts.push(`## ${title}\n${cap(body.trim(), max)}`);
  };
  const out = async (program: string, args: string[], cwd = repo) => {
    const result = await probe(program, args, cwd);
    return result.code === 0 ? result.stdout : '';
  };

  add('Surface found', state.surface.map((line) => `- ${line}`).join('\n'));
  add(
    'The project’s containers (docker inspect, environment left out)',
    containerFacts(state.containers, home)
  );
  add(
    'The project’s processes listening (lsof)',
    state.listeners
      .map(
        (listener) =>
          `- ${listener.command} (pid ${listener.pid}) ${listener.address}:${listener.port}`
      )
      .join('\n')
  );

  const labels = new Set<string>();
  for (const file of state.files.filter((each) => each.endsWith('.plist')).slice(0, 20)) {
    try {
      const text = fs.readFileSync(path.join(repo, file), 'utf8').slice(0, 64 * 1024);
      const match = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
      if (match) labels.add(match[1].trim());
    } catch {
      // Unreadable: skipped.
    }
  }
  if (labels.size) {
    const list = await out('launchctl', ['list'], home);
    add(
      'launchd jobs of the project (launchctl list: pid, status, label)',
      list
        .split('\n')
        .filter((line) => labels.has(line.split('\t').pop()?.trim() ?? ''))
        .join('\n') || `none loaded (${[...labels].join(', ')})`
    );
  }

  const processes = await out('ps', ['-axww', '-o', 'pid=,command='], home);
  add(
    'Tunnels running on the Mac (ps)',
    [...parsePs(processes)]
      .filter(([, args]) => TUNNEL_PROCESS.test(args))
      .map(([pid, args]) => `- ${pid} ${args}`)
      .join('\n')
  );
  if (has('Tailscale') || has('tunnel')) {
    add('tailscale serve status', await out('tailscale', ['serve', 'status', '--json'], home));
    add('tailscale funnel status', await out('tailscale', ['funnel', 'status', '--json'], home));
  }
  if (has('tunnel')) {
    add('cloudflared tunnel list', await out('cloudflared', ['tunnel', 'list'], home));
  }
  if (has('Fly.io')) add('flyctl status', await out('flyctl', ['status']));
  if (has('Kubernetes') || has('Helm')) {
    add(
      'kubectl get services,ingresses (current context)',
      await out('kubectl', ['get', 'services,ingresses', '--all-namespaces', '-o', 'wide'])
    );
  }
  add(
    'Repository on GitHub (gh repo view)',
    await out('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility,isFork'])
  );
  // The start of the log is enough when it passes the output limit (newest commits first).
  // 2026-11-10: past 16 MB the probe counted as failed and this part was left out in silence
  // (this repository's last 300 commits are 80 MB of patches).
  const logged = await probe(
    'git',
    [
      'log',
      '--all',
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      `-n${HISTORY_COMMITS}`,
      '--format=@@@ %h',
    ],
    repo
  );
  const history = logged.code === 0 || logged.truncated ? logged.stdout : '';
  const hits = historySecrets(history, options.redact);
  add(
    `What looks like a secret committed in the last ${HISTORY_COMMITS} commits (commit, file; values never shown)`,
    hits.map((hit) => `- ${hit}`).join('\n')
  );
  // Last, and short: images' build steps fill the room the rest needs (seen 2026-10-26).
  const images = [
    ...new Set(state.containers.map((container) => container.Config?.Image).filter(Boolean)),
  ];
  for (const image of images.slice(0, 5) as string[]) {
    add(
      `Build steps of ${image} (docker history)`,
      await out('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', image], home),
      IMAGE_HISTORY_MAX
    );
  }
  return options.redact(parts.join('\n\n')).slice(0, FACTS_MAX);
}

// --- connectors ---------------------------------------------------------------------------------

export interface ConnectorResult {
  findings: ExposureFinding[];
  errors: string[];
}

export interface ConnectorIo {
  /** The credential's value (null: not there). Never logged. */
  credential?: (credential: SecurityConnector['credential']) => Promise<string | null>;
  /** A GET of the provider's API with the credential. */
  get?: (provider: ConnectorProvider, secret: string, apiPath: string) => Promise<unknown>;
  now?: () => number;
}

/** The credential from the server's environment or the keychain; never logged. */
export async function readCredential(
  credential: SecurityConnector['credential']
): Promise<string | null> {
  if (credential.from === 'env') {
    const value = process.env[credential.name]?.trim();
    return value || null;
  }
  const args = [
    'find-generic-password',
    '-s',
    credential.name,
    ...(credential.account ? ['-a', credential.account] : []),
    '-w',
  ];
  const result = await run('/usr/bin/security', args, os.homedir(), PROBE_TIMEOUT_MS);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

const API_BASE: Record<ConnectorProvider, string> = { tailscale: TAILSCALE_API };

async function apiGet(
  provider: ConnectorProvider,
  secret: string,
  apiPath: string
): Promise<unknown> {
  const response = await fetch(`${API_BASE[provider]}${apiPath}`, {
    headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function describeCredential(credential: SecurityConnector['credential']): string {
  return credential.from === 'env'
    ? `environment variable ${credential.name}`
    : `keychain item "${credential.name}"${credential.account ? ` (account "${credential.account}")` : ''}`;
}

/** Every connector of the project, each on its own (one failing never hides the others). */
export async function runConnectors(
  connectors: readonly SecurityConnector[],
  io: ConnectorIo = {}
): Promise<ConnectorResult> {
  const findings: ExposureFinding[] = [];
  const errors: string[] = [];
  for (const connector of connectors) {
    const secret = await (io.credential ?? readCredential)(connector.credential).catch(() => null);
    if (!secret) {
      errors.push(
        `${connector.provider}: no credential in the ${describeCredential(connector.credential)}`
      );
      continue;
    }
    const get = (apiPath: string) => (io.get ?? apiGet)(connector.provider, secret, apiPath);
    const result = await CONNECTORS[connector.provider](
      get,
      connector.options ?? {},
      (io.now ?? Date.now)()
    );
    findings.push(...result.findings);
    errors.push(...result.errors);
  }
  return { findings, errors };
}

type ConnectorRun = (
  get: (apiPath: string) => Promise<unknown>,
  options: Record<string, string>,
  now: number
) => Promise<ConnectorResult>;

// --- the Tailscale connector ------------------------------------------------------------------

export interface TailscaleData {
  devices?: unknown;
  acl?: unknown;
  settings?: unknown;
  keys?: unknown;
}

export interface TailscaleOptions {
  /** The tag of the project's nodes; none: the shared-ports check is skipped. */
  tag?: string;
  /** Ports they may open to autogroup:shared. */
  sharedPorts: string[];
}

export function tailscaleOptions(options: Record<string, string>): TailscaleOptions {
  const tag = options.tag?.trim();
  return {
    ...(tag ? { tag: tag.startsWith('tag:') ? tag : `tag:${tag}` } : {}),
    sharedPorts: (options.sharedPorts ?? '')
      .split(/[,\s]+/)
      .map((port) => port.trim())
      .filter(Boolean),
  };
}

const ICMP = new Set(['icmp', 'ipv6-icmp', '1', '58']);

/** "tag:web:80,443" → host tag:web, ports 80 and 443. */
function dstPorts(dst: string): { host: string; ports: string[] } {
  const at = dst.lastIndexOf(':');
  if (at < 0) return { host: dst, ports: ['*'] };
  return { host: dst.slice(0, at), ports: dst.slice(at + 1).split(',') };
}

function portAllowed(port: string, allowed: readonly string[]): boolean {
  const plain = (spec: string) => spec.replace(/^(tcp|udp|sctp):/, '');
  const span = (spec: string) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
    return match ? [Number(match[1]), Number(match[2] ?? match[1])] : null;
  };
  const asked = span(plain(port));
  return allowed.some((spec) => {
    const want = span(plain(spec));
    return !!(want && asked && asked[0] >= want[0] && asked[1] <= want[1]);
  });
}

function aclFindings(acl: unknown, options: TailscaleOptions): ExposureFinding[] {
  const out: ExposureFinding[] = [];
  const policy = (acl ?? {}) as { acls?: unknown; grants?: unknown };
  const notice = (key: string, title: string, detail: string, fix: string) =>
    out.push({ key, source: 'tailscale', severity: 'high', title, detail, fix, fixable: false });
  const shared = (rule: unknown, src: string[], dsts: Array<{ host: string; ports: string[] }>) => {
    if (!options.tag || !src.includes('autogroup:shared')) return;
    for (const { host, ports } of dsts) {
      if (host !== options.tag && host !== '*') continue;
      const extra = ports.filter((port) => !portAllowed(port, options.sharedPorts));
      if (!extra.length) continue;
      notice(
        `tailscale:shared:${shortHash(rule)}:${extra.join(',')}`,
        `Shared users reach ${host} on ${extra.join(', ')}`,
        `A policy rule opens ${extra.join(', ')} of the project's nodes to everyone the tailnet shares them with, beyond the ports allowed (${options.sharedPorts.join(', ') || 'none set'}).`,
        "Narrow the rule in the tailnet policy to the ports the project needs (or list them in the connector's settings)"
      );
    }
  };
  for (const rule of Array.isArray(policy.acls) ? policy.acls : []) {
    const entry = (rule ?? {}) as {
      action?: string;
      src?: unknown;
      dst?: unknown;
      proto?: unknown;
    };
    if (entry.action && entry.action !== 'accept') continue;
    if (typeof entry.proto === 'string' && ICMP.has(entry.proto.toLowerCase())) continue;
    const src = strings(entry.src);
    const dst = strings(entry.dst);
    const text = `${src.join(',')} → ${dst.join(',')}`.slice(0, 200);
    if (src.includes('*')) {
      notice(
        `tailscale:acl-src:${shortHash(rule)}`,
        `Policy rule open to every source: ${text}`,
        'Any device or user of the tailnet, shared ones included, matches it.',
        'Name the groups, users or tags that need it in the tailnet policy'
      );
    }
    if (dst.includes('*:*')) {
      notice(
        `tailscale:acl-dst:${shortHash(rule)}`,
        `Policy rule opens every port of every device: ${text}`,
        'Its sources reach any service on any node.',
        'Limit the destinations to the hosts and ports needed'
      );
    }
    shared(rule, src, dst.map(dstPorts));
  }
  for (const rule of Array.isArray(policy.grants) ? policy.grants : []) {
    const entry = (rule ?? {}) as { src?: unknown; dst?: unknown; ip?: unknown; app?: unknown };
    const ip = strings(entry.ip);
    if (!ip.length && entry.app) continue;
    if (ip.length && ip.every((spec) => ICMP.has(spec.split(':')[0].toLowerCase()))) continue;
    const src = strings(entry.src);
    const dst = strings(entry.dst);
    const text = `${src.join(',')} → ${dst.join(',')} ${ip.join(',')}`.trim().slice(0, 200);
    if (src.includes('*')) {
      notice(
        `tailscale:grant-src:${shortHash(rule)}`,
        `Grant open to every source: ${text}`,
        'Any device or user of the tailnet, shared ones included, matches it.',
        'Name the groups, users or tags that need it in the tailnet policy'
      );
    }
    if (dst.includes('*') && (!ip.length || ip.includes('*'))) {
      notice(
        `tailscale:grant-dst:${shortHash(rule)}`,
        `Grant opens every port of every device: ${text}`,
        'Its sources reach any service on any node.',
        'Limit the destinations to the hosts and ports needed'
      );
    }
    const ports = ip.length
      ? ip.map((spec) => (spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec))
      : ['*'];
    shared(
      rule,
      src,
      dst.map((host) => ({ host, ports }))
    );
  }
  return out;
}

/** What the tailnet allows (pure: the API's answers in, findings out). Only ever told. */
export function tailscaleFindings(
  data: TailscaleData,
  options: TailscaleOptions,
  now: number
): ExposureFinding[] {
  const out = aclFindings(data.acl, options);
  const tell = (finding: Omit<ExposureFinding, 'source' | 'fixable'>) =>
    out.push({ ...finding, source: 'tailscale', fixable: false });
  const devices = ((data.devices ?? {}) as { devices?: unknown }).devices;
  for (const device of Array.isArray(devices) ? devices : []) {
    const entry = (device ?? {}) as {
      id?: string;
      nodeId?: string;
      name?: string;
      hostname?: string;
      lastSeen?: string;
      updateAvailable?: boolean;
      connectedToControl?: boolean;
    };
    const id = entry.nodeId ?? entry.id ?? entry.name ?? '?';
    const name = (entry.name ?? entry.hostname ?? id).split('.')[0];
    const seen = entry.lastSeen ? Date.parse(entry.lastSeen) : Number.NaN;
    const days = Number.isFinite(seen) ? Math.floor((now - seen) / 86_400_000) : 0;
    if (!entry.connectedToControl && days > DEVICE_STALE_DAYS) {
      tell({
        key: `tailscale:stale:${id}`,
        severity: 'high',
        title: `${name} not connected for ${days} days`,
        detail: 'An old device keeps its access to the tailnet: lost or sold, it still gets in.',
        fix: 'Remove it in the admin console if nobody uses it (Untether never deletes anything)',
      });
    }
    if (entry.updateAvailable) {
      tell({
        key: `tailscale:update:${id}`,
        severity: 'low',
        title: `${name}: Tailscale update available`,
        detail: 'It runs an older Tailscale than the one published.',
        fix: 'Update Tailscale on it',
      });
    }
  }
  const settings = (data.settings ?? {}) as {
    devicesApprovalOn?: boolean;
    usersApprovalOn?: boolean;
  };
  if (settings.devicesApprovalOn === false) {
    tell({
      key: 'tailscale:settings:devicesApprovalOn',
      severity: 'high',
      title: 'Device approval is off',
      detail:
        'A new device joins the tailnet without anyone approving it: a leaked auth key is enough.',
      fix: 'Turn on device approval in the admin console',
    });
  }
  if (settings.usersApprovalOn === false) {
    tell({
      key: 'tailscale:settings:usersApprovalOn',
      severity: 'medium',
      title: 'User approval is off',
      detail: 'A new user of the domain joins the tailnet without being approved.',
      fix: 'Turn on user approval in the admin console',
    });
  }
  const keys = ((data.keys ?? {}) as { keys?: unknown }).keys;
  for (const key of Array.isArray(keys) ? keys : []) {
    const entry = (key ?? {}) as {
      id?: string;
      keyType?: string;
      description?: string;
      expires?: string;
      revoked?: string;
      invalid?: boolean;
      capabilities?: { devices?: { create?: { reusable?: boolean } } };
    };
    if (entry.keyType && entry.keyType !== 'auth') continue;
    if (!entry.capabilities?.devices?.create?.reusable || entry.revoked || entry.invalid) continue;
    const expires = entry.expires ? Date.parse(entry.expires) : Number.NaN;
    if (Number.isFinite(expires) && expires <= now) continue;
    const id = entry.id ?? '?';
    tell({
      key: `tailscale:key:${id}`,
      severity: 'high',
      title: `Reusable auth key ${id}${entry.description ? ` (${entry.description.slice(0, 60)})` : ''} still valid`,
      detail: `Whoever holds it adds any number of devices${Number.isFinite(expires) ? ` until ${new Date(expires).toISOString().slice(0, 10)}` : ''}.`,
      fix: 'Revoke it in the admin console if nothing needs it now; prefer one-off or ephemeral keys',
    });
  }
  return out;
}

const tailscaleConnector: ConnectorRun = async (get, options, now) => {
  const errors: string[] = [];
  const part = async (apiPath: string): Promise<unknown> => {
    try {
      return await get(apiPath);
    } catch (error) {
      // Only the path and the status: never the credential, never the request.
      errors.push(
        `tailscale ${apiPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  };
  const [devices, acl, settings, keys] = await Promise.all([
    part('/tailnet/-/devices'),
    part('/tailnet/-/acl'),
    part('/tailnet/-/settings'),
    part('/tailnet/-/keys?all=true'),
  ]);
  let detailed = keys;
  const list = ((keys ?? {}) as { keys?: unknown }).keys;
  if (Array.isArray(list)) {
    detailed = {
      keys: await Promise.all(
        list.slice(0, KEYS_LOOKUP_MAX).map(async (entry) => {
          const item = (entry ?? {}) as { id?: string; capabilities?: unknown };
          if (item.capabilities || typeof item.id !== 'string' || !/^[\w-]+$/.test(item.id)) {
            return entry;
          }
          return (await part(`/tailnet/-/keys/${item.id}`)) ?? entry;
        })
      ),
    };
  }
  return {
    findings: tailscaleFindings(
      { devices, acl, settings, keys: detailed },
      tailscaleOptions(options),
      now
    ),
    errors,
  };
};

const CONNECTORS: Record<ConnectorProvider, ConnectorRun> = { tailscale: tailscaleConnector };
