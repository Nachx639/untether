// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const STORAGE_KEY = 'untether_locale';

async function loadI18n() {
  vi.resetModules();
  return import('./index.js');
}

describe('i18n', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it('defaults to English and marks the document ltr', async () => {
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('common.settings')).toBe('Settings');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('starts in the device language when nothing was chosen, and the choice wins', async () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-ES', 'en']);
    let i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('es');
    await i18n.whenLocaleReady();
    expect(i18n.t('common.close')).not.toBe('Close');
    // The device language isn't saved: only a choice is.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    localStorage.setItem(STORAGE_KEY, 'fr');
    i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('fr');
    languages.mockRestore();
  });

  it('maps device languages to ours, English when there is no match', async () => {
    const { deviceLocale } = await loadI18n();
    expect(deviceLocale(['de-DE', 'pt-PT'])).toBe('pt-BR');
    expect(deviceLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(deviceLocale(['zh-TW'])).toBeNull();
    expect(deviceLocale(['ar-EG'])).toBe('ar');
    expect(deviceLocale(['de-DE', 'it'])).toBeNull();
  });

  it('interpolates parameters and leaves unknown placeholders intact', async () => {
    const { t } = await loadI18n();
    expect(t('login.welcomeBack', { user: 'alice' })).toBe('Welcome back, alice');
    expect(t('toast.killPartial', { count: 2 })).toBe('Killed 2 of {total} sessions');
  });

  it('persists the chosen locale, notifies listeners, and restores it on reload', async () => {
    const i18n = await loadI18n();
    const listener = vi.fn();
    window.addEventListener(i18n.LOCALE_CHANGED_EVENT, listener);

    await i18n.setLocale('es');
    window.removeEventListener(i18n.LOCALE_CHANGED_EVENT, listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
    expect(i18n.t('common.settings')).toBe('Ajustes');

    const reloaded = await loadI18n();
    expect(reloaded.getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    // A stored non-English locale arrives as its own chunk; the app waits for it.
    await reloaded.whenLocaleReady();
    expect(reloaded.t('common.settings')).toBe('Ajustes');
  });

  it('ignores an invalid stored locale', async () => {
    localStorage.setItem(STORAGE_KEY, 'xx');
    const i18n = await loadI18n();
    expect(i18n.getLocale()).toBe('en');
  });

  it('cuts a translation around one value, to isolate only that value', async () => {
    const i18n = await loadI18n();
    expect(
      i18n.tAround('macSessions.view.inTmuxWindow', { name: 'qa: 1', index: 2 }, 'name')
    ).toEqual(['tmux · ', 'qa: 1', ' · window 2']);
    await i18n.setLocale('ar');
    expect(
      i18n.tAround('macSessions.setting.locked', { name: '--no-mac-sessions' }, 'name')
    ).toEqual(['حُدِّد عند تشغيل الخادم (', '--no-mac-sessions', ').']);
    // A value the phrase doesn't have is not shown, as with t().
    expect(i18n.tAround('common.cancel', { name: 'x' }, 'name')).toEqual(['إلغاء', '', '']);
  });

  it('sets rtl for Arabic and back to ltr for other languages', async () => {
    const i18n = await loadI18n();
    await i18n.setLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');

    await i18n.setLocale('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('picks the plural form by the language’s own rules ("1 sesión", "2 sesiones")', async () => {
    const i18n = await loadI18n();
    expect(i18n.t('chat.newMessages', { n: 1 })).toBe('1 new reply · jump to latest');
    expect(i18n.t('chat.newMessages', { n: 3 })).toBe('3 new replies · jump to latest');
    await i18n.setLocale('es');
    expect(i18n.t('sidebar.sessionCount', { n: 1 })).toBe('1 sesión');
    expect(i18n.t('sidebar.sessionCount', { n: 2 })).toBe('2 sesiones');
    expect(i18n.t('sidebar.sessionCount', { n: 0 })).toBe('0 sesiones');
    // The commit confirmation said "3 archivo(s)".
    expect(i18n.t('ship.confirmCommit', { n: 1 })).toBe(
      'Hacer commit de 1 archivo con este mensaje:'
    );
    expect(i18n.t('ship.confirmCommit', { n: 3 })).toBe(
      'Hacer commit de 3 archivos con este mensaje:'
    );
    // French uses the singular for 0 too.
    await i18n.setLocale('fr');
    expect(i18n.t('sidebar.sessionCount', { n: 0 })).toBe('0 session');
    // No plural forms in Chinese: the base text, never another language's singular.
    await i18n.setLocale('zh-CN');
    expect(i18n.t('sidebar.sessionCount', { n: 1 })).toBe('1 个会话');
  });

  it('never borrows another language’s plural form', async () => {
    const i18n = await loadI18n();
    const { es } = await import('./locales/es.js');
    delete (es as Partial<typeof es>)['sidebar.sessionCount.one'];
    await i18n.setLocale('es');
    expect(i18n.t('sidebar.sessionCount', { n: 1 })).toBe('1 sesiones');
  });

  it('falls back to English when a key is missing from the active locale', async () => {
    const i18n = await loadI18n();
    const { fr } = await import('./locales/fr.js');
    delete (fr as Partial<typeof fr>)['common.close'];

    await i18n.setLocale('fr');
    expect(i18n.t('common.close')).toBe('Close');
    expect(i18n.t('missing.key' as Parameters<typeof i18n.t>[0])).toBe('missing.key');
  });

  it('keeps working when storage throws', async () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const i18n = await loadI18n();
      expect(i18n.getLocale()).toBe('en');
      expect(() => i18n.setLocale('hi')).not.toThrow();
      expect(i18n.getLocale()).toBe('hi');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  // Codex borrows these texts with its name in Claude's place (shared/agent-push.ts
  // namedForAgent): every translation has to carry the name.
  it('names Claude in every language’s texts that Codex borrows', async () => {
    vi.resetModules();
    const dictionaries = await Promise.all([
      import('./locales/en.js').then((m) => m.en),
      import('./locales/zh-CN.js').then((m) => m.zhCN),
      import('./locales/fr.js').then((m) => m.fr),
      import('./locales/hi.js').then((m) => m.hi),
      import('./locales/es.js').then((m) => m.es),
      import('./locales/ar.js').then((m) => m.ar),
      import('./locales/bn.js').then((m) => m.bn),
      import('./locales/pt-BR.js').then((m) => m.ptBR),
    ]);
    const keys = [
      'notify.needsYou',
      'notify.finished',
      'toast.claudeFinished',
      'answerSheet.title',
    ] as const;
    for (const dictionary of dictionaries) {
      for (const key of keys) expect(dictionary[key]).toContain('Claude');
    }
  });

  it('provides every locale with the same keys as English', async () => {
    vi.resetModules();
    const { en } = await import('./locales/en.js');
    const locales = await Promise.all([
      import('./locales/zh-CN.js').then((m) => m.zhCN),
      import('./locales/fr.js').then((m) => m.fr),
      import('./locales/hi.js').then((m) => m.hi),
      import('./locales/es.js').then((m) => m.es),
      import('./locales/ar.js').then((m) => m.ar),
      import('./locales/bn.js').then((m) => m.bn),
      import('./locales/pt-BR.js').then((m) => m.ptBR),
    ]);
    const englishKeys = Object.keys(en).sort();
    for (const dictionary of locales) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
        expect(placeholders(dictionary[key as keyof typeof en]), key).toEqual(
          placeholders(en[key as keyof typeof en])
        );
      }
    }
  });

  // 2026-11-10: 83 keys nothing read any more (old action bar, session filters, badges) were
  // still translated into eight languages and shipped to every phone. A key has to be named
  // somewhere in src/client or src/shared: whole, as the base of a plural form, or under a prefix the code
  // builds (`theme.${id}`).
  it('has no text that nothing in the client shows', async () => {
    vi.resetModules();
    const { en } = await import('./locales/en.js');
    const sources: string[] = [];
    const read = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'locales') read(path);
        } else if (entry.name.endsWith('.ts') && !/\.(test|browser)\.ts$/.test(entry.name)) {
          sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    read(join(process.cwd(), 'src/client'));
    read(join(process.cwd(), 'src/shared'));
    const source = sources.join('\n');
    const named = (key: string) =>
      ["'", '"', '`'].some((quote) => source.includes(`${quote}${key}${quote}`));
    const builtPrefixes = [
      ...source.matchAll(/`([\w.-]+\.)\$\{/g),
      ...source.matchAll(/'([\w.-]+\.)'\s*\+/g),
    ].map((match) => match[1]);
    const built = (key: string) => builtPrefixes.some((prefix) => key.startsWith(prefix));
    const pluralBase = (key: string) => key.match(/^(.+)\.(?:zero|one|two|few|many|other)$/)?.[1];
    const unused = Object.keys(en).filter((key) => {
      if (named(key) || built(key)) return false;
      const base = pluralBase(key);
      return !(base && (named(base) || built(base)));
    });
    expect(unused).toEqual([]);
  });

  // 2026-11-11: the eight locales are the files most tasks edit (32 tasks in 14 days). A text
  // added at the end of the file makes every such task edit the same lines; next to its area's
  // texts, two tasks only meet when they change the same area.
  describe('where a new text goes', () => {
    /** "tasks" of 'tasks.new.title': the area a text belongs to. */
    const area = (key: string) => key.split('.')[0];
    /**
     * Areas whose texts were already in several places when the rule came, and in how many.
     * The number may only go down: a new text never opens another block of its area.
     */
    const SCATTERED: Record<string, number> = {
      a11y: 2,
      app: 2,
      appearance: 2,
      ask: 4,
      attach: 2,
      auth: 2,
      board: 9,
      branchSelector: 2,
      changes: 2,
      chat: 10,
      cleanup: 2,
      clipboard: 2,
      common: 3,
      confirm: 5,
      create: 4,
      empty: 2,
      files: 3,
      gitInit: 2,
      groupPin: 2,
      header: 6,
      history: 2,
      look: 11,
      macSessions: 5,
      macShare: 2,
      menu: 2,
      mission: 3,
      newChat: 2,
      newChoice: 2,
      notify: 12,
      orch: 3,
      phone: 2,
      phoneList: 2,
      preview: 2,
      previewRows: 3,
      previewView: 2,
      projectSettings: 2,
      quickActions: 2,
      quickKeys: 4,
      repoHeader: 3,
      screenMenu: 2,
      session: 3,
      sessions: 13,
      settings: 19,
      share: 2,
      shield: 5,
      status: 2,
      switcher: 3,
      tasks: 2,
      terminal: 2,
      terminalSettings: 2,
      theme: 3,
      toast: 7,
      whatsNew: 7,
    };

    /** Areas with more blocks of texts than allowed: "tasks: 3 blocks (2 allowed)". */
    function scatteredMore(keys: string[], allowed: Record<string, number>): string[] {
      const blocks = new Map<string, number>();
      keys.forEach((key, index) => {
        if (index === 0 || area(keys[index - 1]) !== area(key)) {
          blocks.set(area(key), (blocks.get(area(key)) ?? 0) + 1);
        }
      });
      return [...blocks]
        .filter(([name, count]) => count > (allowed[name] ?? 1))
        .map(([name, count]) => `${name}: ${count} blocks (${allowed[name] ?? 1} allowed)`);
    }

    it('next to the texts of its area (same first word of the key), never in a new place', async () => {
      vi.resetModules();
      const { en } = await import('./locales/en.js');
      // Fails with the area to move the new text to: put it right after that area's last text.
      expect(scatteredMore(Object.keys(en), SCATTERED)).toEqual([]);
    });

    it('a text of an area added at the end of the file is caught', () => {
      const keys = ['tasks.a', 'tasks.b', 'board.a', 'notify.a'];
      expect(scatteredMore(keys, {})).toEqual([]);
      expect(scatteredMore([...keys, 'tasks.c'], {})).toEqual(['tasks: 2 blocks (1 allowed)']);
      expect(scatteredMore([...keys, 'tasks.c'], { tasks: 2 })).toEqual([]);
      expect(scatteredMore([...keys, 'notify.b', 'fresh.a'], {})).toEqual([]);
    });

    it('in the same place in every language, so the eight files change alike', async () => {
      vi.resetModules();
      const { en } = await import('./locales/en.js');
      const locales = {
        'zh-CN': (await import('./locales/zh-CN.js')).zhCN,
        fr: (await import('./locales/fr.js')).fr,
        hi: (await import('./locales/hi.js')).hi,
        es: (await import('./locales/es.js')).es,
        ar: (await import('./locales/ar.js')).ar,
        bn: (await import('./locales/bn.js')).bn,
        'pt-BR': (await import('./locales/pt-BR.js')).ptBR,
      };
      const english = Object.keys(en);
      for (const [name, dictionary] of Object.entries(locales)) {
        const keys = Object.keys(dictionary);
        const first = keys.findIndex((key, index) => key !== english[index]);
        expect(
          first < 0 ? null : `${name}: ${keys[first]} where en has ${english[first]}`
        ).toBeNull();
      }
    });
  });
});
