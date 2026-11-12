// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MacShareErrorCode,
  MacShareFailReason,
  MacShareJob,
  MacSharePlan,
  MacShareSheetDetail,
} from '../../shared/mac-share.js';
import { setLocale } from '../i18n/index.js';
import { macShareErrorText, macShareReasonText } from '../utils/mac-share.js';
import { closeMacShareSheet, type MacShareSheet, openMacShareSheet } from './mac-share-sheet.js';

const ID = 'a-20085-1759500000';
const JOB = 'j'.repeat(22);
const TOKEN = 't'.repeat(22);
const DETAIL: MacShareSheetDetail = { id: ID, agent: 'claude', app: 'Terminal', title: 'Docs' };
const COMMAND = `cd '/Users/u/‮evil' && ut claude --resume '0b402254-352f-4532-b05e-1186d66e984a'`;
const PLAN: MacSharePlan = {
  token: TOKEN,
  expiresAt: new Date().toISOString(),
  agent: 'claude',
  app: 'Terminal',
  tty: 'ttys001',
  cwd: '/Users/u',
  conversationId: '0b402254-352f-4532-b05e-1186d66e984a',
  mode: 'same-tab',
  command: COMMAND,
  kept: ['--model'],
  dropped: ['--append-system-prompt'],
  droppedPrompt: true,
  warnings: ['flags-dropped', 'argv-inexact'],
};

const job = (over: Partial<MacShareJob> = {}): MacShareJob => ({
  id: JOB,
  state: 'running',
  step: 'checking',
  closed: false,
  agent: 'claude',
  app: 'Terminal',
  mode: 'same-tab',
  updatedAt: new Date().toISOString(),
  ...over,
});

const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sheet = () => document.querySelector<MacShareSheet>('mac-share-sheet');
const touch = (el: Element | null) => {
  for (const type of ['pointerdown', 'pointerup']) {
    el?.dispatchEvent(
      new PointerEvent(type, { pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 })
    );
  }
};

