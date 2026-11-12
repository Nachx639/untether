// @vitest-environment happy-dom
// 2026-11-07 (user request): organize the sessions by dragging, in the sidebar and the desktop
// home.
// happy-dom has no layout: the pointer events go to the element they are "over", which is what
// a browser does without pointer capture (utils/list-drag.ts reads the event's target).
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { Session } from '../../shared/types.js';
import type { AuthClient } from '../services/auth-client.js';
import { taskStore } from '../services/task-store.js';
import type { SessionList } from './session-list.js';

const ALPHA = '/Users/me/Projects/alpha';
const BETA = '/Users/me/Projects/beta';

const inRepo = (id: string, repo: string, extra: Partial<Session> = {}) =>
  ({
    ...createMockSession({ id, name: id, status: 'running', command: ['claude'] }),
    gitRepoPath: repo,
    gitMainRepoPath: repo,
    gitBranch: 'main',
    // One time for all: the automatic order is then the order they come in (a1 before a2),
    // not whichever mock was made a millisecond later.
    startedAt: '2026-11-07T10:00:00.000Z',
    lastModified: '2026-11-07T10:00:00.000Z',
    ...extra,
  }) as Session;

type Call = { url: string; method: string; body: unknown };

describe('session list drag and drop', () => {
  let element: SessionList;
  let calls: Call[];

  beforeAll(async () => {
    await import('./session-list.js');
    await import('./session-card.js');
  });

  beforeEach(async () => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url.includes('/group-pin')) {
          return Response.json({ success: true, groupPin: body.groupPin });
        }
        if (url.includes('/api/projects/group-order')) {
          return Response.json({ order: body.order });
        }
        if (url.includes('/api/projects/session-order')) {
          return Response.json({ order: body.order });
        }
        if (url.includes('/api/sessions')) return Response.json([]);
        return Response.json({});
      })
    );
    element = await fixture<SessionList>(html`<session-list
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`);
    vi.spyOn(element as unknown as { usePhoneRows: () => boolean }, 'usePhoneRows').mockReturnValue(
      false
    );
    element.compactMode = true;
    element.sessions = [inRepo('a1', ALPHA), inRepo('a2', ALPHA), inRepo('b1', BETA)];
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    for (const toast of document.body.querySelectorAll('.ut-toast-stack')) toast.remove();
    taskStore.reset();
    for (const ghost of document.body.querySelectorAll('.ut-drag-ghost')) ghost.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const row = (id: string) =>
    element.querySelector<HTMLElement>(
      `compact-session-card[data-drag-session="${id}"] [data-testid="compact-session-card"]`
    ) as HTMLElement;
  const group = (key: string) =>
    element.querySelector<HTMLElement>(`[data-group-key="${key}"]`) as HTMLElement;
  const groupIds = (key: string) =>
    [...group(key).querySelectorAll('compact-session-card')]
      .map((card) => (card as HTMLElement & { session: Session }).session.id)
      .sort();
  const headerKeys = () =>
    [...element.querySelectorAll('.ut-side-list [data-group-key]')].map((el) =>
      el.getAttribute('data-group-key')
    );
  const pointer = (
    type: string,
    target: Element,
    init: Partial<PointerEventInit> & { x?: number; y?: number } = {}
  ) => {
    const { x = 0, y = 0, ...rest } = init;
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      // The main button is down from the press until its release.
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
      ...rest,
    });
    target.dispatchEvent(event);
    return event;
  };
  /** Press on `from`, move past the slop over `to`, and (unless `release` is false) let go. */
  const drag = async (
    from: Element,
    to: Element,
    options: { y?: number; release?: boolean } = {}
  ) => {
    pointer('pointerdown', from, { x: 10, y: 10 });
    pointer('pointermove', from, { x: 30, y: 30 });
    await element.updateComplete;
    pointer('pointermove', to, { x: 30, y: options.y ?? 30 });
    if (options.release === false) return;
    pointer('pointerup', to, { x: 30, y: options.y ?? 30 });
    // The click the browser sends after the release.
    to.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await element.updateComplete;
  };
  const groupPinCalls = () => calls.filter((call) => call.url.includes('/group-pin'));
  const orderCalls = () => calls.filter((call) => call.url.includes('/session-order'));
  /** The ids of a group's rows as they show, top to bottom. */
  const rowOrder = (key: string) =>
    [...group(key).querySelectorAll('compact-session-card')].map(
      (card) => (card as HTMLElement & { session: Session }).session.id
    );
  const card = (id: string) =>
    element.querySelector(`compact-session-card[data-drag-session="${id}"]`) as HTMLElement;
  /** Where a row sits on screen (happy-dom has no layout). */
  const place = (el: Element, top: number) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 44,
      height: 44,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  /** The toast on screen (one leaving is still in the DOM for its exit transition). */
  const toastText = () =>
    document.body.querySelector('.ut-toast:not([data-state="exit"]) .ut-toast-text')?.textContent ??
    null;
  const undoButton = () =>
    document.body.querySelector<HTMLButtonElement>(
      '.ut-toast:not([data-state="exit"]) .ut-toast-action'
    ) as HTMLButtonElement;
  const cmdZ = (target: EventTarget = window) => {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(event);
    return event;
  };

  it('a session dropped on another group is anchored there and moves at once', async () => {
    expect(groupIds(ALPHA)).toEqual(['a1', 'a2']);
    const select = vi.fn();
    element.addEventListener('session-select', select);
    const from = row('a1');
    await drag(from, group(BETA), { release: false });
    // While it moves: the floating label, the row dimmed, the group lit.
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')?.textContent).toBe('a1');
    expect(from.closest('compact-session-card')?.classList.contains('ut-drag-source')).toBe(true);
    expect(group(BETA).classList.contains('ut-drop-target')).toBe(true);
    pointer('pointerup', group(BETA), { x: 30, y: 30 });
    group(BETA).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(groupIds(BETA)).toEqual(['a1', 'b1']);
    });
    expect(groupPinCalls()).toEqual([
      expect.objectContaining({
        url: '/api/sessions/a1/group-pin',
        method: 'POST',
        body: { groupPin: { repoPath: BETA } },
      }),
    ]);
    expect(select).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
    expect(element.querySelector('.ut-drop-target, .ut-drag-source')).toBeNull();
    expect(document.body.classList.contains('ut-list-dragging')).toBe(false);
  });

  // The real case: «Insights del canal StarterStoryBuild», opened in ~, fell in bakery by the
  // majority rule, and with every session in a project there was no "Otras" to drop it on.
  it('"Otras" shows as a drop zone while a session moves, and takes it out of its project', async () => {
    expect(element.querySelector('[data-testid="drop-others"]')).toBeNull();
    await drag(row('b1'), row('b1'), { release: false });
    const zone = element.querySelector('[data-testid="drop-others"]') as HTMLElement;
    expect(zone).not.toBeNull();
    pointer('pointermove', zone, { x: 30, y: 30 });
    expect(zone.classList.contains('ut-drop-target')).toBe(true);
    pointer('pointerup', zone, { x: 30, y: 30 });
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(groupIds('')).toEqual(['b1']);
    });
    expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: { repoPath: null } }]);
    // A real "Otras" group now; no extra zone outside a drag.
    expect(element.querySelectorAll('[data-testid="drop-others"]')).toHaveLength(0);
  });

  it('back on its automatic group, the anchor goes («Quitar ancla»)', async () => {
    element.sessions = [
      inRepo('a1', ALPHA, { groupPin: { repoPath: BETA, git: true } }),
      inRepo('a2', ALPHA),
      inRepo('b1', BETA),
    ];
    await element.updateComplete;
    expect(groupIds(BETA)).toEqual(['a1', 'b1']);
    await drag(row('a1'), group(ALPHA));
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(groupIds(ALPHA)).toEqual(['a1', 'a2']);
    });
    expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: null }]);
  });

  it('an anchor to its own automatic group goes when dropped there', async () => {
    element.sessions = [
      inRepo('a1', ALPHA, { groupPin: { repoPath: ALPHA, git: true } }),
      inRepo('a2', ALPHA),
      inRepo('b1', BETA),
    ];
    await element.updateComplete;
    await drag(row('a1'), group(ALPHA));
    await vi.waitFor(() =>
      expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: null }])
    );
  });

  // 2026-11-07, user report: the drag did not always start, text got selected instead. A press
  // on the title drags as any other point of the row (list.css makes it unselectable).
  it('a press on the title drags the row as any other point of it', async () => {
    const name = row('a1').querySelector('.ut-side-name') as HTMLElement;
    expect(name.textContent?.trim()).toBe('a1');
    await drag(name, group(BETA));
    await vi.waitFor(() =>
      expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: { repoPath: BETA } }])
    );
  });

  it("the browser's own drag (an image, a link in the row) never starts during a press", () => {
    pointer('pointerdown', row('a1'), { x: 10, y: 10 });
    const native = new Event('dragstart', { bubbles: true, cancelable: true });
    row('a1').dispatchEvent(native);
    expect(native.defaultPrevented).toBe(true);
    pointer('pointerup', row('a1'), { x: 10, y: 10 });
    const after = new Event('dragstart', { bubbles: true, cancelable: true });
    row('a1').dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('dropped on the group it is in already, nothing is saved', async () => {
    await drag(row('a1'), group(ALPHA));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(groupPinCalls()).toEqual([]);
  });

  it("a group's header dropped above another reorders the groups, saved on the server", async () => {
    const before = headerKeys();
    expect(before).toHaveLength(2);
    const [first, second] = before as string[];
    const header = group(second).querySelector(`[data-drag-group="${second}"]`) as HTMLElement;
    expect(header).not.toBeNull();
    // The top half of the first group: the line goes above it.
    vi.spyOn(group(first), 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    await drag(header, group(first), { y: 20, release: false });
    expect(group(first).classList.contains('ut-drop-before')).toBe(true);
    pointer('pointerup', group(first), { x: 30, y: 20 });
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(headerKeys()).toEqual([second, first]);
    });
    expect(calls.filter((call) => call.url.includes('/api/projects/group-order'))).toEqual([
      expect.objectContaining({ method: 'PUT', body: { order: [second, first] } }),
    ]);
    expect(taskStore.groupOrder).toEqual([second, first]);
  });

  it('Escape cancels: nothing moves and the release opens nothing', async () => {
    const select = vi.fn();
    element.addEventListener('session-select', select);
    await drag(row('a1'), group(BETA), { release: false });
    expect(element.querySelector('[data-testid="drop-others"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await element.updateComplete;
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
    expect(element.querySelector('[data-testid="drop-others"]')).toBeNull();
    expect(group(BETA).classList.contains('ut-drop-target')).toBe(false);
    // The button is still down and the mouse goes on moving (2026-11-07 review): no new drag.
    pointer('pointermove', group(BETA), { x: 90, y: 90 });
    await element.updateComplete;
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
    expect(group(BETA).classList.contains('ut-drop-target')).toBe(false);
    pointer('pointerup', group(BETA), { x: 90, y: 90 });
    group(BETA).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(groupPinCalls()).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(groupIds(ALPHA)).toEqual(['a1', 'a2']);
  });

  it('a click still opens the session; a right click, a touch or a small wobble never drag', async () => {
    const select = vi.fn();
    element.addEventListener('session-select', select);
    // A click with a few pixels of wobble.
    pointer('pointerdown', row('a1'), { x: 10, y: 10 });
    pointer('pointermove', row('a1'), { x: 13, y: 12 });
    pointer('pointerup', row('a1'), { x: 13, y: 12 });
    row('a1').click();
    expect(select).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
    // The right button and a finger leave the press alone.
    for (const init of [{ button: 2 }, { pointerType: 'touch' }, { ctrlKey: true }]) {
      pointer('pointerdown', row('a1'), { x: 10, y: 10, ...init });
      pointer('pointermove', group(BETA), { x: 60, y: 60, ...init });
      expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
      pointer('pointerup', group(BETA), { x: 60, y: 60, ...init });
    }
    expect(groupPinCalls()).toEqual([]);
    // The next click after them opens the session as usual.
    row('a2').click();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('«Subir» / «Bajar» in the header menu move a group without a mouse', async () => {
    const [first, second] = headerKeys() as string[];
    const more = group(second).querySelector<HTMLButtonElement>('.ut-repo-more');
    more?.click();
    await element.updateComplete;
    // The menu opens on <body>: the last group can go up, not down.
    expect(document.body.querySelector('[data-testid="repo-popover"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="group-move-down"]')).toBeNull();
    document.body.querySelector<HTMLButtonElement>('[data-testid="group-move-up"]')?.click();
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(headerKeys()).toEqual([second, first]);
    });
    expect(calls.find((call) => call.url.includes('/group-order'))?.body).toEqual({
      order: [second, first],
    });
  });

  it('the saved order puts back the old one when the save fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'nope' }, { status: 500 }))
    );
    const [first, second] = headerKeys() as string[];
    const result = await taskStore.saveGroupOrder([second, first]);
    expect(result.ok).toBe(false);
    expect(taskStore.groupOrder).toEqual([]);
  });

  it('desktop home: a card dropped on another project block is anchored there', async () => {
    element.compactMode = false;
    await element.updateComplete;
    const card = element.querySelector(
      'session-card[data-drag-session="a1"] [data-testid="session-card"]'
    ) as HTMLElement;
    expect(card).not.toBeNull();
    const block = element.querySelector(`.ut-group-block[data-group-key="${BETA}"]`) as HTMLElement;
    await drag(card, block);
    await vi.waitFor(() =>
      expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: { repoPath: BETA } }])
    );
  });

  // 2026-11-07, user request: drag the rows up and down into an order of their own.
  it('a row dropped above another of its group goes there, saved on the server; Deshacer puts it back', async () => {
    expect(rowOrder(ALPHA)).toEqual(['a1', 'a2']);
    place(card('a1'), 100);
    await drag(row('a2'), row('a1'), { y: 110, release: false });
    // The line above a1; its own group is not lit (it does not leave it).
    expect(card('a1').classList.contains('ut-drop-row-before')).toBe(true);
    expect(group(ALPHA).classList.contains('ut-drop-target')).toBe(false);
    pointer('pointerup', row('a1'), { x: 30, y: 110 });
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(rowOrder(ALPHA)).toEqual(['a2', 'a1']);
    });
    expect(orderCalls()).toEqual([
      expect.objectContaining({ method: 'PUT', body: { order: ['a2', 'a1'] } }),
    ]);
    expect(groupPinCalls()).toEqual([]);
    expect(element.querySelector('.ut-drop-row-before, .ut-drop-row-after')).toBeNull();
    await vi.waitFor(() => expect(toastText()).toBe('Order changed'));
    undoButton().click();
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(rowOrder(ALPHA)).toEqual(['a1', 'a2']);
    });
    expect(orderCalls().map((call) => call.body)).toEqual([{ order: ['a2', 'a1'] }, { order: [] }]);
    expect(toastText()).toBeNull();
  });

  // The 2026-11-07 case: the orchestrator «Bakery», moved down inside bakery, landed in the
  // "Otras" right below and was anchored there. Over a row of its own group it is an order now,
  // never an anchor.
  it('moved down over a row of its own group, a session is reordered, never anchored', async () => {
    place(card('a2'), 144);
    await drag(row('a1'), row('a2'), { y: 180 });
    await vi.waitFor(() =>
      expect(orderCalls().map((call) => call.body)).toEqual([{ order: ['a2', 'a1'] }])
    );
    expect(groupPinCalls()).toEqual([]);
  });

  it('a row dropped where it already is saves nothing and offers no undo', async () => {
    place(card('a2'), 144);
    // a1 just above a2: already there.
    await drag(row('a1'), row('a2'), { y: 150 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orderCalls()).toEqual([]);
    expect(toastText()).toBeNull();
  });

  it('on a row of another group: anchored there, at that place; Deshacer undoes both', async () => {
    place(card('b1'), 300);
    await drag(row('a1'), row('b1'), { y: 305, release: false });
    expect(card('b1').classList.contains('ut-drop-row-before')).toBe(true);
    // It leaves its group: the other one is lit too.
    expect(group(BETA).classList.contains('ut-drop-target')).toBe(true);
    pointer('pointerup', row('b1'), { x: 30, y: 305 });
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(rowOrder(BETA)).toEqual(['a1', 'b1']);
    });
    expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: { repoPath: BETA } }]);
    expect(orderCalls().map((call) => call.body)).toEqual([{ order: ['a1', 'b1'] }]);
    await vi.waitFor(() => expect(toastText()).toBe('Moved to beta'));
    undoButton().click();
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(rowOrder(ALPHA)).toEqual(['a1', 'a2']);
    });
    expect(groupPinCalls().map((call) => call.body)).toEqual([
      { groupPin: { repoPath: BETA } },
      { groupPin: null },
    ]);
    expect(orderCalls().map((call) => call.body)).toEqual([{ order: ['a1', 'b1'] }, { order: [] }]);
  });

  it('sorted by name, the rows keep the sort menu order: only their group counts', async () => {
    (element as unknown as { listSort: string }).listSort = 'name';
    await element.updateComplete;
    place(card('a1'), 100);
    await drag(row('a2'), row('a1'), { y: 110, release: false });
    expect(element.querySelector('.ut-drop-row-before, .ut-drop-row-after')).toBeNull();
    pointer('pointerup', row('a1'), { x: 30, y: 110 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orderCalls()).toEqual([]);
    expect(groupPinCalls()).toEqual([]);
  });

  // Deshacer puts back exactly the anchor it had: none, another project, or "Otras".
  it('Deshacer (button or Cmd+Z) restores the anchor it had before, whatever it was', async () => {
    const GAMMA = '/Users/me/Projects/gamma';
    const cases: Array<{ pin: Session['groupPin']; restored: unknown }> = [
      { pin: undefined, restored: null },
      { pin: { repoPath: GAMMA, git: true }, restored: { repoPath: GAMMA } },
      { pin: { repoPath: null }, restored: { repoPath: null } },
    ];
    for (const [index, { pin, restored }] of cases.entries()) {
      calls = [];
      element.sessions = [
        inRepo('a1', ALPHA, pin ? { groupPin: pin } : {}),
        inRepo('a2', ALPHA),
        inRepo('b1', BETA),
        inRepo('g1', GAMMA),
      ];
      await element.updateComplete;
      await drag(row('a1'), group(BETA));
      await vi.waitFor(async () => {
        await element.updateComplete;
        expect(rowOrder(BETA)).toContain('a1');
      });
      await vi.waitFor(() => expect(toastText()).toBe('Moved to beta'));
      if (index % 2) undoButton().click();
      else expect(cmdZ().defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(groupPinCalls().map((call) => call.body)).toEqual([
          { groupPin: { repoPath: BETA } },
          { groupPin: restored },
        ])
      );
      await vi.waitFor(async () => {
        await element.updateComplete;
        expect(rowOrder(BETA)).not.toContain('a1');
      });
      // Once only: the toast is gone and Cmd+Z does nothing more.
      expect(toastText()).toBeNull();
      expect(cmdZ().defaultPrevented).toBe(false);
      expect(groupPinCalls()).toHaveLength(2);
    }
  });

  it("a group's order changed by a drop comes back with Cmd+Z; Cmd+Z in a text field is the field's", async () => {
    const [first, second] = headerKeys() as string[];
    const header = group(second).querySelector(`[data-drag-group="${second}"]`) as HTMLElement;
    vi.spyOn(group(first), 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    await drag(header, group(first), { y: 20 });
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(headerKeys()).toEqual([second, first]);
    });
    await vi.waitFor(() => expect(toastText()).toBe('Order changed'));
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    expect(cmdZ(field).defaultPrevented).toBe(false);
    field.remove();
    expect(toastText()).toBe('Order changed');
    expect(cmdZ().defaultPrevented).toBe(true);
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(headerKeys()).toEqual([first, second]);
    });
    expect(
      calls.filter((call) => call.url.includes('/group-order')).map((call) => call.body)
    ).toEqual([{ order: [second, first] }, { order: [] }]);
  });

  // A release the page never saw (let go outside the window): moving with the button up must
  // not drag that old press around, and the next click must not drop it anywhere.
  it('a press whose release was lost ends at the next move without the button', async () => {
    const select = vi.fn();
    element.addEventListener('session-select', select);
    pointer('pointerdown', row('a1'), { x: 10, y: 10 });
    pointer('pointermove', group(BETA), { x: 80, y: 80, buttons: 0 });
    await element.updateComplete;
    expect(document.body.querySelector('[data-testid="list-drag-ghost"]')).toBeNull();
    expect(group(BETA).classList.contains('ut-drop-target')).toBe(false);
    // The click that follows, over another group: nothing moves, the click does its own thing.
    pointer('pointermove', group(BETA), { x: 90, y: 90, buttons: 0 });
    pointer('pointerup', group(BETA), { x: 90, y: 90 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(groupPinCalls()).toEqual([]);
    row('b1').click();
    expect(select).toHaveBeenCalledTimes(1);
    // A new press after a lost one drags as usual.
    await drag(row('a2'), group(BETA));
    await vi.waitFor(() =>
      expect(groupPinCalls().map((call) => call.body)).toEqual([{ groupPin: { repoPath: BETA } }])
    );
  });

  it('desktop cards side by side say so: before or after by the left or right half', async () => {
    element.compactMode = false;
    await element.updateComplete;
    const cards = [...element.querySelectorAll('session-card[data-drag-session]')];
    expect(cards.length).toBeGreaterThan(0);
    for (const entry of cards) expect(entry.getAttribute('data-drag-axis')).toBe('x');
  });

  // Review 2026-11-07: the anchor saved, the order refused: the move can still be undone.
  it('on a row of another group, a failed order save still offers to undo the anchor', async () => {
    const base = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/session-order')) {
          calls.push({ url: String(input), method: 'PUT', body: JSON.parse(String(init?.body)) });
          return Response.json({ error: 'nope' }, { status: 500 });
        }
        return base(input, init);
      })
    );
    place(card('b1'), 300);
    await drag(row('a1'), row('b1'), { y: 305 });
    const kindText = (kind: string) =>
      document.body.querySelector(`.ut-toast[data-kind="${kind}"] .ut-toast-text`)?.textContent;
    await vi.waitFor(() => expect(kindText('success')).toBe('Moved to beta'));
    expect(kindText('error')).toBe("Couldn't save the order of the sessions. Try again.");
    undoButton().click();
    await vi.waitFor(() =>
      expect(groupPinCalls().map((call) => call.body)).toEqual([
        { groupPin: { repoPath: BETA } },
        { groupPin: null },
      ])
    );
    // Only the order that was saved is put back: none here.
    expect(orderCalls()).toHaveLength(1);
    await vi.waitFor(async () => {
      await element.updateComplete;
      expect(rowOrder(ALPHA)).toContain('a1');
    });
  });
});
