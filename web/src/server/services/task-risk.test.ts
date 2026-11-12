import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  assessRisk,
  collectRiskInput,
  globToRegExp,
  parseAddedLines,
  parseChangedLines,
  parseNumstatZ,
  parseRawZ,
  type RiskFileChange,
  type RiskRule,
} from './task-risk';

function mod(file: string, extra: Partial<RiskFileChange> = {}): RiskFileChange {
  return { path: file, status: 'M', insertions: 1, deletions: 1, ...extra };
}

const cases: {
  name: string;
  files: RiskFileChange[];
  ignore?: string[];
  expected: { rule: RiskRule; file?: string }[];
}[] = [
  { name: 'ordinary edit', files: [mod('src/app.ts', { addedLines: ['x()'] })], expected: [] },
  {
    name: 'mass deletion',
    files: [
      mod('src/a.ts', { insertions: 10, deletions: 300 }),
      mod('src/b.ts', { deletions: 260 }),
    ],
    expected: [{ rule: 'mass-deletion' }],
  },
  {
    name: 'many deletions balanced by insertions is fine',
    files: [mod('src/a.ts', { insertions: 400, deletions: 600 })],
    expected: [],
  },
  {
    name: 'five deleted files',
    files: ['a', 'b', 'c', 'd', 'e'].map((n) =>
      mod(`src/${n}.ts`, { status: 'D', insertions: 0, deletions: 3 })
    ),
    expected: [{ rule: 'files-deleted' }],
  },
  {
    name: 'four deleted files is fine',
    files: ['a', 'b', 'c', 'd'].map((n) =>
      mod(`src/${n}.ts`, { status: 'D', insertions: 0, deletions: 3 })
    ),
    expected: [],
  },
  {
    name: 'gutted file',
    files: [mod('src/big.ts', { linesBefore: 300, insertions: 5, deletions: 200 })],
    expected: [{ rule: 'file-gutted', file: 'src/big.ts' }],
  },
  {
    name: 'file split into modules beside it is not gutted; new files elsewhere or too small do not count',
    files: [
      mod('src/ui/view.ts', { linesBefore: 4000, insertions: 10, deletions: 3960 }),
      mod('src/ui/view/a.ts', { status: 'A', insertions: 2000, deletions: 0 }),
      mod('src/ui/view/b.ts', { status: 'A', insertions: 1900, deletions: 0 }),
      mod('src/core/big.ts', { linesBefore: 1000, insertions: 0, deletions: 900 }),
      mod('src/other/new.ts', { status: 'A', insertions: 900, deletions: 0 }),
      mod('src/core/tiny.ts', { status: 'A', insertions: 100, deletions: 0 }),
    ],
    expected: [{ rule: 'file-gutted', file: 'src/core/big.ts' }],
  },
  {
    name: 'small file losing everything is not gutted',
    files: [mod('src/small.ts', { linesBefore: 150, insertions: 0, deletions: 150 })],
    expected: [],
  },
  {
    name: 'deleted test file',
    files: [mod('src/foo.test.ts', { status: 'D', insertions: 0, deletions: 20 })],
    expected: [{ rule: 'test-deleted', file: 'src/foo.test.ts' }],
  },
  {
    name: 'test moved and rewritten (D + A with the same name) is not deleted; another name is',
    files: [
      mod('src/test/helpers/foo.test.ts', { status: 'D', insertions: 0, deletions: 20 }),
      mod('src/test/unit/foo.test.ts', { status: 'A', insertions: 40, deletions: 0 }),
      mod('src/bar.test.ts', { status: 'D', insertions: 0, deletions: 20 }),
    ],
    expected: [{ rule: 'test-deleted', file: 'src/bar.test.ts' }],
  },
  {
    name: 'secret files',
    files: [
      mod('.env', { status: 'A' }),
      mod('config/.env.production', { status: 'A' }),
      mod('certs/server.pem', { status: 'A' }),
      mod('deploy/id_ed25519', { status: 'A' }),
      mod('.npmrc'),
      mod('aws/credentials.json'),
    ],
    expected: [
      { rule: 'secret-file', file: '.env' },
      { rule: 'secret-file', file: 'config/.env.production' },
      { rule: 'secret-file', file: 'certs/server.pem' },
      { rule: 'secret-file', file: 'deploy/id_ed25519' },
      { rule: 'deploy', file: 'deploy/id_ed25519' },
      { rule: 'secret-file', file: '.npmrc' },
      { rule: 'secret-file', file: 'aws/credentials.json' },
    ],
  },
  {
    name: 'example env files are fine',
    files: [mod('.env.example', { status: 'A' }), mod('web/.env.sample')],
    expected: [],
  },
  ...[
    'const k = "AKIAABCDEFGHIJKLMNOP";',
    '-----BEGIN RSA PRIVATE KEY-----',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuv',
    'OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
    'slack: xoxb-1234567890-abcdefghij',
    'maps: AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
    'const apiKey = "q8w7e6r5t4y3u2i1o0p9";',
    "token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'",
  ].map((line) => ({
    name: `secret content: ${line.slice(0, 20)}`,
    files: [mod('src/config.ts', { addedLines: ['ok()', line] })],
    expected: [{ rule: 'secret-content' as RiskRule, file: 'src/config.ts' }],
  })),
  {
    // 2026-11-01: plain code calling a method named skip held a merge as a disabled test.
    name: 'a skip() of plain code is not a disabled test',
    files: [
      mod('src/walk.ts', { addedLines: ['if (!options.skip(full)) add(full);', 'iter.only(x)'] }),
    ],
    expected: [],
  },
  {
    // 2026-11-01: an i18n message id held a merge as a hard-coded secret.
    name: 'dotted message keys are not secrets',
    files: [
      mod('src/status.ts', {
        addedLines: [
          "  tokens: 'board.budget.tokens',",
          "  secretHint: 'settings.secret-hint.title',",
        ],
      }),
    ],
    expected: [],
  },
  {
    name: 'env var references are not secrets',
    files: [
      mod('src/config.ts', {
        addedLines: ['const apiKey = process.env.API_KEY;', `password: "\${PASSWORD}"`],
      }),
    ],
    expected: [],
  },
  ...[
    '.github/workflows/ci.yml',
    '.gitlab-ci.yml',
    'vercel.json',
    'apps/api/fly.toml',
    'Dockerfile.prod',
    'docker-compose.yml',
    'infra/main.tf',
    'k8s/deploy.yaml',
    'charts/helm/values.yaml',
    'mac/App.entitlements',
    '.github/actions/setup/action.yml',
    '.circleci/config.yml',
    'Jenkinsfile',
    'ansible/site.yml',
    'scripts/release.sh',
    'docs/RELEASE.md',
  ].map((file) => ({
    name: `deploy: ${file}`,
    files: [mod(file)],
    expected: [{ rule: 'deploy' as RiskRule, file }],
  })),
  {
    name: 'signing change in xcconfig',
    files: [mod('mac/Shared.xcconfig', { addedLines: ['DEVELOPMENT_TEAM = ABC123'] })],
    expected: [{ rule: 'deploy', file: 'mac/Shared.xcconfig' }],
  },
  {
    name: 'version bump in xcconfig is fine',
    files: [mod('mac/version.xcconfig', { addedLines: ['MARKETING_VERSION = 1.2'] })],
    expected: [],
  },
  {
    name: 'package.json scripts changed',
    files: [
      mod('web/package.json', {
        packageScripts: { before: { test: 'vitest' }, after: { test: 'echo ok' } },
      }),
    ],
    expected: [{ rule: 'check-config', file: 'web/package.json' }],
  },
  {
    name: 'package.json deps only is fine',
    files: [
      mod('package.json', {
        packageScripts: { before: { test: 'vitest' }, after: { test: 'vitest' } },
      }),
    ],
    expected: [],
  },
  ...[
    'Makefile',
    'web/vitest.config.ts',
    'jest.config.js',
    'playwright.config.ts',
    'biome.json',
    '.eslintrc.cjs',
    'eslint.config.mjs',
    'tsconfig.server.json',
  ].map((file) => ({
    name: `check config: ${file}`,
    files: [mod(file)],
    expected: [{ rule: 'check-config' as RiskRule, file }],
  })),
  {
    // 2026-11-02: a fixture's config is test data, not the project's check.
    name: 'a config inside test fixtures is not check config',
    files: [
      mod('web/src/test/fixtures/leaky-run/vitest.config.ts'),
      mod('examples/basic/tsconfig.json'),
    ],
    expected: [],
  },
  ...[
    'it.skip("a", () => {})',
    'describe.only("x"',
    'test.concurrent.skip("y"',
    'xit("later"',
    '// @ts-nocheck',
  ].map((line) => ({
    name: `test disabled: ${line}`,
    files: [mod('src/a.test.ts', { addedLines: [line] })],
    expected: [{ rule: 'test-disabled' as RiskRule, file: 'src/a.test.ts' }],
  })),
  {
    // 2026-11-04: a guard test's fixture quoting the call is not a disabled test.
    name: 'a disabled-test call quoted inside a string is not a disabled test',
    files: [
      mod('src/guard.test.ts', {
        addedLines: [
          `    "describe.skip('y', function () {",`,
          "  const src = `it.only('x', () => {})`;",
          "  expect(find('test.skip(')).toBe(true);",
        ],
      }),
    ],
    expected: [],
  },
  {
    name: 'big binary',
    files: [
      mod('assets/video.mp4', {
        status: 'A',
        binary: true,
        insertions: null,
        deletions: null,
        sizeBytes: 6 * 1024 * 1024,
      }),
    ],
    expected: [{ rule: 'binary', file: 'assets/video.mp4' }],
  },
  {
    name: 'small binary is fine',
    files: [mod('icon.png', { binary: true, insertions: null, deletions: null, sizeBytes: 2048 })],
    expected: [],
  },
  {
    name: 'submodule',
    files: [mod('vendor/lib', { submodule: true })],
    expected: [{ rule: 'submodule', file: 'vendor/lib' }],
  },
  {
    name: 'riskIgnore exempts files and aggregates',
    files: [
      mod('db/migrations/002.sql'),
      ...['a', 'b', 'c', 'd', 'e'].map((n) =>
        mod(`fixtures/${n}.json`, { status: 'D', insertions: 0, deletions: 200 })
      ),
    ],
    ignore: ['db/migrations/**', 'fixtures/'],
    expected: [],
  },
  // 2026-10-20: risk by what the change touches: migrations and auth code need the user.
  ...[
    'db/migrations/001_init.sql',
    'db/migrate/20261020_add_users.rb',
    'alembic/versions/abc_add.py',
    'prisma/schema.prisma',
    'src/db/001.migration.ts',
  ].map((file) => ({
    name: `migration: ${file}`,
    files: [mod(file)],
    expected: [{ rule: 'migration' as RiskRule, file }],
  })),
  // 2026-10-20: server-side auth logic only (by path), plus changed lines that touch it.
  ...[
    'src/server/middleware/auth.ts',
    'web/src/server/services/session-permissions.ts',
    'api/login.py',
    'src/auth/session.ts',
    'src/rbac/policy.go',
    'lib/jwt.ts',
    'pkg/oauth_client.go',
    'src/server/session-store.ts',
    'api/middleware/cookie_session.py',
  ].map((file) => ({
    name: `auth: ${file}`,
    files: [mod(file)],
    expected: [{ rule: 'auth' as RiskRule, file }],
  })),
  {
    name: 'not auth: UI, client code, copy, docs, tests, author names (2026-10-20)',
    files: [
      mod('src/author.ts'),
      mod('src/components/AuthorCard.tsx'),
      mod('docs/auth.md'),
      mod('src/auth/session.test.ts'),
      mod('src/components/LoginButton.tsx'),
      mod('src/screens/LoginScreen.tsx'),
      mod('web/src/client/components/role-badge.tsx'),
      mod('src/useAuthStore.ts'),
      mod('src/guards/README.md'),
      mod('src/auth/strings.ts'),
      mod('src/OAuthCallback.tsx'),
      mod('src/security-headers.ts'),
      mod('src/i18n/permissions-copy.ts'),
      mod('app/permissions.py'),
      mod('src/client/login-view.ts'),
      mod('src/security/headers.ts'),
      // 2026-11-02: terminal sessions, not logins.
      mod('web/src/server/services/session-recordings.ts'),
      mod('web/src/server/services/exited-session-cleanup.ts'),
      mod('web/src/server/routes/sessions.ts'),
    ],
    expected: [],
  },
  {
    name: 'auth by content: a changed line verifies tokens or checks permissions (2026-10-20)',
    files: [
      mod('src/lib/request.ts', { addedLines: ['const claims = jwt.verify(token, key);'] }),
      mod('app/views.py', { removedLines: ['@login_required'] }),
      mod('src/store/hash.ts', { addedLines: ['const h = await bcrypt.hash(pw, 12);'] }),
      mod('src/components/Gate.tsx', { addedLines: ['if (!hasPermission(user)) return null;'] }),
      mod('src/lib/request.test.ts', { addedLines: ['jwt.verify(token, key)'] }),
      mod('src/lib/plain.ts', { addedLines: ['const token = nextToken();'] }),
    ],
    expected: [
      { rule: 'auth', file: 'src/lib/request.ts' },
      { rule: 'auth', file: 'app/views.py' },
      { rule: 'auth', file: 'src/store/hash.ts' },
    ],
  },
  {
    name: 'conflict markers committed (2026-10-20)',
    files: [
      mod('src/a.ts', { addedLines: ['<<<<<<< HEAD', 'const a = 1;', '=======', '>>>>>>> main'] }),
      mod('docs/x.md', { addedLines: ['<<<<<<<< not seven', '>>>>>>>x', 'a <<<<<<< b'] }),
    ],
    expected: [{ rule: 'conflict-marker', file: 'src/a.ts' }],
  },
  {
    name: 'basename glob in riskIgnore',
    files: [mod('apps/web/Dockerfile'), mod('Dockerfile')],
    ignore: ['Dockerfile'],
    expected: [],
  },
];

