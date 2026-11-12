// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '../utils/action-toast.js';
import { ROUTE_UNDO_MS, type RouteChoiceItem, sendAsTask } from './task-routing.js';

const open = [
  { id: 'g', name: 'Login con Google', branch: 'ut/login-google', state: 'working' },
  { id: 'h', name: 'Login con GitHub', branch: 'ut/login-github', state: 'ready' },
];

function harness(routeAnswer: Record<string, unknown>, submitStatus = 200) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    posts.push({ url, body });
    if (url === '/api/tasks/route') {
      return new Response(JSON.stringify({ repoPath: '/repo', open, ...routeAnswer }), {
        status: 200,
      });
    }
    const task =
      body.choice === 'new'
        ? { id: 'n', name: 'Nueva cosa' }
        : open.find((t) => t.id === body.choice);
    return new Response(
      JSON.stringify(
        submitStatus === 200
          ? { action: body.choice === 'new' ? 'created' : 'sent', task }
          : { error: 'nope', message: 'The task is merged' }
      ),
      { status: submitStatus }
    );
  });
  const toasts: ToastOptions[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const choices: Array<{ title: string; items: RouteChoiceItem[]; cancel: () => void }> = [];
  const restored: string[] = [];
  const submitted: unknown[] = [];
  const refresh = vi.fn();
  const ui = {
    choose: (title: string, items: RouteChoiceItem[], cancel: () => void) =>
      choices.push({ title, items, cancel }),
    restore: (text: string) => restored.push(text),
    onSubmitted: (result: unknown) => submitted.push(result),
  };
  const deps = {
    fetch: fetchFn as unknown as typeof fetch,
    headers: () => ({ Authorization: 'Bearer x' }),
    toast: (options: ToastOptions) => {
      toasts.push(options);
      return () => {};
    },
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    refresh,
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { posts, toasts, timers, choices, restored, submitted, refresh, ui, deps, flush };
}

const request = { repoPath: '/repo/web', text: 'y que pida el email', agent: 'claude' as const };

describe('sendAsTask (Ask box in Tarea mode)', () => {
  it('match: «→ añadido a …» for 2.5 s, then sent to that task', async () => {
    const h = harness({ decision: { kind: 'match', taskId: 'g' } });
    await sendAsTask(request, h.ui, h.deps);
    expect(h.posts[0]).toEqual({
      url: '/api/tasks/route',
      body: { repoPath: '/repo/web', text: 'y que pida el email' },
    });
    expect(h.toasts[0]).toMatchObject({
      text: '→ added to «Login con Google»',
      timeoutMs: ROUTE_UNDO_MS,
      action: { label: 'Change' },
    });
    expect(h.timers[0].ms).toBe(2500);
    expect(h.posts).toHaveLength(1);
    h.timers[0].fn();
    await h.flush();
    expect(h.posts[1]).toEqual({
      url: '/api/tasks/submit',
      body: { repoPath: '/repo', text: 'y que pida el email', agent: 'claude', choice: 'g' },
    });
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Sent to «Login con Google»' });
    expect(h.submitted).toEqual([{ action: 'sent', taskId: 'g' }]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it('Cambiar stops the timer and offers every open task and «new»', async () => {
    const h = harness({ decision: { kind: 'match', taskId: 'g' } });
    await sendAsTask(request, h.ui, h.deps);
    h.toasts[0].action?.run();
    expect(h.timers[0].cleared).toBe(true);
    h.timers[0].fn();
    await h.flush();
    expect(h.posts).toHaveLength(1);
    const [choice] = h.choices;
    expect(choice.title).toBe('Which task does it go with?');
    expect(choice.items.map((item) => [item.label, item.hint, item.testId])).toEqual([
      ['Login con Google', 'ut/login-google', 'route-choice-g'],
      ['Login con GitHub', 'ut/login-github', 'route-choice-h'],
      ["It's a new task", undefined, 'route-choice-new'],
    ]);
    choice.items[2].run();
    await h.flush();
    expect(h.posts[1].body).toMatchObject({ choice: 'new' });
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Task launched: «Nueva cosa»' });
    expect(h.submitted).toEqual([{ action: 'created', taskId: 'n' }]);
  });

  it('ask: one tap «¿Va con X o es nueva?»; closing it gives the text back', async () => {
    const h = harness({ decision: { kind: 'ask', candidates: ['h', 'g'] } });
    await sendAsTask(request, h.ui, h.deps);
    expect(h.toasts).toHaveLength(0);
    const [choice] = h.choices;
    expect(choice.title).toBe('Does it go with «Login con GitHub» or is it new?');
    expect(choice.items.map((item) => item.testId)).toEqual([
      'route-choice-h',
      'route-choice-g',
      'route-choice-new',
    ]);
    choice.cancel();
    expect(h.restored).toEqual(['y que pida el email']);
    expect(h.posts).toHaveLength(1);

    const picked = harness({ decision: { kind: 'ask', candidates: ['h'] } });
    await sendAsTask(request, picked.ui, picked.deps);
    picked.choices[0].items[0].run();
    await picked.flush();
    expect(picked.posts[1].body).toMatchObject({ choice: 'h' });
  });

  it('new: started at once', async () => {
    const h = harness({ decision: { kind: 'new' } });
    await sendAsTask(request, h.ui, h.deps);
    expect(h.choices).toHaveLength(0);
    expect(h.posts[1].body).toMatchObject({ choice: 'new', agent: 'claude' });
  });

  it('gives the text back when a request fails; a pending OK is said as such', async () => {
    const failed = harness({ decision: { kind: 'new' } }, 409);
    await sendAsTask(request, failed.ui, failed.deps);
    expect(failed.toasts.at(-1)).toMatchObject({
      kind: 'error',
      text: "Couldn't send it: The task is merged",
    });
    expect(failed.restored).toEqual(['y que pida el email']);

    const pending = harness({ decision: { kind: 'new' } }, 202);
    await sendAsTask(request, pending.ui, pending.deps);
    expect(pending.toasts.at(-1)).toMatchObject({ kind: 'attention', text: 'Waiting for your OK' });
    expect(pending.restored).toEqual([]);

    const offline = harness({ decision: { kind: 'new' } });
    offline.deps.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await sendAsTask(request, offline.ui, offline.deps);
    expect(offline.toasts.at(-1)).toMatchObject({ text: "Couldn't send it: offline" });
    expect(offline.restored).toEqual(['y que pida el email']);
  });
});
