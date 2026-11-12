import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  chooseNode,
  describeNodeRuntime,
  findInstalledNodes,
  type InstalledNode,
  nodeRuntimeBrief,
  pathPrependEnv,
  pathPrependLine,
  readNodeRequirements,
  resolveNodeRuntime,
  satisfies,
  versionFileRange,
} from './node-runtime.js';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-'));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, RM_TEST_DIR);
});

function write(file: string, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A fake Node install: <bin>/node exists. */
function fakeNode(bin: string) {
  write(path.join(bin, 'node'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
}

describe('satisfies', () => {
  it.each([
    // Untether's own engines.node (2026-11-02)
    ['24.21.0', '>=22.12.0 <25', true],
    ['22.12.0', '>=22.12.0 <25', true],
    ['22.11.9', '>=22.12.0 <25', false],
    ['26.12.1', '>=22.12.0 <25', false],
    ['25.0.0', '>=22.12.0 <25', false],
    ['20.1.0', '^20 || ^22', true],
    ['21.0.0', '^20 || ^22', false],
    ['22.3.0', '^22.2.0', true],
    ['23.0.0', '^22.2.0', false],
    ['22.9.0', '~22.8', false],
    ['22.8.4', '~22.8.1', true],
    ['24.0.0', '24', true],
    ['24.9.9', '24.x', true],
    ['25.0.0', '24.x', false],
    ['18.0.0', '>= 18', true],
    ['18.0.0', '>18', false],
    ['19.0.0', '>18', true],
    ['18.5.0', '<=18', true],
    ['19.0.0', '<=18', false],
    ['20.5.0', '18 - 20', true],
    ['21.0.0', '18 - 20', false],
    ['30.0.0', '*', true],
    ['24.21.0', 'v24.21.0', true],
    ['24.21.1', '=24.21.0', false],
    ['0.3.1', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
  ])('%s in "%s" → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('cannot say for ranges or versions it does not read', () => {
    expect(satisfies('24.0.0', 'latest')).toBeUndefined();
    expect(satisfies('24.0.0', '>=a.b')).toBeUndefined();
    expect(satisfies('banana', '>=20')).toBeUndefined();
  });

  it('reads Homebrew and pre-release versions by their numbers', () => {
    expect(satisfies('24.11.0_1', '<25')).toBe(true);
    expect(satisfies('v26.0.0-rc.1', '<25')).toBe(false);
  });
});

describe('versionFileRange (.nvmrc / .node-version)', () => {
  it('reads versions, partial versions and LTS names', () => {
    expect(versionFileRange('v24.21.0\n')).toBe('24.21.0');
    expect(versionFileRange('24\n')).toBe('24');
    expect(versionFileRange('# comment\n\nlts/iron\n')).toBe('20');
    expect(versionFileRange('lts/Jod')).toBe('22');
  });

  it('names nothing for aliases with no version', () => {
    for (const alias of ['node', 'lts/*', 'system', 'stable', '', 'lts/unknownname']) {
      expect(versionFileRange(alias)).toBeUndefined();
    }
  });
});

describe('readNodeRequirements', () => {
  it('reads engines.node, .nvmrc and .node-version at the root', () => {
    const dir = path.join(tmp, 'req-root');
    write(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22 <25' } }));
    write(path.join(dir, '.nvmrc'), 'v24\n');
    write(path.join(dir, '.node-version'), 'node\n');
    expect(readNodeRequirements(dir)).toEqual([
      { range: '>=22 <25', source: 'package.json (engines.node)' },
      { range: '24', source: '.nvmrc' },
    ]);
  });

  it('looks one folder down in a repository whose root asks nothing (web/package.json)', () => {
    const dir = path.join(tmp, 'req-sub');
    write(path.join(dir, '.git'), 'gitdir: elsewhere\n');
    write(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
    write(
      path.join(dir, 'web/package.json'),
      JSON.stringify({ engines: { node: '>=22.12.0 <25' } })
    );
    write(
      path.join(dir, 'node_modules/x/package.json'),
      JSON.stringify({ engines: { node: '1' } })
    );
    write(path.join(dir, '.hidden/package.json'), JSON.stringify({ engines: { node: '2' } }));
    expect(readNodeRequirements(dir)).toEqual([
      { range: '>=22.12.0 <25', source: 'web/package.json (engines.node)' },
    ]);
  });

  it('never looks down outside a repository ($HOME, /tmp), nor reads unreadable ranges', () => {
    const dir = path.join(tmp, 'req-norepo');
    write(path.join(dir, 'other/package.json'), JSON.stringify({ engines: { node: '>=22' } }));
    write(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: 'whatever' } }));
    expect(readNodeRequirements(dir)).toEqual([]);
    write(path.join(dir, 'package.json'), '{not json');
    expect(readNodeRequirements(dir)).toEqual([]);
  });
});

describe('findInstalledNodes', () => {
  let home: string;
  let brew: string;

  beforeAll(() => {
    home = path.join(tmp, 'home');
    brew = path.join(tmp, 'brew');
    fakeNode(path.join(home, '.nvm/versions/node/v24.21.0/bin'));
    fakeNode(path.join(home, '.nvm/versions/node/v26.1.0/bin'));
    write(path.join(home, '.nvm/versions/node/v20.0.0/bin/README')); // no node in it
    fakeNode(path.join(home, '.local/share/fnm/node-versions/v22.12.0/installation/bin'));
    fakeNode(path.join(home, '.volta/tools/image/node/23.1.0/bin'));
    fakeNode(path.join(home, '.asdf/installs/nodejs/21.0.0/bin'));
    fakeNode(path.join(home, '.local/share/mise/installs/node/24.1.0/bin'));
    // mise's alias "24" → 24.1.0: one Node, listed once
    fs.symlinkSync('24.1.0', path.join(home, '.local/share/mise/installs/node/24'));
    fakeNode(path.join(brew, 'Cellar/node@24/24.11.0_1/bin'));
    fs.mkdirSync(path.join(brew, 'opt'), { recursive: true });
    fs.symlinkSync('../Cellar/node@24/24.11.0_1', path.join(brew, 'opt/node@24'));
    fs.symlinkSync('../Cellar/node@24/24.11.0_1', path.join(brew, 'opt/not-node'));
  });

  it('finds nvm, fnm, volta, asdf, mise and Homebrew node@NN installs', () => {
    const found = findInstalledNodes({ home, env: {}, brewPrefixes: [brew] });
    expect(found.map(({ source, version }) => `${source} ${version}`).sort()).toEqual([
      'asdf 21.0.0',
      'fnm 22.12.0',
      'homebrew 24.11.0',
      'mise 24.1.0',
      'nvm 24.21.0',
      'nvm 26.1.0',
      'volta 23.1.0',
    ]);
    expect(found.find((n) => n.source === 'homebrew')?.bin).toBe(
      path.join(brew, 'opt/node@24/bin')
    );
  });

  it('follows NVM_DIR and friends', () => {
    const nvm = path.join(tmp, 'custom-nvm');
    fakeNode(path.join(nvm, 'versions/node/v24.0.0/bin'));
    const found = findInstalledNodes({
      home: path.join(tmp, 'nohome'),
      env: { NVM_DIR: nvm },
      brewPrefixes: [],
    });
    expect(found).toEqual([
      { source: 'nvm', version: '24.0.0', bin: path.join(nvm, 'versions/node/v24.0.0/bin') },
    ]);
  });
});

describe('chooseNode', () => {
  const req = [{ range: '>=22.12.0 <25', source: 'web/package.json (engines.node)' }];
  const node = (version: string, source: InstalledNode['source'] = 'nvm'): InstalledNode => ({
    version,
    source,
    bin: `/x/${source}/${version}/bin`,
  });

  it('asks nothing → nothing to do; the default fits → kept', () => {
    expect(chooseNode([], '26.0.0', [node('24.0.0')])).toEqual({ kind: 'none' });
    expect(chooseNode(req, '24.1.0', [node('24.21.0')])).toMatchObject({ kind: 'default' });
  });

  it('the default does not fit → the newest installed that fits every requirement', () => {
    const choice = chooseNode([...req, { range: '24', source: '.nvmrc' }], '26.12.1', [
      node('22.12.0'),
      node('24.21.0'),
      node('24.11.0', 'homebrew'),
      node('26.12.1'),
    ]);
    expect(choice).toMatchObject({ kind: 'switch', node: node('24.21.0') });
    expect(describeNodeRuntime(choice)).toContain(
      'Node v24.21.0 (nvm, /x/nvm/24.21.0/bin) is first on PATH'
    );
    expect(nodeRuntimeBrief(choice)).toContain('export PATH=/x/nvm/24.21.0/bin:"$PATH"');
  });

  it('no default node at all counts as not fitting', () => {
    expect(chooseNode(req, undefined, [node('24.0.0')])).toMatchObject({ kind: 'switch' });
  });

  it('none installed fits → missing, said plainly with what there is', () => {
    const choice = chooseNode(req, '26.12.1', [node('26.12.1'), node('20.0.0')]);
    expect(choice).toEqual({
      kind: 'missing',
      requirements: req,
      defaultVersion: '26.12.1',
      installed: ['v26.12.1', 'v20.0.0'],
    });
    const said = describeNodeRuntime(choice) as string;
    expect(said).toContain('">=22.12.0 <25" (web/package.json (engines.node))');
    expect(said).toContain('the default node is v26.12.1');
    expect(said).toContain('Untether installs nothing');
    expect(nodeRuntimeBrief(choice)).toMatch(/^\[untether\] The project asks for Node/);
  });
});

describe('resolveNodeRuntime', () => {
  it('reads the project, the default and the installs together; never probes without a requirement', async () => {
    const dir = path.join(tmp, 'resolve');
    write(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '<25' } }));
    const home = path.join(tmp, 'resolve-home');
    fakeNode(path.join(home, '.nvm/versions/node/v24.2.0/bin'));
    const choice = await resolveNodeRuntime(dir, {
      home,
      env: {},
      brewPrefixes: [],
      defaultVersion: async () => '26.0.0',
    });
    expect(choice).toMatchObject({ kind: 'switch', node: { version: '24.2.0' } });
    let probed = false;
    const none = await resolveNodeRuntime(path.join(tmp, 'empty-dir'), {
      defaultVersion: async () => {
        probed = true;
        return '1.0.0';
      },
    });
    expect(none).toEqual({ kind: 'none' });
    expect(probed).toBe(false);
  });
});

