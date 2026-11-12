/**
 * @vitest-environment happy-dom
 */
import { render } from 'lit';
import { describe, expect, it } from 'vitest';
import {
  CARD_LINE_MAX,
  clipLine,
  explainLine,
  firstLine,
  midCutTitle,
  splitTitleEnd,
  TITLE_END_MAX,
  TITLE_START_MIN,
  titleLinesCut,
} from './card-line.js';

describe('card-line', () => {
  it('folds a text to one line of at most CARD_LINE_MAX characters, cut with …', () => {
    const long = `${'palabra '.repeat(30)}\nsegunda línea`;
    const line = clipLine(long);
    expect([...line].length).toBe(CARD_LINE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toContain('\n');
    expect(clipLine('  corta \n y   breve ')).toBe('corta y breve');
    // Counted by characters, not UTF-16 units: an emoji is one.
    expect([...clipLine('🙂'.repeat(100))].length).toBe(CARD_LINE_MAX);
  });

  it('takes the first non-empty line of a summary', () => {
    expect(firstLine('\n\n  Hecho el login.\nVerificado: pnpm test')).toBe('Hecho el login.');
    expect(firstLine(undefined)).toBe('');
  });

  it('the model line only for a running session', () => {
    const explain = { text: 'Ejecuta los tests', at: 1 };
    expect(explainLine({ status: 'running', explain })).toBe('Ejecuta los tests');
    expect(explainLine({ status: 'exited', explain })).toBe('');
    expect(explainLine(undefined)).toBe('');
  });

  it('a two-line title is cut by a hidden line, not by what its glyphs reach below a tight line', () => {
    // 2026-11-11: WebKit in Comic and Cosmos held 2-4px more than a one-line title's height.
    const title = (scrollHeight: number, clientHeight: number) => {
      const el = document.createElement('span');
      el.style.lineHeight = '18px';
      Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
      Object.defineProperty(el, 'clientHeight', { value: clientHeight });
      document.body.append(el);
      const cut = titleLinesCut(el);
      el.remove();
      return cut;
    };
    expect(title(18, 18)).toBe(false);
    expect(title(22, 18)).toBe(false);
    expect(title(40, 36)).toBe(false);
    expect(title(54, 36)).toBe(true);
    expect(title(58, 36)).toBe(true);
  });

  it('splits a long title so a one-line row keeps the end that tells it apart', () => {
    // 2026-11-10: three queued tasks read the same; their ends were different.
    const start = 'Revisión 2ª vuelta: arreglos claros';
    const ends = [' del servidor', ' e infraestructura', ' iPhone y scripts'];
    const titles = [
      `${start} del servidor`,
      `${start} de agentes e infraestructura`,
      `${start} de web, iPhone y scripts`,
    ];
    titles.forEach((title, index) => {
      const parts = splitTitleEnd(title);
      expect(parts.end).toBe(ends[index]);
      // Nothing lost or added: the two parts are the title.
      expect(parts.start + parts.end).toBe(title);
      expect([...parts.end].length).toBeLessThanOrEqual(TITLE_END_MAX);
    });
    expect(new Set(titles.map((title) => splitTitleEnd(title).end)).size).toBe(3);
    // A short title is whole; a long word gives its last characters.
    expect(splitTitleEnd('Login con Google')).toEqual({ start: 'Login con Google', end: '' });
    expect(splitTitleEnd('ut/tarjetas-de-tarea-titulos-largos-que-se')).toEqual({
      start: 'ut/tarjetas-de-tarea-tit',
      end: 'ulos-largos-que-se',
    });
    // Counted by characters, not UTF-16 units.
    expect(splitTitleEnd('🙂'.repeat(30)).end).toBe('🙂'.repeat(TITLE_END_MAX));
  });

  it('cuts in the middle only a title whose start is worth keeping, and gives the end word by word', () => {
    // 2026-11-10: «Tokenh examples» for «Token auth examples» in the styles with large type.
    expect(splitTitleEnd('Token auth examples')).toEqual({ start: 'Token', end: ' auth examples' });
    // A start under TITLE_START_MIN characters is not a start: the title is one piece.
    expect(splitTitleEnd('Fix authentication')).toEqual({ start: 'Fix authentication', end: '' });
    expect(splitTitleEnd('Fix the login screen')).toEqual({
      start: 'Fix the login screen',
      end: '',
    });
    expect([...splitTitleEnd('Arreglar el inicio de sesión').start].length).toBeGreaterThanOrEqual(
      TITLE_START_MIN
    );

    const parts = (title: string) => {
      const host = document.createElement('span');
      render(midCutTitle(title), host);
      return host;
    };
    const cut = parts('Split lunch and dinner shifts');
    expect(cut.textContent).toBe('Split lunch and dinner shifts');
    // No text between the pieces: a line break of the template would be a second space.
    expect(
      [...cut.childNodes].every((node) => node.nodeType !== Node.TEXT_NODE || !node.data)
    ).toBe(true);
    const words = [...cut.querySelectorAll<HTMLElement>('.ut-mid-end > .ut-mid-word')];
    expect(words.map((word) => word.textContent)).toEqual([' and', ' dinner', ' shifts']);
    // Numbered from the last one: the styles fill the line from the title's end.
    expect(words.map((word) => word.style.order)).toEqual(['2', '1', '0']);
    expect(cut.querySelector('.ut-mid-start')?.getAttribute('data-keep')).toBe('long');
    expect(
      parts('Token auth examples').querySelector('.ut-mid-start')?.getAttribute('data-keep')
    ).toBe('short');
    // The end may leave the line only beside a start that is then cut: well longer than the
    // end's widest word. Beside a short start it stays, its last word cut with its own «…».
    expect(cut.querySelector('.ut-mid-end')?.hasAttribute('data-leave')).toBe(false);
    expect(
      parts('Limpiar enlaces rotos de la guía')
        .querySelector('.ut-mid-end')
        ?.hasAttribute('data-leave')
    ).toBe(true);
    // A long word's end is one piece; a whole title has no end and keeps no room.
    expect(
      parts('ut/tarjetas-de-tarea-titulos-largos-que-se').querySelectorAll('.ut-mid-word').length
    ).toBe(1);
    const whole = parts('Login con Google');
    expect(whole.querySelector('.ut-mid-end')).toBeNull();
    expect(whole.querySelector('.ut-mid-start')?.hasAttribute('data-keep')).toBe(false);
    expect(whole.textContent).toBe('Login con Google');
  });
});
