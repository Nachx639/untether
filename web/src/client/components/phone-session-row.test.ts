/**
 * @vitest-environment happy-dom
 */
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { render } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAC_SESSIONS_CHANGED_EVENT } from '../../shared/mac-sessions.js';
import type { Session, SessionMultiplexer } from '../../shared/types.js';
import { sessionActionService } from '../services/session-action-service.js';
import { rememberMacSessionsPlatform } from '../utils/mac-sessions.js';
import { type AvatarKind, agentAvatar } from './agent-avatar.js';
import {
  formatRowTime,
  isNoiseLine,
  type PhoneSessionRow,
  rowGlyphKind,
  rowState,
  sessionTool,
} from './phone-session-row.js';
import './phone-session-row.js';

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 'claude (~/Projects)',
    command: ['claude'],
    workingDir: '/Users/x/Projects',
    status: 'running',
    startedAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    ...overrides,
  }) as Session;

/** Opened from "On this Mac": its program is a tmux client of the user's tmux session. */
const multiplexer: SessionMultiplexer = {
  type: 'tmux',
  socketPath: '/tmp/tmux-501/default',
  serverPid: 4100,
  serverStartedAt: 1759490000,
  sessionId: '$0',
  sessionName: 'work',
  mode: 'control',
  sizing: 'others',
  source: 'mac-sessions',
};

async function renderRow(value: Session) {
  return fixture<PhoneSessionRow>(html`<phone-session-row .session=${value}></phone-session-row>`);
}

/** A finger down on `el` and up `dy` px away: iOS ends a scroll that began on it with a pointerup. */
function touch(el: Element, dy: number) {
  const at = (y: number) => ({
    pointerType: 'touch',
    pointerId: 7,
    clientX: 40,
    clientY: y,
    bubbles: true,
  });
  el.dispatchEvent(new PointerEvent('pointerdown', at(300)));
  el.dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
}

