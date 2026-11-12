/**
 * The Node a project asks for, and an installed one that fits when the default does not.
 *
 * 2026-11-02: task agents and task checks ran with the shell's default node (Homebrew node 26)
 * while web/package.json asked for engines.node ">=22.12.0 <25": `pnpm run build` refused to
 * run in every task worktree unless the agent put a Node 24 on PATH by hand. Now a task's
 * session and its check read what the project asks for (package.json engines.node, .nvmrc,
 * .node-version, at its root or one folder down), and when the default node does not fit,
 * the newest installed one that does (nvm, fnm, volta, asdf, mise, Homebrew node@NN) goes first
 * on PATH. When none fits, the task and the check say so in plain words. Nothing is installed.
 *
 * PATH alone is not enough: a login shell's profile (`brew shellenv` in .zprofile) puts
 * /opt/homebrew/bin back in front. So a check prepends it inside its own `zsh -lc` command,
 * and a session gets a CLAUDE_ENV_FILE that Claude Code runs before each Bash command.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------------------------
// Versions and ranges (the semver subset package.json engines and .nvmrc files use)
// ---------------------------------------------------------------------------------------------

type Triple = [number, number, number];
type Op = '>=' | '>' | '<' | '<=';
interface Comparator {
  op: Op;
  v: Triple;
}

/** "v24.21.0", "24.21.0_1", "24.21.0-rc.1" → [24, 21, 0]; undefined when it is not one. */
export function parseVersion(text: string): Triple | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-_+].*)?$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const WILD = /^[xX*]$/;

/** "24", "24.1", "24.x", "24.1.0", "*" → the parts given (wildcards end it). */
function parsePartial(text: string): number[] | undefined {
  const body = text.replace(/^v/, '');
  if (body === '' || WILD.test(body)) return [];
  const parts: number[] = [];
  for (const part of body.split('.')) {
    if (WILD.test(part)) break;
    if (!/^\d+$/.test(part)) return undefined;
    parts.push(Number(part));
  }
  return parts.length > 3 ? undefined : parts;
}

const full = (parts: number[]): Triple => [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];

/** One comparator ("^24", ">=22.12.0", "24.x") as bounds. */
function comparators(op: string, partial: number[]): Comparator[] | undefined {
  const [major, minor, patch] = partial;
  const n = partial.length;
  if (n === 0) return op === '<' || op === '>' ? undefined : [];
  const bumpLast = (): Triple =>
    n === 1 ? [major + 1, 0, 0] : n === 2 ? [major, minor + 1, 0] : [major, minor, patch + 1];
  switch (op) {
    case '':
    case '=':
      return n === 3
        ? [
            { op: '>=', v: full(partial) },
            { op: '<=', v: full(partial) },
          ]
        : [
            { op: '>=', v: full(partial) },
            { op: '<', v: bumpLast() },
          ];
    case '^': {
      const upper: Triple =
        major > 0 || n === 1
          ? [major + 1, 0, 0]
          : minor > 0 || n === 2
            ? [0, minor + 1, 0]
            : [0, 0, patch + 1];
      return [
        { op: '>=', v: full(partial) },
        { op: '<', v: upper },
      ];
    }
    case '~':
      return [
        { op: '>=', v: full(partial) },
        { op: '<', v: n === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0] },
      ];
    case '>':
      return n === 3 ? [{ op: '>', v: full(partial) }] : [{ op: '>=', v: bumpLast() }];
    case '>=':
      return [{ op: '>=', v: full(partial) }];
    case '<':
      return [{ op: '<', v: full(partial) }];
    case '<=':
      return n === 3 ? [{ op: '<=', v: full(partial) }] : [{ op: '<', v: bumpLast() }];
    default:
      return undefined;
  }
}

/** A range as alternatives of comparator sets; undefined when it can't be read. */
function parseRange(range: string): Comparator[][] | undefined {
  const alternatives: Comparator[][] = [];
  for (const raw of range.split('||')) {
    const text = raw.trim().replace(/([<>]=?|=|\^|~)\s+/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const low = parsePartial(hyphen[1]);
      const high = parsePartial(hyphen[2]);
      const lower = low && comparators('>=', low);
      const upper = high && comparators('<=', high);
      if (!lower || !upper) return undefined;
      alternatives.push([...lower, ...upper]);
      continue;
    }
    const set: Comparator[] = [];
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token) as RegExpExecArray;
      const partial = parsePartial(match[2]);
      const parsed = partial && comparators(match[1] ?? '', partial);
      if (!parsed) return undefined;
      set.push(...parsed);
    }
    alternatives.push(set);
  }
  return alternatives;
}

