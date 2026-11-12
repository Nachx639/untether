import * as path from 'path';

/**
 * Cache-Control for the files under public/.
 *
 * ETag/Last-Modified come from size+mtime, so a rebuild always changes them. With `no-cache` the
 * browser revalidates on every load and gets a 304 instead of re-downloading the multi-MB bundle
 * over Tailscale (it used to be `no-store`, 2026-10-02).
 *
 * The client's lazy chunks (public/bundle/chunks/*.js) are named by a hash of their content, so
 * a name never stands for other code: cached for good, in dev mode too, they cost no round trip
 * on later starts (2026-10-04, docs/cold-start.md). Their source maps keep the same name when
 * only a comment changes, so they are revalidated like everything else.
 */
export function staticCacheControl(filePath: string, isDevelopment: boolean): string | undefined {
  const chunksDir = `${path.sep}bundle${path.sep}chunks${path.sep}`;
  if (filePath.includes(chunksDir) && filePath.endsWith('.js')) {
    return 'public, max-age=31536000, immutable';
  }
  if (isDevelopment) return 'no-cache';
  // Bundle file names other than the chunks carry no content hash, so they must be revalidated:
  // a year-long `immutable` cache kept phones on the old client after an upgrade.
  if (/\.(js|css|map|wasm|json)$/.test(filePath)) return 'no-cache';
  if (/\.(woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/.test(filePath)) {
    return 'public, max-age=31536000, immutable';
  }
  if (filePath.endsWith('.html')) return 'public, max-age=3600'; // 1 hour
  return undefined;
}