describe('PhoneSessionRow', () => {
  afterEach(() => vi.useRealTimers());

  it('reads as one named button whose inner buttons stay reachable', async () => {
    const row = await renderRow(
      session({
        claudeStatus: {
          status: 'waiting',
          title: 'Nombre para perro',
          choices: { question: 'Allow?', options: ['Yes', 'No'] },
        },
      } as Partial<Session>)
    );
    const main = row.querySelector('[role="button"]') as HTMLElement;
    expect(main.getAttribute('aria-label')).toMatch(/^claude, Nombre para perro, .*Needs you/);
    // A role=button flattens its children for screen readers: the answers and ⋯ live outside.
    expect(main.querySelector('button')).toBeNull();
    expect(row.querySelectorAll('.psr-choice')).toHaveLength(2);
    expect(row.querySelector('.psr-menu')?.getAttribute('aria-label')).toContain(
      'Nombre para perro'
    );
  });

  it('offers a Codex approval’s quick answers with its command, and sends them alike', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const row = await renderRow(
        session({
          command: ['codex'],
          codexActive: true,
          agentStatus: {
            agent: 'codex',
            status: 'waiting',
            choices: {
              question: 'Would you like to run the following command?',
              options: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'],
              detail: ['touch nuevo.txt', 'Necesito crear el archivo'],
              key: 'touchnuevo.txtYes,proceed(y)No',
            },
          },
        } as Partial<Session>)
      );
      expect(row.querySelector('[data-testid="psr-needs-chip"]')).not.toBeNull();
      expect(row.querySelector('.psr-choices-detail')?.textContent).toBe(
        'touch nuevo.txt · Necesito crear el archivo'
      );
      const choices = row.querySelectorAll('.psr-choice');
      expect(choices).toHaveLength(2);
      (choices[0] as HTMLButtonElement).click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/\/answer$/);
      expect(JSON.parse(String(init.body))).toMatchObject({
        option: 1,
        question: 'Would you like to run the following command?',
        key: 'touchnuevo.txtYes,proceed(y)No',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows what a quick answer approves, and sends it for the server to check', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const row = await renderRow(
        session({
          claudeStatus: {
            status: 'waiting',
            choices: {
              question: 'Do you want to proceed?',
              options: ['Yes', 'No'],
              detail: ['Bash command', 'Remove the build output', 'rm -rf dist/'],
              key: 'BashcommandRemovethebuildoutputrm-rfdist/YesNo',
            },
          },
        } as Partial<Session>)
      );
      // Without its title where room is short: the command came after it and got cut off.
      expect(row.querySelector('.psr-choices-detail')?.textContent).toBe(
        'Remove the build output · rm -rf dist/'
      );
      (row.querySelectorAll('.psr-choice')[0] as HTMLButtonElement).click();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        option: 1,
        key: 'BashcommandRemovethebuildoutputrm-rfdist/YesNo',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says another answer is on its way, not that the prompt changed, when the server is busy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 }))
    );
    try {
      const row = await renderRow(
        session({
          claudeStatus: {
            status: 'waiting',
            choices: { question: 'Allow?', options: ['Yes', 'No'] },
          },
        } as Partial<Session>)
      );
      (row.querySelectorAll('.psr-choice')[0] as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(row.querySelector('.psr-choices-error')?.textContent).toContain('Still sending')
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says a tmux session opened to watch takes no answers until control is taken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'read-only' }), { status: 409 }))
    );
    try {
      const row = await renderRow(
        session({
          claudeStatus: {
            status: 'waiting',
            choices: { question: 'Allow?', options: ['Yes', 'No'] },
          },
        } as Partial<Session>)
      );
      (row.querySelectorAll('.psr-choice')[0] as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(row.querySelector('.psr-choices-error')?.textContent?.trim()).toBe(
          'Watch only: take control to type here.'
        )
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the answer sheet from the "needs you" chip, not the session', async () => {
    const row = await renderRow(
      session({ claudeStatus: { status: 'waiting', waitingFor: 'permission' } } as Partial<Session>)
    );
    const opened = vi.fn();
    const navigated = vi.fn();
    window.addEventListener('ut-open-answer-sheet', opened);
    row.addEventListener('session-select', navigated);
    try {
      const chip = row.querySelector('[data-testid="psr-needs-chip"]') as HTMLElement;
      touch(chip, -100); // scrolling the list
      expect(opened).not.toHaveBeenCalled();
      chip.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      chip.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      chip.click();
      expect(opened).toHaveBeenCalledTimes(1);
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 's1' });
      expect(navigated).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('ut-open-answer-sheet', opened);
    }
  });

  it('opens the preview from its chip on a tap, not at the end of a scroll', async () => {
    const row = await renderRow(
      session({ previewPorts: [{ port: 5173, source: 'ut-open', at: 1 }] } as Partial<Session>)
    );
    const opened = vi.fn();
    window.addEventListener('ut-open-preview', opened);
    try {
      const chip = row.querySelector('[data-testid="psr-preview-chip"]') as HTMLElement;
      touch(chip, -100);
      expect(opened).not.toHaveBeenCalled();
      touch(chip, 2);
      chip.click();
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('ut-open-preview', opened);
    }
  });

  it('opens the action sheet as a modal and gives focus back to the ⋯ button', async () => {
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    const menu = row.querySelector('.psr-menu') as HTMLButtonElement;
    menu.focus();
    menu.click();
    const sheet = document.body.querySelector('.psr-sheet') as HTMLElement;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.contains(document.activeElement) || document.activeElement === sheet).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('leads with what needs attention: a waiting Claude, or its last message', async () => {
    const waiting = await renderRow(
      session({ claudeStatus: { status: 'waiting', waitingFor: 'permission', title: 'Fix login' } })
    );
    expect(waiting.querySelector('.psr-title')?.textContent).toBe('Fix login');
    // The status line is a button to the reply sheet (2026-10-12).
    expect(waiting.querySelector('.psr-needs-btn')?.textContent).toContain(
      'Needs you · permission'
    );

    const idle = await renderRow(
      session({ claudeStatus: { status: 'idle', preview: { role: 'user', text: 'hola' } } })
    );
    expect(idle.querySelector('.psr-preview')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'You: hola'
    );

    const shell = await renderRow(session({ name: 'zsh', command: ['zsh'] }));
    // Neutral tiles with a glyph, no hashed hues or letters (2026-10-12).
    expect(shell.querySelector('.psr-avatar-terminal')).toBeTruthy();
  });

  it("shows a shell's last line of output under its folder, and only while it runs", async () => {
    const shell = await renderRow(
      session({ name: 'zsh', command: ['zsh'], lastLine: 'npm ERR! missing script: start' })
    );
    // The folder lives in its sheet (2026-11-08); the status line is the output.
    expect(shell.querySelector('.psr-caption')).toBeNull();
    expect((await sheetWhere(shell))?.querySelector('.psr-where')?.textContent?.trim()).toBe(
      'Projects'
    );
    const line = shell.querySelector('[data-testid="row-last-line"]') as HTMLElement;
    expect(line.textContent).toBe('npm ERR! missing script: start');
    expect(line.querySelector('bdi')).toBeTruthy();
    expect(shell.querySelector('[role="button"]')?.getAttribute('aria-label')).toMatch(
      /~\/Projects, npm ERR! missing script: start$/
    );

    const exited = await renderRow(
      session({ name: 'zsh', command: ['zsh'], status: 'exited', lastLine: 'bye' })
    );
    expect(exited.querySelector('[data-testid="row-last-line"]')).toBeNull();

    const quiet = await renderRow(session({ name: 'zsh', command: ['zsh'] }));
    expect(quiet.querySelector('[data-testid="row-last-line"]')).toBeNull();
  });

  it('opens on tap; a long press offers actions instead of opening', async () => {
    vi.useFakeTimers();
    const row = await renderRow(session());
    const select = vi.fn();
    row.addEventListener('session-select', select);
    const target = row.querySelector('.psr') as HTMLElement;

    target.dispatchEvent(new Event('pointerdown'));
    target.click();
    expect(select).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(600);
    target.click();
    expect(select).toHaveBeenCalledTimes(1);

    const sheet = document.body.querySelector('.psr-sheet');
    expect(sheet?.textContent).toContain('Kill session');
    vi.advanceTimersByTime(600); // past the guard against the tap that opened the sheet
    (sheet?.querySelector('button') as HTMLButtonElement | null)?.click(); // "Open"
    expect(select).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
  });

  it('asks before killing a running session from the action sheet', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockResolvedValue({ success: true } as never);
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const kill = [...document.body.querySelectorAll('.psr-sheet button')].find((b) =>
      b.textContent?.includes('Kill session')
    ) as HTMLButtonElement;
    kill.click();
    expect(del).not.toHaveBeenCalled();
    const confirm = document.body.querySelector('[data-testid="psr-kill-confirm"]');
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toContain(
      'Kill “Fix login”?'
    );
    // The tap that opened the confirm step can't also confirm it.
    (confirm as HTMLButtonElement).click();
    expect(del).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    (confirm as HTMLButtonElement).click();
    expect(del).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    del.mockRestore();
  });

  it('pins from the action sheet on a touch pointerup, ignoring the trailing click', async () => {
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    const toggle = vi.fn();
    row.addEventListener('session-pin-toggle', toggle);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    const pin = () => document.body.querySelector('[data-testid="psr-pin"]') as HTMLButtonElement;
    // The tap that opened the sheet can't pin.
    pin().dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(toggle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(pin().textContent?.trim()).toBe('Pin to top');
    // A scroll of the sheet that started on the button is no tap.
    touch(pin(), -100);
    expect(toggle).not.toHaveBeenCalled();
    const button = pin();
    button.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    button.click();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle.mock.calls[0][0].detail).toEqual({ sessionId: 's1', pinned: true });
    expect(document.body.querySelector('.psr-sheet')).toBeNull();

    row.pinned = true;
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-pinned-badge"] svg')).not.toBeNull();
    vi.advanceTimersByTime(1000);
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    expect(pin().textContent?.trim()).toBe('Unpin');
    pin().click();
    expect(toggle.mock.calls[1][0].detail).toEqual({ sessionId: 's1', pinned: false });
  });

  it("a sheet action's trailing click doesn't open the row that was under the sheet", async () => {
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    const select = vi.fn();
    row.addEventListener('session-select', select);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    (document.body.querySelector('[data-testid="psr-pin"]') as HTMLButtonElement).dispatchEvent(
      new PointerEvent('pointerup', { pointerType: 'touch' })
    );
    // iOS's click lands where the finger was: now the row under the closed sheet.
    (row.querySelector('.psr') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('mutes a session on the server from the action sheet and marks the row', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    expect(row.querySelector('[data-testid="psr-muted-badge"]')).toBeNull();
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const mute = document.body.querySelector('[data-testid="psr-mute"]') as HTMLButtonElement;
    expect(mute.textContent?.trim()).toBe('Mute notifications');
    mute.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    mute.click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions/s1/mute');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ muted: true });
    await vi.waitFor(() =>
      expect(row.querySelector('[data-testid="psr-muted-badge"] svg')).not.toBeNull()
    );
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
      'Notifications muted'
    );
    vi.unstubAllGlobals();
  });

  it('anchors the session to its group, moves it to "Otras" and lets it go, without touching it (2026-11-04)', async () => {
    const bakery = '/Users/n/Projects/bakery';
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { groupPin: unknown };
      bodies.push(body);
      return new Response(JSON.stringify({ success: true, groupPin: body.groupPin }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const value = session({ claudeStatus: { status: 'idle', title: 'Insights' } });
    const row = await fixture<PhoneSessionRow>(html`<phone-session-row
      .session=${value}
      .groupMenu=${{
        choices: [
          { key: bakery, name: 'bakery', folder: false },
          { key: null, name: '', folder: false },
        ],
        groupOf: new Map([['s1', bakery]]),
      }}
    ></phone-session-row>`);
    const pinned = vi.fn();
    row.addEventListener('session-group-pinned', pinned);
    const tap = (testId: string) => {
      const button = document.body.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
      expect(button, testId).not.toBeNull();
      button.click();
      return button;
    };
    const openMenu = () => {
      vi.useFakeTimers();
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
    };

    openMenu();
    expect(document.body.querySelector('[data-testid="group-pin-clear"]')).toBeNull();
    expect(tap('group-pin-here').textContent?.trim()).toBe('Anchor to this group');
    vi.useRealTimers();
    await vi.waitFor(() => expect(pinned).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/sessions/s1/group-pin');
    expect(bodies[0]).toEqual({ groupPin: { repoPath: bakery } });
    expect(value.groupPin).toEqual({ repoPath: bakery });

    // Anchored: "Quitar ancla"; "Mover a…" lists the other groups ("Otras" here).
    openMenu();
    expect(document.body.querySelector('[data-testid="group-pin-here"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="group-pin-clear"]')).not.toBeNull();
    tap('group-pin-move');
    vi.advanceTimersByTime(600);
    expect(document.body.querySelector(`[data-testid="group-pin-to-${bakery}"]`)).toBeNull();
    expect(tap('group-pin-to-others').textContent?.trim()).toBe('Other');
    vi.useRealTimers();
    await vi.waitFor(() => expect(pinned).toHaveBeenCalledTimes(2));
    expect(bodies[1]).toEqual({ groupPin: { repoPath: null } });

    openMenu();
    tap('group-pin-clear');
    vi.useRealTimers();
    await vi.waitFor(() => expect(pinned).toHaveBeenCalledTimes(3));
    expect(bodies[2]).toEqual({ groupPin: null });
    expect(value.groupPin).toBeUndefined();
    // Only the group-pin endpoint: nothing sent to the session itself.
    expect(fetchMock.mock.calls.every((call) => String(call[0]).endsWith('/group-pin'))).toBe(true);
    vi.unstubAllGlobals();
  });

  // 2026-11-11 (client audit): a session row cut its title at the end, so two sessions whose
  // titles differ in their last words read the same; task rows already kept the end (.ut-mid).
  it('cuts a long title in the middle and keeps its end, like a task row', async () => {
    const name = 'Revisión 2ª vuelta: arreglos claros de agentes e infraestructura';
    const row = await renderRow(session({ userTitle: name }));
    const title = row.querySelector('.psr-title') as HTMLElement;
    expect(title.classList.contains('ut-mid')).toBe(true);
    expect(title.getAttribute('dir')).toBe('auto');
    expect(title.querySelector('.ut-mid-start')?.textContent).toBe(
      'Revisión 2ª vuelta: arreglos claros de agentes'
    );
    expect(title.querySelector('.ut-mid-end')?.textContent).toBe(' e infraestructura');
    expect(title.textContent).toBe(name);
  });

  it("shows the user's title over Claude's; a given name stays as the subtitle, a generated one goes", async () => {
    const row = await renderRow(
      session({ userTitle: 'Mi tarea', claudeStatus: { status: 'idle', title: 'Fix login' } })
    );
    expect(row.querySelector('.psr-title')?.textContent).toBe('Mi tarea');
    // The row is its title, state, one line and time: no caption (2026-11-08). In its sheet,
    // "claude (~/Projects)" says nothing the folder doesn't (2026-10-12).
    expect(row.querySelector('.psr-caption')).toBeNull();
    const where = await sheetWhere(row);
    expect(where?.querySelector('.psr-subtitle')).toBeNull();
    expect(where?.textContent?.trim()).toBe('Projects');
    const named = await renderRow(
      session({
        name: 'Bot de citas',
        gitBranch: 'feat/x',
        claudeStatus: { status: 'idle', title: 'Fix login' },
      })
    );
    expect(named.querySelector('.psr-subtitle')).toBeNull();
    const namedWhere = await sheetWhere(named);
    expect(namedWhere?.querySelector('.psr-subtitle')?.textContent).toBe('Bot de citas');
    expect(namedWhere?.querySelector('.psr-where')?.textContent?.trim()).toBe('Projects · feat/x');
  });

  it('2026-11-08: one line from the model while it fits, the status of always otherwise', async () => {
    const long =
      'Runs the card component tests after cutting their text down to a single line, then checks the screenshots';
    const row = await renderRow(
      session({
        claudeStatus: {
          status: 'busy',
          title: 'Fix login',
          activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test' },
        },
        explain: { text: long, at: Date.now() },
      })
    );
    const line = row.querySelector('[data-testid="row-explain"]') as HTMLElement;
    expect([...(line.textContent ?? '')].length).toBeLessThanOrEqual(80);
    expect(line.textContent?.endsWith('…')).toBe(true);
    expect(row.querySelector('[data-testid="row-activity"]')).toBeNull();
    // The whole line in its sheet.
    expect((await sheetWhere(row))?.querySelector('.psr-sheet-explain')?.textContent).toBe(long);

    // Without one: what Claude does now, as always.
    const plain = await renderRow(
      session({
        claudeStatus: {
          status: 'busy',
          title: 'Fix login',
          activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test' },
        },
      })
    );
    expect(plain.querySelector('[data-testid="row-explain"]')).toBeNull();
    expect(plain.querySelector('[data-testid="row-activity"]')?.textContent).toBe(
      'Bash · pnpm test'
    );
  });

  /**
   * Opens the row's ⋯ sheet and returns a copy of its lines under the title (folder, branch,
   * name, the agent's whole line); the sheet is closed again.
   */
  async function sheetWhere(row: PhoneSessionRow) {
    vi.useFakeTimers();
    try {
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
      const sheets = document.body.querySelectorAll('[data-testid="psr-sheet-where"]');
      const where = sheets[sheets.length - 1]?.cloneNode(true) as Element | undefined;
      (document.body.querySelector('.psr-sheet-cancel') as HTMLButtonElement | null)?.click();
      vi.advanceTimersByTime(1000);
      return where ?? null;
    } finally {
      vi.useRealTimers();
    }
  }

  /** Opens the row's ⋯ sheet and turns its Rename row into the field. */
  async function startRename(row: PhoneSessionRow) {
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    expect(document.body.querySelector('[data-testid="psr-reset-title"]')).toBeNull();
    (document.body.querySelector('[data-testid="psr-rename"]') as HTMLButtonElement).click();
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="rename-input"]')).not.toBeNull()
    );
    return document.body.querySelector('[data-testid="rename-input"]') as HTMLInputElement;
  }

  it('renames the visible title in place, from a field that starts with it', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    const renamed = vi.fn();
    row.addEventListener('session-renamed', renamed);
    const input = await startRename(row);
    expect(input.value).toBe('Fix login');
    expect(document.body.querySelector('[data-testid="psr-rename"]')).toBeNull();

    input.value = 'Mi tarea';
    (document.body.querySelector('[data-testid="rename-ok"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(renamed).toHaveBeenCalledTimes(1));
    expect(prompt).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions/s1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ userTitle: 'Mi tarea' });
    expect(renamed.mock.calls[0][0].detail).toEqual({ sessionId: 's1', userTitle: 'Mi tarea' });
    // Saved: the sheet closes.
    await vi.waitFor(() => expect(document.body.querySelector('.psr-sheet')).toBeNull());
    vi.unstubAllGlobals();
  });

  it('a failed rename says why in the field; Cancel brings the Rename row back', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(session({ claudeStatus: { status: 'idle', title: 'Fix login' } }));
    const renamed = vi.fn();
    row.addEventListener('session-renamed', renamed);
    const input = await startRename(row);
    input.value = 'Mi tarea';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="rename-error"]')?.textContent?.trim()).toBe(
        'Failed to rename session: server error (500)'
      )
    );
    expect(renamed).not.toHaveBeenCalled();

    (document.body.querySelector('[data-testid="rename-cancel"]') as HTMLButtonElement).click();
    expect(document.body.querySelector('[data-testid="rename-input"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="psr-rename"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("goes back to Claude's title from the action sheet", async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(
      session({ userTitle: 'Mi tarea', claudeStatus: { status: 'idle', title: 'Fix login' } })
    );
    const renamed = vi.fn();
    row.addEventListener('session-renamed', renamed);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const reset = document.body.querySelector(
      '[data-testid="psr-reset-title"]'
    ) as HTMLButtonElement;
    expect(reset.textContent?.trim()).toBe("Use Claude's title");
    reset.click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(renamed).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ userTitle: null });
    vi.unstubAllGlobals();
  });

  it('shields a running Claude session after a confirm step, and marks shielded rows', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ sessionId: 's2', replaced: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(
      session({ claudeSessionId: 'c1', claudeStatus: { status: 'idle', title: 'Fix login' } })
    );
    const created = vi.fn();
    row.addEventListener('session-created', created);
    // Not shielded is the exception a row flags (2026-10-12).
    expect(row.querySelector('[data-testid="psr-unshielded-badge"]')).not.toBeNull();
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    const shield = document.body.querySelector('[data-testid="psr-shield"]') as HTMLButtonElement;
    touch(shield, -100);
    expect(document.body.querySelector('[data-testid="psr-shield-confirm"]')).toBeNull();
    shield.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    shield.click();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toContain(
      'Claude restarts in a shielded session'
    );
    const confirm = document.body.querySelector(
      '[data-testid="psr-shield-confirm"]'
    ) as HTMLButtonElement;
    // The tap that opened the confirm step can't also confirm it.
    confirm.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    confirm.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    confirm.click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/sessions/s1/shield');
    expect(created.mock.calls[0][0].detail).toEqual({ sessionId: 's2', replaced: true });
    vi.unstubAllGlobals();

    row.session = session({ shielded: true });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-unshielded-badge"]')).toBeNull();
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain('Shielded');
    vi.useFakeTimers();
    vi.advanceTimersByTime(3000); // past the ghost-click guard of the confirm tap
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    // Already shielded: no Shield action, just what it means.
    expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="psr-shield-info"]')).not.toBeNull();
    (document.body.querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
  });

  it('moves a ut Claude session to Untether after a confirm step (2026-10-25)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ sessionId: 's2', replaced: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const row = await renderRow(
      session({ id: 'fwd_1761400000000_4242', claudeSessionId: 'c1', userTitle: 'bakery' })
    );
    const created = vi.fn();
    row.addEventListener('session-created', created);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
    const move = document.body.querySelector(
      '[data-testid="psr-move-to-untether"]'
    ) as HTMLButtonElement;
    move.click();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('.psr-sheet-title')?.textContent).toContain(
      'Move “bakery” to Untether?'
    );
    vi.advanceTimersByTime(600);
    (
      document.body.querySelector(
        '[data-testid="psr-move-to-untether-confirm"]'
      ) as HTMLButtonElement
    ).click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions/fwd_1761400000000_4242/shield');
    expect(JSON.parse(String(init.body)).windowNotice).toContain('bakery');
    vi.unstubAllGlobals();
  });

  it('flags a shielded session restored after a reboot, for a day while it runs', async () => {
    const row = await renderRow(
      session({ shielded: true, restoredAt: new Date(Date.now() - 60_000).toISOString() })
    );
    expect(row.querySelector('[data-testid="psr-restored-badge"]')).not.toBeNull();
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
      'Restored after a restart'
    );
    row.session = session({
      shielded: true,
      restoredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-restored-badge"]')).toBeNull();
  });

  // 2026-10-31: Untether restarted its idle Claude on the installed version.
  it('says a session was updated to a new Claude, for a day while it runs', async () => {
    const update = {
      from: '2.1.310',
      to: '2.1.316',
      at: new Date(Date.now() - 60_000).toISOString(),
    };
    const row = await renderRow(session({ shielded: true, claudeUpdatedTo: update }));
    const badge = row.querySelector('[data-testid="psr-claude-updated-badge"]');
    expect(badge?.getAttribute('title')).toBe('Updated to 2.1.316');
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
      'Updated to 2.1.316'
    );
    row.session = session({
      shielded: true,
      claudeUpdatedTo: {
        ...update,
        at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-claude-updated-badge"]')).toBeNull();
  });

  it('a sideways swipe reveals Kill (still confirmed) without opening; a vertical drag does not', async () => {
    const row = await renderRow(session());
    vi.useFakeTimers();
    const select = vi.fn();
    row.addEventListener('session-select', select);
    const target = row.querySelector('.psr') as HTMLElement;
    const drag = async (dx: number, dy: number) => {
      const at = (x: number, y: number) => ({
        clientX: x,
        clientY: y,
        pointerId: 1,
        bubbles: true,
      });
      target.dispatchEvent(new PointerEvent('pointerdown', at(300, 100)));
      target.dispatchEvent(new PointerEvent('pointermove', at(300 + dx / 2, 100 + dy / 2)));
      target.dispatchEvent(new PointerEvent('pointermove', at(300 + dx, 100 + dy)));
      target.dispatchEvent(new PointerEvent('pointerup', at(300 + dx, 100 + dy)));
      target.click();
      await row.updateComplete;
    };

    await drag(-10, -120); // a scroll
    expect(target.style.transform).toBe('');
    expect(select).toHaveBeenCalledTimes(1);

    await drag(-150, 8);
    expect(target.style.transform).toBe('translateX(-168px)');
    expect(select).toHaveBeenCalledTimes(1);
    expect(row.querySelector('[data-testid="psr-swipe-more"]')).not.toBeNull();

    // A touch acts on pointerup (iOS may never send the click); the click that follows,
    // landing on the new sheet's backdrop, neither repeats the action nor closes the sheet.
    const kill = row.querySelector('[data-testid="psr-swipe-kill"]') as HTMLButtonElement;
    touch(kill, -100);
    expect(document.body.querySelector('.psr-sheet')).toBeNull();
    kill.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    kill.click();
    (document.body.querySelector('.psr-sheet-backdrop') as HTMLElement).click();
    expect(document.body.querySelector('[data-testid="psr-kill-confirm"]')).toBeTruthy();
    expect(document.body.querySelectorAll('.psr-sheet')).toHaveLength(1);
    vi.advanceTimersByTime(600);
    (document.body.querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
  });

  it('resumes a finished Claude conversation from its row in one tap', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 }));
    const row = await renderRow(
      session({ status: 'exited', claudeSessionId: 'abc', claudeResumable: true })
    );
    const select = vi.fn();
    row.addEventListener('session-select', select);
    (row.querySelector('[data-testid="psr-resume"]') as HTMLButtonElement).click();
    expect(select).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/sessions');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.command).toEqual(['claude', '--resume', 'abc']);
    fetchMock.mockRestore();

    const plain = await renderRow(session({ status: 'exited', claudeSessionId: 'abc' }));
    expect(plain.querySelector('[data-testid="psr-resume"]')).toBeNull();
  });

  // 2026-11-10: only Claude sessions had Resume.
  it('resumes a finished Codex thread from its row in one tap', async () => {
    const thread = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 }));
    const row = await renderRow(
      session({
        status: 'exited',
        command: ['codex', '--yolo'],
        codexThreadId: thread,
        codexResumable: true,
      })
    );
    const created = vi.fn();
    row.addEventListener('session-created', created);
    (row.querySelector('[data-testid="psr-resume"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/sessions');
    expect(JSON.parse(String(call?.[1]?.body)).command).toEqual(['codex', 'resume', thread]);
    fetchMock.mockRestore();

    // Resumed already in another session, or its thread gone: the server says no.
    const not = await renderRow(
      session({ status: 'exited', codexThreadId: thread, codexResumable: false })
    );
    expect(not.querySelector('[data-testid="psr-resume"]')).toBeNull();
  });

  it('knows which program a session runs, through shell wrappers and paths', () => {
    expect(sessionTool({ command: ['zsh', '-lic', 'claude --resume x'] })).toBe('claude');
    expect(sessionTool({ command: ['/opt/homebrew/bin/gemini'] })).toBe('gemini');
    expect(sessionTool({ command: ['zsh'] })).toBe('zsh');
    // Gemini typed inside a shell: the server flags the session.
    expect(sessionTool({ command: ['zsh'], geminiActive: true })).toBe('gemini');
    // Wrappers and assignments in front, and an agent anywhere in a shell's script (2026-10-12).
    expect(sessionTool({ command: ['caffeinate', '-i', 'claude'] })).toBe('claude');
    expect(sessionTool({ command: ['env', 'FOO=1', 'codex', '--yolo'] })).toBe('codex');
    expect(sessionTool({ command: ['zsh', '-lc', 'exec nohup gemini'] })).toBe('gemini');
    expect(sessionTool({ command: ['zsh', '-lc', 'cd ~/app && claude --resume 1'] })).toBe(
      'claude'
    );
    expect(sessionTool({ command: ['sudo', 'htop'] })).toBe('htop');
    expect(sessionTool({ command: ['vim', 'claude.md'] })).toBe('vim');
  });

  it('a waiting prompt answers in one row of short pills; only the first is filled', async () => {
    const row = await renderRow(
      session({
        claudeStatus: {
          status: 'waiting',
          waitingFor: 'permission prompt',
          title: 'Fix login',
          choices: {
            question: 'Do you want to proceed?',
            options: ['Yes', "Yes, and don't ask again", 'No'],
            detail: ['Bash command', 'pnpm test'],
          },
        },
      })
    );
    const pills = [...row.querySelectorAll<HTMLButtonElement>('.psr-choice')];
    expect(pills.map((pill) => pill.textContent?.trim())).toEqual(['Yes', 'Always', 'No']);
    expect(pills.map((pill) => pill.getAttribute('aria-label'))).toEqual([
      'Yes',
      "Yes, and don't ask again",
      'No',
    ]);
    expect(pills.map((pill) => pill.classList.contains('primary'))).toEqual([true, false, false]);
    // What it approves, not the stock question.
    // With the pills, above them; the caption stays "folder · branch" (QA 2026-10-12).
    expect(row.querySelector('.psr-choices .psr-choices-detail')?.textContent?.trim()).toBe(
      'Bash command · pnpm test'
    );
    expect(row.querySelector('.psr-main .psr-choices-detail')).toBeNull();
    expect(row.textContent).not.toContain('Do you want to proceed?');
    // With pills there is still the ⋯; without, a "Reply" pill takes its place.
    expect(row.querySelector('.psr-menu')).not.toBeNull();
    const plain = await renderRow(
      session({ claudeStatus: { status: 'waiting', title: 'Fix login' } })
    );
    expect(plain.querySelector('.psr-menu')).toBeNull();
    const open = vi.fn();
    window.addEventListener('ut-open-answer-sheet', open);
    plain.querySelector<HTMLButtonElement>('[data-testid="psr-reply"]')?.click();
    window.removeEventListener('ut-open-answer-sheet', open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a working row says the tool and target, at minute resolution, and keeps "You:" for VoiceOver', async () => {
    const row = await renderRow(
      session({
        claudeStatus: {
          status: 'busy',
          title: 'Refactor',
          activity: {
            kind: 'tool',
            tool: 'Bash',
            target: 'vitest run',
            since: Date.now() - 125_000,
          },
          preview: { role: 'user', text: 'Pasa los tests' },
        },
      })
    );
    expect(row.querySelector('[data-testid="row-activity"]')?.textContent).toBe(
      'Bash · vitest run'
    );
    expect(row.querySelector('claude-activity-elapsed')?.hasAttribute('minutes')).toBe(true);
    expect(row.querySelector('.psr-status')?.textContent).not.toContain('Pasa los tests');
    expect(row.querySelector('.psr-main')?.getAttribute('aria-label')).toContain('Pasa los tests');
  });

  it('an idle Claude shows when it last did something, the same moment as its agent card', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-04T13:05:00') });
    try {
      const value = session({
        // Opening the session redrew the screen a few minutes ago: that isn't activity.
        lastModified: new Date('2026-10-04T13:01:00').toISOString(),
        claudeStatus: { status: 'idle', since: new Date('2026-10-04T12:45:00').getTime() },
      });
      const row = await fixture<PhoneSessionRow>(
        html`<phone-session-row .session=${value}></phone-session-row>`
      );
      expect(row.querySelector('.psr-time')?.textContent?.trim()).toBe('20 min');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its time current without new session data, on one shared timer', async () => {
    fixtureCleanup(); // rows left by earlier tests would own the (real) shared timer
    vi.useFakeTimers({ now: new Date('2026-10-02T10:30:00') });
    const value = session({ lastModified: new Date('2026-10-02T10:30:00').toISOString() });
    const rows = document.createElement('div');
    document.body.append(rows);
    render(
      html`<phone-session-row .session=${value}></phone-session-row>
        <phone-session-row .session=${session({ id: 's2' })}></phone-session-row>`,
      rows
    );
    const row = rows.querySelector('phone-session-row') as PhoneSessionRow;
    await row.updateComplete;
    const time = () => row.querySelector('.psr-time')?.textContent?.trim();
    const rowRender = vi.spyOn(row, 'render');
    expect(time()).toBe('now');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(5 * 60_000);
    expect(time()).toBe('5 min');
    expect(rowRender).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    vi.advanceTimersByTime(5 * 60_000);
    expect(time()).toBe('5 min'); // paused while the page is hidden
    delete (document as { hidden?: boolean }).hidden;
    vi.advanceTimersByTime(30_000);
    expect(time()).toBe('10 min');

    rows.remove();
    vi.runOnlyPendingTimers(); // each row's one-shot sheet check after disconnecting
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says Disconnect for a session attached to a tmux session, never Shield', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockResolvedValue({ success: true } as never);
    const changed = vi.fn();
    window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    try {
      const row = await renderRow(
        session({
          name: 'tmux: work',
          command: ['/opt/homebrew/bin/tmux', '-u', '-N', '-S', '/tmp/tmux-501/default'],
          claudeSessionId: 'c1',
          claudeStatus: { status: 'idle', title: 'Fix login' },
          multiplexer,
        })
      );
      expect(row.querySelector('[data-testid="psr-swipe-kill"]')?.textContent?.trim()).toBe(
        'Disconnect'
      );
      vi.useFakeTimers();
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
      // Shielding would run its tmux client inside a shield.
      expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
      const disconnect = document.body.querySelector('.psr-sheet .destructive') as HTMLElement;
      expect(disconnect.textContent?.trim()).toBe('Disconnect');
      disconnect.click();
      expect(document.body.querySelector('.psr-sheet-title')?.textContent?.trim()).toBe(
        'Disconnect from “Fix login”? It keeps running in tmux.'
      );
      const confirm = document.body.querySelector(
        '[data-testid="psr-kill-confirm"]'
      ) as HTMLButtonElement;
      expect(confirm.textContent?.trim()).toBe('Disconnect');
      vi.advanceTimersByTime(600);
      confirm.click();
      vi.useRealTimers();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(del).toHaveBeenCalledTimes(1);
      await row.updateComplete;
      expect(row.querySelector('.psr-live')?.textContent).toBe('Disconnecting…');

      // Attached from the tmux sessions modal: only its name says so.
      const named = await renderRow(session({ id: 's2', name: 'tmux: work' }));
      expect(named.querySelector('[data-testid="psr-swipe-kill"]')?.textContent?.trim()).toBe(
        'Disconnect'
      );
    } finally {
      window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
      del.mockRestore();
    }
  });

  it('says a failed disconnect in its own words', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockImplementation(async (_session, options) => {
        options.callbacks?.onError?.('Failed to terminate session: terminate failed: 500');
        return { success: false, error: 'terminate failed: 500' };
      });
    const row = await renderRow(session({ multiplexer }));
    const failed = vi.fn();
    const killError = vi.fn();
    row.addEventListener('error', failed);
    row.addEventListener('session-kill-error', killError);
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    (document.body.querySelector('.psr-sheet .destructive') as HTMLElement).click();
    vi.advanceTimersByTime(600);
    (document.body.querySelector('[data-testid="psr-kill-confirm"]') as HTMLElement).click();
    vi.useRealTimers();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed.mock.calls[0][0].detail).toBe('Couldn’t disconnect: terminate failed: 500');
    expect(killError).not.toHaveBeenCalled();
    del.mockRestore();
  });

  it('never resumes a finished attached session: its conversation still runs in tmux', async () => {
    const row = await renderRow(
      session({ status: 'exited', claudeSessionId: 'abc', claudeResumable: true, multiplexer })
    );
    expect(row.querySelector('[data-testid="psr-resume"]')).toBeNull();
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    expect(document.body.querySelector('.psr-sheet')?.textContent).not.toContain(
      'Resume conversation'
    );
    expect(document.body.querySelector('.psr-sheet .destructive')?.textContent?.trim()).toBe(
      'Clear session'
    );
  });

  it('marks a session in a terminal window on the Mac with a monitor icon and its app', async () => {
    rememberMacSessionsPlatform('darwin');
    const row = await renderRow(
      session({
        id: 'fwd_1759500000_20085',
        name: 'claude',
        claudeSessionId: 'c1',
        claudeStatus: { status: 'idle', title: 'Fix login' },
        macWindow: { app: 'Terminal' },
      })
    );
    const line = row.querySelector('[data-testid="psr-mac-window"]') as HTMLElement;
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('On the Mac · Terminal · claude');
    expect(line.querySelector('[role="img"] svg')).not.toBeNull();
    expect(line.querySelector('bdi')?.textContent).toBe('On the Mac · Terminal');
    const mark = line.querySelector('[role="img"]') as HTMLElement;
    expect(mark.getAttribute('aria-label')).toBe('Runs in a terminal window on this Mac');
    expect(mark.getAttribute('title')).toBe('Runs in a terminal window on this Mac');
    expect(row.querySelector('.psr-subtitle')).toBeNull();
    expect(row.querySelector('.psr-main')?.getAttribute('aria-label')).toMatch(
      /^claude, Fix login, On the Mac · Terminal, /
    );
    vi.useFakeTimers();
    (row.querySelector('.psr-menu') as HTMLButtonElement).click();
    vi.advanceTimersByTime(600);
    // Shielding would close it in its window.
    expect(document.body.querySelector('[data-testid="psr-shield"]')).toBeNull();
    (document.body.querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
    vi.useRealTimers();

    rememberMacSessionsPlatform('linux');
    row.session = session({ id: 'fwd_1', macWindow: { app: null } });
    await row.updateComplete;
    expect(row.querySelector('[data-testid="psr-mac-window"] bdi')?.textContent).toBe(
      'On this computer'
    );
  });

  it('warns before killing a session opened with ut that it ends in its window too', async () => {
    const del = vi
      .spyOn(sessionActionService, 'deleteSession')
      .mockResolvedValue({ success: true } as never);
    // The row's own sheet: the last one in <body> (earlier tests may leave theirs open).
    const sheet = () => [...document.body.querySelectorAll('.psr-sheet')].at(-1) as HTMLElement;
    /** The confirm step's note under "Kill “…”?", then cancelled; null when it has none. */
    const killNote = async (value: Session) => {
      const row = await renderRow(value);
      vi.useFakeTimers();
      (row.querySelector('.psr-menu') as HTMLButtonElement).click();
      vi.advanceTimersByTime(600);
      (sheet().querySelector('.destructive') as HTMLElement).click();
      expect(sheet().querySelector('[data-testid="psr-kill-confirm"]')).toBeTruthy();
      const note = sheet().querySelector('[data-testid="psr-kill-mac-window"]');
      vi.advanceTimersByTime(600);
      (sheet().querySelector('.psr-sheet-cancel') as HTMLButtonElement).click();
      vi.useRealTimers();
      return note?.textContent?.trim() ?? null;
    };
    try {
      const inWindow = session({
        id: 'fwd_1759500000_20085',
        name: 'claude',
        macWindow: { app: 'Terminal' },
      });
      rememberMacSessionsPlatform('darwin');
      expect(await killNote(inWindow)).toBe('It also closes in the Mac window.');
      rememberMacSessionsPlatform('linux');
      expect(await killNote(inWindow)).toBe('It also closes in its window on this computer.');
      expect(await killNote(session())).toBeNull();
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
  });

  it('formats times like a chat list', () => {
    const now = new Date('2026-10-02T10:30:00');
    expect(formatRowTime('2026-10-02T10:29:40', now)).toBe('now');
    expect(formatRowTime('2026-10-02T10:05:00', now)).toBe('25 min');
    expect(formatRowTime(undefined, now)).toBe('');
  });
});

