/**
 * The supply-chain watch of the security sweep (2026-10-23): what a project's lockfiles pin
 * (pnpm-lock.yaml, package-lock.json, Cargo.lock, Package.resolved, go.sum, requirements*.txt),
 * crossed with the public advisories of OSV (osv.dev: free, no key; it carries the GitHub
 * Advisory Database, RustSec, the Go and PyPI databases). Only names and versions leave the
 * Mac, never code. Parsers read text only: nothing of the project runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { compareVersions, type SecuritySeverity } from '../../shared/security.js';
import { run } from '../utils/exec-file.js';

export interface LockedPackage {
  /** OSV's ecosystem name: npm, crates.io, Go, PyPI, SwiftURL. */
  ecosystem: string;
  name: string;
  version: string;
  /** The lockfile it is pinned in, relative to the repository. */
  lockfile: string;
}

export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'Package.resolved',
  'go.sum',
];
const MAX_LOCKFILES = 20;
const MAX_LOCKFILE_BYTES = 30 * 1024 * 1024;

function isLockfile(file: string): boolean {
  const base = path.basename(file);
  return LOCKFILE_NAMES.includes(base) || /^requirements[\w.-]*\.txt$/.test(base);
}

/** "name@1.2.3" (or "@scope/name@1.2.3(peer@x)"): name and version, null otherwise. */
function splitAt(spec: string): { name: string; version: string } | null {
  const clean = spec.replace(/\(.*$/, '');
  const at = clean.lastIndexOf('@');
  if (at <= 0) return null;
  const name = clean.slice(0, at);
  const version = clean.slice(at + 1);
  return name && /^\d/.test(version) ? { name, version } : null;
}

/** pnpm-lock.yaml v5–v9: the keys under `packages:` (and `snapshots:`), two spaces in. */
export function parsePnpmLock(text: string, lockfile = 'pnpm-lock.yaml'): LockedPackage[] {
  const out: LockedPackage[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = /^(packages|snapshots):\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(\S.*):\s*$/.exec(line)?.[1];
    if (!key) continue;
    let spec = key.replace(/^['"]|['"]$/g, '').replace(/^\//, '');
    let parsed = splitAt(spec);
    if (!parsed) {
      // v5: /name/1.2.3 or /@scope/name/1.2.3
      spec = spec.replace(/_.*$/, '');
      const slash = spec.lastIndexOf('/');
      if (slash > 0 && /^\d/.test(spec.slice(slash + 1))) {
        parsed = { name: spec.slice(0, slash), version: spec.slice(slash + 1) };
      }
    }
    if (parsed) out.push({ ecosystem: 'npm', ...parsed, lockfile });
  }
  return out;
}

/** package-lock.json v2/v3 (`packages`) and v1 (`dependencies`). */
export function parsePackageLock(text: string, lockfile = 'package-lock.json'): LockedPackage[] {
  let data: {
    packages?: Record<string, { version?: string; link?: boolean }>;
    dependencies?: Record<string, { version?: string }>;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: LockedPackage[] = [];
  if (data.packages && typeof data.packages === 'object') {
    for (const [key, entry] of Object.entries(data.packages)) {
      const at = key.lastIndexOf('node_modules/');
      if (at < 0 || !entry || entry.link || typeof entry.version !== 'string') continue;
      const name = key.slice(at + 'node_modules/'.length);
      if (name && /^\d/.test(entry.version)) {
        out.push({ ecosystem: 'npm', name, version: entry.version, lockfile });
      }
    }
  } else if (data.dependencies && typeof data.dependencies === 'object') {
    for (const [name, entry] of Object.entries(data.dependencies)) {
      if (typeof entry?.version === 'string' && /^\d/.test(entry.version)) {
        out.push({ ecosystem: 'npm', name, version: entry.version, lockfile });
      }
    }
  }
  return out;
}

/** Cargo.lock: each [[package]] from a registry (local crates have no `source`). */
export function parseCargoLock(text: string, lockfile = 'Cargo.lock'): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const source = /^source\s*=\s*"registry\+/m.test(block);
    if (name && version && source) out.push({ ecosystem: 'crates.io', name, version, lockfile });
  }
  return out;
}

/** go.sum: "module v1.2.3[/go.mod] h1:…"; OSV's Go versions have no "v". */
export function parseGoSum(text: string, lockfile = 'go.sum'): LockedPackage[] {
  const out: LockedPackage[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const [name, raw] = line.trim().split(/\s+/);
    if (!name || !raw) continue;
    const version = raw.replace(/\/go\.mod$/, '').replace(/^v/, '');
    if (!/^\d/.test(version) || seen.has(`${name}@${version}`)) continue;
    seen.add(`${name}@${version}`);
    out.push({ ecosystem: 'Go', name, version, lockfile });
  }
  return out;
}

/** requirements*.txt: only exact pins (name==1.2.3). */
export function parseRequirements(text: string, lockfile = 'requirements.txt'): LockedPackage[] {
  const out: LockedPackage[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([0-9][^\s;#]*)/.exec(
      line
    );
    if (match) out.push({ ecosystem: 'PyPI', name: match[1], version: match[2], lockfile });
  }
  return out;
}

/** Package.resolved v1 (object.pins) and v2/v3 (pins): SwiftURL by the repository's URL. */
export function parsePackageResolved(text: string, lockfile = 'Package.resolved'): LockedPackage[] {
  let data: {
    pins?: Array<{ location?: string; state?: { version?: string } }>;
    object?: { pins?: Array<{ repositoryURL?: string; state?: { version?: string } }> };
  };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const pins = [
    ...(data.pins ?? []).map((pin) => ({ url: pin.location, version: pin.state?.version })),
    ...(data.object?.pins ?? []).map((pin) => ({
      url: pin.repositoryURL,
      version: pin.state?.version,
    })),
  ];
  return pins
    .filter((pin): pin is { url: string; version: string } => !!pin.url && !!pin.version)
    .map((pin) => ({
      ecosystem: 'SwiftURL',
      name: pin.url.replace(/\.git$/, ''),
      version: pin.version,
      lockfile,
    }));
}

export function parseLockfile(file: string, text: string): LockedPackage[] {
  const base = path.basename(file);
  switch (base) {
    case 'pnpm-lock.yaml':
      return parsePnpmLock(text, file);
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return parsePackageLock(text, file);
    case 'Cargo.lock':
      return parseCargoLock(text, file);
    case 'Package.resolved':
      return parsePackageResolved(text, file);
    case 'go.sum':
      return parseGoSum(text, file);
    default:
      return /^requirements[\w.-]*\.txt$/.test(base) ? parseRequirements(text, file) : [];
  }
}

/** Every package the repository's tracked lockfiles pin, once per lockfile, name and version. */
export async function lockedPackages(repoPath: string): Promise<LockedPackage[]> {
  const listed = await run('git', ['ls-files', '-z'], repoPath, 30_000);
  if (listed.code !== 0) return [];
  const files = listed.stdout
    .split('\0')
    .filter((file) => file && isLockfile(file) && !file.split('/').includes('node_modules'))
    .slice(0, MAX_LOCKFILES);
  const out = new Map<string, LockedPackage>();
  for (const file of files) {
    const full = path.join(repoPath, file);
    try {
      if (fs.statSync(full).size > MAX_LOCKFILE_BYTES) continue;
      for (const pkg of parseLockfile(file, fs.readFileSync(full, 'utf8'))) {
        // Per lockfile (2026-10-23): each one is bumped in its own task.
        const key = `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}\0${pkg.lockfile}`;
        if (!out.has(key)) out.set(key, pkg);
      }
    } catch {
      // Gone or unreadable: skipped.
    }
  }
  return [...out.values()];
}

/** A direct dependency nothing in its package imports, and how that was checked. */
export interface UnusedDependency {
  /** The package.json that declares it, relative to the repository. */
  manifest: string;
  name: string;
  /** The search that found nothing, for the user to read. */
  proof: string;
}

const MAX_MANIFESTS = 20;
/** Files where a package is imported or named (code and config, not Swift or docs). */
const USE_EXTENSIONS = [
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'html',
  // Native addons name their headers' package in binding.gyp (node-addon-api).
  'gyp',
  'gypi',
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The npm runtime dependencies (`dependencies`, not dev ones: tooling lives in configs and
 * binaries) nothing in their package names (2026-10-23, after ws sat in mac/package.json with
 * no file of mac/ importing it): no import, require or quoted mention of the name or a
 * subpath in the package's code and config (other package.json files and lockfiles left
 * out), and no script of the manifest naming it. A git error counts as used.
 */
export async function unusedDependencies(repoPath: string): Promise<UnusedDependency[]> {
  const listed = await run('git', ['ls-files', '-z'], repoPath, 30_000);
  if (listed.code !== 0) return [];
  const manifests = listed.stdout
    .split('\0')
    .filter(
      (file) =>
        path.posix.basename(file) === 'package.json' && !file.split('/').includes('node_modules')
    )
    .slice(0, MAX_MANIFESTS);
  const out: UnusedDependency[] = [];
  for (const manifest of manifests) {
    let data: { dependencies?: Record<string, unknown>; scripts?: Record<string, unknown> };
    try {
      data = JSON.parse(fs.readFileSync(path.join(repoPath, manifest), 'utf8'));
    } catch {
      continue;
    }
    const names = Object.keys(data?.dependencies ?? {}).filter(
      (name) => !name.startsWith('@types/')
    );
    if (!names.length) continue;
    const scripts = Object.values(data.scripts ?? {}).join('\n');
    const dir = path.posix.dirname(manifest);
    const prefix = dir === '.' ? '' : `${dir}/`;
    const pathspecs = [
      ...USE_EXTENSIONS.map((ext) => `:(glob)${prefix}**/*.${ext}`),
      ':(exclude,glob)**/node_modules/**',
      ':(exclude,glob)**/package.json',
      ...LOCKFILE_NAMES.map((name) => `:(exclude,glob)**/${name}`),
    ];
    for (const name of names) {
      if (new RegExp(`(^|[^\\w@/.-])${escapeRegExp(name)}($|[^\\w/.-])`).test(scripts)) continue;
      // The closing quote may be escaped (binding.gyp: require(\'node-addon-api\')).
      const pattern = `['"\`]${escapeRegExp(name)}(/[^'"\`]*)?\\\\?['"\`]`;
      const found = await run(
        'git',
        ['grep', '-l', '-E', '-e', pattern, '--', ...pathspecs],
        repoPath,
        30_000
      );
      // 1: nothing matched. Anything else (a match, an error) keeps the dependency.
      if (found.code !== 1) continue;
      out.push({
        manifest,
        name,
        proof: `git grep -E "${pattern}" over the ${USE_EXTENSIONS.join('/')} files of ${dir === '.' ? 'the repository' : `${dir}/`} (package.json files and lockfiles left out) finds nothing, and no script of ${manifest} names it`,
      });
    }
  }
  return out;
}

/** An advisory as the sweep uses it. */
export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: SecuritySeverity;
  /** The first fixed version above the locked one, when there is one. */
  fixed?: string;
}

/** One locked package an advisory names. */
export interface AffectedPackage {
  pkg: LockedPackage;
  advisories: Advisory[];
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const OSV_API = 'https://api.osv.dev/v1';
const OSV_BATCH = 500;
const OSV_TIMEOUT_MS = 30_000;
const OSV_DETAILS_MAX = 60;

interface OsvVuln {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ type?: string; events?: Array<{ introduced?: string; fixed?: string }> }>;
  }>;
}

function severityOf(vuln: OsvVuln): SecuritySeverity {
  const said = vuln.database_specific?.severity?.toUpperCase();
  if (said === 'CRITICAL' || said === 'HIGH') return 'high';
  if (said === 'LOW') return 'low';
  return 'medium';
}

/** The first fixed version of `pkg` above its locked version, from the advisory's ranges. */
export function fixedVersion(vuln: OsvVuln, pkg: LockedPackage): string | undefined {
  const fixes: string[] = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== pkg.name || affected.package?.ecosystem !== pkg.ecosystem) {
      continue;
    }
    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') continue;
      for (const event of range.events ?? []) {
        if (event.fixed && compareVersions(event.fixed, pkg.version) > 0) fixes.push(event.fixed);
      }
    }
  }
  return fixes.sort(compareVersions)[0];
}