describe('assessRisk', () => {
  it.each(cases)('$name', ({ files, ignore, expected }) => {
    const findings = assessRisk({ files }, ignore);
    expect(findings.map(({ rule, file }) => (file ? { rule, file } : { rule }))).toEqual(expected);
    for (const f of findings) expect(f.detail).toBeTruthy();
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.md', 'docs/a.md', true],
    ['*.md', 'a.mdx', false],
    ['docs/*.md', 'docs/a.md', true],
    ['docs/*.md', 'docs/x/a.md', false],
    ['docs/**', 'docs/x/a.md', true],
    ['**/fixtures/**', 'a/b/fixtures/c.json', true],
    ['**/fixtures/**', 'fixtures/c.json', true],
    ['file?.txt', 'file1.txt', true],
  ])('%s vs %s → %s', (glob, file, match) => {
    expect(globToRegExp(glob).test(file)).toBe(match);
  });
});

describe('git output parsers', () => {
  it('parses raw -z with renames', () => {
    const z = (s: string) => s.replace(/\|/g, '\0');
    const out = z(
      ':100644 100644 aaa bbb M|src/a.ts|:100644 100644 ccc ddd R095|old.ts|new.ts|:160000 160000 e f M|vendor/lib|'
    );
    expect(parseRawZ(out)).toEqual([
      expect.objectContaining({ status: 'M', path: 'src/a.ts' }),
      expect.objectContaining({ status: 'R', oldPath: 'old.ts', path: 'new.ts' }),
      expect.objectContaining({ status: 'M', path: 'vendor/lib', newMode: '160000' }),
    ]);
  });

  it('parses numstat -z with renames and binaries', () => {
    const out = '3\t1\tsrc/a.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '-\t-\timg.png\0';
    const map = parseNumstatZ(out);
    expect(map.get('src/a.ts')).toEqual({ insertions: 3, deletions: 1 });
    expect(map.get('new.ts')).toEqual({ insertions: 0, deletions: 0 });
    expect(map.get('img.png')).toEqual({ insertions: null, deletions: null });
  });

  it('collects added lines per file', () => {
    const out = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '-bye',
    ].join('\n');
    expect([...parseAddedLines(out)]).toEqual([['a.ts', ['new']]]);
  });

  it('parseChangedLines: removed lines too, a deleted file\'s, and "-- x" inside a hunk (2026-10-20)', () => {
    const out = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1 @@',
      '--- not a header',
      '-requireAuth(req);',
      '+++ not a header either',
      'diff --git a/gone.py b/gone.py',
      '--- a/gone.py',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-@login_required',
    ].join('\n');
    const { added, removed } = parseChangedLines(out);
    expect([...added]).toEqual([['a.ts', ['++ not a header either']]]);
    expect([...removed]).toEqual([
      ['a.ts', ['-- not a header', 'requireAuth(req);']],
      ['gone.py', ['@login_required']],
    ]);
  });
});

