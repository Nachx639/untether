// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from './task-store.js';

describe('TaskStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the running orchestrators from GET /api/tasks and hears when they change', async () => {
    let body: Record<string, unknown> = {
      tasks: [],
      orchestrators: [{ repoPath: '/repo', sessionId: 'orch-1' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body))
    );
    const store = new TaskStore(() => ({}));
    const heard = vi.fn();
    const off = store.subscribe(heard);
    await store.refresh();
    expect(store.orchestrators).toEqual([{ repoPath: '/repo', sessionId: 'orch-1' }]);
    const before = heard.mock.calls.length;
    body = { tasks: [] };
    await store.refresh();
    expect(store.orchestrators).toEqual([]);
    expect(heard.mock.calls.length).toBe(before + 1);
    off();
    store.reset();
  });

  it('a poll that hangs times out and keeps what is shown (2026-10-20 review)', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
        })
    );
    vi.stubGlobal('fetch', fetchFn);
    const store = new TaskStore(() => ({}));
    const refresh = store.refresh();
    const tasksCall = fetchFn.mock.calls.find(([url]) => url === '/api/tasks');
    expect(tasksCall?.[1]?.signal).toBe(controller.signal);
    const projectsCall = fetchFn.mock.calls.find(([url]) => url === '/api/projects');
    expect(projectsCall?.[1]?.signal).toBe(controller.signal);
    expect(timeout).toHaveBeenCalledWith(8000);
    controller.abort();
    await refresh; // settles: the next poll can go out
    timeout.mockRestore();
    store.reset();
  });

  it('starts and stops an orchestrator', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ sessionId: 'orch-1' })
    );
    vi.stubGlobal('fetch', fetchFn);
    const store = new TaskStore(() => ({ Authorization: 'Bearer t' }));
    const started = await store.startOrchestrator('/repo', 'Añade login');
    expect(started).toMatchObject({ ok: true, data: { sessionId: 'orch-1' } });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/projects/orchestrator');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ repoPath: '/repo', goal: 'Añade login' });
    await store.stopOrchestrator('/repo');
    const stop = fetchFn.mock.calls.find(([, options]) => options?.method === 'DELETE');
    expect(stop?.[0]).toBe('/api/projects/orchestrator?repo=%2Frepo');
    store.reset();
  });
  it('reads project notices from GET /api/projects and clears a merge pause', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects') {
        return Response.json({
          projects: [
            {
              repoPath: '/gone',
              settings: { mergePolicy: 'auto', missingSince: '2026-10-20T10:00:00Z' },
            },
            {
              repoPath: '/moved',
              settings: { movedFrom: '/old/skylark', autoMergePausedUntil: 7 },
            },
            { name: 'no path' },
          ],
        });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({ tasks: [] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const store = new TaskStore(() => ({}));
    await store.loadProjects();
    expect(store.projects).toEqual([
      { repoPath: '/gone', missingSince: '2026-10-20T10:00:00Z' },
      { repoPath: '/moved', movedFrom: '/old/skylark' },
    ]);
    const result = await store.setProjectSettings('/moved', { autoMergePausedUntil: null });
    expect(result.ok).toBe(true);
    const put = fetchFn.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/projects/settings');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      repoPath: '/moved',
      settings: { autoMergePausedUntil: null },
    });
    store.reset();
  });

  it('reads why merges paused as a code and a count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          projects: [
            {
              repoPath: '/app',
              settings: {
                autoMergePausedUntil: '2026-10-21T10:00:00Z',
                autoMergePausedReason: '2 of its tasks were undone',
                autoMergePausedCode: 'reverts',
                autoMergePausedCount: 2,
              },
            },
            { repoPath: '/odd', settings: { autoMergePausedCount: 'many' } },
          ],
        })
      )
    );
    const store = new TaskStore(() => ({}));
    await store.loadProjects();
    expect(store.projects).toEqual([
      {
        repoPath: '/app',
        autoMergePausedUntil: '2026-10-21T10:00:00Z',
        autoMergePausedReason: '2 of its tasks were undone',
        autoMergePausedCode: 'reverts',
        autoMergePausedCount: 2,
      },
      { repoPath: '/odd' },
    ]);
    store.reset();
  });

  it('forgets a project with DELETE /api/projects?repo= and reads the board again', async () => {
    let open = true;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return open
          ? Response.json(
              { error: 'open-tasks', message: 'It still has 1 open task(s)', openTasks: 1 },
              { status: 409 }
            )
          : Response.json({ repoPath: '/gone', forgotten: true });
      }
      if (url === '/api/projects') return Response.json({ projects: [] });
      return Response.json({ tasks: [] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const store = new TaskStore(() => ({}));
    const refused = await store.forgetProject('/Users/me/gone app');
    expect(refused).toMatchObject({ ok: false, status: 409, error: 'open-tasks' });
    const del = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(del?.[0]).toBe('/api/projects?repo=%2FUsers%2Fme%2Fgone%20app');
    open = false;
    expect(await store.forgetProject('/gone')).toMatchObject({ ok: true, status: 200 });
    // The projects and the tasks are read again.
    expect(fetchFn.mock.calls.filter(([url]) => url === '/api/projects').length).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(fetchFn.mock.calls.some(([url]) => url === '/api/tasks')).toBe(true)
    );
    store.reset();
  });

  it("loads a project's icon with the login header and shows it from memory (2026-10-20)", async () => {
    const headersSeen: unknown[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects') {
        return Response.json({
          projects: [
            { repoPath: '/atlas', settings: { icon: 'app/icon.png' } },
            { repoPath: '/plain', settings: {} },
          ],
        });
      }
      if (url.startsWith('/api/projects/icon')) {
        headersSeen.push(init?.headers);
        return new Response(new Blob(['png'], { type: 'image/png' }));
      }
      return Response.json({ tasks: [] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const created = vi.fn(() => 'blob:icon-1');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    );
    const store = new TaskStore(() => ({ Authorization: 'Bearer t' }));
    await store.loadProjects();
    await vi.waitFor(() => expect(store.iconFor('/atlas')).toBe('blob:icon-1'));
    expect(store.iconFor('/plain')).toBeNull();
    expect(headersSeen).toEqual([{ Authorization: 'Bearer t' }]);
    // Read again: fetched once.
    await store.loadProjects();
    expect(
      fetchFn.mock.calls.filter(([url]) => String(url).startsWith('/api/projects/icon'))
    ).toHaveLength(1);
    store.reset();
  });

  it('asks again for a project icon only when it was not a 404, and frees the icons of gone projects (2026-11-10)', async () => {
    let projects = [
      { repoPath: '/missing', settings: { icon: 'app/gone.png' } },
      { repoPath: '/atlas', settings: { icon: 'app/icon.png' } },
    ];
    const iconStatus = 404;
    const iconCalls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (url === '/api/projects') return Response.json({ projects });
      if (url.startsWith('/api/projects/icon')) {
        iconCalls.push(url);
        return url.includes('gone')
          ? new Response('', { status: iconStatus })
          : new Response(new Blob(['png'], { type: 'image/png' }));
      }
      return Response.json({ tasks: [] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const revoked = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:icon-a'), revokeObjectURL: revoked })
    );
    const store = new TaskStore(() => ({}));
    await store.loadProjects();
    await vi.waitFor(() => expect(store.iconFor('/atlas')).toBe('blob:icon-a'));
    await vi.waitFor(() => expect(iconCalls.filter((url) => url.includes('gone'))).toHaveLength(1));

    // A 404 is not asked again on the next poll.
    await store.loadProjects();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(iconCalls.filter((url) => url.includes('gone'))).toHaveLength(1);

    // The project is forgotten: its blob URL is freed.
    projects = [{ repoPath: '/missing', settings: { icon: 'app/gone.png' } }];
    await store.loadProjects();
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith('blob:icon-a'));
    expect(store.iconFor('/atlas')).toBeNull();
    store.reset();
  });
});