describe('PhoneSessionRow of an orchestrator', () => {
  // 2026-10-24: outside its project group (mission control, "On this Mac") nothing said which
  // session was the orchestrator.
  it('carries the sparkles and says so to VoiceOver', async () => {
    const row = await renderRow(session());
    expect(row.querySelector('[data-testid="psr-orchestrator-badge"]')).toBeNull();
    row.orchestrator = true;
    await row.updateComplete;
    const badge = row.querySelector('[data-testid="psr-orchestrator-badge"]');
    expect(badge?.getAttribute('aria-label')).toBe('Orchestrator');
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
      'Orchestrator'
    );
  });
});

describe('PhoneSessionRow while background agents run', () => {
  it('says it waits for background agents, calm, with the reply, instead of "Working"', async () => {
    const { setLocale } = await import('../i18n/index.js');
    await setLocale('es');
    try {
      const row = await renderRow(
        session({
          claudeStatus: {
            status: 'busy',
            waitingForBackground: true,
            title: 'Agentes',
            preview: { role: 'assistant', text: 'Lanzado; te aviso.' },
          },
        })
      );
      expect(row.querySelector('[data-testid="row-background"]')?.textContent).toBe(
        'Esperando a agentes en segundo plano'
      );
      expect(row.querySelector('.psr-working')).toBeNull();
      expect(row.querySelector('.psr-dots')).toBeNull();
      expect(row.querySelector('.psr-preview')?.textContent).toContain('Lanzado; te aviso.');
      expect(row.querySelector('[role="button"]')?.getAttribute('aria-label')).toContain(
        'Esperando a agentes en segundo plano'
      );
      fixtureCleanup();

      // A turn in progress is still "Working".
      const working = await renderRow(session({ claudeStatus: { status: 'busy' } }));
      expect(working.querySelector('.psr-working')?.textContent).toContain('Trabajando');
      expect(working.querySelector('[data-testid="row-background"]')).toBeNull();
    } finally {
      fixtureCleanup();
      await setLocale('en');
    }
  });

  describe('swipe right', () => {
    const swipe = async (row: PhoneSessionRow, dx: number) => {
      const target = row.querySelector('.psr') as HTMLElement;
      const at = (x: number) => ({ clientX: x, clientY: 100, pointerId: 2, bubbles: true });
      target.dispatchEvent(new PointerEvent('pointerdown', at(40)));
      target.dispatchEvent(new PointerEvent('pointermove', at(40 + dx / 2)));
      target.dispatchEvent(new PointerEvent('pointermove', at(40 + dx)));
      target.dispatchEvent(new PointerEvent('pointerup', at(40 + dx)));
      await row.updateComplete;
      return target;
    };

    it('reveals Pin', async () => {
      const row = await renderRow(session());
      const target = await swipe(row, 70);
      expect(target.style.transform).toBe('translateX(84px)');
      const toggle = vi.fn();
      row.addEventListener('session-pin-toggle', toggle);
      row.querySelector<HTMLButtonElement>('[data-testid="psr-swipe-pin"]')?.click();
      expect(toggle.mock.calls[0][0].detail).toEqual({ sessionId: 's1', pinned: true });
    });

    it('all the way on a waiting row opens the reply sheet', async () => {
      const row = await renderRow(session({ claudeStatus: { status: 'waiting', title: 'Fix' } }));
      const open = vi.fn();
      window.addEventListener('ut-open-answer-sheet', open);
      const target = await swipe(row, 260);
      window.removeEventListener('ut-open-answer-sheet', open);
      expect(open).toHaveBeenCalledTimes(1);
      expect(target.style.transform).toBe('');
    });
  });
});

