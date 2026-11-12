/**
 * 2026-11-08: every Claude task ran for days on claude-opus-4-8 (a `claude` without --model on
 * the account's default) while claude-opus-5-5 was out. The real model is read and the doctor
 * warns when it is not the one asked for, or older than the newest of its family seen here.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelMatches, parseClaudeModel, streamEventModel } from '../../shared/agent-models.js';
import type { ClaudeStartSettings } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { askClaudeOnce, type ClaudeChild } from './claude-oneshot.js';
import {
  claudePidOfConversation,
  claudeSettingsModel,
  claudeStartSettings,
  isAnthropicEndpoint,
  lastTranscriptModel,
  type ModelUse,
  modelFlag,
  modelObservations,
  parsePsLaunch,
  recentTranscriptModels,
  sessionModelChanged,
  tailLines,
  transcriptModelChanged,
  unexpectedModelsCheck,
} from './model-observations.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const AT = '2026-11-08T11:00:00.000Z';

const run = async (uses: ModelUse[], seen: Array<{ model: string; at?: string }> = []) =>
  unexpectedModelsCheck({ uses: () => uses, seen: () => seen, now: () => NOW }).run();

describe('model ids', () => {
  it('parses families and versions, matches aliases and dated releases', () => {
    expect(parseClaudeModel('claude-opus-4-8')).toEqual({ family: 'opus', version: [4, 8] });
    expect(parseClaudeModel('claude-haiku-4-5-20251001')).toEqual({
      family: 'haiku',
      version: [4, 5],
    });
    expect(parseClaudeModel('claude-3-5-sonnet-20241022')).toEqual({
      family: 'sonnet',
      version: [3, 5],
    });
    expect(parseClaudeModel('gpt-6-astra')).toBeUndefined();
    expect(modelMatches('opus', 'claude-opus-4-8')).toBe(true);
    expect(modelMatches('sonnet', 'claude-opus-4-8')).toBe(false);
    expect(modelMatches('claude-opus-5-5', 'claude-opus-4-8')).toBe(false);
    expect(modelMatches('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true);
    expect(modelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(true);
    // Only a release date may follow: another version is another model.
    expect(modelMatches('claude-opus-4', 'claude-opus-4-8')).toBe(false);
    expect(modelMatches('claude-opus-4-8', 'claude-opus-4')).toBe(false);
    expect(modelMatches('claude-haiku-4-5-20251001', 'claude-haiku-4-5')).toBe(true);
  });

  it('reads the model of stream-json events, the transcript tail and --model', () => {
    expect(
      streamEventModel({
        type: 'stream_event',
        event: { type: 'message_start', message: { model: 'claude-haiku-5-5' } },
      })
    ).toBe('claude-haiku-5-5');
    expect(
      streamEventModel({ type: 'assistant', message: { model: '<synthetic>' } })
    ).toBeUndefined();
    expect(streamEventModel({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' })).toBe(
      'claude-sonnet-5-5'
    );
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: AT, message: { model: 'claude-opus-4-8' } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
      '{"type":"user","message":{"content":"hi"}}',
      '{"cut',
    ];
    expect(lastTranscriptModel(lines)).toEqual({ model: 'claude-opus-4-8', at: AT });
    expect(modelFlag(['claude', '--model', 'opus'])).toBe('opus');
    expect(modelFlag('claude --model=claude-opus-5-5 -c')).toBe('claude-opus-5-5');
    expect(modelFlag(['claude'])).toBeUndefined();
  });
});

describe('claude -p records its real model', () => {
  afterEach(() => modelObservations.clear());

  it('askClaudeOnce records the model its stream named under its purpose', async () => {
    const { EventEmitter } = await import('events');
    const { PassThrough } = await import('stream');
    const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-models-'));
    const tokenFile = path.join(tokenDir, 'token');
    fs.writeFileSync(tokenFile, 'x');
    let args: string[] = [];
    const reply = await askClaudeOnce(
      {
        timeoutMs: 5000,
        claudeBin: '/bin/claude',
        tokenFile,
        purpose: 'task review',
        model: 'claude-sonnet-5-5',
        spawn: (_bin, argv) => {
          args = argv;
          const child = new EventEmitter() as unknown as ClaudeChild & EventEmitter;
          const stdout = new PassThrough();
          Object.assign(child, { stdout, kill: () => true });
          setImmediate(() => {
            stdout.write(
              `${JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } })}\n`
            );
            stdout.write(`${JSON.stringify({ type: 'result', result: 'ok' })}\n`);
            stdout.end();
            child.emit('close', 0);
          });
          return child;
        },
      },
      'system',
      'question'
    );
    fs.rmSync(tokenDir, RM_TEST_DIR);
    expect(reply).toBe('ok');
    expect(args).toContain('claude-sonnet-5-5');
    expect(modelObservations.list()).toEqual([
      expect.objectContaining({
        label: 'task review',
        requested: 'claude-sonnet-5-5',
        actual: 'claude-sonnet-4-6',
      }),
    ]);
    expect((await run(modelObservations.list()))[0].problem).toContain(
      'task review ran with claude-sonnet-4-6 (asked for claude-sonnet-5-5 (--model))'
    );
  });
});

describe('unexpected models (doctor)', () => {
  it('warns when the real model is not the configured one', async () => {
    const findings = await run([
      {
        label: 'task "a" (t1)',
        requested: 'claude-opus-5-5',
        requestedFrom: '"model" in ~/.claude/settings.json',
        actual: 'claude-opus-4-8',
        at: AT,
      },
      {
        label: 'task "b" (t2)',
        requested: 'claude-opus-5-5',
        requestedFrom: '"model" in ~/.claude/settings.json',
        actual: 'claude-opus-4-8',
        at: AT,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('unexpected-model');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].problem).toContain('task "a" (t1), task "b" (t2) ran with claude-opus-4-8');
    expect(findings[0].problem).toContain('asked for claude-opus-5-5');
    expect(findings[0].problem).toContain('~/.claude/settings.json');
  });

  it('warns, with nothing configured, when it is older than the newest of its family seen', async () => {
    const findings = await run(
      [{ label: 'task "a" (t1)', actual: 'claude-opus-4-8', at: AT }],
      [
        { model: 'claude-opus-5-5', at: AT },
        { model: 'claude-sonnet-5-5', at: AT },
      ]
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('unexpected-model:default:claude-opus-4-8');
    expect(findings[0].problem).toContain(
      'nothing configured, while claude-opus-5-5 is the newest opus'
    );
    // An alias asks for the newest too.
    const alias = await run(
      [{ label: 'copilot', requested: 'opus', actual: 'claude-opus-4-8', at: AT }],
      [{ model: 'claude-opus-5-5', at: AT }]
    );
    expect(alias).toHaveLength(1);
  });

  it('says nothing when the model is the asked one, the newest, or a newer one was seen long ago', async () => {
    expect(
      await run(
        [
          {
            label: 'task review',
            requested: 'claude-sonnet-5-5',
            actual: 'claude-sonnet-5-5',
            at: AT,
          },
          // A concrete old model asked for and got: the user's choice.
          {
            label: 'task "old" (t3)',
            requested: 'claude-opus-4-8',
            actual: 'claude-opus-4-8',
            at: AT,
          },
          { label: 'task "a" (t1)', actual: 'claude-opus-5-5', at: AT },
          { label: 'task "codex" (t4)', requested: 'gpt-6-astra', actual: 'gpt-6-astra', at: AT },
        ],
        [{ model: 'claude-opus-5-5', at: AT }]
      )
    ).toEqual([]);
    expect(
      await run(
        [{ label: 'task "a" (t1)', actual: 'claude-opus-4-8', at: AT }],
        [{ model: 'claude-opus-5-5', at: '2026-10-01T00:00:00.000Z' }]
      )
    ).toEqual([]);
  });

  it('keeps a run on an unexpected model after later runs got the right one (2026-11-08 review)', async () => {
    modelObservations.record('task review', 'claude-sonnet-5-5', 'claude-sonnet-4-6', NOW - 3000);
    modelObservations.record('task review', 'claude-sonnet-5-5', 'claude-sonnet-5-5', NOW - 2000);
    modelObservations.record('task review', 'claude-sonnet-5-5', 'claude-sonnet-5-5', NOW - 1000);
    expect(modelObservations.list().map((use) => [use.label, use.actual])).toEqual([
      ['task review', 'claude-sonnet-4-6'],
      [`task review (2 runs, last ${new Date(NOW - 1000).toISOString()})`, 'claude-sonnet-5-5'],
    ]);
    const findings = await run(modelObservations.list());
    modelObservations.clear();
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toContain('task review ran with claude-sonnet-4-6');
  });

  it('takes the records of claude -p runs', async () => {
    modelObservations.record('task router', 'claude-haiku-5-5', 'claude-haiku-4-5', NOW - 1000);
    const findings = await run(modelObservations.list());
    modelObservations.clear();
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toContain('task router ran with claude-haiku-4-5');
    expect(findings[0].problem).toContain('asked for claude-haiku-5-5 (--model)');
  });
});

describe('models of another endpoint (2026-11-08 false warning)', () => {
  const settings = '"model" in ~/.claude/settings.json';
  const ablit = (extra: Partial<ModelUse> = {}): ModelUse => ({
    label: 'session "zsh (~/Projects)" (s1)',
    requested: 'claude-opus-5-5',
    requestedFrom: settings,
    actual: 'abliterated-model-large-flash',
    at: AT,
    ...extra,
  });
  const check = (uses: ModelUse[], providerModels: string[] = []) =>
    unexpectedModelsCheck({
      uses: () => uses,
      seen: () => [{ model: 'claude-opus-5-5', at: AT }],
      providerModels: () => providerModels,
      now: () => NOW,
    }).run();

  it('says nothing for a session on a provider, its endpoint, or a model Anthropic never names', async () => {
    // The real incident: claude-ablit in a zsh session, settings.json asks for claude-opus-5-5.
    expect(await check([ablit()])).toEqual([]);
    expect(await check([ablit({ endpoint: 'https://api.abliteration.ai' })])).toEqual([]);
    // A configured provider's model, also when what was asked is another of its models.
    expect(
      await check(
        [ablit({ requested: 'abliterated-model-small', requestedFrom: 'ANTHROPIC_MODEL' })],
        ['Abliterated-Model-Large-Flash']
      )
    ).toEqual([]);
    // Another endpoint serving claude-* names (a proxy): not Anthropic's default either.
    expect(
      await check([ablit({ actual: 'claude-opus-4-8', endpoint: 'https://openrouter.ai/api' })])
    ).toEqual([]);
    // The model the session asked for itself, even an old one.
    expect(
      await check([
        ablit({
          requested: 'claude-opus-4-8',
          requestedFrom: '--model',
          actual: 'claude-opus-4-8',
        }),
      ])
    ).toEqual([]);
  });

  it('still warns for an Anthropic model other or older than the asked one', async () => {
    const other = await check(
      [ablit({ actual: 'claude-opus-4-8', endpoint: 'https://api.anthropic.com' })],
      ['abliterated-model-large-flash', 'claude-opus-4-8']
    );
    expect(other).toHaveLength(1);
    expect(other[0].problem).toContain('ran with claude-opus-4-8 (asked for claude-opus-5-5');
    const older = await check([
      ablit({ requested: 'opus', requestedFrom: '--model', actual: 'claude-opus-4-8' }),
    ]);
    expect(older).toHaveLength(1);
    expect(older[0].problem).toContain('while claude-opus-5-5 is the newest opus');
    // A Codex task on the wrong model is still told (not a Claude request).
    expect(
      await check([{ label: 'task "c" (t5)', requested: 'gpt-6-astra', actual: 'gpt-5-9', at: AT }])
    ).toHaveLength(1);
  });

  it('reads the endpoint and the env model of a session', () => {
    expect(isAnthropicEndpoint(undefined)).toBe(true);
    expect(isAnthropicEndpoint('https://api.anthropic.com/')).toBe(true);
    expect(isAnthropicEndpoint('https://api.abliteration.ai')).toBe(false);
    expect(isAnthropicEndpoint('provider:ablit')).toBe(false);
    const args = 'claude --model claude-opus-4-8 -c';
    expect(
      parsePsLaunch(
        args,
        `${args} TERM=xterm ANTHROPIC_BASE_URL=https://api.abliteration.ai ` +
          'ANTHROPIC_AUTH_TOKEN=redacted ANTHROPIC_MODEL=abliterated-model-large-flash HOME=/x'
      )
    ).toEqual({
      baseUrl: 'https://api.abliteration.ai',
      model: 'abliterated-model-large-flash',
      flag: 'claude-opus-4-8',
    });
    // A command line naming the variable is not the environment.
    const env = 'env ANTHROPIC_MODEL=claude-opus-4-8 claude';
    expect(parsePsLaunch(env, `${env} TERM=xterm`)).toEqual({});
    expect(parsePsLaunch('claude', 'claude TERM=xterm')).toEqual({});
  });

  it('finds the running claude of a conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-models-'));
    try {
      fs.mkdirSync(path.join(dir, 'sessions'));
      fs.writeFileSync(
        path.join(dir, 'sessions', '41.json'),
        JSON.stringify({ pid: 41, sessionId: 'conv-a' })
      );
      fs.writeFileSync(
        path.join(dir, 'sessions', '42.json'),
        JSON.stringify({ pid: 42, sessionId: 'conv-b' })
      );
      fs.writeFileSync(path.join(dir, 'sessions', '42.abc.key'), 'x');
      const alive = (pid: number) => pid === 42;
      expect(claudePidOfConversation(dir, 'conv-b', alive)).toBe(42);
      expect(claudePidOfConversation(dir, 'conv-a', alive)).toBeUndefined();
      expect(claudePidOfConversation(dir, 'conv-z', alive)).toBeUndefined();
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});

describe('the model asked when the session started (2026-11-09 false warnings)', () => {
  let dir: string;
  let file: string;
  const settings = '"model" in ~/.claude/settings.json';
  const turn = (model: string, extra: object = {}) =>
    `${JSON.stringify({ type: 'assistant', timestamp: AT, message: { model }, ...extra })}\n`;
  const reply = (text: string) =>
    `${JSON.stringify({
      type: 'user',
      message: { content: `<local-command-stdout>${text}</local-command-stdout>` },
    })}\n`;
  const fableReply = reply('Set model to `Fable 5.2` and saved as your default for new sessions');
  const session = (requested: string | undefined, actual: string): ModelUse => ({
    label: 'session "a" (s1)',
    ...(requested ? { requested, requestedFrom: settings } : {}),
    actual,
    at: AT,
  });
  const saveSettings = (model: string) =>
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-models-'));
    file = path.join(dir, 'conv.jsonl');
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('(a) keeps what settings said at the start when /model elsewhere rewrites it', async () => {
    saveSettings('claude-opus-5-5');
    const start = claudeStartSettings(dir, undefined);
    expect(start).toEqual({ model: 'claude-opus-5-5' });
    // /model in another session saves fable as the default.
    saveSettings('fable');
    expect(start.model).toBe('claude-opus-5-5');
    expect(await run([session(start.model, 'claude-opus-5-5')])).toEqual([]);
    // Against today's value it would have warned: this is what the snapshot prevents.
    expect(await run([session(claudeSettingsModel(dir), 'claude-opus-5-5')])).toHaveLength(1);
  });

  it('keeps the snapshot across a /clear in the same claude, a new claude takes a new one', () => {
    fs.mkdirSync(path.join(dir, 'sessions'));
    const claudeOn = (pid: number, conv: string) =>
      fs.writeFileSync(
        path.join(dir, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId: conv })
      );
    const alive = () => true;
    saveSettings('claude-opus-5-5');
    claudeOn(41, 'conv-a');
    const first = claudeStartSettings(dir, 'conv-a', undefined, alive);
    expect(first).toEqual({ pid: 41, model: 'claude-opus-5-5', conversations: ['conv-a'] });
    saveSettings('fable');
    claudeOn(41, 'conv-b');
    expect(claudeStartSettings(dir, 'conv-b', first, alive)).toEqual({
      ...first,
      conversations: ['conv-a', 'conv-b'],
    });
    fs.rmSync(path.join(dir, 'sessions', '41.json'));
    claudeOn(42, 'conv-c');
    expect(claudeStartSettings(dir, 'conv-c', first, alive)).toEqual({
      pid: 42,
      model: 'fable',
      conversations: ['conv-c'],
    });
  });

  it('keeps every conversation of one claude, without repeats, however many /clear (2026-11-09 review)', async () => {
    fs.mkdirSync(path.join(dir, 'sessions'));
    const alive = () => true;
    const bind = (conv: string, previous?: ClaudeStartSettings) => {
      fs.writeFileSync(
        path.join(dir, 'sessions', '41.json'),
        JSON.stringify({ pid: 41, sessionId: conv })
      );
      return claudeStartSettings(dir, conv, previous, alive);
    };
    saveSettings('claude-opus-5-5');
    let start = bind('with-model-change');
    for (let i = 0; i < 30; i++) start = bind(`clear-${i}`, start);
    start = bind('clear-3', start);
    expect(start.conversations).toHaveLength(31);
    expect(start.conversations?.[0]).toBe('with-model-change');
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(file, turn('claude-opus-5-5') + fableReply);
    fs.writeFileSync(other, turn('claude-fable-5-2'));
    expect(
      await sessionModelChanged(
        { claudeSessionId: 'clear-29', claudeStartSettings: start },
        (id) => (id === 'with-model-change' ? file : other)
      )
    ).toBe(true);
  });

  it('is the same claude only on proof: same pid, the kept one alive, or its own spawn', () => {
    saveSettings('fable');
    const kept = { pid: 41, model: 'claude-opus-5-5', conversations: ['a'] };
    // No sessions/<pid>.json readable for conv b.
    expect(claudeStartSettings(dir, 'b', kept, () => true)).toEqual({
      ...kept,
      conversations: ['a', 'b'],
    });
    expect(claudeStartSettings(dir, 'b', kept, () => false)).toEqual({
      model: 'fable',
      conversations: ['b'],
    });
    // Taken when `claude --resume a` was spawned: the first pid seen is that claude's.
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(
      path.join(dir, 'sessions', '50.json'),
      JSON.stringify({ pid: 50, sessionId: 'b' })
    );
    const spawned = { spawned: true, model: 'claude-opus-5-5', conversations: ['a'] };
    expect(claudeStartSettings(dir, 'b', spawned, () => true)).toEqual({
      pid: 50,
      model: 'claude-opus-5-5',
      conversations: ['a', 'b'],
    });
    // A pid that could not be read proves no continuity: another claude starts afresh.
    expect(
      claudeStartSettings(dir, 'b', { model: 'claude-opus-5-5', conversations: ['a'] }, () => true)
    ).toEqual({ pid: 50, model: 'fable', conversations: ['b'] });
    expect(
      claudeStartSettings(dir, 'c', { model: 'claude-opus-5-5', conversations: ['a'] }, () => true)
    ).toEqual({ model: 'fable', conversations: ['c'] });
  });

  it('a /model, then a /clear: the earlier conversation of that claude shows the change', async () => {
    const other = path.join(dir, 'after-clear.jsonl');
    fs.writeFileSync(file, turn('claude-opus-5-5') + fableReply + turn('claude-fable-5-2'));
    fs.writeFileSync(other, turn('claude-fable-5-2'));
    const files: Record<string, string> = { before: file, after: other };
    expect(await transcriptModelChanged(other)).toBe(false);
    const start = { pid: 41, model: 'claude-opus-5-5', conversations: ['before', 'after'] };
    expect(
      await sessionModelChanged(
        { claudeSessionId: 'after', claudeStartSettings: start },
        (id) => files[id]
      )
    ).toBe(true);
    // Without the earlier conversation there is no evidence of a change.
    expect(
      await sessionModelChanged(
        { claudeSessionId: 'after', claudeStartSettings: { model: 'claude-opus-5-5' } },
        (id) => files[id]
      )
    ).toBe(false);
  });

  it('(b) sees a /model reply, labels included, anywhere in a long transcript', async () => {
    const filler = turn('claude-sonnet-5-5').replace('}}', `,"text":"${'ñ'.repeat(4000)}"}}`);
    fs.writeFileSync(file, fableReply + filler.repeat(800));
    expect(tailLines(file, 64 * 1024).some((line) => line.includes('Set model to'))).toBe(false);
    expect(await transcriptModelChanged(file)).toBe(true);
    // Only what is new is read, and a shorter file is read again.
    fs.writeFileSync(file, turn('claude-sonnet-5-5'));
    expect(await transcriptModelChanged(file)).toBe(false);
    fs.appendFileSync(file, fableReply);
    expect(await transcriptModelChanged(file)).toBe(true);
  });

  it('(b) a message or a tool result quoting the reply changes nothing', async () => {
    const quoted = `<local-command-stdout>Set model to \`Fable 5.2\`</local-command-stdout>`;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { content: `Look: ${quoted}` } })}\n` +
        `${JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: quoted }] },
        })}\n` +
        turn('claude-sonnet-5-5')
    );
    expect(await transcriptModelChanged(file)).toBe(false);
  });

  it('(b) two turns on different models are a change; a subagent or a dated id is not', async () => {
    fs.writeFileSync(
      file,
      turn('claude-sonnet-5-5') + turn('claude-haiku-5-5', { isSidechain: true })
    );
    expect(await transcriptModelChanged(file)).toBe(false);
    fs.appendFileSync(file, turn('claude-sonnet-5-5-20261101') + turn('<synthetic>'));
    expect(await transcriptModelChanged(file)).toBe(false);
    fs.appendFileSync(file, turn('claude-fable-5-2'));
    expect(await transcriptModelChanged(file)).toBe(true);
    expect(
      lastTranscriptModel([
        turn('claude-opus-5-5'),
        turn('claude-haiku-5-5', { isSidechain: true }),
      ])
    ).toEqual({ model: 'claude-opus-5-5', at: AT });
  });

  it('(c) resolves aliases before comparing', async () => {
    const newest = [{ model: 'claude-fable-5-2', at: AT }];
    expect(await run([session('fable', 'claude-fable-5-2')], newest)).toEqual([]);
    expect(await run([session('Fable[1m]', 'claude-fable-5-2')], newest)).toEqual([]);
    expect(await run([session('opus', 'claude-opus-5-5')])).toEqual([]);
    expect(await run([session('sonnet', 'claude-sonnet-5-5')])).toEqual([]);
    expect(await run([session('haiku', 'claude-haiku-5-5')])).toEqual([]);
    // opusplan is Opus in plan mode and Sonnet otherwise; default names no model.
    expect(await run([session('opusplan', 'claude-sonnet-5-5')])).toEqual([]);
    expect(await run([session('default', 'claude-opus-5-5')])).toEqual([]);
    saveSettings('default');
    expect(claudeSettingsModel(dir)).toBeUndefined();
    // An alias of another family is still a different model.
    expect(await run([session('fable', 'claude-opus-5-5')])).toHaveLength(1);
  });

  it('(real) warns when X was asked at the start and Y ran from the first turn', async () => {
    saveSettings('claude-opus-5-5');
    const start = claudeStartSettings(dir, undefined);
    fs.writeFileSync(file, turn('claude-opus-4-8') + turn('claude-opus-4-8'));
    expect(await transcriptModelChanged(file)).toBe(false);
    const findings = await run([session(start.model, 'claude-opus-4-8')]);
    expect(findings).toHaveLength(1);
    expect(findings[0].problem).toContain('ran with claude-opus-4-8 (asked for claude-opus-5-5');
    // Another session saving what ran as the default removes no warning (2026-11-09 review).
    saveSettings('claude-opus-4-8');
    expect(await run([session(start.model, 'claude-opus-4-8')])).toHaveLength(1);
    // Same with --model and with an alias asked.
    expect(await run([session('claude-sonnet-5-5', 'claude-opus-5-5')])).toHaveLength(1);
    expect(await run([session('sonnet', 'claude-opus-5-5')])).toHaveLength(1);
  });
});

describe('models on this Mac', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-models-'));
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('reads the settings model and the recent transcripts’ models', () => {
    expect(claudeSettingsModel(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5' }));
    expect(claudeSettingsModel(dir)).toBe('claude-opus-5-5');
    const project = path.join(dir, 'projects', '-x');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, 's1.jsonl'),
      `${JSON.stringify({ type: 'assistant', timestamp: AT, message: { model: 'claude-opus-5-5' } })}\n`
    );
    expect(recentTranscriptModels(dir)).toEqual([{ model: 'claude-opus-5-5', at: AT }]);
    expect(recentTranscriptModels(dir, Date.now() + 10 * 24 * 3600 * 1000)).toEqual([]);
  });
});