describe('putting a Node first on PATH', () => {
  it('pathPrependLine wins over a login profile that reordered PATH, and only once', () => {
    const bin = path.join(tmp, 'with space', 'bin');
    const out = execFileSync(
      '/bin/sh',
      [
        '-c',
        // A profile like `brew shellenv` already put its own folder first.
        `PATH="/opt/homebrew/bin:$PATH"; ${pathPrependLine(bin)}; ${pathPrependLine(bin)}; printf %s "$PATH"`,
      ],
      { encoding: 'utf8' }
    );
    expect(out.split(':').slice(0, 2)).toEqual([bin, '/opt/homebrew/bin']);
    expect(out.split(':').filter((p) => p === bin)).toHaveLength(1);
  });

  it("pathPrependEnv: PATH first, and a CLAUDE_ENV_FILE that runs the user's own one too", () => {
    const dir = path.join(tmp, 'env-files');
    const own = path.join(tmp, 'own-env.sh');
    write(own, 'export OWN_ENV_RAN=yes\n');
    const bin = path.join(tmp, 'node24/bin');
    const vars = pathPrependEnv({ PATH: `/usr/bin:${bin}`, CLAUDE_ENV_FILE: own }, bin, dir);
    expect(vars.PATH).toBe(`${bin}:/usr/bin`);
    expect(path.dirname(vars.CLAUDE_ENV_FILE)).toBe(dir);
    const out = execFileSync(
      '/bin/sh',
      [
        '-c',
        `PATH=/usr/bin:/bin; . "${vars.CLAUDE_ENV_FILE}"; printf '%s|%s' "$OWN_ENV_RAN" "$PATH"`,
      ],
      { encoding: 'utf8' }
    );
    expect(out).toBe(`yes|${bin}:/usr/bin:/bin`);
    // The same request writes the same file once.
    expect(
      pathPrependEnv({ PATH: '/usr/bin', CLAUDE_ENV_FILE: own }, bin, dir).CLAUDE_ENV_FILE
    ).toBe(vars.CLAUDE_ENV_FILE);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('a file it cannot write still leaves PATH set', () => {
    const blocked = path.join(tmp, 'blocked-file');
    write(blocked, 'not a folder');
    const vars = pathPrependEnv({ PATH: '/usr/bin' }, '/n/bin', path.join(blocked, 'sub'));
    expect(vars).toEqual({ PATH: '/n/bin:/usr/bin' });
  });
});

describe('doctor task-node', () => {
  it('warns when no installed Node fits an open task, tells when one was put first, once per folder', async () => {
    const { taskNodeCheck } = await import('../services/doctor-checks.js');
    const dirA = path.join(tmp, 'doctor-a');
    const dirB = path.join(tmp, 'doctor-b');
    const dirC = path.join(tmp, 'doctor-c');
    for (const dir of [dirA, dirB, dirC]) fs.mkdirSync(dir, { recursive: true });
    const requirements = [{ range: '<25', source: 'package.json (engines.node)' }];
    const findings = await taskNodeCheck({
      tasks: () => [
        { name: 'A', workingDir: '/repo', worktreePath: dirA, isolation: 'worktree' },
        { name: 'A2', workingDir: '/repo', worktreePath: dirA, isolation: 'worktree' },
        { name: 'B', workingDir: dirB, isolation: 'none' },
        { name: 'C', workingDir: dirC, isolation: 'none' },
        { name: 'Gone', workingDir: path.join(tmp, 'gone'), isolation: 'none' },
      ],
      resolve: async (dir) =>
        dir === dirA
          ? { kind: 'missing', requirements, defaultVersion: '26.0.0', installed: ['v26.0.0'] }
          : dir === dirB
            ? {
                kind: 'switch',
                requirements,
                defaultVersion: '26.0.0',
                node: { version: '24.0.0', bin: '/n/bin', source: 'nvm' },
              }
            : { kind: 'default', requirements, defaultVersion: '24.0.0' },
    }).run();
    expect(findings.map((f) => [f.check, f.severity, f.key])).toEqual([
      ['task-node', 'warning', `task-node:missing:${dirA}`],
      ['task-node', 'info', `task-node:switch:${dirB}`],
    ]);
    expect(findings[0].problem).toContain('Task "A"');
    expect(findings[0].problem).toContain('no installed Node fits');
  });
});
