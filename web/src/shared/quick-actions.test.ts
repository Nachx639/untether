import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_ACTIONS,
  newQuickActionId,
  parseQuickActions,
  quickActionsFor,
  validateQuickAction,
  validateQuickActionsForSave,
} from './quick-actions.js';

const status = { id: 'status', emoji: '📊', label: 'Estado', prompt: '¿Cómo vamos?' };

describe('parseQuickActions', () => {
  it('reads a valid file, dropping unknown keys', () => {
    const { config, warnings } = parseQuickActions(
      JSON.stringify({
        version: 1,
        actions: [
          { ...status, extra: 'ignored' },
          {
            id: 'compact',
            emoji: '🗜️',
            label: 'Compactar',
            prompt: '/compact',
            confirm: true,
            agents: ['claude'],
          },
        ],
      })
    );
    expect(warnings).toEqual([]);
    expect(config?.actions).toEqual([
      status,
      {
        id: 'compact',
        emoji: '🗜️',
        label: 'Compactar',
        prompt: '/compact',
        confirm: true,
        agents: ['claude'],
      },
    ]);
  });

  it('skips invalid entries with a warning and keeps the rest in order', () => {
    const { config, warnings } = parseQuickActions(
      JSON.stringify({
        version: 1,
        actions: [
          'nope',
          { ...status, prompt: '' },
          status,
          { ...status, label: 'Again' },
          { id: 'x y', emoji: '🙂', label: 'Bad id', prompt: 'p' },
          { id: 'a', emoji: '🙂', label: 'Gemini', prompt: 'p', agents: ['gemini'] },
          { id: 'b', emoji: '🙂', label: 'Confirm', prompt: 'p', confirm: 'yes' },
          { id: 'c', emoji: '🙂', label: 'Codex', prompt: 'p', agents: ['codex', 'codex'] },
        ],
      })
    );
    expect(config?.actions.map((a) => a.id)).toEqual(['status', 'c']);
    expect(config?.actions[1].agents).toEqual(['codex']);
    expect(warnings).toEqual([
      'action 1: not an object',
      'action 2: prompt is required',
      'action 4: duplicate id "status"',
      'action 5: id may only hold letters, digits, - and _',
      'action 6: agents must be a non-empty list of claude, codex',
      'action 7: confirm must be true or false',
    ]);
  });

  it('rejects a file that is not usable as a whole', () => {
    expect(parseQuickActions('{').config).toBeNull();
    expect(parseQuickActions('[]').warnings).toEqual(['not a JSON object']);
    expect(parseQuickActions('{"version":2,"actions":[]}').warnings).toEqual([
      'unsupported version 2',
    ]);
    expect(parseQuickActions('{"version":1}').warnings).toEqual(['actions must be a list']);
  });

  it('caps text lengths', () => {
    expect(validateQuickAction({ ...status, label: 'x'.repeat(41) })).toEqual({
      error: 'label is longer than 40 characters',
    });
  });
});

describe('validateQuickActionsForSave', () => {
  it('accepts a valid list and refuses any invalid entry or duplicate id', () => {
    expect(validateQuickActionsForSave([status])).toEqual({ actions: [status] });
    expect(validateQuickActionsForSave('x')).toEqual({ error: 'actions must be a list' });
    expect(validateQuickActionsForSave([status, { ...status, emoji: '' }])).toEqual({
      error: 'action 2: emoji is required',
    });
    expect(validateQuickActionsForSave([status, status])).toEqual({
      error: 'action 2: duplicate id "status"',
    });
  });
});

describe('quickActionsFor (defaults by agent)', () => {
  const ids = (agent: Parameters<typeof quickActionsFor>[1]) =>
    quickActionsFor(DEFAULT_QUICK_ACTIONS, agent).map((a) => a.id);

  it('gives Claude the five defaults, Compact included', () => {
    expect(ids('claude')).toEqual([
      'status',
      'next-steps',
      'run-tests',
      'summarize-changes',
      'compact',
    ]);
  });

  it('leaves /compact out for Codex', () => {
    expect(ids('codex')).toEqual(['status', 'next-steps', 'run-tests', 'summarize-changes']);
  });

  it('shows no default in a plain shell', () => {
    expect(ids(null)).toEqual([]);
  });

  it('shows an action without agents in every session', () => {
    expect(quickActionsFor([status], null)).toEqual([status]);
    expect(quickActionsFor([status], 'codex')).toEqual([status]);
  });

  it('asks before compacting', () => {
    expect(DEFAULT_QUICK_ACTIONS.find((a) => a.id === 'compact')).toMatchObject({
      prompt: '/compact',
      confirm: true,
      agents: ['claude'],
    });
  });
});

describe('newQuickActionId', () => {
  it('slugs the label and keeps ids unique', () => {
    expect(newQuickActionId('Revisión rápida', [])).toBe('revision-rapida');
    expect(newQuickActionId('Estado', [{ ...status, id: 'estado' }])).toBe('estado-2');
    expect(newQuickActionId('🚀', [])).toBe('action');
  });
});
