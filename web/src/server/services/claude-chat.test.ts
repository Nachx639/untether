import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  activityFromLines,
  claudeConversationExists,
  claudeFormatSurprises,
  claudePidLookups,
  claudeWorkingDir,
  clearClaudePidCache,
  clearProcessTableCache,
  newWorkTracker,
  parseToolResults,
  parseTranscriptLine,
  plainPreview,
  projectOf,
  readClaudeChat,
  readClaudeStatuses,
  sessionFileSurprise,
  toolSteps,
  trackWork,
  turnEndedFromLines,
  WORK_MIN_STEPS,
  WORK_WINDOW,
} from './claude-chat.js';

const line = (entry: Record<string, unknown>) => JSON.stringify({ uuid: 'u1', ...entry });

describe('parseTranscriptLine', () => {
  it('turns user and assistant turns into chat messages, tools into summaries', () => {
    expect(parseTranscriptLine(line({ type: 'user', message: { content: 'hola' } }))).toEqual([
      { id: 'u1:0', role: 'user', text: 'hola', timestamp: undefined },
    ]);

    const assistant = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: ' Listo. ' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la', description: 'List files' },
            },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } },
          ],
        },
      })
    );
    expect(assistant.map(({ role, text, tool }) => ({ role, text, tool }))).toEqual([
      { role: 'assistant', text: 'Listo.', tool: undefined },
      { role: 'tool', text: 'List files', tool: 'Bash' },
      { role: 'tool', text: 'app.ts', tool: 'Edit' },
    ]);
  });

  it('carries what an Edit changed, so it can be reviewed from the phone', () => {
    const [tool] = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'Edit',
              input: {
                file_path: '/repo/a.ts',
                old_string: 'x = 1\ny = 2',
                new_string: 'x = 1\ny = 3',
              },
            },
          ],
        },
      })
    );
    expect(tool).toMatchObject({
      tool: 'Edit',
      detail: '/repo/a.ts',
      diff: [' x = 1', '-y = 2', '+y = 3'],
    });
    // Nothing left out: no count in the message.
    expect('diffMore' in tool && tool.diffMore !== undefined).toBe(false);
  });

  it('exposes single-choice AskUserQuestion options so the chat can answer them', () => {
    const ask = (questions: unknown[]) =>
      parseTranscriptLine(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions } }],
          },
        })
      )[0]?.question;

    expect(
      ask([{ question: '¿Fruta?', options: [{ label: 'Manzana' }, { label: 'Fresa' }] }])
    ).toEqual({ text: '¿Fruta?', options: ['Manzana', 'Fresa'] });
    expect(
      ask([{ question: 'Varias', multiSelect: true, options: [{ label: 'a' }] }])
    ).toBeUndefined();
    expect(
      ask([
        { question: 'a', options: [{ label: 'x' }] },
        { question: 'b', options: [{ label: 'y' }] },
      ])
    ).toBeUndefined();
  });

  it('keeps tool details and reads their results, truncated', () => {
    const [bash] = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      })
    );
    expect(bash).toMatchObject({ toolUseId: 't1', detail: '$ ls' });

    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const [result] = parseToolResults(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [{ type: 'text', text: long }],
            },
          ],
        },
      })
    );
    expect(result.toolUseId).toBe('t1');
    expect(result.isError).toBe(true);
    expect(result.text.split('\n')).toHaveLength(21);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('turns an interruption into a note', () => {
    expect(
      parseTranscriptLine(
        line({
          type: 'user',
          message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        })
      )
    ).toEqual([{ id: 'u1:0', role: 'note', text: 'Interrupted', timestamp: undefined }]);
  });

  it('shows slash commands and drops Claude Code bookkeeping', () => {
    const command = line({
      type: 'user',
      message: { content: '<command-name>/model</command-name><command-args>opus</command-args>' },
    });
    expect(parseTranscriptLine(command)[0]?.text).toBe('/model opus');

    for (const hidden of [
      line({
        type: 'user',
        message: { content: '<local-command-stdout>ok</local-command-stdout>' },
      }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'x' }] },
      }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }),
      line({ type: 'attachment' }),
      'not json',
    ]) {
      expect(parseTranscriptLine(hidden)).toEqual([]);
    }
  });
});

describe('readClaudeStatuses', () => {
  it('reports the Claude Code status found in a session process tree', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    const tz = process.env.TZ;
    // The server's local zone must not leak into the comparison.
    process.env.TZ = 'America/New_York';
    try {
      // Claude Code writes procStart as `ps` lstart rendered in UTC.
      const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
        env: { ...process.env, TZ: 'UTC' },
      })
        .toString()
        .trim();
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId: 's',
          cwd: '/x',
          status: 'waiting',
          waitingFor: 'input needed',
          procStart,
          version: '2.1.316',
        })
      );

      const statuses = await readClaudeStatuses([process.pid, 999_999_999], claudeDir);

      expect(statuses.get(process.pid)).toEqual({
        status: 'waiting',
        waitingFor: 'input needed',
        sessionId: 's',
        // The Claude process and the version it started as (claude-update-restart, 2026-10-31).
        pid: process.pid,
        version: '2.1.316',
      });
      expect(statuses.has(999_999_999)).toBe(false);

      // A file left behind by an earlier process with the same pid is ignored.
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId: 's',
          cwd: '/x',
          status: 'busy',
          procStart: 'Mon Jan  1 00:00:00 2001',
        })
      );
      clearProcessTableCache(); // a fresh `ps`, as once its 2 s cache ran out
      expect((await readClaudeStatuses([process.pid], claudeDir)).has(process.pid)).toBe(false);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});

