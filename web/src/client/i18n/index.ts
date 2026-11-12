/**
 * Minimal, dependency-free i18n for the Untether web client.
 *
 * English (`locales/en.ts`) is the source of truth: its keys type every other
 * locale, so a missing translation fails typecheck. At runtime a key missing
 * from the active locale falls back to English, then to the key itself.
 *
 * Only English ships in the main bundle. Other locales are separate chunks (esbuild
 * `splitting`), loaded on first use: the seven non-English dictionaries were ~474 KB of
 * the ~1.57 MB minified client every phone downloaded (2026-10-02). Until a locale's
 * chunk arrives t() answers in English; the root app waits for whenLocaleReady() before
 * its first render, and LOCALE_CHANGED_EVENT fires once the strings are in.
 *
 * Usage in a Lit component:
 *   protected readonly i18n = new LocaleController(this); // re-renders on language change
 *   html`<button>${t('common.cancel')}</button>`
 *   t('login.welcomeBack', { user: 'alice' }) // "Welcome back, {user}"
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { en, type MessageKey, type Messages } from './locales/en.js';

export type { MessageKey, Messages };

export const SUPPORTED_LOCALES = ['en', 'zh-CN', 'hi', 'es', 'fr', 'ar', 'bn', 'pt-BR'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'untether_locale';
export const LOCALE_CHANGED_EVENT = 'untether-locale-changed';

/** Each language shown in its own name, for pickers. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '中文',
  hi: 'हिन्दी',
  es: 'Español',
  fr: 'Français',
  ar: 'العربية',
  bn: 'বাংলা',
  'pt-BR': 'Português',
};

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar']);

// Literal import() paths so esbuild can split each locale into its own chunk.
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Partial<Messages>>> = {
  'zh-CN': () => import('./locales/zh-CN.js').then((m) => m.zhCN),
  hi: () => import('./locales/hi.js').then((m) => m.hi),
  es: () => import('./locales/es.js').then((m) => m.es),
  fr: () => import('./locales/fr.js').then((m) => m.fr),
  ar: () => import('./locales/ar.js').then((m) => m.ar),
  bn: () => import('./locales/bn.js').then((m) => m.bn),
  'pt-BR': () => import('./locales/pt-BR.js').then((m) => m.ptBR),
};

const DICTIONARIES: Partial<Record<Locale, Partial<Messages>>> = { en };
const loading = new Map<Locale, Promise<void>>();

/** Fetches a locale's dictionary once; failures leave English in place and may retry. */
function loadLocale(locale: Locale): Promise<void> {
  if (DICTIONARIES[locale]) return Promise.resolve();
  let pending = loading.get(locale);
  if (!pending) {
    pending = LOADERS[locale as Exclude<Locale, 'en'>]()
      .then((dictionary) => {
        DICTIONARIES[locale] = dictionary;
      })
      .catch((error: unknown) => {
        console.warn(`[i18n] failed to load locale ${locale}`, error);
      })
      .finally(() => loading.delete(locale));
    loading.set(locale, pending);
  }
  return pending;
}

function notifyLocaleChanged(locale: Locale): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGED_EVENT, { detail: { locale } }));
}

export type TranslationParams = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The device's language when it is one of ours, else null. Chinese maps to zh-CN only for
 * Simplified Chinese (zh, zh-CN, zh-Hans, zh-SG); any Portuguese to pt-BR.
 */
export function deviceLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language]
): Locale | null {
  for (const raw of languages) {
    const tag = String(raw ?? '').toLowerCase();
    if (!tag) continue;
    if (tag.startsWith('zh')) {
      if (/^zh(-cn|-hans|-sg|$)/.test(tag)) return 'zh-CN';
      continue;
    }
    if (tag.startsWith('pt')) return 'pt-BR';
    const base = tag.split('-')[0];
    const match = SUPPORTED_LOCALES.find((locale) => locale === base);
    if (match) return match;
  }
  return null;
}

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage unavailable (private mode, blocked site data): use the device's language.
  }
  // Nothing chosen yet: the device's language if it is one of ours, else English. Decided on
  // 2026-10-03 (it used to be English regardless): a Spanish-speaking user's fresh
  // install (the home-screen app has its own storage) opened in English. The language chosen
  // in the picker always wins; this one is never saved, so it follows the device.
  return deviceLocale() ?? DEFAULT_LOCALE;
}

