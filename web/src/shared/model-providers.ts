/**
 * External model providers as the web/phone UI sees them (model-providers.ts): no key, no base
 * URL. Sent on GET /api/config and used by the New Session dialog and the session badge. Shared
 * between the server (built by sanitizedProviders) and the client.
 */

import type { ProviderSessionMarker } from './types.js';

/** One model a provider offers, as the UI sees it. */
export interface PublicProviderModel {
  id: string;
  label: string;
  alias?: 'sonnet' | 'opus' | 'haiku';
  contextTokens?: number;
}

/** A configured provider, without the key or base URL. */
export interface PublicModelProvider {
  id: string;
  label: string;
  defaultModel?: string;
  models: PublicProviderModel[];
  /** It has a price (config or 'auto'): its tasks/sessions are costed in dollars. */
  priced: boolean;
  /** Its mark in the session and task rows, as configured (parseProviderIcon). */
  icon?: string;
  /** The emoji or icon name to show while `icon`, an image file, is missing or loading. */
  iconFallback?: string;
}

/** The avatars whose mark can be replaced (UntetherConfig.avatarIcons). */
export type AvatarIconKey = 'claude' | 'codex' | 'shell' | 'preview' | 'previewPaused';

/** Each value has the syntax of a provider's `icon` (parseProviderIcon). */
export type AvatarIcons = Partial<Record<AvatarIconKey, string>>;

/** Longest `icon` accepted: fits every emoji sequence, icon name and image file name. */
export const PROVIDER_ICON_MAX = 64;

const EMOJI_PART =
  '\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|[\\u{E0020}-\\u{E007F}]+)*';
const ONE_EMOJI = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|${EMOJI_PART}(?:\\u200D${EMOJI_PART})*)$`,
  'u'
);
const ICON_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
/** A bare file name of ~/.untether/icons: no folder, no leading dot, an image's extension. */
const ICON_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|webp|svg)$/i;

/** A provider's mark: an emoji, an icon of the app's set, an image file, or the generic one. */
export type ProviderIcon =
  | { kind: 'emoji'; emoji: string }
  | { kind: 'named'; name: string }
  | { kind: 'file'; file: string }
  | { kind: 'generic' };

/** What a configured `icon` means; undefined when it is none of the accepted forms. */
export function parseProviderIcon(value: string): ProviderIcon | undefined {
  if (value.length > PROVIDER_ICON_MAX) return undefined;
  if (ICON_NAME.test(value)) return { kind: 'named', name: value };
  if (ICON_FILE.test(value) && !value.includes('..')) return { kind: 'file', file: value };
  if (ONE_EMOJI.test(value)) return { kind: 'emoji', emoji: value };
  return undefined;
}

/**
 * The mark and name for a session or task on `providerId`. A provider without `icon`, or no
 * longer in the config (the session still runs on it), gets the generic mark.
 */
export function providerBadgeInfo(
  providers: readonly PublicModelProvider[],
  providerId: string
): { icon: ProviderIcon; name: string } {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return {
    icon: (provider?.icon ? parseProviderIcon(provider.icon) : undefined) ?? { kind: 'generic' },
    name: provider?.label ?? providerId,
  };
}

/** What stands in while a provider's image is missing: its iconFallback, else the generic mark. */
export function providerIconFallback(
  providers: readonly PublicModelProvider[],
  providerId: string
): Exclude<ProviderIcon, { kind: 'file' }> {
  const value = providers.find((candidate) => candidate.id === providerId)?.iconFallback;
  const fallback = value ? parseProviderIcon(value) : undefined;
  return fallback && fallback.kind !== 'file' ? fallback : { kind: 'generic' };
}

/**
 * The provider a session's rows show: the one Untether launched it on (New Session, tasks), else
 * the one detected for a Claude started in a terminal by the user's own script (server
 * detectedProviderFor).
 */
export function sessionProviderMarker(session: {
  modelProvider?: ProviderSessionMarker;
  terminalClaude?: { detectedProvider?: ProviderSessionMarker };
}): ProviderSessionMarker | undefined {
  return session.modelProvider ?? session.terminalClaude?.detectedProvider;
}

/** "Claude · Abliteration" — how a provider session is labelled in the UI. */
export function providerSessionLabel(provider: Pick<PublicModelProvider, 'label'>): string {
  return `Claude · ${provider.label}`;
}

/** The default model of a provider for the UI: its defaultModel, else its first model. */
export function publicDefaultModel(provider: PublicModelProvider): string | undefined {
  return provider.defaultModel ?? provider.models[0]?.id;
}