// 2026-11-02 (CPU measurement): every status look ran `ps -A` over the whole Mac.
describe('readClaudeStatuses without a ps each time', () => {
  it('reads the remembered claude until a pid dies or the sessions folder changes', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    const sessions = path.join(claudeDir, 'sessions');
    fs.mkdirSync(sessions);
    const write = (pid: number, status: string) =>
      fs.writeFileSync(
        path.join(sessions, `${pid}.json`),
        JSON.stringify({ sessionId: `s${pid}`, cwd: '/x', status })
      );
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    const quiet = sleeper.pid as number;
    try {
      clearClaudePidCache();
      write(process.pid, 'idle');
      const start = claudePidLookups();
      const first = await readClaudeStatuses([process.pid, quiet], claudeDir);
      expect(first.get(process.pid)?.status).toBe('idle');
      expect(first.has(quiet)).toBe(false);
      expect(claudePidLookups()).toBe(start + 1);

      // Claude updates its file in place: read without looking at the processes again.
      write(process.pid, 'busy');
      const second = await readClaudeStatuses([process.pid, quiet], claudeDir);
      expect(second.get(process.pid)?.status).toBe('busy');
      expect(second.has(quiet)).toBe(false);
      expect(claudePidLookups()).toBe(start + 1);

      // A claude starts in the quiet session: its new file changes the folder, found at once.
      await new Promise((resolve) => setTimeout(resolve, 20));
      write(quiet, 'waiting');
      clearProcessTableCache(); // a fresh `ps`, as once its 2 s cache ran out
      const third = await readClaudeStatuses([process.pid, quiet], claudeDir);
      expect(third.get(quiet)?.status).toBe('waiting');
      expect(claudePidLookups()).toBe(start + 2);

      // A remembered pid that died: looked up again.
      sleeper.kill('SIGKILL');
      await new Promise((resolve) => sleeper.once('exit', resolve));
      clearProcessTableCache();
      await readClaudeStatuses([process.pid, quiet], claudeDir);
      expect(claudePidLookups()).toBe(start + 3);
    } finally {
      sleeper.kill('SIGKILL');
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  }, 20_000);

  // 2026-11-02 review: one global stamp let a lookup of one session renew every other one.
  it('a change seen by a lookup of one session still looks again for the others', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    const sessions = path.join(claudeDir, 'sessions');
    fs.mkdirSync(sessions);
    const write = (pid: number) =>
      fs.writeFileSync(
        path.join(sessions, `${pid}.json`),
        JSON.stringify({ sessionId: `s${pid}`, cwd: '/x', status: 'waiting' })
      );
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    const other = sleeper.pid as number;
    try {
      clearClaudePidCache();
      const start = claudePidLookups();
      const first = await readClaudeStatuses([process.pid, other], claudeDir);
      expect(first.has(other)).toBe(false);
      expect(claudePidLookups()).toBe(start + 1);

      // A claude starts under `other`, but the next look only asks about this process.
      await new Promise((resolve) => setTimeout(resolve, 20));
      write(other);
      clearProcessTableCache(); // a fresh `ps`, as once its 2 s cache ran out
      await readClaudeStatuses([process.pid], claudeDir);
      expect(claudePidLookups()).toBe(start + 2);

      // The look over both does not take `other`'s old answer as fresh.
      const both = await readClaudeStatuses([process.pid, other], claudeDir);
      expect(both.get(other)?.status).toBe('waiting');
      expect(claudePidLookups()).toBe(start + 3);
    } finally {
      sleeper.kill('SIGKILL');
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  }, 20_000);
});

describe('readClaudeChat transcript reading', () => {
  it('starts large transcripts from their tail and follows appends', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'big', cwd: '/x', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-x');
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(projectDir, 'big.jsonl');
      const userLine = (text: string) =>
        `${JSON.stringify({ type: 'user', uuid: text, message: { content: text } })}\n`;
      // ~6 MB of old history (more than the 4 MB tail), then a recent message.
      const filler = userLine('x'.repeat(1024 * 1024));
      fs.writeFileSync(transcript, filler.repeat(6) + userLine('recent'));

      const first = await readClaudeChat(process.pid, claudeDir);
      expect(first.messages.at(-1)?.text).toBe('recent');
      expect(first.messages.length).toBeLessThan(6);

      fs.appendFileSync(transcript, userLine('newer'));
      const second = await readClaudeChat(process.pid, claudeDir);
      expect(second.messages.at(-1)?.text).toBe('newer');
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});

describe('readClaudeStatuses previews', () => {
  it('adds the conversation title and last message for the session list', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'p', cwd: '/proj', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      const long = 'x'.repeat(300);
      fs.writeFileSync(
        path.join(projectDir, 'p.jsonl'),
        [
          line({ type: 'ai-title', aiTitle: 'Fix the login' }),
          line({ type: 'user', uuid: 'a', message: { content: 'arregla el login' } }),
          line({
            type: 'assistant',
            uuid: 'b',
            message: { content: [{ type: 'text', text: `Hecho.\n\n${long}` }] },
          }),
          line({
            type: 'assistant',
            uuid: 'c',
            message: {
              content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }],
            },
          }),
          '',
        ].join('\n')
      );

      const status = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);

      expect(status?.title).toBe('Fix the login');
      expect(status?.preview?.role).toBe('assistant');
      expect(status?.preview?.text.startsWith('Hecho. xxx')).toBe(true);
      expect(status?.preview?.text).toHaveLength(160);
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});

