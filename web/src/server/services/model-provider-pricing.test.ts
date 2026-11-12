import * as http from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { emptyUsage } from '../../shared/task-metrics.js';
import type { ModelProvider, ModelProviderRates } from '../../types/config.js';
import {
  fetchProviderModels,
  MODELS_FAILURE_TTL_MS,
  ProviderPricing,
  parseProviderModelsResponse,
  taskUsdCost,
  usdCost,
} from './model-provider-pricing.js';

const body = {
  data: [
    {
      id: 'abliterated-model-large-flash',
      name: 'Large Flash',
      context_length: 1_000_000,
      pricing: { prompt: '0.0000004', completion: '0.0000016', input_cache_read: '0.0000001' },
    },
    {
      id: 'abliterated-model',
      context_length: 262144,
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
    },
  ],
};

describe('parseProviderModelsResponse', () => {
  it('reads OpenRouter-like per-token rates and context length', () => {
    const list = parseProviderModelsResponse(body);
    expect(list['abliterated-model-large-flash']).toEqual({
      rates: { prompt: 0.0000004, completion: 0.0000016, input_cache_read: 0.0000001 },
      contextLength: 1_000_000,
    });
    expect(list['abliterated-model'].rates.input_cache_read).toBeUndefined();
    expect(list['abliterated-model'].contextLength).toBe(262144);
  });
  it('tolerates a malformed body', () => {
    expect(parseProviderModelsResponse(null)).toEqual({});
    expect(parseProviderModelsResponse({ data: 'nope' })).toEqual({});
    expect(parseProviderModelsResponse({ data: [{ pricing: {} }] })).toEqual({});
  });
});

const autoProvider: ModelProvider = {
  id: 'abliteration',
  label: 'Abliteration',
  baseUrl: 'https://api.abliteration.ai',
  keychainService: 'abliteration-ai-api-key',
  pricing: 'auto',
};

describe('ProviderPricing auto with a fake server', () => {
  it('fetches once and caches within the TTL', async () => {
    let calls = 0;
    const pricing = new ProviderPricing({
      readKey: async () => 'k',
      fetchModels: async () => {
        calls++;
        return parseProviderModelsResponse(body);
      },
    });
    expect(await pricing.ratesFor(autoProvider, 'abliterated-model-large-flash')).toEqual({
      prompt: 0.0000004,
      completion: 0.0000016,
      input_cache_read: 0.0000001,
    });
    await pricing.ratesFor(autoProvider, 'abliterated-model');
    expect(calls).toBe(1);
    expect(await pricing.contextWindows(autoProvider)).toEqual({
      'abliterated-model-large-flash': 1_000_000,
      'abliterated-model': 262144,
    });
    expect(calls).toBe(1);
  });

  it('returns no rates (tokens counted) when the fetch fails', async () => {
    const pricing = new ProviderPricing({
      readKey: async () => 'k',
      fetchModels: async () => {
        throw new Error('network');
      },
    });
    expect(await pricing.ratesFor(autoProvider, 'x')).toBeUndefined();
  });

  it('a failed fetch is not retried on every launch, and concurrent ones share a call (review 2026-11-08)', async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = true;
    const pricing = new ProviderPricing({
      now: () => now,
      readKey: async () => 'k',
      fetchModels: async () => {
        calls++;
        if (fail) throw new Error('timeout');
        return parseProviderModelsResponse(body);
      },
    });
    await Promise.all([pricing.contextWindows(autoProvider), pricing.ratesFor(autoProvider, 'x')]);
    expect(calls).toBe(1);
    await pricing.ratesFor(autoProvider, 'x');
    expect(calls).toBe(1);
    // Once the failure window passes it is asked again.
    fail = false;
    now += MODELS_FAILURE_TTL_MS + 1;
    expect(await pricing.contextWindows(autoProvider)).toHaveProperty('abliterated-model', 262144);
    expect(calls).toBe(2);
  });
});

