/**
 * Cost of a provider task (model-providers.ts). With `pricing: 'auto'` the per-token USD rates
 * come from `GET <baseUrl>/v1/models` (OpenRouter-like: `pricing.prompt` / `.completion` /
 * `.input_cache_read` per token, as strings), cached; with an object in the config they come
 * from there. The task's tokens are turned into dollars for its budget (`--budget usd=`) and
 * `ut project stats`. With no price, tokens are counted as before.
 */
import type { AgentUsage } from '../../shared/task-metrics.js';
import type { ModelProvider, ModelProviderRates } from '../../types/config.js';
import { providerModels, readProviderKey } from './model-providers.js';

/** A model's rates and context window from `GET /v1/models`. */
export interface ProviderModelPricing {
  rates: ModelProviderRates;
  contextLength?: number;
}

/** What one `/v1/models` call returns: by model id. */
export type ProviderPriceList = Record<string, ProviderModelPricing>;

/** Token usage of a turn/task. */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Parse the OpenRouter-like `/v1/models` body into rates by model id. */
export function parseProviderModelsResponse(body: unknown): ProviderPriceList {
  const out: ProviderPriceList = {};
  const data =
    body && typeof body === 'object' && Array.isArray((body as { data?: unknown[] }).data)
      ? ((body as { data: unknown[] }).data as unknown[])
      : [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { id?: unknown; pricing?: unknown; context_length?: unknown };
    if (typeof row.id !== 'string') continue;
    const pricing = (row.pricing ?? {}) as Record<string, unknown>;
    const rates: ModelProviderRates = {};
    const prompt = toNumber(pricing.prompt);
    const completion = toNumber(pricing.completion);
    const cacheRead = toNumber(pricing.input_cache_read);
    if (prompt !== undefined) rates.prompt = prompt;
    if (completion !== undefined) rates.completion = completion;
    if (cacheRead !== undefined) rates.input_cache_read = cacheRead;
    const contextLength = toNumber(row.context_length);
    out[row.id] = { rates, ...(contextLength ? { contextLength } : {}) };
  }
  return out;
}

/** Fetches and parses `GET <baseUrl>/v1/models`. Injected in tests. */
export type ModelsFetcher = (baseUrl: string, key: string) => Promise<ProviderPriceList>;

/**
 * How long one `/v1/models` call may take (2026-11-08, second review): it is awaited before a
 * provider task, session or shield restore starts (context window, `/model` picker), and with no
 * timeout a provider that accepted the connection but never answered held them for undici's
 * 5 min defaults — twice, as nothing was cached on failure.
 */
export const MODELS_FETCH_TIMEOUT_MS = 10_000;
/** After a failed `/v1/models` call, the next one waits this long (no stale list to keep). */
export const MODELS_FAILURE_TTL_MS = 5 * 60_000;

export async function fetchProviderModels(
  baseUrl: string,
  key: string,
  timeoutMs = MODELS_FETCH_TIMEOUT_MS
): Promise<ProviderPriceList> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return parseProviderModelsResponse(await response.json());
}

const PRICING_TTL_MS = 60 * 60 * 1000;

/**
 * Per-token USD rates for provider models, cached per provider for an hour. `pricing: 'auto'`
 * fetches `GET /v1/models`; an object in the config is used as given (flat rates plus optional
 * per-model overrides), with no network call. Missing pricing: no rates, tokens are counted.
 */
export class ProviderPricing {
  private cache = new Map<string, { at: number; list: ProviderPriceList }>();
  /** When the last `/v1/models` call of a provider failed (MODELS_FAILURE_TTL_MS). */
  private failedAt = new Map<string, number>();
  /** The call in flight per provider: concurrent launches share it. */
  private inFlight = new Map<string, Promise<ProviderPriceList>>();