describe('plainPreview', () => {
  it('turns a markdown answer into one line of plain text', () => {
    expect(
      plainPreview(
        '## Ideas\n1. **Barra de teclas** con `Tab` y [docs](https://x.io)\n> nota\n```sh\nls\n```\nfin _ya_.'
      )
    ).toBe('Ideas 1. Barra de teclas con Tab y docs nota fin ya.');
  });

  it('reads a table as its cells and drops bullets, not their words', () => {
    expect(
      plainPreview(
        '| Lenguaje | Año de creación |\n|-----------|-----------------|\n| C | 1972 |\n| Python | 1991 |\n\n- **listo** el *cambio*'
      )
    ).toBe('Lenguaje · Año de creación; C · 1972; Python · 1991 listo el cambio');
  });
});

describe('claudeWorkingDir', () => {
  const T0 = Date.parse('2026-11-04T16:00:00Z');
  const minute = 60_000;
  const toolLine = (cwd: string, name: string, input: Record<string, unknown>, at = T0) =>
    `${JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp: new Date(at).toISOString(),
      message: { content: [{ type: 'tool_use', name, input }] },
    })}\n`;
  /** `count` Bash calls in `dir`, one every `every` ms from `from`. */
  const commands = (cwd: string, dir: string, count: number, from: number, every = 30_000) =>
    Array.from({ length: count }, (_, i) =>
      toolLine(cwd, 'Bash', { command: `cd ${dir} && git status` }, from + i * every)
    ).join('');
  const entry = (cwd: string) => `${JSON.stringify({ type: 'user', cwd })}\n`;
  /** A home folder with real projects (a repository and a plain folder) and a transcript. */
  const withHome = (
    run: (ctx: {
      file: string;
      claudeDir: string;
      home: string;
      projects: string;
      repo: (name: string) => string;
      folder: (name: string) => string;
    }) => void
  ) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      const claudeDir = path.join(root, 'claude');
      const home = path.join(root, 'home');
      const projects = path.join(home, 'Projects');
      const dir = path.join(claudeDir, 'projects', '-home');
      fs.mkdirSync(dir, { recursive: true });
      const folder = (name: string) => {
        const at = path.join(projects, name);
        fs.mkdirSync(at, { recursive: true });
        return at;
      };
      const repo = (name: string) => {
        const at = folder(name);
        fs.mkdirSync(path.join(at, '.git'), { recursive: true });
        return at;
      };
      run({ file: path.join(dir, 'conv.jsonl'), claudeDir, home, projects, repo, folder });
    } finally {
      fs.rmSync(root, RM_TEST_DIR);
    }
  };

  it('the folder Claude started in, not where a later cd only looks', () => {
    withHome(({ file, claudeDir, home }) => {
      fs.writeFileSync(file, entry('/Users/n/Projects/untether'));
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe('/Users/n/Projects/untether');
      // Claude Code moves the entries' cwd with every cd: still where it started.
      fs.appendFileSync(file, `${entry('/Users/n/Projects/other')}{"type":"ai-title"}\n`);
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe('/Users/n/Projects/untether');
      expect(claudeWorkingDir(home, 'missing', claudeDir, home)).toBeNull();
    });
  });

  it('2026-11-04 channel insights: a burst in bakery and a subagent naming it do not move a session opened in ~', () => {
    withHome(({ file, claudeDir, home, repo }) => {
      const bakery = repo('bakery');
      const notes = path.join(home, 'notes');
      fs.mkdirSync(notes);
      fs.writeFileSync(
        file,
        entry(home) +
          toolLine(home, 'WebSearch', { query: 'StarterStoryBuild' }, T0) +
          Array.from({ length: 12 }, (_, i) =>
            toolLine(home, 'Read', { file_path: path.join(notes, `${i}.md`) }, T0 + i * minute)
          ).join('') +
          // The burst: cd + ./bakery up, a few looks, a subagent whose prompt names the repo.
          toolLine(home, 'Bash', { command: `cd ${bakery} && ./bakery up` }, T0 + 13 * minute) +
          commands(bakery, bakery, 8, T0 + 14 * minute) +
          toolLine(
            bakery,
            'Agent',
            {
              description: 'Parchear bakery',
              prompt: `Work in ${bakery}`,
            },
            T0 + 18 * minute
          ) +
          // Back to the finance bot while Claude Code's cwd stays in bakery.
          toolLine(bakery, 'Bash', { command: `cat ${notes}/bot.md` }, T0 + 19 * minute)
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(home);
    });
  });

  it('moves with a sustained majority of its recent work, and follows it to another project', () => {
    withHome(({ file, claudeDir, home, repo, folder }) => {
      const skylark = repo('skylark');
      const finanzas = folder('finanzas');
      // WORK_MIN_STEPS calls in skylark, but within less than WORK_MIN_STAY_MS: not yet.
      fs.writeFileSync(file, entry(home) + commands(home, skylark, WORK_MIN_STEPS, T0, 20_000));
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(home);
      // It keeps working there past WORK_MIN_STAY_MS: the session is skylark's.
      fs.appendFileSync(file, commands(skylark, skylark, 10, T0 + 4 * minute));
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(skylark);
      // A file elsewhere and a few looks in finanzas do not take it away.
      fs.appendFileSync(
        file,
        toolLine(skylark, 'Write', { file_path: path.join(finanzas, 'a.py') }, T0 + 10 * minute) +
          commands(skylark, finanzas, 4, T0 + 11 * minute)
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(skylark);
      // Then most of its work is in finanzas (a folder without git), sustained: it follows.
      fs.appendFileSync(file, commands(finanzas, finanzas, 20, T0 + 14 * minute));
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(finanzas);
      // And back to work outside any project: it goes back to where it started.
      fs.appendFileSync(
        file,
        Array.from({ length: WORK_WINDOW }, (_, i) =>
          toolLine(
            finanzas,
            'Read',
            { file_path: `/private/tmp/x/${i}` },
            T0 + 30 * minute + i * minute
          )
        ).join('')
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(home);
    });
  });

  it('sustained work named from ~ (git -C, no cd) moves it too (2026-11-04 review)', () => {
    withHome(({ file, claudeDir, home, repo }) => {
      const app = repo('app');
      fs.writeFileSync(
        file,
        entry(home) +
          Array.from({ length: 15 }, (_, i) =>
            toolLine(home, 'Bash', { command: `git -C ${app} status` }, T0 + i * minute)
          ).join('')
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(app);
    });
  });

  it('a pause is no stay: a burst, an hour idle, one more call does not move it', () => {
    withHome(({ file, claudeDir, home, repo }) => {
      const app = repo('app');
      fs.writeFileSync(
        file,
        entry(home) + commands(home, app, 12, T0, 15_000) + commands(app, app, 1, T0 + 60 * minute)
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(home);
    });
  });

  it('a session started in a project stays in it wherever its work goes', () => {
    withHome(({ file, claudeDir, home, repo }) => {
      const own = repo('own');
      const other = repo('other');
      fs.writeFileSync(file, entry(own) + commands(own, other, WORK_WINDOW, T0, minute));
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(own);
    });
  });

  it('2026-10-28 snoring app: looks into atlas do not move it; git init makes the new app its project', () => {
    withHome(({ file, claudeDir, home, projects, repo }) => {
      const atlas = path.join(repo('atlas'), 'ios/Atlas');
      fs.mkdirSync(atlas, { recursive: true });
      fs.writeFileSync(
        file,
        entry(projects) +
          toolLine(projects, 'WebSearch', { query: 'apps restlog sleep' }) +
          toolLine(projects, 'Bash', { command: 'xcodebuild -version; ls ~/Projects | head -50' }) +
          toolLine(projects, 'Bash', { command: `cat ${atlas}/project.yml` }) +
          toolLine(projects, 'Bash', { command: `cd ${atlas}; cat Config/Atlas.xcconfig` }) +
          entry(atlas).repeat(11)
      );
      expect(claudeWorkingDir(projects, 'conv', claudeDir, home)).toBe(projects);

      const app = path.join(projects, 'restlog');
      fs.appendFileSync(
        file,
        toolLine(atlas, 'Bash', { command: `mkdir -p ${app} && cd ${app} && git init` })
      );
      expect(claudeWorkingDir(projects, 'conv', claudeDir, home)).toBe(app);
      fs.appendFileSync(file, toolLine(app, 'Bash', { command: `cd ${atlas} && ls` }));
      expect(claudeWorkingDir(projects, 'conv', claudeDir, home)).toBe(app);
    });
  });

  it('reads the whole transcript once, then what was appended; the start folder past 64KB counts', () => {
    withHome(({ file, claudeDir, home, repo }) => {
      const skylark = repo('skylark');
      const noise = `${JSON.stringify({ type: 'summary', text: 'x'.repeat(100_000) })}\n`;
      // A move 4MB before the end (more than one read chunk).
      fs.writeFileSync(
        file,
        noise + entry(home) + commands(home, skylark, 15, T0, minute) + noise.repeat(40)
      );
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(skylark);
      fs.appendFileSync(file, `${toolLine(home, 'Bash', { command: 'ls' })}{"cwd":"\\x"}\n`);
      expect(claudeWorkingDir(home, 'conv', claudeDir, home)).toBe(skylark);

      const other = path.join(path.dirname(file), 'conv2.jsonl');
      fs.writeFileSync(
        other,
        noise + entry(skylark) + toolLine(skylark, 'Bash', { command: 'ls' })
      );
      expect(claudeWorkingDir(home, 'conv2', claudeDir, home)).toBe(skylark);
    });
  });
});

describe('trackWork', () => {
  it('needs a clear majority of the window held over time; unknown times take the last known', () => {
    const tracker = newWorkTracker();
    const at = (minutes: number) => Date.parse('2026-11-04T10:00:00Z') + minutes * 60_000;
    for (let i = 0; i < 10; i++) trackWork(tracker, { project: '', at: at(i) });
    // 9 of 19 in /h/a: no majority.
    for (let i = 0; i < 9; i++) trackWork(tracker, { project: '/h/a', at: at(10 + i) });
    expect(tracker.current).toBe('');
    // 15 of 25 (60 %) from minute 24, held until minute 29: moves.
    for (let i = 0; i < 6; i++) trackWork(tracker, { project: '/h/a', at: at(19 + i) });
    expect(tracker.current).toBe('');
    for (let i = 0; i < 5; i++) trackWork(tracker, { project: '/h/a', at: 0 });
    expect(tracker.current).toBe('');
    trackWork(tracker, { project: '/h/a', at: at(30) });
    expect(tracker.current).toBe('/h/a');
    trackWork(tracker, { project: '/h/new', created: true, at: at(31) });
    expect(tracker.current).toBe('/h/new');
    expect(tracker.window).toEqual([]);
  });
});

describe('toolSteps', () => {
  const home = '/Users/n';
  const use = (name: string, input: Record<string, unknown>, cwd = home) =>
    JSON.stringify({
      type: 'assistant',
      cwd,
      timestamp: '2026-11-04T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', name, input }] },
    });
  const dirOf = (line: string) => toolSteps(line, home).map((step) => step.dir);

  it('the folder each call acts on, and a repository git init makes', () => {
    expect(
      toolSteps(use('Write', { file_path: '/Users/n/Projects/skylark/src/a.ts' }), home)
    ).toEqual([
      {
        dir: '/Users/n/Projects/skylark/src',
        created: null,
        at: Date.parse('2026-11-04T10:00:00Z'),
      },
    ]);
    expect(dirOf(use('Read', { file_path: '/private/tmp/x/a.txt' }))).toEqual(['/private/tmp/x']);
    expect(dirOf(use('Grep', { pattern: 'x', path: '~/Projects/a' }))).toEqual([
      '/Users/n/Projects/a',
    ]);
    expect(dirOf(use('Glob', { pattern: '*.ts' }, '/Users/n/Projects/b'))).toEqual([
      '/Users/n/Projects/b',
    ]);
    expect(dirOf(use('Bash', { command: 'cd ~/Projects/skylark && npm test' }))).toEqual([
      '/Users/n/Projects/skylark',
    ]);
    expect(dirOf(use('Bash', { command: 'cd "/Users/n/Projects/my app"; ls' }))).toEqual([
      '/Users/n/Projects/my app',
    ]);
    expect(dirOf(use('Bash', { command: 'cd $HOME/Projects/a && ls' }))).toEqual([
      '/Users/n/Projects/a',
    ]);
    // Claude Code keeps an old cd's cwd: a command naming only other places works there.
    expect(
      dirOf(use('Bash', { command: 'cat /private/tmp/t/out 2>/dev/null' }, '/Users/n/Projects/b'))
    ).toEqual(['/private/tmp/t/out']);
    expect(
      dirOf(
        use('Bash', { command: 'git status; cat /Users/n/Projects/b/x' }, '/Users/n/Projects/b')
      )
    ).toEqual(['/Users/n/Projects/b/x']);
    // A place deeper than the cwd (from ~) is where the command works.
    expect(dirOf(use('Bash', { command: 'git -C ~/Projects/app status' }))).toEqual([
      '/Users/n/Projects/app',
    ]);
    expect(dirOf(use('Bash', { command: 'ls ~ /private/tmp' }))).toEqual(['/Users/n']);
    expect(dirOf(use('Bash', { command: 'ls > /dev/null' }, '/Users/n/Projects/b'))).toEqual([
      '/Users/n/Projects/b',
    ]);
    // Unknown folder; tools without one are left out.
    expect(dirOf(use('Bash', { command: 'cd "$DIR" && git commit -m x' }))).toEqual([null]);
    expect(dirOf(use('Agent', { prompt: 'work in ~/Projects/bakery' }))).toEqual([]);
    expect(dirOf(use('WebSearch', { query: 'x' }))).toEqual([]);
    expect(toolSteps(JSON.stringify({ type: 'user', cwd: home }), home)).toEqual([]);

    const created = (line: string) => toolSteps(line, home).map((step) => step.created);
    expect(created(use('Bash', { command: 'git init ~/Projects/restlog' }))).toEqual([
      '/Users/n/Projects/restlog',
    ]);
    expect(
      created(
        use('Bash', { command: 'mkdir restlog && cd restlog && git init' }, '/Users/n/Projects')
      )
    ).toEqual(['/Users/n/Projects/restlog']);
    expect(created(use('Bash', { command: 'git status' }))).toEqual([null]);
  });
});

