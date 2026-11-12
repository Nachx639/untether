/**
 * A project's icon (ProjectSettings.icon, 2026-10-20): an image inside the repository that its
 * orchestrator chose when it started (`ut project set icon=<path>`), shown on the orchestrator's
 * row in the home. Never detected by Untether; only checked here: inside the repository, an
 * image, small.
 */
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { endOnReadError } from '../utils/stream-response.js';

export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;

export const PROJECT_ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Sends a checked icon as an image that can run nothing, not even an SVG opened on its own. */
export function sendIconFile(
  res: Response,
  icon: { file: string; type: string },
  maxAgeSeconds: number
): void {
  res.setHeader('Content-Type', icon.type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  );
  res.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
  const stream = fs.createReadStream(icon.file);
  endOnReadError(stream, res);
  stream.pipe(res);
}

/** The icon's file, or why it can't be one. Symlinks out of the repository don't count. */
export function resolveProjectIcon(
  repoPath: string,
  relative: string
): { file: string; type: string; size: number } | { error: string } {
  const type = PROJECT_ICON_TYPES[path.extname(relative).toLowerCase()];
  if (!type) {
    return { error: `icon must be an image (${Object.keys(PROJECT_ICON_TYPES).join(', ')})` };
  }
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(repoPath);
    file = fs.realpathSync(path.resolve(root, relative));
  } catch {
    return { error: `icon not found: ${relative}` };
  }
  if (!file.startsWith(`${root}${path.sep}`)) {
    return { error: 'icon must be a file inside the project' };
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { error: `icon is not a file: ${relative}` };
  if (stat.size > PROJECT_ICON_MAX_BYTES) {
    return { error: `icon is larger than ${PROJECT_ICON_MAX_BYTES / 1024} KB` };
  }
  return { file, type, size: stat.size };
}
