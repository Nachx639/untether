/**
 * Display-only wording for the prompts Claude Code and Codex draw on screen (phone-spec §3.6,
 * 2026-10-12). Their menus are in English whatever the app's language: on a phone in Spanish
 * "Yes, and don't ask again for pnpm build commands in /Users/…/web" is read as
 * "Sí, y no preguntar más por pnpm build en /Users/…/web".
 *
 * Only what is shown changes. An answer always sends the menu's own option text, question and
 * key (the server checks them against the screen), so a translation can never pick another
 * option. Text no pattern knows passes through unchanged.
 *
 * Shared code: the wording comes in as a `t()` so the client's i18n stays on the client.
 */

/** The phone.prompt.* keys this file reads (the client's MessageKey narrows to them). */
export type PromptTextKey =
  | 'phone.prompt.proceed'
  | 'phone.prompt.yes'
  | 'phone.prompt.always'
  | 'phone.prompt.alwaysFor'
  | 'phone.prompt.noTell'
  | 'phone.prompt.short.always'
  | 'phone.prompt.short.no'
  | 'phone.prompt.trust'
  | 'phone.prompt.planApprove';

export type PromptTranslate = (
  key: PromptTextKey,
  params?: Record<string, string | number>
) => string;

/** What a menu is for, as far as its wording tells. */
export type PromptKind = 'permission' | 'plan' | 'trust' | 'question';

/** A menu as the screen parser reads it (claude-screen.ts ScreenChoices, the parts used here). */
export interface PromptLike {
  question: string;
  options: string[];
  detail?: string[];
}

const PROCEED = /^(?:do you want to|would you like to) proceed\?$/i;
const TRUST =
  /^(?:quick safety check: )?(?:is this a project you created or one you trust\?|do you trust the (?:contents of this directory|files in this folder)\?)$/i;
const PLAN_DETAIL = /^(?:ready to code\?|here is claude's plan:|plan:)/i;
const ESC_HINT = /\s*\((?:esc|shift\+tab)\)\s*$/i;

/** What kind of prompt this is: a plan to approve, a folder to trust, a permission, a question. */
export function promptKind(prompt: PromptLike): PromptKind {
  const question = prompt.question.trim();
  if (TRUST.test(question)) return 'trust';
  if (prompt.detail?.some((line) => PLAN_DETAIL.test(line.trim()))) return 'plan';
  if (prompt.options.some((option) => /^yes, and (?:switch to bypass|auto-accept)/i.test(option)))
    return 'plan';
  if (PROCEED.test(question) || /^do you want to (?:make this edit|create|allow)/i.test(question))
    return 'permission';
  return 'question';
}

/** The question in the app's language, or as it is. */
export function translatePromptQuestion(
  question: string,
  t: PromptTranslate,
  kind?: PromptKind
): string {
  const text = question.trim();
  if (TRUST.test(text)) return t('phone.prompt.trust');
  if (kind === 'plan' && (PROCEED.test(text) || text === '')) return t('phone.prompt.planApprove');
  if (PROCEED.test(text)) return t('phone.prompt.proceed');
  return question;
}

/** An option's label in the app's language, or as it is. */
export function translatePromptOption(option: string, t: PromptTranslate): string {
  const text = option.replace(ESC_HINT, '').trim();
  if (/^yes$/i.test(text)) return t('phone.prompt.yes');
  if (/^no$/i.test(text)) return t('phone.prompt.short.no');
  const forWhat = /^yes, and don'?t ask again for (.+?) in (\S+)$/i.exec(text);
  if (forWhat) {
    const what = forWhat[1].replace(/\s+commands?$/i, '').trim();
    return t('phone.prompt.alwaysFor', { what, path: forWhat[2] });
  }
  if (/^yes, and don'?t ask again(?: this session| for this session)?$/i.test(text))
    return t('phone.prompt.always');
  if (/^no, and tell claude what to do(?: differently)?$/i.test(text))
    return t('phone.prompt.noTell');
  if (/^tell claude what to change$/i.test(text)) return t('phone.prompt.noTell');
  return option;
}

/** The whole prompt as shown: question and options translated, the originals left alone. */
export function translatePrompt(
  prompt: PromptLike,
  t: PromptTranslate
): { kind: PromptKind; question: string; options: string[] } {
  const kind = promptKind(prompt);
  return {
    kind,
    question: translatePromptQuestion(prompt.question, t, kind),
    options: prompt.options.map((option) => translatePromptOption(option, t)),
  };
}

/**
 * A one-word label for an inline row card's pill: "Sí", "Siempre" or "No", or null when the
 * option is none of those (the caller shows the translated label).
 */
export function shortPromptLabel(option: string, t: PromptTranslate): string | null {
  const text = option.replace(ESC_HINT, '').trim();
  if (/^(?:yes|allow)\b/i.test(text)) {
    return /don'?t ask again|always|auto-accept|switch to|bypass|for this session/i.test(text)
      ? t('phone.prompt.short.always')
      : t('phone.prompt.yes');
  }
  if (/^no\b/i.test(text) || /^tell claude what to/i.test(text)) return t('phone.prompt.short.no');
  return null;
}

/** "No…" options: they decline and usually want a word for Claude (the composer takes it). */
export function isDeclineOption(option: string): boolean {
  return /^no\b/i.test(option.trim()) || /^tell claude what to/i.test(option.trim());
}