/**
 * The locked packages OSV knows advisories for, with them. Throws when OSV can't be reached
 * (the caller tries again next time).
 */
export async function queryOsv(
  packages: LockedPackage[],
  fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<AffectedPackage[]> {
  const hits: Array<{ pkg: LockedPackage; ids: string[] }> = [];
  for (let start = 0; start < packages.length; start += OSV_BATCH) {
    const chunk = packages.slice(start, start + OSV_BATCH);
    const response = await fetchFn(`${OSV_API}/querybatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: chunk.map((pkg) => ({
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          version: pkg.version,
        })),
      }),
      signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OSV answered ${response.status}`);
    const body = (await response.json()) as { results?: Array<{ vulns?: Array<{ id?: string }> }> };
    (body.results ?? []).forEach((result, index) => {
      const ids = (result?.vulns ?? []).map((vuln) => vuln.id).filter((id): id is string => !!id);
      if (ids.length && chunk[index]) hits.push({ pkg: chunk[index], ids });
    });
  }
  const details = new Map<string, OsvVuln>();
  const wanted = [...new Set(hits.flatMap((hit) => hit.ids))].slice(0, OSV_DETAILS_MAX);
  for (const id of wanted) {
    const response = await fetchFn(`${OSV_API}/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
    });
    if (response.ok) details.set(id, (await response.json()) as OsvVuln);
  }
  return hits.map(({ pkg, ids }) => ({
    pkg,
    advisories: ids.map((id) => {
      const vuln = details.get(id) ?? { id };
      const fixed = fixedVersion(vuln, pkg);
      return {
        id,
        aliases: (vuln.aliases ?? []).slice(0, 5),
        summary: (vuln.summary || vuln.details || id).trim().slice(0, 300),
        severity: severityOf(vuln),
        ...(fixed ? { fixed } : {}),
      };
    }),
  }));
}