describe('isNoiseLine', () => {
  it('drops escapes and pager prompts, keeps real output', () => {
    for (const line of ['^[', '^[^[b', ':', '^[[A', '(END)', '  '])
      expect(isNoiseLine(line)).toBe(true);
    for (const line of ['adios mundo', '• Running swift build', '$ ls', 'Done: 3 files']) {
      expect(isNoiseLine(line)).toBe(false);
    }
  });
});

// Live in colour, finished in grey (2026-10-12): list.css tints the tile from the avatar's
// data-state and colours the dot from its class, so the mapping state -> markup is the contract.
describe('agentAvatar row: live vs finished', () => {
  const stamp = (kind: AvatarKind, state: string) => {
    const host = document.createElement('div');
    render(agentAvatar({ variant: 'row', kind, state }), host);
    const avatar = host.querySelector('.psr-avatar') as HTMLElement;
    return { avatar, dot: avatar.querySelector('.psr-dot') as HTMLElement };
  };

  it("an orchestrator's tile shows its project's icon with the agent's mark kept small (2026-10-20)", () => {
    const host = document.createElement('div');
    render(
      agentAvatar({
        variant: 'row',
        kind: 'claude',
        state: 'idle',
        projectIcon: '/api/projects/icon?repo=%2Frepo&v=icon.png',
      }),
      host
    );
    const avatar = host.querySelector('.psr-avatar') as HTMLElement;
    expect(avatar.getAttribute('data-icon')).toBe('project');
    expect(avatar.querySelector('img.psr-avatar-icon')?.getAttribute('src')).toContain(
      '/api/projects/icon?repo=%2Frepo'
    );
    expect(avatar.querySelector('.psr-avatar-glyph svg')).not.toBeNull();
    expect(avatar.querySelector('.psr-dot-idle')).not.toBeNull();
    // An icon that can't load gives the plain tile back.
    avatar.querySelector('img')?.dispatchEvent(new Event('error'));
    expect(avatar.hasAttribute('data-icon')).toBe(false);
    // No icon: the tile as before.
    const plain = document.createElement('div');
    render(agentAvatar({ variant: 'row', kind: 'claude', state: 'idle' }), plain);
    expect(plain.querySelector('img')).toBeNull();
  });

  it('stamps every state on the tile and its dot, with the agent or terminal glyph', () => {
    for (const state of ['working', 'waiting', 'idle', 'shell', 'exited'] as const) {
      const { avatar, dot } = stamp('claude', state);
      expect(avatar.getAttribute('data-state')).toBe(state);
      expect(avatar.classList.contains('psr-avatar-claude')).toBe(true);
      expect(dot.classList.contains(`psr-dot-${state}`)).toBe(true);
    }
    expect(stamp('terminal', 'shell').avatar.querySelector('svg')).not.toBeNull();
    expect(stamp('terminal', 'shell').avatar.querySelector('.psr-initial')).toBeNull();
  });

  it('maps sessions to live (working / waiting / idle / shell) or finished states', () => {
    const base = session({});
    expect(rowState({ ...base, status: 'exited' })).toBe('exited');
    expect(rowState({ ...base, claudeStatus: { status: 'busy' } } as Session)).toBe('working');
    expect(rowState({ ...base, claudeStatus: { status: 'waiting' } } as Session)).toBe('waiting');
    expect(rowState({ ...base, claudeStatus: { status: 'idle' } } as Session)).toBe('idle');
    expect(rowState({ ...base, claudeStatus: undefined })).toBe('shell');
    // Codex's own state (its rollout); without one it rests like a shell, as before.
    const codex = (status: 'busy' | 'waiting' | 'idle') =>
      rowState({ ...base, codexActive: true, agentStatus: { agent: 'codex', status } } as Session);
    expect(codex('busy')).toBe('working');
    expect(codex('waiting')).toBe('waiting');
    expect(codex('idle')).toBe('idle');
    expect(rowState({ ...base, codexActive: true } as Session)).toBe('shell');
    expect(rowGlyphKind('tmux')).toBe('terminal');
    expect(rowGlyphKind('codex')).toBe('codex');
  });
});