describe('fetchProviderModels', () => {
  it('gives up on a provider that never answers instead of holding the launch (review 2026-11-08)', async () => {
    const server = http.createServer(() => {
      // Accepts the request and never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      await expect(fetchProviderModels(`http://127.0.0.1:${port}`, 'k', 200)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('ProviderPricing config object', () => {
  const provider: ModelProvider = {
    id: 'p',
    label: 'P',
    baseUrl: 'https://p.example',
    keyEnv: 'P_KEY',
    pricing: {
      prompt: 0.000001,
      completion: 0.000002,
      models: { special: { prompt: 0.000005, completion: 0.000009 } },
    },
  };
  it('uses flat rates and per-model overrides, no network', async () => {
    const pricing = new ProviderPricing({
      fetchModels: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(await pricing.ratesFor(provider, 'base')).toEqual({
      prompt: 0.000001,
      completion: 0.000002,
    });
    expect(await pricing.ratesFor(provider, 'special')).toEqual({
      prompt: 0.000005,
      completion: 0.000009,
    });
  });
  it('is undefined when the provider has no pricing', async () => {
    const pricing = new ProviderPricing();
    const noPrice: ModelProvider = { ...provider, pricing: undefined };
    expect(await pricing.ratesFor(noPrice, 'base')).toBeUndefined();
  });
});

describe('taskUsdCost', () => {
  const rates: Record<string, ModelProviderRates> = {
    flash: { prompt: 0.000001, completion: 0.000002 },
    v2: { prompt: 0.000004, completion: 0.000008 },
  };
  const rateFor = async (model: string) => rates[model];

  it('bills each model at its own rate', async () => {
    const usage = {
      ...emptyUsage(),
      input: 1500,
      output: 300,
      byModel: {
        flash: { input: 1000, cacheWrite: 0, cacheRead: 0, output: 200 },
        v2: { input: 500, cacheWrite: 0, cacheRead: 0, output: 100 },
      },
    };
    // flash: 1000*1e-6 + 200*2e-6 = 0.0014 ; v2: 500*4e-6 + 100*8e-6 = 0.0028
    expect(await taskUsdCost(usage, 'flash', rateFor)).toBeCloseTo(0.0042, 10);
  });

  it('also bills tokens with no model, at the task model rate (the review fix)', async () => {
    // Total 1000 input / 200 output, but only 600/120 are attributed to a model.
    const usage = {
      ...emptyUsage(),
      input: 1000,
      output: 200,
      byModel: { v2: { input: 600, cacheWrite: 0, cacheRead: 0, output: 120 } },
    };
    // v2: 600*4e-6 + 120*8e-6 = 0.00336 ; remainder 400/80 at flash: 400*1e-6 + 80*2e-6 = 0.00056
    expect(await taskUsdCost(usage, 'flash', rateFor)).toBeCloseTo(0.00392, 10);
  });

  it('with no byModel, bills the whole total at the task model rate', async () => {
    const usage = { ...emptyUsage(), input: 1000, output: 200 };
    expect(await taskUsdCost(usage, 'flash', rateFor)).toBeCloseTo(0.0014, 10);
  });

  it('is undefined when no rate applies', async () => {
    const usage = { ...emptyUsage(), input: 1000 };
    expect(await taskUsdCost(usage, 'unknown', async () => undefined)).toBeUndefined();
  });
});

describe('usdCost', () => {
  it('bills input, output and cached reads', () => {
    const rates = { prompt: 0.000001, completion: 0.000002, input_cache_read: 0.0000001 };
    const cost = usdCost(rates, { input: 1000, output: 500, cacheRead: 2000 });
    // 1000*1e-6 + 500*2e-6 + 2000*1e-7 = 0.001 + 0.001 + 0.0002
    expect(cost).toBeCloseTo(0.0022, 10);
  });
  it('falls back cached reads to the prompt rate when none is set', () => {
    const cost = usdCost({ prompt: 0.000001 }, { cacheRead: 1000 });
    expect(cost).toBeCloseTo(0.001, 10);
  });
});
