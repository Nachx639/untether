// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/index.js';
import {
  ANSWER_OPEN_GUARD_MS,
  ANSWER_STALE_CLOSE_MS,
  closeAnswerSheet,
  openAnswerSheet,
} from './answer-sheet';

const permission = {
  question: 'Do you want to proceed?',
  options: ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)'],
};

type Route = (init?: RequestInit) => { status: number; body?: unknown };

function mockApi(routes: Record<string, Route>) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/sessions/s1', '');
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const handler = routes[`${init?.method ?? 'GET'} ${path}`];
      const { status, body } = handler ? handler(init) : { status: 500 };
      return new Response(JSON.stringify(body ?? {}), { status });
    })
  );
  return calls;
}

const sheet = () => document.querySelector('[data-testid="answer-sheet"]');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tap = (el: Element | null | undefined) => {
  el?.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
  el?.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
};

describe('answer sheet', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    closeAnswerSheet();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // A test that fails before its own useRealTimers must not leave the next ones on a fake clock.
    vi.useRealTimers();
  });

  it('answers with the key of what it shows, never with one read at the tap', async () => {
    // Taking the key read at the tap made the server compare the screen with itself: a stale
    // sheet approved whatever came next with the same question (fifth review, 2026-10-03).
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const answers = () => calls.filter((c) => c.path === '/answer').map((c) => c.body);
    let live: unknown = { ...permission, key: 'K1' };
    const calls = mockApi({
      'GET /prompt': () =>
        live ? { status: 200, body: { waiting: true, choices: live } } : { status: 500 },
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await vi.advanceTimersByTimeAsync(10);
    now += ANSWER_OPEN_GUARD_MS + 1;
    live = { ...permission, key: 'K2' };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await vi.advanceTimersByTimeAsync(10);
    expect(answers()).toEqual([expect.objectContaining({ option: 1, key: 'K1' })]);
    vi.useRealTimers();
  });

  it("answers from a push's choices with its fingerprint of the key, and long options match", async () => {
    // Opened from a push and unable to read at first (the phone waking up): the push carries
    // the key's fingerprint, and its options are cut to 80 characters (fifth review).
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const longOption = `Yes, and don't ask again for pnpm build commands in ${'/x'.repeat(30)}`;
    const full = { question: permission.question, options: ['Yes', longOption, 'No'] };
    const fromPush = { ...full, options: full.options.map((o) => o.slice(0, 80)), keyHash: 'H' };
    let live: unknown = null;
    const calls = mockApi({
      'GET /prompt': () =>
        live ? { status: 200, body: { waiting: true, choices: live } } : { status: 500 },
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1', choices: fromPush });
    await vi.advanceTimersByTimeAsync(3000);
    now += ANSWER_OPEN_GUARD_MS + 1;
    live = { ...full, key: 'K' };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await vi.advanceTimersByTimeAsync(10);
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(calls.filter((c) => c.path === '/answer').map((c) => c.body)).toEqual([
      expect.objectContaining({ option: 1, keyHash: 'H' }),
    ]);
    vi.useRealTimers();
  });

  it('names Codex for its prompts and offers its options, no written reply (2026-11-10)', async () => {
    const approval = {
      question: 'Would you like to run the following command?',
      options: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'],
      detail: ['touch nuevo.txt'],
      key: 'touchnuevo.txtYes,proceed(y)No',
    };
    const calls = mockApi({
      // The server says whose prompt it is: opened from a push, the sheet knew no session.
      'GET /prompt': () => ({
        status: 200,
        body: { waiting: true, agent: 'codex', choices: approval },
      }),
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    await flush();
    expect(sheet()?.querySelector('.ans-eyebrow')?.textContent).toContain('Codex');
    expect(sheet()?.querySelector('.ans-eyebrow')?.textContent).not.toContain('Claude');
    expect(document.querySelector('[data-testid="answer-reply"]')).toBeNull();
    const buttons = document.querySelectorAll('[data-testid="answer-choice"]');
    expect(buttons).toHaveLength(2);
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(buttons[0]);
    await flush();
    await flush();
    expect(calls[calls.length - 1]).toMatchObject({
      path: '/answer',
      body: { option: 1, question: approval.question, key: approval.key },
    });
  });

  it('keeps Claude’s name and the written reply for Claude’s prompts', async () => {
    mockApi({
      'GET /prompt': () => ({
        status: 200,
        body: { waiting: true, agent: 'claude', choices: permission },
      }),
    });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await flush();
    expect(sheet()?.querySelector('.ans-eyebrow')?.textContent).toContain('Claude');
    expect(document.querySelector('[data-testid="answer-reply"]')).not.toBeNull();
  });

  it('sends the chosen option after re-reading the live prompt', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 200, body: { success: true } }),
    });
    const onSent = vi.fn();
    openAnswerSheet({ sessionId: 's1', choices: permission, onSent });
    await flush();
    const buttons = document.querySelectorAll('[data-testid="answer-choice"]');
    expect(buttons).toHaveLength(3);

    // The tap that opened the sheet must not pick an option.
    tap(buttons[0]);
    await flush();
    expect(calls.filter((c) => c.path === '/answer')).toHaveLength(0);

    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(buttons[1]);
    await flush();
    await flush();
    expect(calls.map((c) => c.path)).toEqual(['/prompt', '/prompt', '/answer']);
    expect(calls[2].body).toEqual({
      option: 2,
      question: 'Do you want to proceed?',
      options: permission.options,
    });
    expect(onSent).toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it('refuses to send when the prompt changed meanwhile', async () => {
    let live: unknown = { waiting: true, choices: permission };
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: live }),
      'POST /answer': () => ({ status: 200 }),
    });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;

    live = {
      waiting: true,
      choices: { question: 'Delete the other file?', options: ['Yes', 'No'] },
    };
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(calls.some((c) => c.path === '/answer')).toBe(false);
    // Still waiting, on another question: that one is shown, never "no longer waiting".
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(document.querySelector('[data-testid="answer-changed"]')).not.toBeNull();
    expect(document.querySelector('#ans-title')?.textContent).toContain('Delete the other file');
  });

  it('says Claude is no longer waiting when the push is stale', async () => {
    mockApi({ 'GET /prompt': () => ({ status: 200, body: { waiting: false, choices: null } }) });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="answer-choice"]')).toHaveLength(0);
  });

  it('sends a written reply with the question it answers', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /reply': () => ({ status: 200, body: { success: true } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    const input = document.querySelector<HTMLInputElement>('[data-testid="answer-reply"]');
    if (!input) throw new Error('no reply box');
    input.value = 'use pnpm instead';
    input.dispatchEvent(new Event('input'));
    tap(document.querySelector('[data-testid="answer-send"]'));
    await flush();
    await flush();
    expect(calls.find((c) => c.path === '/reply')?.body).toEqual({
      text: 'use pnpm instead',
      question: 'Do you want to proceed?',
      options: permission.options,
      key: null,
      keyHash: null,
    });
  });

  // 2026-10-12: a tap in the middle of the reply has to leave the caret there; the sheet
  // paints again on every keystroke and must not write the same text back (caret to the end).
  it('keeps the caret where it was put while the reply is typed', async () => {
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    const input = document.querySelector<HTMLInputElement>('[data-testid="answer-reply"]');
    if (!input) throw new Error('no reply box');
    input.value = 'use pnpm';
    input.dispatchEvent(new Event('input'));
    await flush();
    input.focus();
    // Typing " only" after "use" (happy-dom's setRangeText leaves the caret at the end).
    input.value = 'use only pnpm';
    input.setSelectionRange(8, 8);
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(input.value).toBe('use only pnpm');
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 8]);
  });

  it('says nothing was answered when the server refuses a prompt that still waits (2026-11-09)', async () => {
    // The refusal read as "already answered": the sheet closed on a prompt that went on waiting.
    const onSent = vi.fn();
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 409, body: { error: 'The prompt changed' } }),
    });
    openAnswerSheet({ sessionId: 's1', onSent });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(document.querySelector('[data-testid="answer-changed"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="answer-choice"]').length).toBeGreaterThan(0);
    expect(onSent).not.toHaveBeenCalled();
  });

  it('says no longer waiting when the server refuses and Claude really stopped waiting', async () => {
    let waiting = true;
    mockApi({
      'GET /prompt': () => ({
        status: 200,
        body: { waiting, choices: waiting ? permission : null },
      }),
      'POST /answer': () => {
        waiting = false;
        return { status: 409, body: { error: 'The prompt changed' } };
      },
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).not.toBeNull();
  });

  it('says the answer did not land and lets the user try again', async () => {
    const onSent = vi.fn();
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 504, body: { error: 'not-delivered' } }),
    });
    openAnswerSheet({ sessionId: 's1', onSent });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(onSent).not.toHaveBeenCalled();
    expect(sheet()).not.toBeNull();
    expect(document.querySelector('[data-testid="answer-failed"]')?.textContent).toContain(
      t('answerSheet.notDelivered')
    );
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(calls.filter((c) => c.path === '/answer')).toHaveLength(2);
  });

  it('shows what the answer approves, and sends it for the server to check', async () => {
    const calls = mockApi({
      'GET /prompt': () => ({
        status: 200,
        body: {
          waiting: true,
          choices: {
            ...permission,
            detail: ['Bash command', 'rm -rf dist/ && pnpm build'],
            key: 'Bashcommandrm-rfdist/&&pnpmbuild',
          },
        },
      }),
      'POST /answer': () => ({ status: 200 }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    expect(document.querySelector('[data-testid="answer-detail"]')?.textContent).toContain(
      'rm -rf dist/ && pnpm build'
    );
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(calls.find((c) => c.path === '/answer')?.body).toMatchObject({
      option: 1,
      key: 'Bashcommandrm-rfdist/&&pnpmbuild',
    });
  });

  it('lets an answer be retried while another one to the session is on its way', async () => {
    // The server takes one answer per session at a time: "busy" is not a changed prompt.
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 409, body: { error: 'busy' } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="answer-choice"]')).toHaveLength(3);
  });

  it('says the session only watches when its tmux client is read-only, prompt kept', async () => {
    mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 409, body: { error: 'read-only' } }),
    });
    openAnswerSheet({ sessionId: 's1' });
    await flush();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(document.querySelectorAll('[data-testid="answer-choice"]')[0]);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="answer-gone"]')).toBeNull();
    expect(document.querySelector('.ans-error')?.textContent?.trim()).toBe(
      'Watch only: take control to type here.'
    );
    expect(document.querySelectorAll('[data-testid="answer-choice"]')).toHaveLength(3);
  });

  // Phone sheet (phone-spec §3.6/§4.4, 2026-10-12).
  it('shows the options translated, option 1 filled, and sends the original', async () => {
    const { setLocale } = await import('../i18n/index.js');
    await setLocale('es');
    const calls = mockApi({
      'GET /prompt': () => ({ status: 200, body: { waiting: true, choices: permission } }),
      'POST /answer': () => ({ status: 200 }),
    });
    openAnswerSheet({ sessionId: 's1', detail: 'permission prompt' });
    await flush();
    const choices = [...document.querySelectorAll<HTMLElement>('[data-testid="answer-choice"]')];
    expect(choices.map((c) => c.querySelector('.ans-choice-label')?.textContent)).toEqual([
      'Sí',
      'Sí, y no volver a preguntar',
      'No, y decirle a Claude qué hacer',
    ]);
    expect(choices[0].classList.contains('ans-choice--primary')).toBe(true);
    expect(choices[1].classList.contains('ans-choice--primary')).toBe(false);
    expect(document.querySelector('#ans-title')?.textContent).toContain('¿Continuar?');
    expect(document.querySelector('.ans-eyebrow')?.textContent).toContain('Claude te necesita');
    expect(document.querySelector('.ans-sheet .ut-grabber')).not.toBeNull();
    now += ANSWER_OPEN_GUARD_MS + 1;
    tap(choices[1]);
    await flush();
    await flush();
    expect(calls.find((c) => c.path === '/answer')?.body).toMatchObject({
      option: 2,
      options: permission.options,
      question: permission.question,
    });
    await setLocale('en');
  });

  it('when stale: title + one body line, then closes itself with a toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockApi({ 'GET /prompt': () => ({ status: 200, body: { waiting: false, choices: null } }) });
    openAnswerSheet({ sessionId: 's1', choices: permission });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('#ans-title')?.textContent).toContain('no longer waiting');
    const body = document.querySelector('[data-testid="answer-gone"]')?.textContent ?? '';
    expect(body).not.toContain('no longer waiting');
    expect(sheet()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(ANSWER_STALE_CLOSE_MS + 1);
    expect(sheet()).toBeNull();
    expect(document.querySelector('.ut-toast')?.textContent).toContain('no longer waiting');
    document.querySelector('.ut-toast-stack')?.remove();
    vi.useRealTimers();
  });
});