describe('projectOf', () => {
  it('the nearest repository, else the folder two levels under home; none for home, hidden or outside', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'project-of-'));
    try {
      fs.mkdirSync(path.join(home, 'Projects/atlas/.git'), { recursive: true });
      fs.mkdirSync(path.join(home, 'Projects/atlas/ios/Atlas'), { recursive: true });
      fs.mkdirSync(path.join(home, 'Projects/plain/src'), { recursive: true });
      fs.mkdirSync(path.join(home, 'cobot/.git'), { recursive: true });
      expect(projectOf(path.join(home, 'Projects/atlas/ios/Atlas'), home)).toBe(
        path.join(home, 'Projects/atlas')
      );
      expect(projectOf(path.join(home, 'Projects/plain/src'), home)).toBe(
        path.join(home, 'Projects/plain')
      );
      expect(projectOf(path.join(home, 'cobot/tools'), home)).toBe(path.join(home, 'cobot'));
      expect(projectOf(path.join(home, 'Projects/gone/x'), home)).toBe('');
      expect(projectOf(path.join(home, 'Projects'), home)).toBe('');
      expect(projectOf(home, home)).toBe('');
      expect(projectOf(path.join(home, '.claude/x'), home)).toBe('');
      expect(projectOf('/private/tmp/x', home)).toBe('');
    } finally {
      fs.rmSync(home, RM_TEST_DIR);
    }
  });
});

