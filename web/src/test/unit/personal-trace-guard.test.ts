import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tracesIn, tracesInTree } from '../../../../scripts/personal-trace.mjs';

/**
 * No tracked text file or file name carries a personal trace (a vetoed proper name, a real home
 * folder, a real tailnet, a real e-mail address). The rules, and how to veto another name, are in
 * scripts/personal-trace.mjs: the public exporter (scripts/public-export.sh) runs the same ones
 * on the copy it makes.
 */
const ROOT = path.resolve(__dirname, '../../../..');

describe('personal traces', () => {
  // Built here, never written: the guard's own file has to pass too.
  const person = ['na', 'cho'].join('');
  const project = ['beaver', 'den'].join('');

  it('reads a vetoed name whatever its case, alone, in a path or inside an identifier', () => {
    const cased = person[0].toUpperCase() + person.slice(1);
    expect(tracesIn(`// 2026-11-07, ${cased}: organize the sessions`)).toHaveLength(1);
    expect(tracesIn(`repo: '/p/${project}/sub'`)).toHaveLength(1);
    expect(tracesIn(`const ${project}Path = 1; "${project}-app"`)).toHaveLength(1);
    expect(tracesIn(`my${cased}Thing`)).toHaveLength(1);
    expect(tracesIn(`${person.toUpperCase()}_HOME`)).toHaveLength(1);
    // A longer word that only contains it is another word.
    expect(tracesIn(`${person}s with cheese`)).toEqual([]);
    expect(tracesIn('the project «bakery», Alex and the agent Otter')).toEqual([]);
    // Never in clear in what a failure prints.
    expect(tracesIn(cased).join(' ')).not.toContain(person);
  });

  it('reads a home folder, a tailnet and an address that are not placeholders', () => {
    // In pieces, as the names above: this file is tracked and read like any other.
    const [real, hex, named, at] = ['realperson', 'tail9f3b21', 'tiger-bass', '@'];
    expect(tracesIn(`cd /Users/${person}639/Projects`)).toContain(`home: ${person}639`);
    expect(tracesIn(`/home/${real}/.ssh`)).toEqual([`home: ${real}`]);
    expect(tracesIn('/Users/me/x /Users/alex/.untether /home/user/a /Users/$USER ~/x')).toEqual([]);
    expect(tracesIn('`/Users/[^/]+/` and /Users/<name> and /Users/${name}')).toEqual([]);

    expect(tracesIn(`https://mac.${hex}.ts.net`)).toEqual([`tailnet: ${hex}.ts.net`]);
    expect(tracesIn(`https://mac.${named}.ts.net:443`)).toEqual([`tailnet: ${named}.ts.net`]);
    expect(tracesIn('mac.tailnet.ts.net, test-machine.tail1234.ts.net')).toEqual([]);

    expect(tracesIn(`write to someone${at}gmail.com`)).toEqual([`mail: someone${at}gmail.com`]);
    expect(
      tracesIn(
        'user@example.com a@sub.example.org x@host.invalid me@my-mac.local noreply@anthropic.com git@github.com:o/r.git'
      )
    ).toEqual([]);
    expect(tracesIn('authenticate-pam@1.0.5.patch icon_512x512@2x.png')).toEqual([]);
    expect(tracesIn(`toc${at}daybefore.net`, 'web/src/a.ts')).toHaveLength(1);
    expect(tracesIn(`toc${at}daybefore.net`, 'web/node-pty/src/unix/pty.cc')).toEqual([]);
  });

  it('are in no tracked file or file name', () => {
    const { stray, unusedMail } = tracesInTree(ROOT);
    expect(stray).toEqual([]);
    // An entry that excuses nothing any more goes: the list can only shrink.
    expect(unusedMail).toEqual([]);
  }, 60_000);
});
