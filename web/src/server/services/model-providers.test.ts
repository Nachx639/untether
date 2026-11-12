import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../../types/config.js';
import {
  ANTHROPIC_CREDENTIAL_VARS,
  findProvider,
  modelLabel,
  parseProviderModel,
  providerCommandArgs,
  providerDefaultModel,
  providerForBaseUrl,
  providerModelPicker,
  providerModels,
  providerSessionEnv,
  readProviderKey,
  sanitizedProviders,
} from './model-providers.js';

const ablit: ModelProvider = {
  id: 'abliteration',
  label: 'Abliteration',
  baseUrl: 'https://api.abliteration.ai',
  keychainService: 'abliteration-ai-api-key',
  defaultModel: 'abliterated-model-large-flash',
  models: [
    {
      id: 'abliterated-model-large-flash',
      label: 'Large Flash',
      alias: 'sonnet',
      contextTokens: 1_000_000,
    },
    {
      id: 'abliterated-model-large-v2',
      label: 'Large v2',
      alias: 'opus',
      contextTokens: 1_000_000,
    },
    { id: 'abliterated-model', label: 'Abliterated', alias: 'haiku', contextTokens: 262_144 },
  ],
  pricing: 'auto',
};

describe('parseProviderModel', () => {
  it('splits <providerId>:<model>', () => {
    expect(parseProviderModel('abliteration:abliterated-model-large-v2')).toEqual({
      providerId: 'abliteration',
      model: 'abliterated-model-large-v2',
    });
  });
  it('accepts a provider with no model', () => {
    expect(parseProviderModel('abliteration:')).toEqual({ providerId: 'abliteration' });
  });
  it('rejects a bare model (no colon) and an invalid id', () => {
    expect(parseProviderModel('sonnet')).toBeUndefined();
    expect(parseProviderModel('Bad Id:x')).toBeUndefined();
    expect(parseProviderModel(':x')).toBeUndefined();
  });
});

describe('provider helpers', () => {
  it('finds a provider and normalises its models', () => {
    expect(findProvider({ modelProviders: [ablit] }, 'abliteration')).toBe(ablit);
    expect(findProvider({ modelProviders: [ablit] }, 'nope')).toBeUndefined();
    const plain: ModelProvider = {
      id: 'p',
      label: 'P',
      baseUrl: 'https://p.example',
      keyEnv: 'P_KEY',
      models: ['m-one', 'm-two'],
    };
    expect(providerModels(plain)).toEqual([
      { id: 'm-one', label: 'm-one' },
      { id: 'm-two', label: 'm-two' },
    ]);
    expect(providerDefaultModel(plain)).toBe('m-one');
    expect(providerDefaultModel(ablit)).toBe('abliterated-model-large-flash');
    expect(modelLabel(ablit, 'abliterated-model-large-v2')).toBe('Large v2');
    expect(modelLabel(ablit, 'unknown')).toBe('unknown');
  });
});

