/**
 * "Search the whole Mac" for the file browser.
 *
 * User report (2026-10-14): the file browser's search box only narrowed the folder on screen,
 * so a PDF sitting in Downloads (and in iCloud Drive) was impossible to find from anywhere
 * else. This looks names up with Spotlight (`mdfind`, case- and accent-insensitive), limited
 * to the user's home and iCloud Drive, and falls back to a bounded walk of the home folder
 * when Spotlight isn't there (Linux, `mdfind` missing).
 *
 * Only names and metadata are read; nothing is opened or written.
 */
import { execFile } from 'child_process';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { nameMatches, nameMatchScore, queryTerms, recencyBonus } from '../../shared/name-match.js';
import type { BlockedFolder, FolderAccessGuard } from './folder-access.js';

export interface FileSearchHit {
  name: string;
  /** Absolute path. */
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  /** Where it lives: the home folder or iCloud Drive. */
  area: 'home' | 'icloud';
  /** Parent folder relative to the area's root, '' when directly in it. */
  parent: string;
}

export interface FileSearchResult {
  results: FileSearchHit[];
  /** 'spotlight' or 'walk' (the fallback). */
  source: 'spotlight' | 'walk';
  /** More matches existed than were looked at (time or size limit). */
  truncated: boolean;
  /** Folders macOS didn't let us read (privacy prompt pending or denied); results are partial. */
  blocked: BlockedFolder[];
}

export interface FileSearchOptions {
  /** Home folder to search; os.homedir() by default. */
  home?: string;
  limit?: number;
  /** Aborts the search (the client went away). */
  signal?: AbortSignal;
  now?: number;
  /**
   * Skips folders macOS privacy hasn't cleared instead of hanging on them (user report
   * 2026-10-14: the search never answered after a fresh app install).
   */
  access?: FolderAccessGuard;
}

export const ICLOUD_DRIVE_RELATIVE = path.join(
  'Library',
  'Mobile Documents',
  'com~apple~CloudDocs'
);
export const SEARCH_TIMEOUT_MS = 3000;
export const SEARCH_MAX_RESULTS = 50;
/** Candidates checked (stat + ranking) at most; Spotlight can answer with thousands of paths. */
const MAX_CANDIDATES = 2000;
const MDFIND_MAX_BUFFER = 4 * 1024 * 1024;
const WALK_MAX_DIRS = 20000;
const WALK_MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['node_modules', 'Library', '__pycache__', 'DerivedData']);