let currentLocale: Locale = readStoredLocale();
// Anything that rendered before a non-English dictionary arrived re-renders on the event.
let ready: Promise<void> =
  currentLocale === DEFAULT_LOCALE
    ? Promise.resolve()
    : loadLocale(currentLocale).then(() => notifyLocaleChanged(currentLocale));

/** Resolves once the active locale's strings are loaded (or failed to, falling back to English). */
export function whenLocaleReady(): Promise<void> {
  return ready;
}

export function isRtlLocale(locale: Locale = currentLocale): boolean {
  return RTL_LOCALES.has(locale);
}

/** Reflect the active locale on <html lang dir>. */
export function applyLocaleToDocument(locale: Locale = currentLocale): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = locale;
  root.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Switches language now; listeners hear about it once the locale's strings are loaded. */
export function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return Promise.resolve();
  const changed = locale !== currentLocale;
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Persisting is best effort.
  }
  applyLocaleToDocument(locale);
  ready = loadLocale(locale);
  if (!changed) return ready;
  if (DICTIONARIES[locale]) {
    notifyLocaleChanged(locale);
    return ready;
  }
  return ready.then(() => {
    if (currentLocale === locale) notifyLocaleChanged(locale);
  });
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value: string | number | undefined = params[name];
    return value === undefined ? match : String(value);
  });
}

const pluralRules = new Map<string, Intl.PluralRules>();

/** The locale's plural category for `n` ("one", "few", "many", "other"…). */
function pluralCategory(locale: string, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

/**
 * Translate `key` into the active locale, falling back to English. With a numeric `n`, a
 * plural form `<key>.one` (or `.few`, `.many`… where a language needs one) is used when the
 * active language itself has it, chosen by its plural rules: "1 activa", "2 activas". Another
 * language's plural form is never borrowed.
 */
export function t(key: MessageKey, params?: TranslationParams): string {
  const dictionary = DICTIONARIES[currentLocale] as Partial<Record<string, string>> | undefined;
  const n = params?.n;
  const plural =
    typeof n === 'number' ? dictionary?.[`${key}.${pluralCategory(currentLocale, n)}`] : undefined;
  const template = plural ?? DICTIONARIES[currentLocale]?.[key] ?? en[key] ?? key;
  return interpolate(template, params);
}

/**
 * t(key, params) cut around the value of `params[name]`: the text before it, the value, and the
 * text after it. Rendered with only that value in its own element (user text in <bdi>, a
 * command with dir="ltr"), the rest of the phrase follows the page's direction; a whole phrase
 * in <bdi> takes the direction of its first letter, and in Arabic it reads backwards when that
 * is a product name ("tmux · {name} · النافذة {index}").
 */
export function tAround(
  key: MessageKey,
  params: TranslationParams,
  name: string
): [before: string, value: string, after: string] {
  const marker = '\u0000';
  const value = String(params[name] ?? '');
  const [before, ...rest] = t(key, { ...params, [name]: marker }).split(marker);
  return rest.length ? [before, value, rest.join(value)] : [before, '', ''];
}

/**
 * Lit controller that re-renders its host whenever the locale changes.
 * Add it as a field: `protected readonly i18n = new LocaleController(this);`
 */
export class LocaleController implements ReactiveController {
  private readonly onLocaleChanged = () => this.host.requestUpdate();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    window.addEventListener(LOCALE_CHANGED_EVENT, this.onLocaleChanged);
  }

  hostDisconnected(): void {
    window.removeEventListener(LOCALE_CHANGED_EVENT, this.onLocaleChanged);
  }
}

applyLocaleToDocument();
