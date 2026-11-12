import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');

/**
 * 2026-11-10 (scripts/docs audit): docs/INDEX.md sent readers to a second tree of documents
 * (core/, guides/, features/…) that described an API and `ut` commands that never existed, and
 * scripts/validate-docs.sh, which checks the Mintlify navigation, was run by nothing. Every link
 * between the repository's documents and every page of docs.json has to lead to a file.
 */
describe('documentation links', () => {
  const tracked = execFileSync('git', ['ls-files', '*.md', '*.mdx'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file && !file.startsWith('web/node-pty/'));

  it('relative links between documents lead to a file', () => {
    expect(tracked.length).toBeGreaterThan(20);
    const broken: string[] = [];
    for (const file of tracked) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/```[\s\S]*?```/g, '');
      for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
        if (!fs.existsSync(path.resolve(ROOT, path.dirname(file), target))) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('every page of docs.json exists', () => {
    const pages: string[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'pages' && Array.isArray(value)) {
            for (const page of value) typeof page === 'string' ? pages.push(page) : collect(page);
          } else collect(value);
        }
      }
    };
    collect(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs.json'), 'utf8')));
    expect(pages.length).toBeGreaterThan(20);
    const missing = pages.filter(
      (page) => !['', '.md', '.mdx'].some((ext) => fs.existsSync(path.join(ROOT, page + ext)))
    );
    expect(missing).toEqual([]);
  });
});
