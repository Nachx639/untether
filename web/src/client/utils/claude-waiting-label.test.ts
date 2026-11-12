import { describe, expect, it } from 'vitest';
import { CLAUDE_WAITING_REASONS, claudeWaitingReason } from '../../shared/claude-waiting-reason.js';
import type { Messages } from '../i18n/index.js';
import { ar } from '../i18n/locales/ar.js';
import { bn } from '../i18n/locales/bn.js';
import { en } from '../i18n/locales/en.js';
import { es } from '../i18n/locales/es.js';
import { fr } from '../i18n/locales/fr.js';
import { hi } from '../i18n/locales/hi.js';
import { ptBR } from '../i18n/locales/pt-BR.js';
import { zhCN } from '../i18n/locales/zh-CN.js';
import { CLAUDE_WAITING_KEYS, claudeWaitingLabel } from './claude-waiting-label.js';

const LOCALES: Record<string, Messages> = { en, es, fr, 'pt-BR': ptBR, 'zh-CN': zhCN, hi, bn, ar };

describe('claudeWaitingLabel', () => {
  it('translates the reasons Claude Code reports and keeps unknown ones as written', () => {
    expect(claudeWaitingLabel('permission prompt')).toBe('Permission request');
    expect(claudeWaitingLabel('something new')).toBe('something new');
    expect(claudeWaitingLabel(undefined)).toBeUndefined();
  });

  it('knows the reasons in any spelling Claude Code or its hooks use', () => {
    expect(claudeWaitingReason('Permission Prompt')).toBe('permission');
    expect(claudeWaitingReason('permission_prompt')).toBe('permission');
    expect(claudeWaitingReason('idle_prompt')).toBe('input');
    expect(claudeWaitingReason('elicitation_dialog')).toBe('input');
    expect(claudeWaitingReason(' dialog  open ')).toBe('dialog');
    expect(claudeWaitingReason('Bash permission')).toBeUndefined();
  });

  it.each(Object.entries(LOCALES))(
    'every known reason has its own text in %s, never the raw reason Claude wrote',
    (_, messages) => {
      for (const [raw, reason] of CLAUDE_WAITING_REASONS) {
        const text = messages[CLAUDE_WAITING_KEYS[reason]];
        expect(text, `${raw} → ${CLAUDE_WAITING_KEYS[reason]}`).toBeTruthy();
        expect(text).not.toBe(raw);
      }
    }
  );

  it('non-English locales translate every reason rather than copy the English text', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      if (locale === 'en') continue;
      for (const key of Object.values(CLAUDE_WAITING_KEYS)) {
        expect(messages[key], `${locale} ${key}`).not.toBe(en[key]);
      }
    }
  });
});
