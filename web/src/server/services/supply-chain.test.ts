import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  fixedVersion,
  lockedPackages,
  parseCargoLock,
  parseGoSum,
  parsePackageLock,
  parsePackageResolved,
  parsePnpmLock,
  parseRequirements,
  queryOsv,
  unusedDependencies,
} from './supply-chain.js';

describe('a real repository', () => {
  let repo: string;
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const commit = () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-supply-'));
  });
  afterEach(() => {
    fs.rmSync(repo, RM_TEST_DIR);
  });

  it('each lockfile keeps its own entry for the same version', async () => {
    const lock = (name: string) =>
      JSON.stringify({ packages: { [`node_modules/${name}`]: { version: '1.1.11' } } });
    write('web/package-lock.json', lock('brace-expansion'));
    write('docs/package-lock.json', lock('brace-expansion'));
    commit();
    const found = await lockedPackages(repo);
    expect(found.map((pkg) => pkg.lockfile).sort()).toEqual([
      'docs/package-lock.json',
      'web/package-lock.json',
    ]);
  });

  it('finds the direct dependencies nothing in their package imports (2026-10-23: ws in mac/)', async () => {
    // mac/: ws declared, only Swift says "ws" (a URL scheme), and web/ imports its own ws.
    write('mac/package.json', JSON.stringify({ dependencies: { ws: '^8.20.0' } }));
    write('mac/Client.swift', 'components.scheme = "ws"\n');
    write(
      'mac/package-lock.json',
      JSON.stringify({ packages: { 'node_modules/ws': { version: '8.20.0' } } })
    );
    write(
      'web/package.json',
      JSON.stringify({
        dependencies: {
          ws: '^8.20.0',
          '@scope/sub': '1.0.0',
          'cli-tool': '1.0.0',
          'via-config': '1.0.0',
          'left.pad': '1.0.0',
          'node-addon-api': '1.0.0',
          '@types/node': '1.0.0',
        },
        scripts: { start: 'cli-tool serve' },
      })
    );
    write(
      'web/src/server.ts',
      "import { WebSocketServer } from 'ws';\nimport x from '@scope/sub/deep';\n"
    );
    write(
      'web/binding.gyp',
      "{ 'include_dirs': ['<!@(node -p \"require(\\'node-addon-api\\').include\")'] }\n"
    );
    write('web/vite.config.js', 'export default { plugins: ["via-config"] };\n');
    // A look-alike name is no use of left.pad.
    write('web/src/other.ts', "import 'leftXpad';\n");
    commit();
    const unused = await unusedDependencies(repo);
    expect(unused.map((dep) => `${dep.manifest} ${dep.name}`)).toEqual([
      'mac/package.json ws',
      'web/package.json left.pad',
    ]);
    expect(unused[0].proof).toContain('mac/');
    expect(unused[0].proof).toContain('no script of mac/package.json names it');
  });

  it('a folder that is no git repository proposes nothing', async () => {
    expect(await unusedDependencies(repo)).toEqual([]);
  });
});

