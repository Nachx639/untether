import { TitleMode } from '../../shared/types.js';
import { t } from '../i18n/index.js';

/**
 * Get a human-readable, translated description for a title mode
 * @param titleMode The title mode to describe
 * @returns Description of what the title mode does
 */
export function getTitleModeDescription(titleMode: TitleMode): string {
  switch (titleMode) {
    case TitleMode.NONE:
      return t('titleMode.none.description');
    case TitleMode.FILTER:
      return t('titleMode.filter.description');
    case TitleMode.STATIC:
      return t('titleMode.static.description');
    default:
      return '';
  }
}