describe('providerSessionEnv', () => {
  const { env, unset } = providerSessionEnv(ablit, 'abliterated-model-large-v2', 'secret-key-123');

  it('points Claude Code at the provider with the key in ANTHROPIC_AUTH_TOKEN', () => {
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.abliteration.ai');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('secret-key-123');
    expect(env.ANTHROPIC_MODEL).toBe('abliterated-model-large-v2');
    expect(env.ANTHROPIC_DEFAULT_MODEL).toBe('abliterated-model-large-v2');
  });

  it('removes the user own Anthropic credentials', () => {
    expect(unset).toEqual([...ANTHROPIC_CREDENTIAL_VARS]);
    expect(unset).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(unset).toContain('ANTHROPIC_API_KEY');
  });

  it('remaps the sonnet/opus/haiku aliases onto provider models, never Anthropic ones', () => {
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('abliterated-model-large-flash');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('abliterated-model-large-v2');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('abliterated-model');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('Large Flash');
    // The internal small/fast model is a provider model, never Anthropic's Haiku.
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('abliterated-model');
    for (const value of Object.values(env)) {
      expect(value.toLowerCase()).not.toContain('claude-');
    }
  });

  it('sets the real context window of the chosen model', () => {
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
    const small = providerSessionEnv(ablit, 'abliterated-model', 'k');
    expect(small.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('262144');
  });

  it('never puts the key on any model/display variable', () => {
    for (const [name, value] of Object.entries(env)) {
      if (name === 'ANTHROPIC_AUTH_TOKEN') continue;
      expect(value).not.toContain('secret-key-123');
    }
  });

  it('fails loudly instead of building a session that would fall back to the Anthropic API', () => {
    expect(() => providerSessionEnv({ ...ablit, baseUrl: '' }, 'm', 'k')).toThrow(
      /baseUrl is empty/
    );
    expect(() => providerSessionEnv({ ...ablit, baseUrl: '   ' }, 'm', 'k')).toThrow(
      /baseUrl is empty/
    );
    expect(() => providerSessionEnv(ablit, '  ', 'k')).toThrow(/no model to run/);
  });

  it('falls back to the chosen model when a provider lists no aliases', () => {
    const plain: ModelProvider = {
      id: 'p',
      label: 'P',
      baseUrl: 'https://p.example',
      keyEnv: 'P_KEY',
      models: ['only-model'],
    };
    const { env: e } = providerSessionEnv(plain, 'only-model', 'k');
    expect(e.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('only-model');
    expect(e.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('only-model');
    expect(e.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('only-model');
    expect(e.ANTHROPIC_SMALL_FAST_MODEL).toBe('only-model');
  });
});

describe('providerModelPicker', () => {
  it('lists only the provider models and replaces the built-ins', () => {
    const picker = providerModelPicker(ablit, { model: 'abliterated-model-large-v2' });
    expect(picker?.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(picker?.modelPicker.options.map((o) => o.model)).toEqual([
      'abliterated-model-large-flash',
      'abliterated-model-large-v2',
      'abliterated-model',
    ]);
    expect(picker?.model).toBe('abliterated-model-large-v2');
  });

  it('uses extraModels (from /v1/models) when the provider lists none', () => {
    const bare: ModelProvider = {
      id: 'p',
      label: 'P',
      baseUrl: 'https://p.example',
      keyEnv: 'P_KEY',
    };
    expect(providerModelPicker(bare)).toBeUndefined();
    const picker = providerModelPicker(bare, { extraModels: ['x', 'y'] });
    expect(picker?.modelPicker.options.map((o) => o.model)).toEqual(['x', 'y']);
  });
});

describe('providerCommandArgs', () => {
  it('inserts --model and --settings after a plain claude', () => {
    expect(providerCommandArgs(['claude'], 'm', '/s.json')).toEqual([
      'claude',
      '--model',
      'm',
      '--settings',
      '/s.json',
    ]);
    expect(providerCommandArgs(['claude', '--resume', 'abc'], 'm')).toEqual([
      'claude',
      '--model',
      'm',
      '--resume',
      'abc',
    ]);
  });
  it('keeps an existing --model/--settings and a leading env prefix', () => {
    expect(providerCommandArgs(['claude', '--model', 'x'], 'm')).toEqual([
      'claude',
      '--model',
      'x',
    ]);
    expect(providerCommandArgs(['env', 'FOO=1', 'claude'], 'm')).toEqual([
      'env',
      'FOO=1',
      'claude',
      '--model',
      'm',
    ]);
  });
  it('leaves a non-claude command alone', () => {
    expect(providerCommandArgs(['codex'], 'm', '/s')).toEqual(['codex']);
    expect(providerCommandArgs(['bash', '-c', 'claude'], 'm')).toEqual(['bash', '-c', 'claude']);
  });
});

describe('sanitizedProviders', () => {
  it('drops the key and base URL, keeps what the UI needs', () => {
    const list = sanitizedProviders({ modelProviders: [ablit] });
    expect(list).toHaveLength(1);
    const [p] = list;
    expect(p).toMatchObject({ id: 'abliteration', label: 'Abliteration', priced: true });
    expect(p.defaultModel).toBe('abliterated-model-large-flash');
    expect(p.models.map((m) => m.id)).toContain('abliterated-model-large-v2');
    // Never any key or base URL.
    expect(JSON.stringify(p)).not.toContain('abliteration-ai-api-key');
    expect(JSON.stringify(p)).not.toContain('https://');
    expect('keychainService' in p).toBe(false);
    expect('baseUrl' in p).toBe(false);
  });
  it('is empty with no providers', () => {
    expect(sanitizedProviders(undefined)).toEqual([]);
    expect(sanitizedProviders({})).toEqual([]);
  });
});

describe('readProviderKey', () => {
  it('reads from a server environment variable (keyEnv)', async () => {
    const provider: ModelProvider = {
      id: 'p',
      label: 'P',
      baseUrl: 'https://p.example',
      keyEnv: 'TEST_PROVIDER_KEY',
    };
    await expect(readProviderKey(provider, { TEST_PROVIDER_KEY: '  k-1 ' })).resolves.toBe('k-1');
    await expect(readProviderKey(provider, {})).rejects.toThrow(/TEST_PROVIDER_KEY/);
  });
});

describe('provider icon and host', () => {
  it('sends the icon to the client only when configured', () => {
    const [plain, marked] = sanitizedProviders({
      modelProviders: [ablit, { ...ablit, id: 'other', icon: '🦊' }],
    });
    expect(plain).not.toHaveProperty('icon');
    expect(marked.icon).toBe('🦊');
  });

  const config = { modelProviders: [ablit] };

  it.each([
    'https://api.abliteration.ai',
    'https://api.abliteration.ai/',
    'https://API.abliteration.ai/v1',
    'http://api.abliteration.ai',
  ])('finds the provider of %s by its host', (url) => {
    expect(providerForBaseUrl(config, url)?.id).toBe('abliteration');
  });

  it.each([
    'https://api.anthropic.com',
    'https://evil.api.abliteration.ai',
    'https://api.abliteration.ai:8443',
    'not a url',
    '',
  ])('finds none for %j', (url) => {
    expect(providerForBaseUrl(config, url)).toBeUndefined();
  });

  it('finds none without providers', () => {
    expect(providerForBaseUrl(undefined, 'https://api.abliteration.ai')).toBeUndefined();
  });
});
