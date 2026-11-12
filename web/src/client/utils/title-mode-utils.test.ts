import { afterEach, describe, expect, it } from 'vitest';
import { TitleMode } from '../../shared/types';
import { setLocale } from '../i18n/index.js';
import { getTitleModeDescription } from './title-mode-utils';

describe('title-mode-utils', () => {
  describe('getTitleModeDescription', () => {
    it('should return correct description for NONE mode', () => {
      expect(getTitleModeDescription(TitleMode.NONE)).toBe('Apps control their own titles');
    });

    it('should return correct description for FILTER mode', () => {
      expect(getTitleModeDescription(TitleMode.FILTER)).toBe('Blocks all title changes');
    });

    it('should return correct description for STATIC mode', () => {
      expect(getTitleModeDescription(TitleMode.STATIC)).toBe('Shows path and command');
    });

    it('is translated', async () => {
      await setLocale('es');
      expect(getTitleModeDescription(TitleMode.STATIC)).toBe('Muestra ruta y comando');
      expect(getTitleModeDescription(TitleMode.FILTER)).toBe('Bloquea todos los cambios de título');
    });

    afterEach(async () => {
      await setLocale('en');
    });

    it('should return empty string for unknown mode', () => {
      // @ts-expect-error Testing invalid input
      expect(getTitleModeDescription('UNKNOWN')).toBe('');
    });

    it('should handle all TitleMode enum values', () => {
      // Ensure all enum values are covered
      Object.values(TitleMode).forEach((mode) => {
        const description = getTitleModeDescription(mode);
        expect(description).toBeTruthy();
        expect(typeof description).toBe('string');
      });
    });
  });
});
