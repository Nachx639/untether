/**
 * External model providers compatible with the Anthropic Messages API (opt-in, 2026-11-08,
 * types/config.ts ModelProvider). A task launched with `--model <providerId>:<model>`, and an
 * interactive session opened from the New Session dialog, run their Claude Code against the
 * provider's `baseUrl` with the provider's key, and never with the user's own Anthropic login.
 *
 * ONE function builds the session environment (providerSessionEnv), used for both tasks and
 * interactive sessions, after the real reference that already works on this Mac
 * (~/.local/bin/claude-ablit): ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (the key, from the
 * Keychain or a server env var, never on argv or in config.json), the model on
 * ANTHROPIC_MODEL, the sonnet/opus/haiku aliases remapped onto provider models so `/model`
 * and the internal small/fast model never reach Anthropic's Haiku, the real context window on
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS, and the user's own Anthropic credentials removed.
 *
 * `/model` inside the session is also driven by a `modelPicker` settings block
 * (providerModelPicker), passed with the `--settings` tasks already use and written for
 * interactive sessions, listing only the provider's models (replaceBuiltInOptions).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PublicModelProvider } from '../../shared/model-providers.js';
import type { ModelProvider, ModelProviderModel, UntetherConfig } from '../../types/config.js';

export type { PublicModelProvider };

const execFileAsync = promisify(execFile);

/** The user's own Anthropic login, removed so a provider session never mixes identities. */
export const ANTHROPIC_CREDENTIAL_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/** A provider model after normalisation (a plain string id becomes `{ id, label: id }`). */
export interface ResolvedProviderModel {
  id: string;
  label: string;
  alias?: 'sonnet' | 'opus' | 'haiku';
  contextTokens?: number;
}

/** The configured providers with the key and base URL stripped, for the client. */
export function sanitizedProviders(
  config: Pick<UntetherConfig, 'modelProviders'> | undefined
): PublicModelProvider[] {
  return (config?.modelProviders ?? []).map((provider) => ({
    id: provider.id,
    label: provider.label,
    ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    models: providerModels(provider),
    priced: provider.pricing !== undefined,
    ...(provider.icon ? { icon: provider.icon } : {}),
    ...(provider.iconFallback ? { iconFallback: provider.iconFallback } : {}),
  }));
}

/** The provider and model named by `<providerId>:<model>`; undefined when there is no colon. */
export function parseProviderModel(
  value: string
): { providerId: string; model?: string } | undefined {
  const colon = value.indexOf(':');
  if (colon <= 0) return undefined;
  const providerId = value.slice(0, colon);
  const model = value.slice(colon + 1).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) return undefined;
  return { providerId, ...(model ? { model } : {}) };
}

/** The provider with this id in the config, or undefined. */
export function findProvider(
  config: Pick<UntetherConfig, 'modelProviders'> | undefined,
  id: string
): ModelProvider | undefined {
  return config?.modelProviders?.find((provider) => provider.id === id);
}

/** The host (and port, when not the default) of a URL; undefined when it is not one. */
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * The configured provider a base URL points at, by host only, for a Claude that Untether did
 * not launch (sessionProviderMarker). The value is compared and dropped, never kept or shown.
 */
export function providerForBaseUrl(
  config: Pick<UntetherConfig, 'modelProviders'> | undefined,
  baseUrl: string
): ModelProvider | undefined {
  const host = urlHost(baseUrl);
  if (!host) return undefined;
  return config?.modelProviders?.find((provider) => urlHost(provider.baseUrl) === host);
}

/** The provider's models, normalised; a plain string id becomes `{ id, label: id }`. */
export function providerModels(provider: ModelProvider): ResolvedProviderModel[] {
  return (provider.models ?? []).map((entry: string | ModelProviderModel) =>
    typeof entry === 'string'
      ? { id: entry, label: entry }
      : {
          id: entry.id,
          label: entry.label ?? entry.id,
          ...(entry.alias ? { alias: entry.alias } : {}),
          ...(entry.contextTokens ? { contextTokens: entry.contextTokens } : {}),
        }
  );
}

/** The model a session gets when none is named: defaultModel, else the first configured model. */
export function providerDefaultModel(provider: ModelProvider): string | undefined {
  if (provider.defaultModel) return provider.defaultModel;
  return providerModels(provider)[0]?.id;
}

/** The human label of a model id (its configured label, else the id itself). */
export function modelLabel(provider: ModelProvider, modelId: string): string {
  return providerModels(provider).find((model) => model.id === modelId)?.label ?? modelId;
}

/** The configured model entry for a model id, if any (its alias, its context window). */
export function providerModelInfo(
  provider: ModelProvider,
  modelId: string
): ResolvedProviderModel | undefined {
  return providerModels(provider).find((model) => model.id === modelId);
}

/**
 * The provider's key, from the macOS Keychain (`security find-generic-password -s <s> -w`) or a
 * server environment variable (keyEnv). Throws when it cannot be read: the caller pauses/fails
 * the task rather than run without it.
 */
export async function readProviderKey(
  provider: ModelProvider,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (provider.keyEnv) {
    const value = env[provider.keyEnv];
    if (value && value.trim()) return value.trim();
    throw new Error(
      `provider ${provider.id}: environment variable ${provider.keyEnv} is empty or unset`
    );
  }
  if (provider.keychainService) {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', provider.keychainService, '-w'],
        { encoding: 'utf8' }
      );
      const key = stdout.replace(/\n$/, '');
      if (key) return key;
    } catch {
      // fall through to the shared error
    }
    throw new Error(
      `provider ${provider.id}: no key in the Keychain (service ${provider.keychainService})`
    );
  }
  throw new Error(`provider ${provider.id}: neither keychainService nor keyEnv is set`);
}