/** Spotlight query: every word in the name, case- and diacritic-insensitive (`cd`), ANDed. */
export function buildSpotlightQuery(terms: readonly string[]): string {
  return terms
    .map((term) => {
      // Inside a quoted Spotlight string `"` and `\` need escaping and `*` is a wildcard.
      const safe = term.replace(/[\\"*]/g, (c) => (c === '*' ? '' : `\\${c}`));
      return `kMDItemFSName == "*${safe}*"cd`;
    })
    .filter((clause) => !clause.includes('"**"'))
    .join(' && ');
}

/**
 * Where an absolute path sits: its area and parent folder, or null when it is outside home,
 * hidden, inside Library (except iCloud Drive), node_modules, .git and the like.
 */
export function classifyPath(
  absolutePath: string,
  home: string
): { area: 'home' | 'icloud'; parent: string } | null {
  const rel = path.relative(home, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let area: 'home' | 'icloud' = 'home';
  let inner = rel;
  const icloudRel = path.relative(ICLOUD_DRIVE_RELATIVE, rel);
  if (!icloudRel.startsWith('..') && !path.isAbsolute(icloudRel)) {
    if (!icloudRel) return null; // iCloud Drive itself
    area = 'icloud';
    inner = icloudRel;
  }
  const segments = inner.split(path.sep);
  for (const segment of segments) {
    if (!segment || segment.startsWith('.')) return null;
    if (segment === 'node_modules' || segment === '__pycache__') return null;
  }
  if (area === 'home' && segments[0] === 'Library') return null;
  return { area, parent: segments.slice(0, -1).join('/') };
}

/** Runs mdfind; resolves with its NUL-separated paths, partial on timeout. Null: unavailable. */
function runMdfind(
  query: string,
  roots: string[],
  signal?: AbortSignal
): Promise<{ paths: string[]; truncated: boolean } | null> {
  const args = ['-0', ...roots.flatMap((root) => ['-onlyin', root]), query];
  return new Promise((resolve) => {
    const child = execFile(
      'mdfind',
      args,
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: MDFIND_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        signal?.removeEventListener('abort', onAbort);
        const out = typeof stdout === 'string' ? stdout : '';
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return resolve(null);
          const cut =
            (error as { killed?: boolean }).killed ||
            code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
            signal?.aborted;
          if (!cut) return resolve(null);
          // A cut-off answer may end in half a path: drop the last piece.
          const pieces = out.split('\0');
          pieces.pop();
          return resolve({ paths: pieces.filter(Boolean), truncated: true });
        }
        resolve({ paths: out.split('\0').filter(Boolean), truncated: false });
      }
    );
    const onAbort = () => child?.kill?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Breadth-first walk of home (and iCloud Drive) collecting matching names, bounded. */
async function walkHome(
  home: string,
  terms: readonly string[],
  deadline: number,
  signal?: AbortSignal,
  access?: FolderAccessGuard,
  onBlocked?: (dir: string) => void
): Promise<{ paths: string[]; truncated: boolean }> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: home, depth: 0 },
    { dir: path.join(home, ICLOUD_DRIVE_RELATIVE), depth: 0 },
  ];
  let visited = 0;
  while (queue.length > 0) {
    if (signal?.aborted || Date.now() > deadline || visited >= WALK_MAX_DIRS) {
      return { paths: found, truncated: true };
    }
    if (found.length >= MAX_CANDIDATES) return { paths: found, truncated: true };
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    visited++;
    // A folder macOS is holding behind a privacy prompt would block readdir: skip it.
    if (access && !access.isReadable(dir)) {
      onBlocked?.(dir);
      continue;
    }
    let entries: Dirent[];
    try {
      entries = access
        ? await access.run(dir, () => fs.readdir(dir, { withFileTypes: true }))
        : await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (access && (error as Error)?.name === 'FolderAccessError') onBlocked?.(dir);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (nameMatches(entry.name, terms)) found.push(full);
      if (entry.isDirectory() && depth < WALK_MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return { paths: found, truncated: false };
}

/** Searches file and folder names under home + iCloud Drive; best matches first. */
export async function searchFiles(
  query: string,
  options: FileSearchOptions = {}
): Promise<FileSearchResult> {
  const home = options.home ?? os.homedir();
  const limit = options.limit ?? SEARCH_MAX_RESULTS;
  const now = options.now ?? Date.now();
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return { results: [], source: 'spotlight', truncated: false, blocked: [] };
  }

  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const access = options.access;
  // Probe the protected folders (in child processes) while Spotlight runs; mdfind is its own
  // process too, so neither can stall the server.
  const settled = access?.settleUnder(home, SEARCH_TIMEOUT_MS);
  let source: FileSearchResult['source'] = 'spotlight';
  const spotlightQuery = buildSpotlightQuery(terms);
  let found = spotlightQuery
    ? await runMdfind(spotlightQuery, [home], options.signal)
    : { paths: [], truncated: false };
  await settled;
  // No mdfind, or an empty answer (Spotlight off for the volume, or a folder it doesn't index):
  // walk the folders instead, within what is left of the time budget.
  const blocked = new Map<string, BlockedFolder>();
  const noteBlocked = (target: string) => {
    const info = access?.describeBlocked(target);
    if (info) blocked.set(info.folder, info);
  };
  if (!found || (found.paths.length === 0 && !options.signal?.aborted)) {
    source = 'walk';
    found = await walkHome(home, terms, deadline, options.signal, access, noteBlocked);
  }

  // Spotlight also matches through the display name; keep only real name matches here, inside
  // the allowed places, and rank them.
  const seen = new Set<string>();
  const candidates: Array<{
    path: string;
    score: number;
    area: 'home' | 'icloud';
    parent: string;
  }> = [];
  for (const candidate of found.paths) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const place = classifyPath(candidate, home);
    if (!place) continue;
    // Spotlight may know names in a folder we can't read yet: stat there would block.
    if (access && !access.isReadable(candidate)) {
      noteBlocked(candidate);
      continue;
    }
    const score = nameMatchScore(path.basename(candidate), terms);
    if (score === 0) continue;
    candidates.push({ path: candidate, score, ...place });
  }
  // Stat only the best by name (plus some slack for recency to reorder).
  candidates.sort((a, b) => b.score - a.score);
  const statted = await Promise.all(
    candidates.slice(0, Math.max(limit * 4, 200)).map(async (candidate) => {
      try {
        const stats = access
          ? await access.run(candidate.path, () => fs.stat(candidate.path))
          : await fs.stat(candidate.path);
        return { candidate, stats };
      } catch {
        noteBlocked(candidate.path);
        return null;
      }
    })
  );
  const ranked = statted
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ candidate, stats }) => ({
      hit: {
        name: path.basename(candidate.path),
        path: candidate.path,
        type: stats.isDirectory() ? ('directory' as const) : ('file' as const),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        area: candidate.area,
        parent: candidate.parent,
      },
      rank:
        candidate.score +
        recencyBonus(stats.mtimeMs, now) -
        // Shallower first among equals: ~/Downloads/x before ~/a/b/c/d/x.
        Math.min(5, candidate.parent.split('/').filter(Boolean).length),
    }))
    .sort((a, b) => b.rank - a.rank || a.hit.name.localeCompare(b.hit.name));

  if (access) {
    for (const root of access.protectedRootsUnder(home)) {
      if (!access.isReadable(root.root)) noteBlocked(root.root);
    }
  }

  return {
    results: ranked.slice(0, limit).map((entry) => entry.hit),
    source,
    truncated: found.truncated || ranked.length > limit,
    blocked: [...blocked.values()],
  };
}
