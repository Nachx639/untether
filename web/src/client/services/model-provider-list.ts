/**
 * The configured model providers, shared by every provider badge: one request however many rows
 * appear at once, and a look again when the app comes back to the foreground (an `icon` just
 * added to config.json, or a request that failed).
 */
import {
  type AvatarIconKey,
  type AvatarIcons,
  type ProviderIcon,
  type PublicModelProvider,
  parseProviderIcon,
  providerBadgeInfo,
  providerIconFallback,
} from '../../shared/model-providers.js';
import { authClient } from './auth-client.js';
import { serverConfigService } from './server-config-service.js';

type Listener = (providers: readonly PublicModelProvider[]) => void;

let providers: readonly PublicModelProvider[] = [];
let avatarIcons: AvatarIcons = {};
let loading = false;
const listeners = new Set<Listener>();

/** Icon images as blob URLs, an `<img>` can't carry the login header; fetched once, on need. */
const iconFileUrls = new Map<string, string>();
const loadingIconFiles = new Set<string>();
const failedIconFiles = new Set<string>();

function notify(): void {
  for (const listener of listeners) listener(providers);
}

async function loadIconFile(file: string): Promise<void> {
  loadingIconFiles.add(file);
  try {
    const response = await fetch(`/api/model-providers/icon/${encodeURIComponent(file)}`, {
      headers: authClient.getAuthHeader(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    iconFileUrls.set(file, URL.createObjectURL(await response.blob()));
  } catch {
    failedIconFiles.add(file);
  } finally {
    loadingIconFiles.delete(file);
  }
  notify();
}

/** The file's URL, loading it the first time something draws it; undefined until it is there. */
function iconFileUrl(file: string): string | undefined {
  const url = iconFileUrls.get(file);
  if (!url && !loadingIconFiles.has(file) && !failedIconFiles.has(file)) void loadIconFile(file);
  return url;
}

/** An image that came but can't be drawn: the rows go to its fallback. */
export function markIconFileBroken(file: string): void {
  const url = iconFileUrls.get(file);
  if (url) URL.revokeObjectURL(url);
  iconFileUrls.delete(file);
  failedIconFiles.add(file);
  notify();
}

export type ResolvedProviderIcon =
  | Exclude<ProviderIcon, { kind: 'file' }>
  | { kind: 'file'; file: string; url: string };

/** The mark to draw now: an image file only once loaded, its fallback until then or if missing. */
export function providerMark(
  list: readonly PublicModelProvider[],
  providerId: string
): { icon: ResolvedProviderIcon; name: string } {
  const { icon, name } = providerBadgeInfo(list, providerId);
  if (icon.kind !== 'file') return { icon, name };
  const url = iconFileUrl(icon.file);
  return { icon: url ? { ...icon, url } : providerIconFallback(list, providerId), name };
}

/** The mark configured for an avatar; undefined keeps the app's: unset, loading or missing. */
export function avatarMark(key: AvatarIconKey): ResolvedProviderIcon | undefined {
  const value = avatarIcons[key];
  const icon = value ? parseProviderIcon(value) : undefined;
  if (icon?.kind !== 'file') return icon;
  const url = iconFileUrl(icon.file);
  return url ? { ...icon, url } : undefined;
}

function refresh(): void {
  if (loading) return;
  loading = true;
  void serverConfigService
    .loadConfig()
    .then((config) => {
      // A failed request comes back without the list: what is known stays.
      if (!config.modelProviders || config.modelProviders === providers) return;
      providers = config.modelProviders;
      avatarIcons = config.avatarIcons ?? {};
      // A file added since is worth another try.
      failedIconFiles.clear();
      notify();
    })
    .finally(() => {
      loading = false;
    });
}

function refreshWhenVisible(): void {
  if (document.visibilityState === 'visible') refresh();
}

export function knownProviders(): readonly PublicModelProvider[] {
  return providers;
}

function follow(listener: Listener): () => void {
  if (listeners.size === 0) document.addEventListener('visibilitychange', refreshWhenVisible);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener('visibilitychange', refreshWhenVisible);
  };
}

/** Calls `listener` whenever the list changes; returns the function that stops it. */
export function watchProviders(listener: Listener): () => void {
  const stop = follow(listener);
  refresh();
  return stop;
}

/** The same for an avatar with no provider: there is one per row, so these never ask. */
export const watchAvatarIcons = follow;

/** Once at startup, after the login: what the avatars with no provider will draw. */
export const loadAvatarIcons = refresh;
