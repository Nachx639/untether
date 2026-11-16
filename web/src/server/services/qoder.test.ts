import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { AgentEventService } from './agent-event-service.js';
import { withClaudeHooks } from './claude-hooks.js';
import { parseQoderTranscript, readQoderChat } from './qoder-chat.js';
import { ensureQoderHookFiles, qoderAgentStatus, qoderSightings } from './qoder-hooks.js';
import { askQoderOnce } from './qoder-oneshot.js';
import { quickStartArgv } from './task-commands-shared.js';
import { modelForLevel, QODER_NO_PROJECT_MCP, taskCommand } from './task-launcher.js';

describe('Qoder installed CLI contract (all executables are doubles)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-qoder-'));
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  it('launches the PATH double with task permissions and selected model, retaining its config dir', () => {
    const bin = path.join(dir, 'qodercli');
    fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const command = taskCommand({
      agent: 'qoder',
      command: [
        ...quickStartArgv(undefined, 'qoder'),
        '--config-dir',
        dir,
        '-m',
        'ultimate',
        '--permission-mode',
        'default',
      ],
      model: modelForLevel(undefined, 'qoder', 'fast'),
      isolation: 'worktree',
    });
    const argv = execFileSync(command[0], command.slice(1), {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(argv).toEqual([
      ...QODER_NO_PROJECT_MCP,
      '--permission-mode',
      'bypass_permissions',
      '--config-dir',
      dir,
      '-m',
      'efficient',
    ]);
    expect(modelForLevel({ qoder: { capable: 'performance' } }, 'qoder', 'capable')).toBe(
      'performance'
    );
    // Capable keeps Qoder's own default (Auto), and the model a quick start names.
    expect(modelForLevel(undefined, 'qoder', 'capable')).toBeUndefined();
  });

  it('feeds real hook mailboxes into working, needs-user, turn-end and usage pause states', () => {
    const files = ensureQoderHookFiles(dir)!;
    const bindings: unknown[] = [];
    const service = new AgentEventService({
      eventsDir: files.eventsDir,
      onQoderSession: (_id, binding) => bindings.push(binding),
    });
    const send = (event: string, extra = {}) => {
      execFileSync(files.script, [event], {
        env: { PATH: '/usr/bin:/bin', UNTETHER_SESSION_ID: 'session' },
        input: JSON.stringify({
          session_id: 'q1',
          transcript_path: path.join(dir, 'q1.jsonl'),
          hook_event_name: event,
          ...extra,
        }),
      });
      return service.snapshot('session');
    };
    expect(send('SessionStart')?.state).toBe('starting');
    expect(send('UserPromptSubmit')?.state).toBe('working');
    expect(
      send('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'echo safe' } })?.state
    ).toBe('permission');
    expect(send('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask' })?.state).toBe(
      'question'
    );
    send('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask' });
    expect(send('Stop', { last_assistant_message: 'Done' })?.state).toBe('turn-ended');
    const halt = send('StopFailure', {
      error_type: 'rate_limit',
      error: 'Usage limit reached. Try again in 2 hours.',
    });
    expect(halt).toMatchObject({
      source: 'qoder-hook',
      state: 'halted',
      halt: { kind: 'usage-limit' },
    });
    expect(halt?.halt?.resumeAt).toBeGreaterThan(Date.now());
    // The same state in the list's words and for the notifier's pushes.
    expect(qoderAgentStatus(halt)).toMatchObject({
      agent: 'qoder',
      status: 'idle',
      halted: 'usage-limit',
    });
    expect(
      qoderSightings([{ id: 'session' }, { id: 'other' }], {
        snapshot: (id) => service.snapshot(id),
        title: () => 'Build a duck',
      })
    ).toEqual(
      new Map([
        [
          'session',
          {
            agent: 'qoder',
            program: 'q1',
            status: expect.objectContaining({
              status: 'idle',
              title: 'Build a duck',
              sessionId: 'q1',
            }),
          },
        ],
      ])
    );
    service.flush(true);
    const restarted = new AgentEventService({ eventsDir: files.eventsDir });
    expect(restarted.snapshot('session')?.state).toBe('halted');
    expect(bindings[0]).toEqual({ id: 'q1', transcriptPath: path.join(dir, 'q1.jsonl') });
  });

  it('injects per-launch hooks into plain, shell-wrapped and env commands', () => {
    const settings = ensureQoderHookFiles(dir)!.settings;
    expect(withClaudeHooks(['qodercli', '-c'], settings, 'qodercli')).toEqual([
      'qodercli',
      '--settings',
      settings,
      '-c',
    ]);
    expect(
      withClaudeHooks(['env', 'QODER_CONFIG_DIR=/tmp/custom', 'qodercli'], settings, 'qodercli')
    ).toEqual(['env', 'QODER_CONFIG_DIR=/tmp/custom', 'qodercli', '--settings', settings]);
    expect(
      withClaudeHooks(['zsh', '-ilc', 'qodercli "$@"', '--'], settings, 'qodercli')[2]
    ).toContain('--settings');
    const ordinary = ['echo', 'qodercli'];
    expect(withClaudeHooks(ordinary, settings, 'qodercli')).toBe(ordinary);
  });

  it('reads only the hooked session and active branch, joins tool results, tolerates a partial line', () => {
    const row = (o: object) => JSON.stringify({ sessionId: 'q1', ...o });
    const raw = [
      row({ type: 'user', uuid: 'u', message: { content: 'Build a duck' } }),
      row({
        type: 'assistant',
        uuid: 'old',
        parentUuid: 'u',
        message: { content: 'Abandoned branch' },
      }),
      row({
        type: 'assistant',
        uuid: 'a',
        parentUuid: 'u',
        message: {
          content: [
            { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'echo duck' } },
          ],
        },
      }),
      row({
        type: 'user',
        uuid: 'r',
        parentUuid: 'a',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'duck' }] },
      }),
      row({ type: 'assistant', uuid: 'f', parentUuid: 'r', message: { content: 'Finished duck' } }),
      row({ type: 'active-leaf', leafUuid: 'f' }),
      row({
        type: 'assistant',
        uuid: 'foreign',
        sessionId: 'other',
        message: { content: 'Private' },
      }),
      '{"type":',
    ].join('\n');
    const chat = parseQoderTranscript(raw, 'q1');
    expect(chat.messages.map((m) => m.text)).toEqual([
      'Build a duck',
      'echo duck',
      'Finished duck',
    ]);
    expect(chat.messages[1].result).toBe('duck');
    const file = path.join(dir, 'q1.jsonl');
    fs.writeFileSync(file, raw);
    expect(readQoderChat({ qoderSession: { id: 'q1', transcriptPath: file } })).toEqual(chat);
    expect(readQoderChat({}).messages).toEqual([]);
  });

  it('uses a headless double for review with no tools and returns null on failure', async () => {
    const bin = path.join(dir, 'qodercli');
    fs.writeFileSync(
      bin,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/args"\nprintf \'{"verdict":"ok"}\\n\'\n',
      { mode: 0o700 }
    );
    expect(await askQoderOnce('Review the supplied diff', { bin, cwd: dir, timeoutMs: 2000 })).toBe(
      '{"verdict":"ok"}'
    );
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    expect(args).toContain('--tools\n\n--strict-mcp-config');
    expect(args).toContain('--permission-mode\ndont_ask');
    expect(args).toContain('--no-session-persistence');
    expect(
      await askQoderOnce('No', { bin: path.join(dir, 'missing'), cwd: dir, timeoutMs: 1000 })
    ).toBeNull();
  });
});