/** Whether `version` is in `range`; undefined when either can't be read. */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  const alternatives = parseRange(range);
  if (!v || !alternatives) return undefined;
  return alternatives.some((set) =>
    set.every(({ op, v: bound }) => {
      const c = compare(v, bound);
      return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c <= 0;
    })
  );
}

/** nvm's LTS names (lts/iron …) by major. */
const LTS_MAJORS: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

/**
 * A .nvmrc / .node-version line as a range: "24", "v24.1.0", "lts/iron"; undefined for what
 * names no version ("node", "lts/*", "system").
 */
export function versionFileRange(content: string): string | undefined {
  const line = content
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .find(Boolean);
  if (!line) return undefined;
  const lts = /^lts\/([a-z]+)$/i.exec(line);
  if (lts) {
    const major = LTS_MAJORS[lts[1].toLowerCase()];
    return major ? String(major) : undefined;
  }
  const range = line.replace(/^v(?=\d)/, '');
  return parseRange(range) && /\d/.test(range) ? range : undefined;
}

// ---------------------------------------------------------------------------------------------
// What a project asks for
// ---------------------------------------------------------------------------------------------

export interface NodeRequirement {
  range: string;
  /** Where it was read, from the project's folder: "web/package.json (engines.node)". */
  source: string;
}

const SKIP_SUBDIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);
const MAX_SUBDIRS = 60;

function requirementsIn(dir: string, rel: string): NodeRequirement[] {
  const found: NodeRequirement[] = [];
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const pkg = read('package.json');
  if (pkg) {
    try {
      const engines = (JSON.parse(pkg) as { engines?: { node?: unknown } }).engines;
      const range = typeof engines?.node === 'string' ? engines.node.trim() : '';
      if (range && parseRange(range)) {
        found.push({ range, source: `${path.posix.join(rel, 'package.json')} (engines.node)` });
      }
    } catch {
      // not JSON: nothing asked
    }
  }
  for (const file of ['.nvmrc', '.node-version']) {
    const content = read(file);
    const range = content === undefined ? undefined : versionFileRange(content);
    if (range) found.push({ range, source: path.posix.join(rel, file) });
  }
  return found;
}

/**
 * What the project in `dir` asks of Node: its root, else, in a repository, its folders one
 * level down (a repository whose web app lives in web/). Ranges that can't be read are left out.
 */
export function readNodeRequirements(dir: string): NodeRequirement[] {
  const root = requirementsIn(dir, '');
  // One level down only in a repository (a worktree has a .git file): never in $HOME or /tmp.
  if (root.length || !fs.existsSync(path.join(dir, '.git'))) return root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_SUBDIRS.has(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_SUBDIRS)
    .flatMap((name) => requirementsIn(path.join(dir, name), name));
}

// ---------------------------------------------------------------------------------------------
// Installed Nodes
// ---------------------------------------------------------------------------------------------

export interface InstalledNode {
  version: string;
  /** The folder holding `node`. */
  bin: string;
  source: 'nvm' | 'fnm' | 'volta' | 'asdf' | 'mise' | 'homebrew';
}

