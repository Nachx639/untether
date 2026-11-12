import { describe, expect, it } from 'vitest';
import {
  filesNamed,
  isZoneName,
  namedPaths,
  namesPath,
  parseZoneRule,
  stoppedText,
  touchLine,
  waitsForNote,
  waitsForShort,
  zonePatternMatches,
  zonesNamed,
} from './task-serial.js';
import type { TaskWaitFor } from './tasks.js';

describe('the paths a prompt names', () => {
  it('takes words with a slash and file names with an extension, as written', () => {
    expect(
      namedPaths(
        'Arregla `web/src/client/app.ts:15` y list.css. Mira también ./scripts/gemelo.sh, (docs/ui-tokens.md) y web/src/server/**.'
      )
    ).toEqual([
      'web/src/client/app.ts',
      'list.css',
      'scripts/gemelo.sh',
      'docs/ui-tokens.md',
      'web/src/server',
    ]);
  });

  it('takes no web address, absolute path, version number or plain word for a path', () => {
    expect(
      namedPaths(
        'Lee https://example.com/a/b.html y /Users/me/x.ts, usa Node v24.22.1 y mejora el cliente y/o el servidor.'
      )
    ).toEqual([]);
  });

  it('a named word names a file by its path, its end, or a folder it is in', () => {
    const file = 'web/src/client/styles/list.css';
    expect(namesPath('web/src/client/styles/list.css', file)).toBe(true);
    expect(namesPath('list.css', file)).toBe(true);
    expect(namesPath('styles/list.css', file)).toBe(true);
    expect(namesPath('web/src/client', file)).toBe(true);
    expect(namesPath('src/client', file)).toBe(true);
    expect(namesPath('ist.css', file)).toBe(false);
    expect(namesPath('web/src/cli', file)).toBe(false);
    expect(filesNamed(['list.css', 'mac'], ['mac/App.swift', file, 'web/a.ts'])).toEqual([
      'mac/App.swift',
      file,
    ]);
  });
});

describe('zones', () => {
  it('a rule is "<path pattern>=<zone name>"', () => {
    expect(parseZoneRule('web/src/client/**=client')).toEqual({
      pattern: 'web/src/client/**',
      zone: 'client',
    });
    expect(parseZoneRule('./mac = mac')).toEqual({ pattern: 'mac', zone: 'mac' });
    expect(parseZoneRule('web/src/client')).toBeNull();
    expect(parseZoneRule('=client')).toBeNull();
    expect(parseZoneRule('web/**=two words')).toBeNull();
    expect(isZoneName('núcleo-1')).toBe(true);
    expect(isZoneName('a,b')).toBe(false);
    expect(isZoneName('')).toBe(false);
  });

  it('a pattern covers the paths under it and the folder it reaches into', () => {
    expect(zonePatternMatches('web/src/client/**', 'web/src/client/app.ts')).toBe(true);
    expect(zonePatternMatches('web/src/client/**', 'web/src/client')).toBe(true);
    expect(zonePatternMatches('web/src/client/**', 'web/src/server/app.ts')).toBe(false);
    expect(zonePatternMatches('mac', 'mac/Untether/App.swift')).toBe(true);
    expect(zonePatternMatches('mac', 'machine/a.ts')).toBe(false);
    expect(zonePatternMatches('**/*.css', 'list.css')).toBe(true);
    expect(zonePatternMatches('**/*.css', 'web/src/client/styles/list.css')).toBe(true);
    expect(zonePatternMatches('web/*/shared/*.ts', 'web/src/shared/tasks.ts')).toBe(true);
    expect(zonePatternMatches('web/*/shared/*.ts', 'web/src/shared/deep/tasks.ts')).toBe(false);
    // A pattern's dots and brackets are plain characters.
    expect(zonePatternMatches('web/a.ts', 'web/abts')).toBe(false);
  });

  it('a prompt is in the zones whose rule a named path falls under; none named, none given', () => {
    const rules = ['web/src/client/**=client', 'web/src/server/**=server', 'web/**=web'];
    expect(zonesNamed('Cambia web/src/client/app.ts', rules)).toEqual(['client', 'web']);
    expect(zonesNamed('Cambia web/src/server/app.ts y web/src/client/a.ts', rules)).toEqual([
      'client',
      'server',
      'web',
    ]);
    expect(zonesNamed('Mejora el cliente web', rules)).toEqual([]);
    expect(zonesNamed('Cambia docs/a.md', rules)).toEqual([]);
    expect(zonesNamed('Cambia web/src/client/app.ts', undefined)).toEqual([]);
  });
});

describe('the words of a waiting task', () => {
  const id = '11111111-aaaa';
  const waits: TaskWaitFor[] = [
    { taskId: 'aaaaaaaa-1', name: 'Uno', why: 'after', state: 'working' },
    { taskId: 'bbbbbbbb-2', name: 'Dos', why: 'zone', zone: 'core', state: 'needs_you' },
  ];

  it('list: the ids; status: what it waits for and what can be done', () => {
    expect(waitsForShort(waits)).toBe('waits for aaaaaaaa, bbbbbbbb');
    expect(waitsForShort([])).toBeUndefined();
    expect(
      waitsForNote({
        id,
        queued: { repoPath: '/r', since: '', order: 1, position: 2, of: 3, waitsFor: waits },
      })
    ).toBe(
      "Waits for aaaaaaaa «Uno» (working), bbbbbbbb «Dos» (needs you, zone core): it starts by itself once they merge or close, from a base with that work. It keeps its place in line (2 of 3) and holds no slot. 'ut task retry 11111111 --force' starts it now without that work, 'ut task discard 11111111' drops it."
    );
    expect(waitsForNote({ id, queued: { repoPath: '/r', since: '', order: 1 } })).toBe('');
  });

  it('a waited-for task that stopped: only that one is named, with the decisions', () => {
    const stopped: TaskWaitFor[] = [
      waits[0],
      { taskId: 'cccccccc-3', name: 'Tres', why: 'after', state: 'failed', stopped: true },
    ];
    expect(waitsForShort(stopped)).toBe('waits for aaaaaaaa, cccccccc (stopped: decide)');
    expect(stoppedText({ id }, stopped)).toBe(
      'It waits for cccccccc «Tres» (failed), which will not merge by itself: it does not start on its own. Decide: `ut task retry cccccccc` tries the failed one again (this one then starts by itself once it merges); `ut task retry 11111111 --force` starts it now without that work; `ut task discard 11111111` drops it.'
    );
  });

  it('ut task new: what it touches that another task changes', () => {
    expect(
      touchLine({ id }, { taskId: 'aaaaaaaa-1', name: 'Uno', files: ['a.ts', 'b.ts'], count: 7 })
    ).toBe(
      "Touches the same as aaaaaaaa «Uno» (a.ts, b.ts (+5 more)): use --after aaaaaaaa (discard this one first: 'ut task discard 11111111') or leave it running."
    );
  });
});
