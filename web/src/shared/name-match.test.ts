import { describe, expect, it } from 'vitest';
import {
  nameMatches,
  nameMatchScore,
  normalizeForMatch,
  queryTerms,
  recencyBonus,
} from './name-match.js';

describe('name matching (user report: an accented file name was not found)', () => {
  it('ignores case and diacritics', () => {
    expect(normalizeForMatch('Inscripción ÁÉÍÓÚ Ñandú Çà')).toBe('inscripcion aeiou nandu ca');
    expect(normalizeForMatch('Inscripción')).toBe('inscripcion'); // decomposed accent
  });

  it('splits the query into words', () => {
    expect(queryTerms('  Hoja de  inscripcion ')).toEqual(['hoja', 'de', 'inscripcion']);
    expect(queryTerms('informe_final-v2')).toEqual(['informe', 'final', 'v2']);
    expect(queryTerms('   ')).toEqual([]);
  });

  it('matches every word in any order, without accents', () => {
    const name = 'Hoja de inscripción - ejemplo.pdf';
    expect(nameMatches(name, queryTerms('hoja de inscripcion'))).toBe(true);
    expect(nameMatches(name, queryTerms('INSCRIPCION hoja'))).toBe(true);
    expect(nameMatches(name, queryTerms('hoja factura'))).toBe(false);
    expect(nameMatches(name, [])).toBe(true);
  });

  it('ranks exact, prefix, phrase, word starts, then inner matches', () => {
    const terms = queryTerms('hoja de inscripcion');
    const exact = nameMatchScore('Hoja de inscripción.pdf', terms);
    const prefix = nameMatchScore('Hoja de inscripción - ejemplo.pdf', terms);
    const phrase = nameMatchScore('Copia hoja de inscripción.pdf', terms);
    const words = nameMatchScore('Inscripción, hoja y de más.pdf', terms);
    const inner = nameMatchScore('prehoja_xde_reinscripcion.txt', terms);
    expect(exact).toBe(100);
    expect(prefix).toBeLessThan(exact);
    expect(phrase).toBeLessThan(prefix);
    expect(words).toBeLessThan(phrase);
    expect(inner).toBeLessThan(words);
    expect(inner).toBeGreaterThan(0);
    expect(nameMatchScore('otra cosa.pdf', terms)).toBe(0);
  });

  it('gives recent files a bonus that fades with age', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(recencyBonus(now, now)).toBeCloseTo(20);
    expect(recencyBonus(now - 30 * 86_400_000, now)).toBeCloseTo(10);
    expect(recencyBonus(Number.NaN, now)).toBe(0);
  });
});