  constructor(
    private readonly deps: {
      fetchModels?: ModelsFetcher;
      readKey?: (provider: ModelProvider) => Promise<string>;
      now?: () => number;
      ttlMs?: number;
    } = {}
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The `/v1/models` rates for a provider (cached); empty on any failure. */
  private async autoList(provider: ModelProvider): Promise<ProviderPriceList> {
    const cached = this.cache.get(provider.id);
    const ttl = this.deps.ttlMs ?? PRICING_TTL_MS;
    if (cached && this.now() - cached.at < ttl) return cached.list;
    // A recent failure is not retried on every launch: the stale list, or none, until it expires.
    const failed = this.failedAt.get(provider.id);
    if (failed !== undefined && this.now() - failed < MODELS_FAILURE_TTL_MS) {
      return cached?.list ?? {};
    }
    let pending = this.inFlight.get(provider.id);
    if (!pending) {
      pending = (async () => {
        try {
          const key = await (this.deps.readKey ?? readProviderKey)(provider);
          const list = await (this.deps.fetchModels ?? fetchProviderModels)(provider.baseUrl, key);
          this.cache.set(provider.id, { at: this.now(), list });
          this.failedAt.delete(provider.id);
          return list;
        } catch {
          this.failedAt.set(provider.id, this.now());
          // Keep the stale list if we have one; otherwise none (tokens are counted).
          return cached?.list ?? {};
        } finally {
          this.inFlight.delete(provider.id);
        }
      })();
      this.inFlight.set(provider.id, pending);
    }
    return pending;
  }

  /** Context windows learnt from `/v1/models` (auto pricing only), by model id. */
  async contextWindows(provider: ModelProvider): Promise<Record<string, number>> {
    if (provider.pricing !== 'auto') return {};
    const list = await this.autoList(provider);
    const out: Record<string, number> = {};
    for (const [id, info] of Object.entries(list)) {
      if (info.contextLength) out[id] = info.contextLength;
    }
    return out;
  }

  /** The model ids a provider offers, learnt from `/v1/models` when it lists none itself. */
  async discoverModels(provider: ModelProvider): Promise<string[]> {
    if (providerModels(provider).length > 0 || provider.pricing !== 'auto') return [];
    return Object.keys(await this.autoList(provider));
  }

  /**
   * The discovered model ids already in the cache (no network), for a synchronous caller like
   * the task guard's `/model` picker. Empty when the provider lists its own models, is not
   * 'auto', or nothing has been fetched yet (warm it with discoverModels/resolve first).
   */
  cachedModels(provider: ModelProvider): string[] {
    if (providerModels(provider).length > 0 || provider.pricing !== 'auto') return [];
    return Object.keys(this.cache.get(provider.id)?.list ?? {});
  }

  /** The per-token rates for a model, or undefined when the provider has no price for it. */
  async ratesFor(
    provider: ModelProvider,
    modelId: string
  ): Promise<ModelProviderRates | undefined> {
    const pricing = provider.pricing;
    if (!pricing) return undefined;
    if (pricing === 'auto') {
      const list = await this.autoList(provider);
      const rates = list[modelId]?.rates;
      return rates && hasAnyRate(rates) ? rates : undefined;
    }
    const perModel = pricing.models?.[modelId];
    const flat: ModelProviderRates = {
      ...(pricing.prompt !== undefined ? { prompt: pricing.prompt } : {}),
      ...(pricing.completion !== undefined ? { completion: pricing.completion } : {}),
      ...(pricing.input_cache_read !== undefined
        ? { input_cache_read: pricing.input_cache_read }
        : {}),
    };
    const merged: ModelProviderRates = { ...flat, ...(perModel ?? {}) };
    return hasAnyRate(merged) ? merged : undefined;
  }
}

function hasAnyRate(rates: ModelProviderRates): boolean {
  return (
    rates.prompt !== undefined ||
    rates.completion !== undefined ||
    rates.input_cache_read !== undefined
  );
}

/**
 * A provider task's cost in USD from its full token usage (model-providers.ts): each model's
 * own tokens (AgentUsage.byModel, from Claude's message.model) at that model's rate, and every
 * token NOT attributed to a model — a message or transcript without one, so the whole total is
 * always counted — at the task's model rate. `rateFor` gives a model's rates (undefined when it
 * has none). Undefined when no rate applied at all (the caller counts tokens instead).
 */
export async function taskUsdCost(
  usage: AgentUsage,
  taskModel: string,
  rateFor: (model: string) => Promise<ModelProviderRates | undefined>
): Promise<number | undefined> {
  let total = 0;
  let anyRate = false;
  const breakdown = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const [model, tokens] of Object.entries(usage.byModel ?? {})) {
    breakdown.input += tokens.input;
    breakdown.cacheWrite += tokens.cacheWrite;
    breakdown.cacheRead += tokens.cacheRead;
    breakdown.output += tokens.output;
    // An unpriced model among them falls back to the task's model rate.
    const rates = (await rateFor(model)) ?? (await rateFor(taskModel));
    if (!rates) continue;
    anyRate = true;
    total += usdCost(rates, tokens);
  }
  const remainder = {
    input: Math.max(0, usage.input - breakdown.input),
    output: Math.max(0, usage.output - breakdown.output),
    cacheRead: Math.max(0, usage.cacheRead - breakdown.cacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite - breakdown.cacheWrite),
  };
  if (remainder.input || remainder.output || remainder.cacheRead || remainder.cacheWrite) {
    const rates = await rateFor(taskModel);
    if (rates) {
      anyRate = true;
      total += usdCost(rates, remainder);
    }
  }
  return anyRate ? total : undefined;
}

/**
 * The USD cost of a token usage at the given rates. Cached input tokens are billed at
 * input_cache_read when it is set (else at the prompt rate); non-cached input at prompt.
 */
export function usdCost(rates: ModelProviderRates, usage: TokenUsage): number {
  const prompt = rates.prompt ?? 0;
  const completion = rates.completion ?? 0;
  const cacheRead = rates.input_cache_read ?? prompt;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cached = usage.cacheRead ?? 0;
  // Cache writes are billed as prompt tokens unless the provider prices them apart (it rarely
  // does in this format); counted at the prompt rate here.
  const cacheWrite = usage.cacheWrite ?? 0;
  return input * prompt + cacheWrite * prompt + cached * cacheRead + output * completion;
}
