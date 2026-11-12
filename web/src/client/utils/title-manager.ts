/**
 * Centralized title management for Untether
 */
import { t } from '../i18n/index.js';

export class TitleManager {
  private static instance: TitleManager;

  private constructor() {}

  static getInstance(): TitleManager {
    if (!TitleManager.instance) {
      TitleManager.instance = new TitleManager();
    }
    return TitleManager.instance;
  }

  /**
   * Title for the session view: "name — Untether", "● name — Untether" while Claude waits
   * for you (design spec 5.2, 2026-10-12), so the tab says which session it is.
   */
  setSessionTitle(sessionName: string, options: { waiting?: boolean } = {}): void {
    const name = sessionName.trim() || 'Untether';
    document.title = `${options.waiting ? '● ' : ''}${name} — Untether`;
  }

  /**
   * Set title for list view with session count
   */
  setListTitle(sessionCount: number): void {
    document.title = sessionCount > 0 ? t('title.sessions', { n: sessionCount }) : 'Untether';
  }

  /**
   * Set title for file browser
   */
  setFileBrowserTitle(): void {
    document.title = `Untether - ${t('files.title')}`;
  }
}

// Export singleton instance
export const titleManager = TitleManager.getInstance();
