import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createFilesystemRoutes } from './filesystem.js';

// User report (2026-10-14): a PDF opened from the file browser showed its raw bytes as text.
describe('GET /api/fs/preview, binary detection', () => {
  let dir: string;
  const app = express();
  app.use('/api', createFilesystemRoutes());

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-preview-'));
    fs.writeFileSync(
      path.join(dir, 'Hoja de inscripción - ejemplo.pdf'),
      Buffer.concat([
        Buffer.from('%PDF-1.6\n%'),
        Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]),
        Buffer.from('\n1 0 obj\n'),
      ])
    );
    fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    fs.writeFileSync(path.join(dir, 'notas.ts'), 'const nombre = "inscripción";\n');
    fs.writeFileSync(path.join(dir, 'LEEME'), 'texto sin extensión, con acentos: áéíóú\n');
  });

  afterAll(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  const preview = (name: string) =>
    request(app)
      .get('/api/fs/preview')
      .query({ path: path.join(dir, name) });

  it('reports a PDF as binary instead of dumping its bytes', async () => {
    const res = await preview('Hoja de inscripción - ejemplo.pdf');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('binary');
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.content).toBeUndefined();
  });

  it('reports a small file with NUL bytes as binary', async () => {
    expect((await preview('blob.dat')).body.type).toBe('binary');
  });

  it('still shows small text files, also ones the mime table calls video (.ts)', async () => {
    const ts = await preview('notas.ts');
    expect(ts.body.type).toBe('text');
    expect(ts.body.content).toContain('inscripción');
    expect((await preview('LEEME')).body.type).toBe('text');
  });
});

// 2026-10-20 (security audit): /api/fs/raw served .html/.svg as the app's own origin.
describe('GET /api/fs/raw, never rendered as this origin', () => {
  let dir: string;
  const app = express();
  app.use('/api', createFilesystemRoutes());

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-raw-'));
    fs.writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  afterAll(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  const raw = (name: string) =>
    request(app)
      .get('/api/fs/raw')
      .query({ path: path.join(dir, name) });

  it('sends HTML as a sandboxed, unsniffed download', async () => {
    const res = await raw('page.html');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename\*=UTF-8''page\.html$/
    );
  });

  it('shows images inline, still sandboxed', async () => {
    const res = await raw('logo.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
});

// 2026-11-10: git ran in the server's own folder, so only that repository's files had a diff.
describe("GET /api/fs/diff and /api/fs/diff-content, in the file's own repository", () => {
  let repo: string;
  const app = express();
  app.use('/api', createFilesystemRoutes());
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: repo,
      stdio: 'pipe',
    });

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-diff-')));
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'two\n');
  });
  afterAll(() => fs.rmSync(repo, RM_TEST_DIR));

  it('diffs a file of another project against its HEAD', async () => {
    const file = path.join(repo, 'src', 'a.ts');
    const diff = await request(app).get('/api/fs/diff').query({ path: file });
    expect(diff.status).toBe(200);
    expect(diff.body.hasDiff).toBe(true);
    expect(diff.body.diff).toContain('-one');
    const content = await request(app).get('/api/fs/diff-content').query({ path: file });
    expect(content.body).toMatchObject({ originalContent: 'one\n', modifiedContent: 'two\n' });
  });
});
