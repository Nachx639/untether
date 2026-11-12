import { t } from '../i18n/index.js';

/** A one-tap prompt above the phone composer. */
export interface QuickPrompt {
  label: string;
  text: string;
}

const STORAGE_KEY = 'ut-quick-prompts';

/** Defaults follow the UI language; they are only written to storage once edited. */
export function defaultQuickPrompts(): QuickPrompt[] {
  return [
    { label: t('prompts.continue'), text: t('prompts.continueText') },
    { label: t('prompts.yes'), text: t('prompts.yesText') },
    { label: t('prompts.explain'), text: t('prompts.explainText') },
    { label: t('prompts.tests'), text: t('prompts.testsText') },
    { label: t('prompts.fix'), text: t('prompts.fixText') },
    { label: '/compact', text: '/compact' },
  ];
}

/** This device's edited list, or null while it still uses the defaults. */
export function loadCustomQuickPrompts(): QuickPrompt[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (p): p is QuickPrompt =>
            typeof p?.label === 'string' && typeof p?.text === 'string' && p.text.trim() !== ''
        );
      }
    }
  } catch {
    // Blocked storage or a corrupt value: the defaults are used.
  }
  return null;
}

/** Keep this device's own list; `null` goes back to the (localized) defaults. */
export function saveQuickPrompts(prompts: QuickPrompt[] | null) {
  try {
    if (prompts) localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or storage full: the edit lasts until reload.
  }
}

/** A prompt ending in "…" is a template: it goes into the field to be finished, not sent. */
export function templateText(text: string): string | null {
  const match = /^(.*?)\s*(?:…|\.\.\.)$/s.exec(text.trimEnd());
  if (!match) return null;
  return match[1] ? `${match[1]} ` : '';
}
