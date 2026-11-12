/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUICK_ACTIONS, type QuickActionsResponse } from '../../shared/quick-actions.js';
import type { Session } from '../../shared/types.js';
import { setupFetchMock } from '../../test/utils/component-helpers.js';
import { quickActionsHidden, setQuickActionsHidden } from '../utils/quick-actions-visibility.js';
import type { QuickActionsBar } from './quick-actions-bar.js';
import './quick-actions-bar.js';

const QA_URL = '/api/sessions/s1/quick-actions';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'claude',
    command: ['claude'],
    workingDir: '/repo',
    status: 'running',
    startedAt: '2026-10-18T09:00:00.000Z',
    lastModified: '2026-10-18T09:00:00.000Z',
    claudeStatus: { status: 'idle' },
    ...overrides,
  } as Session;
}

const defaults: QuickActionsResponse = {
  source: 'default',
  path: '/repo/.untether/quick-actions.json',
  actions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })),
  warnings: [],
};

async function render(s: Session, response: QuickActionsResponse = defaults) {
  const fetchMock = setupFetchMock();
  fetchMock.mockResponse(QA_URL, response);
  const onSend = vi.fn();
  const bar = await fixture<QuickActionsBar>(
    html`<quick-actions-bar .session=${s} .onSend=${onSend}></quick-actions-bar>`
  );
  await vi.waitFor(() =>
    expect(bar.querySelector('[data-testid="quick-actions-bar"]')).not.toBeNull()
  );
  return { bar, onSend, fetchMock };
}

const ids = (bar: HTMLElement) =>
  [...bar.querySelectorAll<HTMLElement>('.ut-qa-scroll [data-testid^="quick-action-"]')].map(
    (b) => b.dataset.testid
  );

describe('quick-actions-bar', () => {
  // The setup's localStorage is a stub: say the strip was turned on in Settings.
  const turnedOn = (on: boolean) =>
    vi
      .mocked(localStorage.getItem)
      .mockImplementation((key) => (on && key === 'untether_quick_actions_shown' ? '1' : null));
  beforeEach(() => turnedOn(true));
  afterEach(() => vi.mocked(localStorage.getItem).mockReset());

  it("shows Claude's defaults, Compact included, and sends a tapped prompt", async () => {
    const { bar, onSend } = await render(session());
    expect(ids(bar)).toEqual([
      'quick-action-status',
      'quick-action-next-steps',
      'quick-action-run-tests',
      'quick-action-summarize-changes',
      'quick-action-compact',
    ]);
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-status"]')?.click();
    expect(onSend).toHaveBeenCalledWith(DEFAULT_QUICK_ACTIONS[0].prompt);
  });

  it('leaves Compact out in a Codex session', async () => {
    const { bar } = await render(session({ claudeStatus: undefined, codexActive: true }));
    expect(ids(bar)).not.toContain('quick-action-compact');
    expect(ids(bar)).toHaveLength(4);
  });

  it('asks before an action with confirm, and sends only on Send', async () => {
    const { bar, onSend } = await render(session());
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-compact"]')?.click();
    await bar.updateComplete;
    expect(onSend).not.toHaveBeenCalled();
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-cancel"]')?.click();
    await bar.updateComplete;
    expect(onSend).not.toHaveBeenCalled();

    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-compact"]')?.click();
    await bar.updateComplete;
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-confirm"]')?.click();
    expect(onSend).toHaveBeenCalledWith('/compact');
  });

  it("shows a project's own actions as written", async () => {
    const { bar } = await render(session(), {
      source: 'file',
      path: '/repo/.untether/quick-actions.json',
      actions: [{ id: 'ci', emoji: '🚦', label: 'CI', prompt: 'Is CI green?' }],
      warnings: [],
    });
    expect(ids(bar)).toEqual(['quick-action-ci']);
    expect(bar.querySelector('.ut-qa-label')?.textContent).toBe('CI');
  });

  it('stays off until Settings turns it on, and follows the switch', async () => {
    turnedOn(false);
    expect(quickActionsHidden()).toBe(true);
    turnedOn(true);
    const { bar } = await render(session());
    setQuickActionsHidden(true);
    await bar.updateComplete;
    expect(bar.querySelector('[data-testid="quick-actions-bar"]')).toBeNull();
    setQuickActionsHidden(false);
    await bar.updateComplete;
    expect(bar.querySelector('[data-testid="quick-actions-bar"]')).not.toBeNull();
  });

  it('an empty list keeps the strip with an add chip that opens the editor', async () => {
    const { bar } = await render(session(), {
      source: 'file',
      path: '/repo/.untether/quick-actions.json',
      actions: [],
      warnings: [],
    });
    expect(ids(bar)).toEqual([]);
    expect(bar.querySelector('.ut-qa-scroll [data-testid="quick-actions-add"]')).not.toBeNull();
    expect(bar.querySelector('[data-testid="quick-actions-edit"]')).not.toBeNull();
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-actions-add"]')?.click();
    await bar.updateComplete;
    expect(bar.querySelector('[data-testid="quick-actions-editor"]')).not.toBeNull();
  });

  it('keeps 44 px touch targets', async () => {
    const css = readFileSync(resolve(__dirname, '../styles/session.css'), 'utf8');
    const rule = css.match(/\.ut-qa-btn \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('min-height: 44px');
    expect(rule).toContain('min-width: 44px');
  });

  it('edits: deletes, reorders, adds and saves the whole list to the project', async () => {
    const { bar, fetchMock } = await render(session());
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-actions-edit"]')?.click();
    await bar.updateComplete;
    const rows = () => [...bar.querySelectorAll('[data-testid="quick-action-edit-row"]')];
    expect(rows()).toHaveLength(5);

    rows()[0].querySelector<HTMLButtonElement>('[data-testid="quick-action-delete"]')?.click();
    await bar.updateComplete;
    // Move the new first (Next steps) below Run tests.
    rows()[0].querySelectorAll<HTMLButtonElement>('button')[1].click();
    await bar.updateComplete;

    const label = bar.querySelector<HTMLInputElement>('[data-testid="quick-action-new-label"]');
    const prompt = bar.querySelector<HTMLTextAreaElement>(
      '[data-testid="quick-action-new-prompt"]'
    );
    if (!label || !prompt) throw new Error('editor fields missing');
    label.value = 'Revisa';
    label.dispatchEvent(new Event('input'));
    prompt.value = 'Revisa el diff';
    prompt.dispatchEvent(new Event('input'));
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-action-add"]')?.click();
    await bar.updateComplete;

    const saved = {
      source: 'file',
      path: defaults.path,
      actions: [{ id: 'revisa', emoji: '⚡', label: 'Revisa', prompt: 'Revisa el diff' }],
      warnings: [],
    };
    fetchMock.mockResponse(QA_URL, saved);
    bar.querySelector<HTMLButtonElement>('[data-testid="quick-actions-save"]')?.click();
    await vi.waitFor(() => expect(ids(bar)).toEqual(['quick-action-revisa']));

    const put = fetchMock
      .getCalls()
      .find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    if (!put) throw new Error('no PUT sent');
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect(body.actions.map((a: { id: string }) => a.id)).toEqual([
      'run-tests',
      'next-steps',
      'summarize-changes',
      'compact',
      'revisa',
    ]);
  });
});