describe('collectRiskInput (real git)', () => {
  const GIT_ENV = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
      .toString()
      .trim();
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'task-risk-'));
    git('init', '-q', '-b', 'main');
    write('big.ts', `${Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n')}\n`);
    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }));
    write('keep.test.ts', 'it("a", () => {});\n');
    write('old-name.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'ut/task');
    write('big.ts', 'line0\n');
    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'true' } }));
    fs.rmSync(path.join(repo, 'keep.test.ts'));
    git('mv', 'old-name.ts', 'new-name.ts');
    write('.env', 'X=1\n');
    write('src/a.ts', 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'task');
  });
  afterAll(() => fs.rmSync(repo, RM_TEST_DIR));

  it('gathers stats, line counts, scripts and added lines; assessRisk flags them', async () => {
    const input = await collectRiskInput(repo, 'main');
    const byPath = new Map(input.files.map((f) => [f.path, f]));
    expect(byPath.get('big.ts')).toMatchObject({ status: 'M', linesBefore: 300, deletions: 299 });
    expect(byPath.get('new-name.ts')).toMatchObject({ status: 'R', oldPath: 'old-name.ts' });
    expect(byPath.get('package.json')?.packageScripts).toEqual({
      before: { test: 'vitest' },
      after: { test: 'true' },
    });
    expect(byPath.get('src/a.ts')?.addedLines?.[0]).toContain('ghp_');
    const rules = assessRisk(input).map((f) => `${f.rule}:${f.file ?? ''}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        'file-gutted:big.ts',
        'test-deleted:keep.test.ts',
        'secret-file:.env',
        'secret-content:src/a.ts',
        'check-config:package.json',
      ])
    );
  });

  it('throws for an unknown base', async () => {
    await expect(collectRiskInput(repo, 'no-such-ref')).rejects.toThrow(/git diff failed/);
  });
});
