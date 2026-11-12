/**
 * Resolves what a provider session (task or interactive) launches with: the provider from the
 * config, its key (Keychain/env), the session environment (providerSessionEnv) with the real
 * context window filled from `/v1/models` when the config did not give one, and the `/model`
 * picker. Shared by the task launcher, the task guard's settings and the shield restore
 * resolver, so one place builds it. See model-providers.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProviderSessionMarker } from '../../shared/types.js';
import type { ModelProvider } from '../../types/config.js';
import { claudeHookFiles, ensureClaudeHookFiles, hookSettings } from './claude-hooks.js';
import { ProviderPricing } from './model-provider-pricing.js';
import {
  type ModelPickerSettings,
  providerCommandArgs,
  providerDefaultModel,
  providerModelPicker,
  providerSessionEnv,
  readProviderKey,
} from './model-providers.js';
import { registerSecretValue } from './security-sweep.js';

/** Everything a provider session starts with. */
export interface ProviderLaunch {
  /** The provider and the resolved model (the default when none was named). */
  marker: ProviderSessionMarker;
  /** Environment to merge over the session's (ANTHROPIC_BASE_URL/_AUTH_TOKEN, model variables). */
  env: Record<string, string>;
  /** The user's own Anthropic credentials to remove. */
  unset: string[];
  /** The `/model` picker block for the session's `--settings` (undefined: aliases cover it). */
  modelPicker?: ModelPickerSettings;
}

export interface ProviderLauncherDeps {
  /** The configured providers (UntetherConfig.modelProviders). */
  providers: () => ModelProvider[] | undefined;
  pricing?: ProviderPricing;
  readKey?: (provider: ModelProvider) => Promise<string>;
  /** Where the interactive `/model` picker settings file is written (default ~/.untether). */
  untetherDir?: string;
}

/** An interactive provider session's launch: its command line, environment and marker. */
export interface InteractiveProviderLaunch {
  command: string[];
  env: Record<string, string>;
  unset: string[];
  marker: ProviderSessionMarker;
}

export function createProviderLauncher(deps: ProviderLauncherDeps) {
  // Every read of a provider key registers it for redaction (notes, status, relays, screen).
  const readKey = async (provider: ModelProvider): Promise<string> => {
    const key = await (deps.readKey ?? readProviderKey)(provider);
    registerSecretValue(key);
    return key;
  };
  const pricing = deps.pricing ?? new ProviderPricing({ readKey });

  const find = (id: string): ModelProvider | undefined =>
    deps.providers()?.find((provider) => provider.id === id);

  /**
   * The launch for a provider marker, or null when the provider is gone or its key cannot be
   * read (the caller fails/pauses the task; it never runs with the user's own login instead).
   */
  async function resolve(marker: ProviderSessionMarker): Promise<ProviderLaunch | null> {
    const provider = find(marker.id);
    if (!provider) return null;
    const model = marker.model || providerDefaultModel(provider);
    if (!model) return null;
    let key: string;
    try {
      key = await readKey(provider);
    } catch {
      return null;
    }
    const { env, unset } = providerSessionEnv(provider, model, key);
    if (!env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
      const windows = await pricing
        .contextWindows(provider)
        .catch((): Record<string, number> => ({}));
      if (windows[model]) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(windows[model]);
    }
    const extraModels = await pricing.discoverModels(provider).catch(() => []);
    const modelPicker = providerModelPicker(provider, { model, extraModels });
    return {
      marker: { id: provider.id, model },
      env,
      unset,
      ...(modelPicker ? { modelPicker } : {}),
    };
  }

  const untetherDir = deps.untetherDir ?? path.join(os.homedir(), '.untether');

  /**
   * An interactive provider session (New Session dialog): the base command with `--model` and,
   * when there is a picker, `--settings <file>`, plus the provider environment. Null when the
   * provider is gone or its key cannot be read.
   *
   * The picker's file holds Untether's hooks too and lives under their folder
   * (~/.untether/agent-hooks/model-pickers), which is how withClaudeHooks knows a command's own
   * `--settings` is hooked. 2026-11-11: it was the picker alone under ~/.untether/model-pickers,
   * Claude takes one `--settings`, so these sessions ran without hooks and their state came
   * from reading the screen.
   */
  async function interactive(
    marker: ProviderSessionMarker,
    baseCommand: readonly string[]
  ): Promise<InteractiveProviderLaunch | null> {
    const launch = await resolve(marker);
    if (!launch) return null;
    let settingsPath: string | undefined;
    if (launch.modelPicker) {
      try {
        const hooks = ensureClaudeHookFiles(claudeHookFiles(untetherDir));
        // Hooks that cannot be written: the picker alone, where nothing takes it for hooked.
        const pickerDir = hooks
          ? path.join(path.dirname(hooks.settings), 'model-pickers')
          : path.join(untetherDir, 'model-pickers');
        const settings = hooks
          ? { ...hookSettings(hooks.script), ...launch.modelPicker }
          : launch.modelPicker;
        fs.mkdirSync(pickerDir, { recursive: true, mode: 0o700 });
        settingsPath = path.join(pickerDir, `${launch.marker.id}.json`);
        const tmp = `${settingsPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, settingsPath);
      } catch {
        settingsPath = undefined; // the env aliases still drive /model
      }
    }
    return {
      command: providerCommandArgs(baseCommand, launch.marker.model, settingsPath),
      env: launch.env,
      unset: launch.unset,
      marker: launch.marker,
    };
  }

  /**
   * The `/model` picker for the task guard (synchronous): the configured models, plus the ones
   * already discovered from `/v1/models` and cached (warm the cache with resolve() first, which
   * the launcher does before the guard writes its settings).
   */
  function modelPickerFor(marker: ProviderSessionMarker): ModelPickerSettings | undefined {
    const provider = find(marker.id);
    if (!provider) return undefined;
    const model = marker.model || providerDefaultModel(provider);
    return providerModelPicker(provider, {
      ...(model ? { model } : {}),
      extraModels: pricing.cachedModels(provider),
    });
  }

  return { resolve, interactive, modelPickerFor, find, pricing };
}

export type ProviderLauncher = ReturnType<typeof createProviderLauncher>;