describe('claudeConversationExists', () => {
  it('is true only once Claude has written a transcript for the conversation', () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      const projectDir = path.join(claudeDir, 'projects', '-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'talked.jsonl'), '{}\n');

      expect(claudeConversationExists('/proj', 'talked', claudeDir)).toBe(true);
      expect(claudeConversationExists('/proj', 'never-messaged', claudeDir)).toBe(false);
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});

describe('activityFromLines', () => {
  const at = '2026-10-02T10:00:00.000Z';
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    line({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  const toolResult = (id: string) =>
    line({
      type: 'user',
      uuid: `r-${id}`,
      timestamp: '2026-10-02T10:00:05.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });

  it('names the tool call that has no result yet, with its start time', () => {
    expect(activityFromLines([toolUse('t1', 'Bash', { command: 'pnpm test --run' })])).toEqual({
      kind: 'tool',
      tool: 'Bash',
      target: 'pnpm test --run',
      since: Date.parse(at),
    });
  });

  it('is thinking once the tool result is back', () => {
    expect(
      activityFromLines([toolUse('t1', 'Read', { file_path: '/r/a.ts' }), toolResult('t1')])
    ).toEqual({ kind: 'thinking', since: Date.parse('2026-10-02T10:00:05.000Z') });
  });

  it('keeps showing a parallel call that is still running', () => {
    const activity = activityFromLines([
      toolUse('t1', 'Read', { file_path: '/r/a.ts' }),
      toolUse('t2', 'Grep', { pattern: 'TODO' }),
      toolResult('t2'),
    ]);
    expect(activity).toMatchObject({ kind: 'tool', tool: 'Read', target: 'a.ts' });
  });

  it('describes each tool kind by its subject', () => {
    const target = (name: string, input: Record<string, unknown>) =>
      activityFromLines([toolUse('t', name, input)])?.target;
    expect(target('Bash', { command: 'npm run build', description: 'Build the app' })).toBe(
      'Build the app'
    );
    expect(target('Bash', { command: `echo ${'x'.repeat(100)}` })).toHaveLength(60);
    expect(target('Edit', { file_path: '/repo/src/app.ts' })).toBe('app.ts');
    expect(target('Write', { file_path: '/repo/new.md' })).toBe('new.md');
    expect(target('Read', { file_path: '/repo/README.md' })).toBe('README.md');
    expect(target('Grep', { pattern: 'claudeStatus' })).toBe('claudeStatus');
    expect(target('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(target('WebFetch', { url: 'https://docs.example.com/a/b?c=1' })).toBe(
      'docs.example.com'
    );
    expect(target('WebSearch', { query: 'lit reactive controllers' })).toBe(
      'lit reactive controllers'
    );
    expect(target('Task', { description: 'Explore the server' })).toBe('Explore the server');
    expect(target('TodoWrite', { todos: [] })).toBeUndefined();
  });

  it('is thinking during a thinking block or after a prompt, writing during text', () => {
    const thinking = line({
      type: 'assistant',
      timestamp: at,
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    expect(activityFromLines([thinking])).toEqual({ kind: 'thinking', since: Date.parse(at) });
    expect(
      activityFromLines([line({ type: 'user', timestamp: at, message: { content: 'hola' } })])
    ).toEqual({ kind: 'thinking', since: Date.parse(at) });
    expect(
      activityFromLines([
        thinking,
        line({
          type: 'assistant',
          timestamp: at,
          message: { content: [{ type: 'text', text: 'Ok' }] },
        }),
        line({ type: 'ai-title', aiTitle: 'x' }),
      ])
    ).toEqual({ kind: 'writing', since: Date.parse(at) });
    expect(activityFromLines([])).toBeUndefined();
  });
});

describe('readClaudeStatuses activity', () => {
  it('reports the running tool only while Claude is busy', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      const sessionFile = path.join(claudeDir, 'sessions', `${process.pid}.json`);
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ sessionId: 'act', cwd: '/proj', status: 'busy' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-proj');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'act.jsonl'),
        `${line({
          type: 'assistant',
          timestamp: '2026-10-02T10:00:00.000Z',
          message: {
            content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/p/x.ts' } }],
          },
        })}\n`
      );

      const busy = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(busy?.activity).toEqual({
        kind: 'tool',
        tool: 'Edit',
        target: 'x.ts',
        since: Date.parse('2026-10-02T10:00:00.000Z'),
      });

      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ sessionId: 'act', cwd: '/proj', status: 'idle' })
      );
      const idle = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(idle?.activity).toBeUndefined();
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});

describe('readClaudeChat images sent with a prompt', () => {
  const upload = '/Users/n/.untether/control/uploads/0b5e-photo.jpg';
  const entries = (promptId: string, text: string | null, extra: string[] = []) => [
    JSON.stringify({
      type: 'user',
      uuid: `p-${promptId}`,
      promptId,
      message: {
        content: [
          ...(text === null ? [] : [{ type: 'text', text }]),
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: `m-${promptId}`,
      promptId,
      isMeta: true,
      turnCompanion: true,
      message: {
        content: [upload, ...extra].map((p) => ({ type: 'text', text: `[Image: source: ${p}]` })),
      },
    }),
  ];

  async function chatFor(lines: string[]) {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'imgs', cwd: '/x', status: 'idle' })
      );
      const projectDir = path.join(claudeDir, 'projects', '-x');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'imgs.jsonl'), `${lines.join('\n')}\n`);
      return await readClaudeChat(process.pid, claudeDir);
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  }

  it('puts the uploaded image path in the prompt bubble, with its text', async () => {
    const chat = await chatFor(entries('a', '¿qué flores son?', ['/tmp/Captura de pantalla.png']));
    const users = chat.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    // Only Untether uploads (which the files route can serve) become thumbnails.
    expect(users[0].text).toBe(`${upload}\n¿qué flores son?`);
  });

  it('shows an image sent without text on its own', async () => {
    const chat = await chatFor([...entries('a', 'hola'), ...entries('b', null)]);
    const users = chat.messages.filter((m) => m.role === 'user').map((m) => m.text);
    expect(users).toEqual([`${upload}\nhola`, upload]);
  });
});

describe('waiting for background agents', () => {
  // Shapes as Claude Code 2.x writes them (checked on a live session with background agents,
  // 2026-10-04); the text is synthetic.
  const at = (s: number) =>
    new Date(Date.parse('2026-10-04T00:00:00.000Z') + s * 1000).toISOString();
  const prompt = (s: number, text = 'lanza un agente en segundo plano') =>
    line({
      type: 'user',
      uuid: `p${s}`,
      timestamp: at(s),
      origin: { kind: 'human' },
      message: { role: 'user', content: text },
    });
  const toolUse = (s: number, id: string, extra: Record<string, unknown> = {}) =>
    line({
      type: 'assistant',
      uuid: `a${s}`,
      timestamp: at(s),
      ...extra,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm test' } }],
      },
    });
  const toolResult = (s: number, id: string) =>
    line({
      type: 'user',
      uuid: `r${s}`,
      timestamp: at(s),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
  /** The reply's thinking and text blocks: separate entries, both with stop_reason end_turn. */
  const endTurn = (s: number) => [
    line({
      type: 'assistant',
      uuid: `t${s}`,
      timestamp: at(s),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }],
      },
    }),
    line({
      type: 'assistant',
      uuid: `e${s}`,
      timestamp: at(s),
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hecho, el agente sigue.' }],
      },
    }),
    line({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(s) }),
    line({ type: 'system', subtype: 'turn_duration', timestamp: at(s) }),
    line({ type: 'last-prompt', lastPrompt: 'x' }),
    line({ type: 'ai-title', aiTitle: 'Agentes' }),
    line({ type: 'permission-mode', permissionMode: 'default' }),
  ];
  const taskNotification = (s: number) => [
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), content: 'x' }),
    line({ type: 'queue-operation', operation: 'dequeue', timestamp: at(s) }),
    line({
      type: 'user',
      uuid: `n${s}`,
      timestamp: at(s),
      origin: { kind: 'task-notification', producer: 'session-task' },
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>',
      },
    }),
  ];

  async function withTranscript(
    sessionId: string,
    lines: string[],
    run: (
      chat: () => ReturnType<typeof readClaudeChat>,
      append: (more: string[]) => void,
      claudeDir: string
    ) => Promise<void>,
    session: Record<string, unknown> = {}
  ) {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dir-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          sessionId,
          cwd: '/bg',
          status: 'busy',
          statusUpdatedAt: Date.parse(at(0)),
          ...session,
        })
      );
      const projectDir = path.join(claudeDir, 'projects', '-bg');
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
      await run(
        () => readClaudeChat(process.pid, claudeDir),
        (more) => fs.appendFileSync(transcript, `${more.join('\n')}\n`),
        claudeDir
      );
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  }

  it('is waiting when the last main-thread entry is an end_turn reply, busy again at a task notification', async () => {
    await withTranscript(
      'bg-1',
      [prompt(1), toolUse(2, 'k'), toolResult(3, 'k'), ...endTurn(4)],
      async (chat, append) => {
        const waiting = await chat();
        expect(waiting.status).toBe('busy');
        expect(waiting.waitingForBackground).toBe(true);
        expect(waiting.activity).toBeUndefined();

        append(taskNotification(60));
        const working = await chat();
        expect(working.waitingForBackground).toBeUndefined();
        expect(working.activity).toBeDefined();

        append(endTurn(70));
        expect((await chat()).waitingForBackground).toBe(true);
      }
    );
  });

  it('reads Claude Code\'s "shell" (turn over, a background shell running) as background work (2026-10-20)', async () => {
    await withTranscript(
      'bg-shell',
      [prompt(1), ...endTurn(4)],
      async (chat, _append, claudeDir) => {
        const now = await chat();
        expect(now.status).toBe('busy');
        expect(now.waitingForBackground).toBe(true);
        expect(now.activity).toBeUndefined();
        const statuses = await readClaudeStatuses([process.pid], claudeDir);
        expect(statuses.get(process.pid)).toMatchObject({
          status: 'busy',
          waitingForBackground: true,
        });
      },
      { status: 'shell' }
    );
  });

  it('reads a status it does not know as idle', async () => {
    await withTranscript(
      'bg-unknown',
      [prompt(1), ...endTurn(4)],
      async (chat) => {
        expect((await chat()).status).toBe('idle');
      },
      { status: 'something-new' }
    );
  });

  it('ignores sidechain (subagent) entries after the reply', async () => {
    await withTranscript(
      'bg-2',
      [
        prompt(1),
        ...endTurn(4),
        toolUse(5, 's1', { isSidechain: true }),
        toolResult(6, 's1').replace('{', '{"isSidechain":true,'),
      ],
      async (chat) => {
        expect((await chat()).waitingForBackground).toBe(true);
      }
    );
  });

  it('is a real turn while a tool call has no result yet', async () => {
    await withTranscript(
      'bg-3',
      [prompt(1), ...endTurn(4), prompt(10, 'otra cosa'), toolUse(11, 'k2')],
      async (chat) => {
        const chatNow = await chat();
        expect(chatNow.waitingForBackground).toBeUndefined();
        expect(chatNow.activity).toMatchObject({ kind: 'tool', tool: 'Bash' });
      }
    );
  });

  it('is a real turn at a tool result or a peer message after the reply', async () => {
    await withTranscript('bg-4', [prompt(1), ...endTurn(4)], async (chat, append) => {
      expect((await chat()).waitingForBackground).toBe(true);
      append([
        line({
          type: 'user',
          uuid: 'peer',
          isMeta: true,
          timestamp: at(30),
          origin: { kind: 'peer', from: 'uds:/tmp/x.sock' },
          message: { role: 'user', content: 'mensaje de otra sesión' },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBeUndefined();
    });
  });

  it('stays waiting through a local slash command, and after an interrupt', async () => {
    await withTranscript('bg-5', [prompt(1), ...endTurn(4)], async (chat, append) => {
      append([
        line({
          type: 'user',
          timestamp: at(20),
          message: {
            role: 'user',
            content: '<command-name>/effort</command-name>\n<command-args>high</command-args>',
          },
        }),
        line({
          type: 'user',
          timestamp: at(20),
          message: {
            role: 'user',
            content: '<local-command-stdout>Effort set</local-command-stdout>',
          },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBe(true);
      append([
        prompt(30),
        toolUse(31, 'k3'),
        line({
          type: 'user',
          timestamp: at(32),
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
          },
        }),
      ]);
      expect((await chat()).waitingForBackground).toBe(true);
    });
  });

  it('is not waiting for a reply that ended before Claude became busy again (a new prompt)', async () => {
    await withTranscript(
      'bg-6',
      [prompt(1), ...endTurn(4)],
      async (chat) => {
        const chatNow = await chat();
        expect(chatNow.waitingForBackground).toBeUndefined();
      },
      { statusUpdatedAt: Date.parse(at(50)) }
    );
  });

  it('is never set when Claude is idle or waiting', async () => {
    await withTranscript(
      'bg-7',
      [prompt(1), ...endTurn(4)],
      async (chat) => {
        expect((await chat()).waitingForBackground).toBeUndefined();
      },
      { status: 'idle' }
    );
  });

  it('reaches the session list status (readClaudeStatuses)', async () => {
    await withTranscript('bg-8', [prompt(1), ...endTurn(4)], async (_chat, _append, claudeDir) => {
      const status = (await readClaudeStatuses([process.pid], claudeDir)).get(process.pid);
      expect(status).toMatchObject({ status: 'busy', waitingForBackground: true });
      expect(status?.activity).toBeUndefined();
    });
  });
});

describe('turn end (2026-10-20 review)', () => {
  const assistant = (stop: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-20T20:00:00Z',
      message: { stop_reason: stop, content: [{ type: 'text', text: 'x' }] },
    });
  const turnDuration = (sidechain = false) =>
    JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      isSidechain: sidechain,
      durationMs: 1200,
      timestamp: '2026-10-20T20:00:01Z',
    });

  it("a turn Claude Code closes with turn_duration is over, whatever its reply's stop reason", () => {
    expect(turnEndedFromLines([assistant('max_tokens')])).toBe(false);
    expect(turnEndedFromLines([assistant('max_tokens'), turnDuration()])).toBe(true);
    // A subagent's turn is not the main thread's.
    expect(turnEndedFromLines([assistant('tool_use'), turnDuration(true)])).toBe(false);
  });

  it('a stop reason Untether does not know is noted once for the doctor', () => {
    turnEndedFromLines([assistant('brand_new_reason'), assistant('brand_new_reason')]);
    expect(
      claudeFormatSurprises().filter((text) => text.includes('brand_new_reason'))
    ).toHaveLength(1);
    expect(claudeFormatSurprises().some((text) => text.includes('"end_turn"'))).toBe(false);
  });
});

describe('session file surprises', () => {
  it('a session still starting up may lack its status; an older one is a format change', () => {
    const now = 1_792_695_400_000;
    const starting = { sessionId: 's', startedAt: now - 1000 };
    expect(sessionFileSurprise(starting, 63740, now)).toBeNull();
    expect(sessionFileSurprise({ sessionId: 's', startedAt: now - 120_000 }, 63740, now)).toBe(
      'a session file (sessions/63740.json) has no status'
    );
    expect(sessionFileSurprise({ sessionId: 's' }, 1, now)).toContain('has no status');
    expect(sessionFileSurprise({ status: 'busy', startedAt: now }, 1, now)).toBeNull();
    expect(sessionFileSurprise({ sessionId: 's', status: 'idle' }, 1, now)).toBeNull();
  });
});