/** What providerSessionEnv returns: variables to set, and the user's own credentials to remove. */
export interface ProviderSessionEnv {
  env: Record<string, string>;
  /** Removed from the inherited environment (the user's own Anthropic login). */
  unset: string[];
}

/**
 * The ONE environment a provider session runs with (task or interactive). `model` is the model
 * the session starts on; `key` is the provider's key. The sonnet/opus/haiku aliases are
 * remapped onto provider models (the configured ones first, then the chosen model) so neither
 * `/model` nor the internal small/fast model ever reaches Anthropic's Haiku.
 */
export function providerSessionEnv(
  provider: ModelProvider,
  model: string,
  key: string
): ProviderSessionEnv {
  // Fail loudly here rather than start a session whose ANTHROPIC_BASE_URL is empty: Claude Code
  // would fall back to the Anthropic API on the user's own login and run the wrong model
  // (2026-11-08). The key is already checked non-empty when it is read (readProviderKey).
  if (!provider.baseUrl?.trim()) {
    throw new Error(
      `provider ${provider.id}: baseUrl is empty; a session would fall back to the Anthropic API`
    );
  }
  if (!model.trim()) {
    throw new Error(`provider ${provider.id}: no model to run; a session cannot start`);
  }
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    // ANTHROPIC_MODEL/--model win over the `model` setting: the session runs on this model.
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_MODEL: model,
    // A third-party endpoint has no Anthropic telemetry/statsig; also keeps the key off those.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  const models = providerModels(provider);
  const byAlias = (alias: 'sonnet' | 'opus' | 'haiku') => models.find((m) => m.alias === alias);
  const chosen = providerModelInfo(provider, model);
  const slots: Array<'sonnet' | 'opus' | 'haiku'> = ['sonnet', 'opus', 'haiku'];
  for (const alias of slots) {
    // The configured model for the slot, else the chosen model: a slot never stays Anthropic's.
    const target = byAlias(alias) ?? chosen ?? { id: model, label: model };
    const upper = alias.toUpperCase();
    env[`ANTHROPIC_DEFAULT_${upper}_MODEL`] = target.id;
    env[`ANTHROPIC_DEFAULT_${upper}_MODEL_NAME`] = target.label;
    env[`ANTHROPIC_DEFAULT_${upper}_MODEL_SUPPORTED_CAPABILITIES`] =
      'thinking,interleaved_thinking';
  }
  // The internal small/fast model (background tasks): a provider model, never Anthropic's Haiku.
  env.ANTHROPIC_SMALL_FAST_MODEL = (byAlias('haiku') ?? chosen ?? { id: model }).id;

  // The real context window of the model the session runs on.
  const contextTokens = chosen?.contextTokens;
  if (contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextTokens);

  return { env, unset: [...ANTHROPIC_CREDENTIAL_VARS] };
}

/**
 * A command line for an interactive provider session: `--model <model>` and, with a picker
 * settings file, `--settings <path>` inserted right after a plain `claude` (each only when not
 * already present; a shell wrapping claude, or the user's own flag, is left as it is). The key
 * is never added here: it travels in the environment (providerSessionEnv).
 */
export function providerCommandArgs(
  command: readonly string[],
  model: string,
  settingsPath?: string
): string[] {
  // Find the claude executable past a leading `env VAR=value …` prefix.
  let index = 0;
  if ((command[0]?.split('/').pop() ?? '') === 'env') {
    index = 1;
    while (index < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index])) index++;
  }
  const executable = command[index]?.split('/').pop() ?? '';
  if (executable !== 'claude') return [...command];
  const has = (flag: string) => command.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const insert: string[] = [];
  if (!has('--model')) insert.push('--model', model);
  if (settingsPath && !has('--settings')) insert.push('--settings', settingsPath);
  if (!insert.length) return [...command];
  return [...command.slice(0, index + 1), ...insert, ...command.slice(index + 1)];
}

/** One row of the `/model` picker. */
export interface ModelPickerOption {
  model: string;
  label?: string;
  description?: string;
}

/** The `modelPicker` settings block that shows only the provider's models in `/model`. */
export interface ModelPickerSettings {
  modelPicker: { replaceBuiltInOptions: true; options: ModelPickerOption[] };
  model?: string;
}

/**
 * The `modelPicker` settings (Claude Code v2.1.242+) that replaces the built-in Opus/Sonnet/
 * Haiku rows with the provider's models, so `/model` never offers an Anthropic model that does
 * not exist on this endpoint. `model` starts the session on the chosen model. `extraModels`
 * (e.g. ids learnt from `GET /v1/models`) are shown too when the provider lists none.
 * Returns undefined when there are no models to show (the env aliases still cover `/model`).
 */
export function providerModelPicker(
  provider: ModelProvider,
  options: { model?: string; extraModels?: string[] } = {}
): ModelPickerSettings | undefined {
  const rows = new Map<string, ModelPickerOption>();
  for (const model of providerModels(provider)) {
    rows.set(model.id, { model: model.id, label: model.label });
  }
  for (const id of options.extraModels ?? []) {
    if (!rows.has(id)) rows.set(id, { model: id });
  }
  if (rows.size === 0) return undefined;
  return {
    modelPicker: { replaceBuiltInOptions: true, options: [...rows.values()] },
    ...(options.model ? { model: options.model } : {}),
  };
}
