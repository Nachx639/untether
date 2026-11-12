import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { baseName, isGenericFolder, spokenNames, spokenTitle, tidyName } from './naming';

const home = os.homedir();
const inHome = (...parts: string[]) => path.join(home, ...parts);

describe('copilot session names', () => {
  it('names a session in ~/Projects after what Claude works on (user report)', () => {
    const s = {
      id: 'a',
      workingDir: inHome('Projects'),
      claudeTitle: 'Videos del curso de ecografía',
    };
    expect(baseName(s, home)).toBe('ecografía');
  });

  it('prefers the live Claude title over the saved one', () => {
    expect(
      baseName(
        {
          id: 'a',
          workingDir: inHome('Projects'),
          claudeTitle: 'Old thing',
          claudeStatus: { title: 'Arreglar el login' },
        },
        home
      )
    ).toBe('login');
  });

  it('uses the saved Claude title when the live status has none', () => {
    expect(
      baseName(
        {
          id: 'a',
          workingDir: inHome('Desktop'),
          claudeStatus: {},
          claudeTitle: 'Factura trimestral',
        },
        home
      )
    ).toBe('Factura trimestral');
  });

  it('uses Codex and Gemini titles', () => {
    expect(baseName({ id: 'a', workingDir: home, codexTitle: 'Revisar las facturas' }, home)).toBe(
      'facturas'
    );
    expect(
      baseName({ id: 'a', workingDir: inHome('code'), geminiTitle: 'Traducir la web' }, home)
    ).toBe('Traducir');
  });

  it('treats the home folder and every generic folder name as saying nothing', () => {
    expect(isGenericFolder(home, home)).toBe(true);
    for (const dir of [
      'home',
      'Projects',
      'projects',
      'Proyectos',
      'Desktop',
      'Escritorio',
      'Documents',
      'Documentos',
      'Downloads',
      'Descargas',
      'src',
      'code',
      'dev',
      'repos',
      'tmp',
    ]) {
      expect(isGenericFolder(inHome(dir), home), dir).toBe(true);
      expect(baseName({ id: 'a', workingDir: inHome(dir) }, home), dir).toBe('principal');
    }
    expect(isGenericFolder(inHome('Projects', 'mediguiapp'), home)).toBe(false);
  });

  it('gives no title in a generic folder the name «principal»', () => {
    expect(baseName({ id: 'a', workingDir: home }, home)).toBe('principal');
  });

  it('lets the user title win', () => {
    expect(
      baseName(
        {
          id: 'a',
          workingDir: inHome('Projects'),
          userTitle: 'Curso',
          claudeTitle: 'Videos del curso de ecografía',
        },
        home
      )
    ).toBe('Curso');
  });

  it('uses a real folder name, never the generated session name', () => {
    expect(
      baseName(
        { id: 'a', workingDir: inHome('Projects', 'mediguiapp'), claudeTitle: 'Algo largo aquí' },
        home
      )
    ).toBe('mediguiapp');
  });

  it('tidies names for speech', () => {
    expect(tidyName('UNTETHER')).toBe('Untether');
    expect(tidyName('web-project')).toBe('web');
    expect(tidyName('mediguiapp proyecto')).toBe('mediguiapp');
    expect(tidyName('my_tool')).toBe('my tool');
    expect(tidyName('API')).toBe('API');
  });

  it('keeps title forms to two words at most', () => {
    expect(spokenTitle('Videos del curso de ecografía')).toBe('ecografía');
    expect(spokenTitle('Fix login')).toBe('Fix login');
    expect(spokenTitle('Fix UI bug')).toBe('Fix UI bug');
    expect(spokenTitle('✳ Ecografía')).toBe('Ecografía');
    expect(spokenTitle('✳ Videos del curso de ecografía')).toBe('ecografía');
    expect(spokenTitle('Investigating flaky CI test failures in the payment module')).toBe(
      'payment module'
    );
    for (const t of ['Revisar todas las facturas del trimestre pasado', 'Uno dos tres cuatro']) {
      expect(spokenTitle(t).split(' ').length).toBeLessThanOrEqual(2);
    }
  });

  it('makes names unique for two sessions on the same repo', () => {
    const names = spokenNames(
      [
        { id: 'a', workingDir: inHome('Projects', 'web'), claudeTitle: 'Arreglar el login' },
        { id: 'b', workingDir: inHome('Projects', 'web'), claudeTitle: 'Nueva tienda online' },
      ],
      home
    );
    expect(names.get('a')).toBe('web login');
    expect(names.get('b')).toBe('web online');
    for (const n of names.values()) expect(n.split(' ').length).toBeLessThanOrEqual(2);
  });

  it('falls back to «dos» when nothing tells two sessions apart', () => {
    const names = spokenNames(
      [
        { id: 'a', workingDir: inHome('Projects', 'web') },
        { id: 'b', workingDir: inHome('Projects', 'web') },
        { id: 'c', workingDir: inHome('Projects', 'web') },
      ],
      home
    );
    expect([...names.values()]).toEqual(['web', 'web dos', 'web tres']);
  });

  it('says the number in the copilot language', () => {
    const two = [
      { id: 'a', workingDir: inHome('Projects', 'web') },
      { id: 'b', workingDir: inHome('Projects', 'web') },
    ];
    expect([...spokenNames(two, home, 'en').values()]).toEqual(['web', 'web two']);
    expect([...spokenNames(two, home, 'es').values()]).toEqual(['web', 'web dos']);
  });

  it('names a home-folder session by its title, without symbols', () => {
    const names = spokenNames(
      [{ id: 'a', workingDir: home, claudeStatus: { title: '✳ Ecografía' } }],
      home
    );
    expect(names.get('a')).toBe('Ecografía');
  });

  it('leaves different names alone', () => {
    const names = spokenNames(
      [
        { id: 'a', workingDir: inHome('Projects'), claudeTitle: 'Videos del curso de ecografía' },
        { id: 'b', workingDir: inHome('Projects', 'mediguiapp') },
      ],
      home
    );
    expect(names.get('a')).toBe('ecografía');
    expect(names.get('b')).toBe('mediguiapp');
  });
});
