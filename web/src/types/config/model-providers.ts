/** External model providers a task may run against. */

/**
 * One model offered by an external provider compatible with the Anthropic Messages API
 * (modelProviders). A plain string is shorthand for `{ id }`.
 *
 * `alias` maps the model onto one of Claude Code's built-in slots (sonnet/opus/haiku) so
 * `/model` inside the session shows it under that name with its real label; `contextTokens`
 * sets CLAUDE_CODE_MAX_CONTEXT_TOKENS for it (the provider's real window).
 */
export interface ModelProviderModel {
  id: string;
  /** Shown to the user (the New Session dialog, `/model`). Defaults to the id. */
  label?: string;
  /** Which built-in Claude Code slot it fills (ANTHROPIC_DEFAULT_<ALIAS>_MODEL). */
  alias?: 'sonnet' | 'opus' | 'haiku';
  /** The model's real context window (CLAUDE_CODE_MAX_CONTEXT_TOKENS). */
  contextTokens?: number;
}

/** Per-token USD rates for a provider model (OpenRouter-like: `GET <baseUrl>/v1/models`). */
export interface ModelProviderRates {
  /** USD per input (prompt) token. */
  prompt?: number;
  /** USD per output (completion) token. */
  completion?: number;
  /** USD per cached input token read. */
  input_cache_read?: number;
}

/**
 * How a provider's cost is priced. 'auto' fetches rates from `GET <baseUrl>/v1/models`
 * (cached); an object gives flat default rates and optional per-model overrides. Missing: no
 * price, the task counts tokens as before.
 */
export type ModelProviderPricing =
  | 'auto'
  | (ModelProviderRates & { models?: Record<string, ModelProviderRates> });

/**
 * An external provider that speaks the Anthropic Messages API (`/v1/messages`), opt-in: with
 * none configured nothing changes. A task launched with `--model <id>:<model>` runs its Claude
 * Code against `baseUrl` with the provider's key, and the New Session dialog offers an
 * interactive session the same way. The key NEVER lives in config.json: it is read from the
 * macOS Keychain (`keychainService`) or from a server environment variable (`keyEnv`).
 * See server/services/model-providers.ts.
 */
export interface ModelProvider {
  /** Referenced as `<id>:<model>` in `--model` and the API; `[a-z0-9-]`. */
  id: string;
  /** Human label, e.g. "Abliteration" (shown as "Claude · <label>"). */
  label: string;
  /**
   * Its mark in the session and task rows: one emoji, an app icon name, or the name of an image
   * in ~/.untether/icons (.png/.webp/.svg); none = generic.
   */
  icon?: string;
  /** One emoji or app icon name, shown when the image named by `icon` is missing. */
  iconFallback?: string;
  /** The API base, https only (e.g. `https://api.abliteration.ai`). */
  baseUrl: string;
  /** macOS Keychain service holding the key (`security find-generic-password -s <s> -w`). */
  keychainService?: string;
  /** A server environment variable holding the key, as an alternative to the Keychain. */
  keyEnv?: string;
  /** The models the provider offers (ids, or `{ id, label, alias, contextTokens }`). */
  models?: Array<string | ModelProviderModel>;
  /** The model a task/session gets when none is named; the internal fast model points here too. */
  defaultModel?: string;
  /** Cost model; missing = count tokens only. */
  pricing?: ModelProviderPricing;
}

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface ModelProvidersConfig {
  /**
   * External model providers compatible with the Anthropic Messages API (opt-in, 2026-11-08):
   * tasks and sessions can run their Claude Code against them. Missing/empty = off, nothing
   * changes. The key is never stored here (keychainService or keyEnv).
   */
  modelProviders?: ModelProvider[];
}