export interface NodeSearchOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Homebrew prefixes; default /opt/homebrew and /usr/local. */
  brewPrefixes?: string[];
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Each installed Node a version manager or Homebrew keeps (one per real folder). */
export function findInstalledNodes(options: NodeSearchOptions = {}): InstalledNode[] {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const out: InstalledNode[] = [];
  const seen = new Set<string>();
  const add = (source: InstalledNode['source'], version: string, bin: string) => {
    const v = parseVersion(version);
    if (!v || !fs.existsSync(path.join(bin, 'node'))) return;
    let real = bin;
    try {
      real = fs.realpathSync(bin);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ version: v.join('.'), bin, source });
  };
  // Version folders: <root>/<version><suffix>
  const managed: Array<[InstalledNode['source'], string[], string]> = [
    ['nvm', [env.NVM_DIR ?? '', path.join(home, '.nvm')], 'versions/node'],
    [
      'fnm',
      [
        env.FNM_DIR ?? '',
        path.join(home, '.local/share/fnm'),
        path.join(home, 'Library/Application Support/fnm'),
        path.join(home, '.fnm'),
      ],
      'node-versions',
    ],
    ['volta', [env.VOLTA_HOME ?? '', path.join(home, '.volta')], 'tools/image/node'],
    ['asdf', [env.ASDF_DATA_DIR ?? '', path.join(home, '.asdf')], 'installs/nodejs'],
    ['mise', [env.MISE_DATA_DIR ?? '', path.join(home, '.local/share/mise')], 'installs/node'],
  ];
  for (const [source, roots, sub] of managed) {
    for (const root of new Set(roots.filter(Boolean))) {
      const base = path.join(root, sub);
      for (const name of listDir(base)) {
        const bin =
          source === 'fnm'
            ? path.join(base, name, 'installation', 'bin')
            : path.join(base, name, 'bin');
        add(source, name, bin);
      }
    }
  }
  // Homebrew: <prefix>/opt/node@NN → ../Cellar/node@NN/<version>
  for (const prefix of options.brewPrefixes ?? ['/opt/homebrew', '/usr/local']) {
    const opt = path.join(prefix, 'opt');
    for (const name of listDir(opt).filter((n) => /^node(@\d+)?$/.test(n))) {
      let version: string;
      try {
        version = path.basename(fs.realpathSync(path.join(opt, name)));
      } catch {
        continue;
      }
      add('homebrew', version, path.join(opt, name, 'bin'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------------------------

export type NodeRuntime =
  /** The project asks for nothing (that can be read). */
  | { kind: 'none' }
  /** The default node fits. */
  | { kind: 'default'; requirements: NodeRequirement[]; defaultVersion: string }
  /** An installed one that fits goes first on PATH. */
  | {
      kind: 'switch';
      requirements: NodeRequirement[];
      defaultVersion?: string;
      node: InstalledNode;
    }
  /** None installed fits. */
  | {
      kind: 'missing';
      requirements: NodeRequirement[];
      defaultVersion?: string;
      installed: string[];
    };

const fitsAll = (version: string, requirements: NodeRequirement[]) =>
  requirements.every((r) => satisfies(version, r.range) === true);

/** The choice for given requirements, default node version and installed Nodes. */
export function chooseNode(
  requirements: NodeRequirement[],
  defaultVersion: string | undefined,
  installed: InstalledNode[]
): NodeRuntime {
  if (!requirements.length) return { kind: 'none' };
  if (defaultVersion && fitsAll(defaultVersion, requirements)) {
    return { kind: 'default', requirements, defaultVersion };
  }
  const fitting = installed
    .filter((node) => fitsAll(node.version, requirements))
    .sort((a, b) =>
      compare(full(b.version.split('.').map(Number)), full(a.version.split('.').map(Number)))
    );
  if (fitting.length) return { kind: 'switch', requirements, defaultVersion, node: fitting[0] };
  return {
    kind: 'missing',
    requirements,
    defaultVersion,
    installed: [...new Set(installed.map((node) => `v${node.version}`))],
  };
}

const DEFAULT_PROBE_TTL_MS = 60_000;
let probeCache: { at: number; version: Promise<string | undefined> } | undefined;

/**
 * The version of the node a login shell finds (what a check's `zsh -lc` and an agent's shell
 * run), cached for a minute; undefined when there is none.
 */
export function defaultNodeVersion(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < DEFAULT_PROBE_TTL_MS) return probeCache.version;
  const version = new Promise<string | undefined>((resolve) => {
    execFile('/bin/zsh', ['-lc', 'node -v'], { env, timeout: 15_000 }, (error, stdout) => {
      const v = error ? undefined : parseVersion(String(stdout).trim().split('\n').pop() ?? '');
      resolve(v ? v.join('.') : undefined);
    });
  });
  probeCache = { at: now, version };
  return version;
}

export interface ResolveNodeOptions extends NodeSearchOptions {
  /** The default node's version; probed through a login shell when not given. */
  defaultVersion?: () => Promise<string | undefined>;
}

/** What `dir` asks of Node and how it is met. Never throws. */
export async function resolveNodeRuntime(
  dir: string,
  options: ResolveNodeOptions = {}
): Promise<NodeRuntime> {
  try {
    const requirements = readNodeRequirements(dir);
    if (!requirements.length) return { kind: 'none' };
    const probe = options.defaultVersion ?? (() => defaultNodeVersion(options.env ?? process.env));
    return chooseNode(requirements, await probe(), findInstalledNodes(options));
  } catch {
    return { kind: 'none' };
  }
}

// ---------------------------------------------------------------------------------------------
// Saying it and applying it
// ---------------------------------------------------------------------------------------------

const asked = (requirements: NodeRequirement[]) =>
  requirements.map((r) => `"${r.range}" (${r.source})`).join(' and ');

/** One line on the choice; undefined when there is nothing to say. */
export function describeNodeRuntime(runtime: NodeRuntime): string | undefined {
  const def = (v?: string) => (v ? `the default node is v${v}` : 'there is no default node');
  if (runtime.kind === 'switch') {
    return `Node v${runtime.node.version} (${runtime.node.source}, ${runtime.node.bin}) is first on PATH: the project asks for ${asked(runtime.requirements)} and ${def(runtime.defaultVersion)}.`;
  }
  if (runtime.kind === 'missing') {
    const installed = runtime.installed.length
      ? `installed: ${runtime.installed.join(', ')}`
      : 'no other Node is installed';
    return `The project asks for Node ${asked(runtime.requirements)}, but ${def(runtime.defaultVersion)} and no installed Node fits (${installed}). Untether installs nothing: install a fitting Node (nvm, fnm, volta, asdf, mise or Homebrew node@NN), or builds and checks that enforce engines will refuse to run.`;
  }
  return undefined;
}

/** For a task's first message: what an agent should know about its Node. */
export function nodeRuntimeBrief(runtime: NodeRuntime): string | undefined {
  const line = describeNodeRuntime(runtime);
  if (!line) return undefined;
  if (runtime.kind === 'switch') {
    return `[untether] ${line} If \`node -v\` in your shell says otherwise, run \`export PATH=${shellQuote(runtime.node.bin)}:"$PATH"\` first.`;
  }
  return `[untether] ${line}`;
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A shell line that puts `bin` first on PATH (unless it is already). */
export function pathPrependLine(bin: string): string {
  const q = shellQuote(bin);
  return `case ":$PATH:" in ${shellQuote(`:${bin}:`)}*) ;; *) export PATH=${q}:"$PATH" ;; esac`;
}

/** Where the CLAUDE_ENV_FILE scripts live. */
export function nodeEnvDir(home: string = os.homedir()): string {
  return path.join(home, '.untether', 'node-env');
}

/**
 * The variables that put `bin` first for a session's programs: PATH for what starts it, and a
 * CLAUDE_ENV_FILE (written here) for Claude's Bash commands, which run after the login profile
 * reordered PATH. A CLAUDE_ENV_FILE the user had is still run, first.
 */
export function pathPrependEnv(
  base: Record<string, string>,
  bin: string,
  dir: string = nodeEnvDir()
): Record<string, string> {
  const own = base.CLAUDE_ENV_FILE;
  const script = [
    '# Written by Untether: the Node this project asks for goes first on PATH (node-runtime.ts).',
    ...(own ? [`[ -f ${shellQuote(own)} ] && . ${shellQuote(own)}`] : []),
    pathPrependLine(bin),
    '',
  ].join('\n');
  const file = path.join(dir, `${createHash('sha1').update(script).digest('hex').slice(0, 16)}.sh`);
  const vars: Record<string, string> = {
    PATH: [bin, ...(base.PATH ?? '').split(':').filter((p) => p && p !== bin)].join(':'),
  };
  try {
    if (fs.readFileSync(file, 'utf8') !== script) throw new Error('changed');
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, script, { mode: 0o600 });
    } catch {
      return vars;
    }
  }
  vars.CLAUDE_ENV_FILE = file;
  return vars;
}