describe('lockfiles', () => {
  it('pnpm-lock v9, v6 and v5 keys, peers dropped', () => {
    const v9 = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies: {}',
      'packages:',
      '',
      "  '@babel/core@7.24.0':",
      '    resolution: {integrity: x}',
      '  tar@6.2.0:',
      '    resolution: {integrity: y}',
      'snapshots:',
      '  react-dom@18.2.0(react@18.2.0):',
      '    dependencies: {}',
    ].join('\n');
    expect(parsePnpmLock(v9).map((p) => `${p.name}@${p.version}`)).toEqual([
      '@babel/core@7.24.0',
      'tar@6.2.0',
      'react-dom@18.2.0',
    ]);
    expect(parsePnpmLock('packages:\n  /tar@6.1.0:\n    x\n')[0]).toMatchObject({
      name: 'tar',
      version: '6.1.0',
    });
    expect(parsePnpmLock('packages:\n  /@scope/a/1.0.0:\n    x\n')[0]).toMatchObject({
      name: '@scope/a',
      version: '1.0.0',
    });
  });

  it('package-lock, Cargo.lock, go.sum, requirements and Package.resolved', () => {
    expect(
      parsePackageLock(
        JSON.stringify({
          packages: {
            '': { version: '1.0.0' },
            'node_modules/ws': { version: '8.20.0' },
            'node_modules/a/node_modules/@s/b': { version: '2.0.0' },
            'node_modules/local': { link: true },
          },
        })
      ).map((p) => `${p.name}@${p.version}`)
    ).toEqual(['ws@8.20.0', '@s/b@2.0.0']);
    expect(
      parseCargoLock(
        '[[package]]\nname = "me"\nversion = "0.1.0"\n\n[[package]]\nname = "libc"\nversion = "0.2.150"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
      )
    ).toEqual([
      { ecosystem: 'crates.io', name: 'libc', version: '0.2.150', lockfile: 'Cargo.lock' },
    ]);
    expect(
      parseGoSum('golang.org/x/net v0.17.0 h1:a\ngolang.org/x/net v0.17.0/go.mod h1:b\n').map(
        (p) => `${p.name}@${p.version}`
      )
    ).toEqual(['golang.org/x/net@0.17.0']);
    expect(
      parseRequirements(
        '# x\nDjango==4.2.1\nrequests>=2\nflask[async]==2.3.0 ; python_version>"3"\n'
      )
    ).toEqual([
      { ecosystem: 'PyPI', name: 'Django', version: '4.2.1', lockfile: 'requirements.txt' },
      { ecosystem: 'PyPI', name: 'flask', version: '2.3.0', lockfile: 'requirements.txt' },
    ]);
    expect(
      parsePackageResolved(
        JSON.stringify({
          pins: [
            { location: 'https://github.com/apple/swift-nio.git', state: { version: '2.60.0' } },
          ],
        })
      )[0]
    ).toMatchObject({
      ecosystem: 'SwiftURL',
      name: 'https://github.com/apple/swift-nio',
      version: '2.60.0',
    });
  });
});

describe('OSV', () => {
  const pkg = { ecosystem: 'npm', name: 'tar', version: '6.1.0', lockfile: 'pnpm-lock.yaml' };

  it('the first fixed version above the locked one, in the same package', () => {
    expect(
      fixedVersion(
        {
          affected: [
            {
              package: { name: 'other', ecosystem: 'npm' },
              ranges: [{ type: 'SEMVER', events: [{ fixed: '6.1.1' }] }],
            },
            {
              package: { name: 'tar', ecosystem: 'npm' },
              ranges: [
                { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '6.2.1' }] },
                { type: 'SEMVER', events: [{ introduced: '7.0.0' }, { fixed: '7.5.7' }] },
              ],
            },
          ],
        },
        pkg
      )
    ).toBe('6.2.1');
  });

  it('batches the query and reads the details of what it found; only names and versions go out', async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body) bodies.push(init.body);
      if (url.endsWith('/querybatch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'GHSA-1',
          aliases: ['CVE-1'],
          summary: 'path traversal',
          database_specific: { severity: 'MODERATE' },
          affected: [
            {
              package: { name: 'tar', ecosystem: 'npm' },
              ranges: [{ type: 'SEMVER', events: [{ fixed: '6.1.1' }] }],
            },
          ],
        }),
      };
    });
    const hits = await queryOsv([pkg, { ...pkg, name: 'ws' }], fetchFn);
    expect(hits).toEqual([
      {
        pkg,
        advisories: [
          {
            id: 'GHSA-1',
            aliases: ['CVE-1'],
            summary: 'path traversal',
            severity: 'medium',
            fixed: '6.1.1',
          },
        ],
      },
    ]);
    expect(JSON.parse(bodies[0])).toEqual({
      queries: [
        { package: { name: 'tar', ecosystem: 'npm' }, version: '6.1.0' },
        { package: { name: 'ws', ecosystem: 'npm' }, version: '6.1.0' },
      ],
    });
  });

  it('throws when OSV fails (the next check tries again)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(queryOsv([pkg], fetchFn)).rejects.toThrow(/503/);
  });
});
