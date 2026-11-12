import { beforeAll, describe, expect, it } from 'vitest';
import {
  isDeclineOption,
  type PromptTranslate,
  promptKind,
  shortPromptLabel,
  translatePrompt,
  translatePromptOption,
  translatePromptQuestion,
} from './claude-prompt-text.js';
import { parseScreenChoices } from './claude-screen.js';

const translator =
  (messages: Record<string, string>): PromptTranslate =>
  (key, params) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) =>
      String(params?.[name] ?? `{${name}}`)
    );

// Shared code is also type-checked as a service worker (no Node types, no client files): the
// fixtures and the app's own es/en wording are loaded at run time by specifiers built here.
type Dictionary = Record<string, string>;
let tEs: PromptTranslate = (key) => key;
let tEn: PromptTranslate = (key) => key;
let readText: (url: URL) => string = () => '';

beforeAll(async () => {
  const load = (specifier: string) => import(/* @vite-ignore */ specifier);
  const fs = (await load(['node', 'fs'].join(':'))) as {
    readFileSync(url: URL, encoding: 'utf8'): string;
  };
  readText = (url) => fs.readFileSync(url, 'utf8');
  const locales = new URL('../client/i18n/locales/', import.meta.url);
  const es = (await load(new URL('es.ts', locales).href)) as { es: Dictionary };
  const en = (await load(new URL('en.ts', locales).href)) as { en: Dictionary };
  tEs = translator(es.es);
  tEn = translator(en.en);
});

const FIXTURES = new URL('../server/services/__fixtures__/claude-waiting/', import.meta.url);
const menu = (name: string) => {
  const choices = parseScreenChoices(readText(new URL(name, FIXTURES)));
  if (!choices) throw new Error(`no menu in ${name}`);
  return choices;
};

describe('translatePrompt against the real waiting screens', () => {
  it('a Bash permission: proceed?, Yes, the "don\'t ask again for … in …" and "No, and tell"', () => {
    const choices = menu('permission-bash.txt');
    const shown = translatePrompt(choices, tEs);
    expect(shown.kind).toBe('permission');
    expect(shown.question).toBe('¿Continuar?');
    expect(shown.options).toEqual([
      'Sí',
      'Sí, y no preguntar más por pnpm build en /Users/alice/Projects/untether/web',
      'No, y decirle a Claude qué hacer',
    ]);
    // Display only: the menu itself keeps Claude's text, which is what an answer sends.
    expect(choices.options[1]).toBe(
      "Yes, and don't ask again for pnpm build commands in /Users/alice/Projects/untether/web"
    );
  });

  it('an edit permission: unknown options pass through unchanged', () => {
    const choices = menu('permission-edit.txt');
    const shown = translatePrompt(choices, tEs);
    expect(shown.kind).toBe('permission');
    expect(shown.question).toBe(choices.question);
    expect(shown.options[0]).toBe('Sí');
    expect(shown.options[1]).toBe(choices.options[1]);
    expect(shown.options[2]).toBe('No');
  });

  it('plan approval: the question reads "Aprobar el plan"', () => {
    for (const name of ['plan-approval.txt', 'plan-approval-live.txt', 'plan-approval-short.txt']) {
      const shown = translatePrompt(menu(name), tEs);
      expect(shown.kind, name).toBe('plan');
      expect(shown.question, name).toBe('Aprobar el plan');
    }
    expect(translatePrompt(menu('plan-approval-live.txt'), tEs).options[2]).toBe(
      'No, y decirle a Claude qué hacer'
    );
  });

  it('trust folder (Claude Code and Codex)', () => {
    expect(translatePrompt(menu('trust-folder.txt'), tEs)).toMatchObject({
      kind: 'trust',
      question: '¿Confías en esta carpeta?',
    });
    expect(translatePrompt(menu('codex-trust.txt'), tEs)).toMatchObject({
      kind: 'trust',
      question: '¿Confías en esta carpeta?',
    });
  });

  it('leaves menus it does not know as they are (Codex update)', () => {
    const choices = menu('codex-update.txt');
    const shown = translatePrompt(choices, tEs);
    expect(shown.kind).toBe('question');
    expect(shown.question).toBe(choices.question);
    expect(shown.options).toEqual(choices.options);
  });

  it('in English the wording is Claude Code’s own, shortened', () => {
    const shown = translatePrompt(menu('permission-bash.txt'), tEn);
    expect(shown.question).toBe('Proceed?');
    expect(shown.options[2]).toBe('No, and tell Claude what to do');
  });
});

describe('single strings', () => {
  it('passes unknown text through unchanged', () => {
    expect(translatePromptQuestion('Which file should I use?', tEs)).toBe(
      'Which file should I use?'
    );
    expect(translatePromptOption('Skip until next version', tEs)).toBe('Skip until next version');
    expect(translatePromptOption('', tEs)).toBe('');
  });

  it('translates "don\'t ask again" with and without what and where', () => {
    expect(translatePromptOption("Yes, and don't ask again this session", tEs)).toBe(
      'Sí, y no volver a preguntar'
    );
    expect(translatePromptOption("Yes, and don't ask again for git in /repo", tEs)).toBe(
      'Sí, y no preguntar más por git en /repo'
    );
  });
});

describe('shortPromptLabel', () => {
  it('Sí / Siempre / No for the inline row card', () => {
    const labels = menu('permission-bash.txt').options.map((o) => shortPromptLabel(o, tEs));
    expect(labels).toEqual(['Sí', 'Siempre', 'No']);
    expect(shortPromptLabel('Allow once', tEs)).toBe('Sí');
    expect(shortPromptLabel('Allow for this session', tEs)).toBe('Siempre');
    expect(shortPromptLabel('Tell Claude what to change', tEs)).toBe('No');
    expect(shortPromptLabel('Skip', tEs)).toBeNull();
  });
});

describe('promptKind / isDeclineOption', () => {
  it('reads a plain question as a question', () => {
    expect(promptKind({ question: 'Overwrite it? (y/n)', options: ['Yes', 'No'] })).toBe(
      'question'
    );
  });
  it('knows the "No…" options', () => {
    expect(isDeclineOption('No, and tell Claude what to do differently (esc)')).toBe(true);
    expect(isDeclineOption('Tell Claude what to change')).toBe(true);
    expect(isDeclineOption('Yes')).toBe(false);
    expect(isDeclineOption('Nothing')).toBe(false);
  });
});
