/**
 * Dev-server previews as items of their own (2026-10-03): the server keeps one per port in
 * previews.json, independent of the session that opened it (GET /api/previews). They are
 * the "Vistas previas" rows of the phone list, the sidebar and mission control; a row stays
 * when its session ends or restarts. Tapping one opens /preview/<id>, its full-screen view.
 */
import type { PreviewCandidate, PreviewItem } from '../../shared/types.js';

export type { PreviewCandidate, PreviewItem };

/** The name the user gave it, else the page title, else "localhost:5173". */
export function previewLabel(item: { customName?: string; title?: string; port: number }): string {
  return item.customName || item.title || `localhost:${item.port}`;
}

/** Pinned first, then the most recently opened (like pinned sessions). */
export function sortPreviews(items: readonly PreviewItem[]): PreviewItem[] {
  return [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt
  );
}

/** The preview a session's chip opens: by port, that session's own first. */
export function findPreviewByPort(
  items: readonly PreviewItem[],
  port: number,
  sessionId?: string
): PreviewItem | undefined {
  const matches = items.filter((item) => item.port === port);
  return matches.find((item) => item.sessionId === sessionId) ?? matches[0];
}

/**
 * `/preview/<id>` (+ `?path=` for a page other than "/", `?from=<sessionId>` when it was
 * opened from that session: Back returns there; without it Back goes to the list).
 */
export function previewViewPath(id: string, path = '/', from?: string | null): string {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (path && path !== '/') query.set('path', path);
  const search = query.toString();
  return `/preview/${encodeURIComponent(id)}${search ? `?${search}` : ''}`;
}

export interface PreviewRoute {
  id: string;
  path: string;
  from: string | null;
}

/** `/preview/<id>?path=/x&from=s1` → its parts. */
export function parsePreviewViewUrl(pathname: string, search = ''): PreviewRoute | null {
  const params = new URLSearchParams(search);
  const raw = params.get('path') || '/';
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const byId = /^\/preview\/(p[a-z0-9]{6,20})\/?$/.exec(pathname);
  return byId ? { id: byId[1], path, from: params.get('from') || null } : null;
}

type AuthHeader = Record<string, string>;

/** Every preview, or null when the server couldn't be asked. */
export async function fetchPreviews(authHeader: AuthHeader): Promise<PreviewItem[] | null> {
  try {
    const response = await fetch('/api/previews', { headers: authHeader });
    if (!response.ok) return null;
    const body = (await response.json()) as { previews?: PreviewItem[] };
    return Array.isArray(body.previews) ? body.previews : null;
  } catch {
    return null;
  }
}

/** Pin/unpin or rename (an empty name goes back to the page title). */
export async function updatePreview(
  id: string,
  patch: { pinned?: boolean; customName?: string },
  authHeader: AuthHeader
): Promise<PreviewItem | null> {
  const response = await fetch(`/api/previews/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify(patch),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { preview: PreviewItem }).preview;
}

/** Forget a preview. The dev server itself keeps running. */
export async function deletePreview(id: string, authHeader: AuthHeader): Promise<boolean> {
  const response = await fetch(`/api/previews/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeader,
  });
  return response.ok || response.status === 404;
}

/**
 * "+ Añadir vista previa": the web servers listening on the Mac, lowest port first; null when
 * the server couldn't say within `timeoutMs` (the sheet then offers only typing a port).
 */
export async function fetchPreviewCandidates(
  authHeader: AuthHeader,
  timeoutMs = 6000
): Promise<PreviewCandidate[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/previews/candidates', {
      headers: authHeader,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { candidates?: PreviewCandidate[] };
    return Array.isArray(body.candidates) ? body.candidates : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line of that sheet: ":5173 · shop — Vite App" (folder, else process, then the page
 * title), or ":3000 · api · node" for a server without a title.
 */
export function previewCandidateLabel(candidate: PreviewCandidate): string {
  const port = `:${candidate.port}`;
  if (!candidate.title) {
    return [port, candidate.folder, candidate.process].filter(Boolean).join(' · ');
  }
  const where = candidate.folder || candidate.process;
  return `${where ? `${port} · ${where}` : port} — ${candidate.title}`;
}

/** "+ Añadir vista previa": a port or a localhost URL. */
export async function addPreview(
  target: string,
  authHeader: AuthHeader
): Promise<{ preview?: PreviewItem; error?: string }> {
  const text = target.trim();
  const body = /^\d+$/.test(text) ? { port: Number(text) } : { url: text };
  try {
    const response = await fetch('/api/previews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as {
      preview?: PreviewItem;
      error?: string;
    };
    if (!response.ok) return { error: json.error || `HTTP ${response.status}` };
    return { preview: json.preview };
  } catch (error) {
    return { error: String(error) };
  }
}

/** `ut open` / a new preview: its row comes to the top and glows for a moment. */
export const PREVIEW_HIGHLIGHT_MS = 2500;
const highlights = new Map<string, number>();

export function highlightPreviewRow(id: string, now = Date.now()): void {
  highlights.set(id, now);
  window.dispatchEvent(new CustomEvent('ut-preview-highlight', { detail: { id } }));
}

export function isPreviewRowHighlighted(id: string, now = Date.now()) {
  const at = highlights.get(id);
  return at !== undefined && now - at < PREVIEW_HIGHLIGHT_MS;
}

/** Rows ask the app to fetch the list again after a change (pin, rename, delete, add). */
export const PREVIEWS_CHANGED_EVENT = 'ut-previews-changed';
export function announcePreviewsChanged(): void {
  window.dispatchEvent(new CustomEvent(PREVIEWS_CHANGED_EVENT));
}