describe('mac share sheet', () => {
  let store: Map<string, string>;
  let jobs: MacShareJob[];
  let planAnswer: () => Response;
  let calls: Array<{ url: string; body?: unknown }>;
  const onShared = vi.fn();

  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    await sheet()?.updateComplete;
  };
  /** Past the 500 ms guard of a new step. */
  const later = () => settle(600);

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map();
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, String(value));
    });
    jobs = [job()];
    planAnswer = () => Response.json(PLAN);
    calls = [];
    onShared.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/share/plan')) return planAnswer();
        if (url.endsWith('/share')) return Response.json({ jobId: JOB }, { status: 202 });
        if (url.includes('/share/')) return Response.json(jobs.length > 1 ? jobs.shift() : jobs[0]);
        return Response.json({}, { status: 404 });
      })
    );
  });

  afterEach(async () => {
    closeMacShareSheet();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    await setLocale('en');
  });

  async function open(detail: MacShareSheetDetail = DETAIL) {
    openMacShareSheet(detail, { authHeader: () => ({ Authorization: 'Bearer x' }), onShared });
    await settle();
  }

  it('explains once per app, then plans with the prompt allowed', async () => {
    await open();
    const dialog = find('mac-share-sheet');
    expect(dialog?.dataset.phase).toBe('explain');
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.textContent).toContain('Allow Untether to use Terminal');
    expect(calls).toEqual([]);
    touch(find('mac-share-explain-continue'));
    await settle();
    expect(calls).toEqual([]); // the tap that showed it can't answer it
    await later();
    touch(find('mac-share-explain-continue'));
    await settle();
    expect(store.get('ut-mac-share-asked-Terminal')).toBe('1');
    expect(calls[0]).toEqual({
      url: `/api/mac-sessions/${ID}/share/plan`,
      body: { allowPrompt: true },
    });
    expect(find('mac-share-sheet')?.dataset.phase).toBe('confirm');

    closeMacShareSheet();
    calls = [];
    await open();
    expect(find('mac-share-sheet')?.dataset.phase).toBe('confirm');
    expect(calls).toHaveLength(1);
  });

  it('confirms with the exact command left to right, bidi shown escaped, and what is dropped', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    await open();
    const dialog = find('mac-share-sheet');
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(
      document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent
    ).toBe('Share this conversation with your phone?');
    expect(dialog?.textContent).toContain('Don’t type in that tab until it’s back.');
    expect(find('mac-share-background')?.textContent).toContain('Subagents');
    const command = find('mac-share-command');
    expect(command?.getAttribute('dir')).toBe('ltr');
    expect(command?.textContent).toContain('\\u{202E}evil');
    expect(command?.textContent).not.toContain('‮');
    expect(find('mac-share-dropped')?.textContent).toBe(
      'Not carried over: --append-system-prompt, the message it was started with'
    );
    expect(find('mac-share-command-details')?.tagName).toBe('DETAILS');
  });

  it('shares once, follows the steps, and opens the session when shared', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    jobs = [
      job({ step: 'closing' }),
      job({ step: 'typing', closed: true, resumeCommand: COMMAND }),
      job({ state: 'shared', step: 'starting', closed: true, sessionId: 'fwd_1_2' }),
    ];
    await open();
    touch(find('mac-share-confirm'));
    await settle();
    expect(calls.filter((call) => call.url.endsWith('/share'))).toHaveLength(0);
    await later();
    touch(find('mac-share-confirm'));
    touch(find('mac-share-confirm'));
    await settle();
    const starts = calls.filter((call) => call.url.endsWith('/share'));
    expect(starts).toEqual([{ url: `/api/mac-sessions/${ID}/share`, body: { token: TOKEN } }]);
    const step = find('mac-share-step');
    expect(step?.getAttribute('role')).toBe('status');
    expect(find('mac-share-sheet')?.getAttribute('role')).toBe('dialog');
    expect(step?.textContent).toContain('Closing it on the Mac…');
    await settle(1000);
    expect(find('mac-share-step')?.textContent).toContain('Reopening it in the same tab…');
    await settle(1000);
    expect(find('mac-share-sheet')?.textContent).toContain(
      'Shared: it’s open on the Mac and here.'
    );
    expect(onShared).not.toHaveBeenCalled();
    await settle(700);
    expect(onShared).toHaveBeenCalledWith('fwd_1_2', undefined);
    expect(sheet()).toBeNull();
  });

  it('locked Mac: says it reopens in a new window, warns about a draft, shows that command', async () => {
    store.set('ut-mac-share-asked-iTerm', '1');
    const windowCommand = `cd '/Users/u' && exec /bin/zsh -lic 'ut claude'`;
    planAnswer = () =>
      Response.json({
        ...PLAN,
        app: 'iTerm',
        mode: 'new-window',
        windowApp: 'Terminal',
        command: windowCommand,
      });
    await open({ ...DETAIL, app: 'iTerm' });
    expect(find('mac-share-sheet')?.dataset.phase).toBe('confirm');
    expect(find('mac-share-new-window')?.textContent).toBe(
      'The Mac is locked: it closes in its tab and reopens in a new Terminal window. The old tab is left at its shell prompt.'
    );
    expect(find('mac-share-draft-unchecked')?.textContent).toBe(
      'If there’s unsent text in it on the Mac, it will be lost.'
    );
    expect(find('mac-share-sheet')?.textContent).not.toContain('Don’t type in that tab');
    expect(find('mac-share-command')?.textContent).toBe(windowCommand);
  });

  it('the same-tab confirm has no new-window lines', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    await open();
    expect(find('mac-share-new-window')).toBeNull();
    expect(find('mac-share-draft-unchecked')).toBeNull();
  });

  it('new window: its step, then where it reopened and the old tab, then the session', async () => {
    const newWindow = { mode: 'new-window', windowApp: 'Terminal' } as const;
    jobs = [
      job({ ...newWindow, step: 'opening', closed: true, resumeCommand: COMMAND }),
      job({ ...newWindow, state: 'shared', step: 'starting', closed: true, sessionId: 'fwd_3' }),
    ];
    await open({ ...DETAIL, jobId: JOB });
    expect(find('mac-share-step')?.textContent).toContain('Opening a new Terminal window…');
    await settle(1000);
    const done = find('mac-share-done-new-window');
    expect(done?.getAttribute('role')).toBe('status');
    expect(done?.textContent).toContain('Reopened in a new Terminal window.');
    expect(done?.textContent).toContain('Its old tab was left at the shell prompt.');
    await settle(1000);
    expect(onShared).not.toHaveBeenCalled(); // long enough to read
    await settle(2000);
    expect(onShared).toHaveBeenCalledWith('fwd_3', undefined);
  });

  it('Spanish: the owner’s words for the new window', async () => {
    await setLocale('es');
    jobs = [
      job({
        mode: 'new-window',
        windowApp: 'Terminal',
        state: 'shared',
        step: 'starting',
        closed: true,
        sessionId: 'fwd_4',
      }),
    ];
    await open({ ...DETAIL, jobId: JOB });
    expect(find('mac-share-done-new-window')?.textContent).toContain(
      'Se ha reabierto en una ventana nueva de Terminal.'
    );
  });

  it('a refusal before the close: its reason and "Nothing was changed."', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    planAnswer = () => Response.json({ error: 'locked' }, { status: 409 });
    await open();
    expect(find('mac-share-sheet')?.textContent).toContain('Unlock the Mac to share this session.');
    expect(find('mac-share-sheet')?.textContent).toContain('Nothing was changed.');
    planAnswer = () => Response.json(PLAN);
    await later();
    touch(find('mac-share-retry'));
    await settle();
    expect(find('mac-share-sheet')?.dataset.phase).toBe('confirm');
  });

  it('closed but not reopened: the command to run, with Copy, never dismissed on its own', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    jobs = [
      job({
        state: 'failed-after-close',
        step: 'typing',
        closed: true,
        reason: 'denied',
        resumeCommand: COMMAND,
      }),
    ];
    await open({ ...DETAIL, jobId: JOB });
    const dialog = find('mac-share-sheet');
    expect(dialog?.textContent).toContain(
      'Claude closed on the Mac and the conversation is saved, but it didn’t reopen: Untether isn’t allowed to control Terminal.'
    );
    expect(dialog?.textContent).toContain('To continue, run this in that tab:');
    expect(find('mac-share-resume')?.getAttribute('dir')).toBe('ltr');
    await later();
    touch(find('mac-share-copy'));
    await settle();
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(find('mac-share-copied')?.textContent).toBe('Copied');
    await settle(60_000);
    expect(sheet()).not.toBeNull();
  });

  it('a typing not confirmed says to check the tab first, and keeps following', async () => {
    jobs = [
      job({
        state: 'relaunch-unknown',
        step: 'typing',
        closed: true,
        reason: 'unconfirmed',
        resumeCommand: COMMAND,
      }),
      job({ state: 'shared', step: 'starting', closed: true, sessionId: 'fwd_9', needs: 'trust' }),
    ];
    await open({ ...DETAIL, jobId: JOB });
    expect(find('mac-share-check-first')?.textContent).toBe(
      'It may still reopen when Terminal answers. Check the tab before running it.'
    );
    await settle(1000);
    await settle(700);
    expect(onShared).toHaveBeenCalledWith('fwd_9', 'trust');
  });

  it('Escape cancels before Share, and only hides it once the job runs', async () => {
    store.set('ut-mac-share-asked-Terminal', '1');
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(sheet()).toBeNull();
    expect(calls.filter((call) => call.url.endsWith('/share'))).toHaveLength(0);

    await open({ ...DETAIL, jobId: JOB });
    expect(find('mac-share-hide')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(sheet()).toBeNull();
    const polls = calls.length;
    await settle(5000);
    expect(calls.length).toBe(polls); // no polling once hidden; the job goes on on the server
  });

  it('every error code and every reason has its own text', () => {
    const names = { agent: 'Claude', app: 'Terminal', window: 'Terminal' };
    const codes: MacShareErrorCode[] = [
      'bad-id',
      'bad-token',
      'gone',
      'disabled',
      'no-auth',
      'not-shareable',
      'agent-not-supported',
      'unsupported-app',
      'unsupported-shell',
      'not-shell-job',
      'busy',
      'waiting',
      'background-work',
      'draft',
      'no-conversation',
      'cwd-missing',
      'unsafe-value',
      'in-progress',
      'locked',
      'tab-not-found',
      'tab-ambiguous',
      'unresponsive',
      'automation-ask',
      'automation-denied',
      'automation-pending',
      'plan-expired',
      'plan-changed',
    ];
    for (const code of codes) {
      const text = macShareErrorText(code, names, 'tcsh');
      expect(text, code).not.toMatch(/macShare\.|\{|Couldn’t share it/);
    }
    expect(macShareErrorText('unsupported-shell', names, 'tcsh')).toContain('tcsh');
    const reasons: MacShareFailReason[] = [
      'refused',
      'timeout',
      'exited',
      'not-shared',
      'other-instance',
      'transcript',
      'locked',
      'tab-gone',
      'shell-busy',
      'denied',
      'unresponsive',
      'already-open',
      'unconfirmed',
      'window-failed',
    ];
    const texts = reasons.map((reason) => macShareReasonText(reason, names, 30));
    for (const text of texts) expect(text).not.toMatch(/macShare\.|\{/);
    expect(new Set(texts).size).toBe(reasons.length);
    expect(macShareReasonText('locked', names)).toContain('15');
  });

  it('reads right to left in Arabic, the command still left to right', async () => {
    await setLocale('ar');
    store.set('ut-mac-share-asked-Terminal', '1');
    await open();
    expect(find('mac-share-command')?.getAttribute('dir')).toBe('ltr');
    expect(find('mac-share-sheet')?.textContent).not.toContain('Share this conversation');
  });
});
