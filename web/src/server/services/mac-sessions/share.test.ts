import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenChoices } from '../../../shared/claude-screen.js';
import type { MacAgentSession } from '../../../shared/mac-sessions.js';
import type { MacShareJob } from '../../../shared/mac-share.js';
import type { ProcessTable, ProcInfo } from '../claude-chat.js';
import type { OsascriptOutcome, OsascriptScript } from './osascript.js';
import type { MacSessionTarget } from './scanner.js';
import { MacShare, type MacShareDeps, MacShareError, type ShareUtSession } from './share.js';
import type { ClaudeSessionRecord, TranscriptState } from './share-checks.js';
import type { MacShareSettings } from './share-settings.js';

const ID = '0b402254-352f-4532-b05e-1186d66e984a';
const MAC_ID = 'a-500-1700000000';
const LSTART = 'Thu Oct 2 10:00:00 2026';
const CWD = '/Users/u/My Project';
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const ITERM_SERVER =
  '/Users/u/Library/Application Support/iTerm2/iTermServer-3.5.4 /Users/u/Library/Application Support/iTerm2/iterm2-daemon-1.socket';
/** The relaunch line of the default FakeMac, and what a new window runs for it. */
const LINE = `cd '${CWD}' && ut claude --resume '${ID}' --dangerously-skip-permissions`;
const WINDOW_COMMAND = `cd '${CWD}' && exec /bin/zsh -lic '${LINE.split("'").join("'\\''")}'`;
const TRUST: ScreenChoices = {
  question: 'Is this a project you created or one you trust?',
  options: ['No, exit', 'Yes, I trust this folder'],
  cursor: 0,
  navigate: true,
};
const PERMISSION: ScreenChoices = {
  question: 'Do you want to proceed?',
  options: ['Yes', 'No'],
  cursor: 0,
  navigate: true,
  numbered: true,
};

interface Proc {
  pid: number;
  ppid: number;
  args: string;
  tty?: string;
  pgid?: number;
  tpgid?: number;
  lstart?: string;
}

/** A Mac with a Terminal tab: login → -zsh → claude, plus whatever a test adds. */
class FakeMac {
  procs = new Map<number, Proc>();
  sessions = new Map<number, ClaudeSessionRecord>();
  transcript: TranscriptState = { size: 1000, flushed: true };
  locked = false;
  lockChecks = 0;
  /** The agent ignores SIGTERM. */
  stubborn = false;
  signals: Array<[number, string]> = [];
  ut: ShareUtSession[] = [];
  live = new Map<string, { where: 'terminal' }>();
  /** Calls to osascript, by script name, and what the screen lock was then. */
  calls: Array<{ script: string; lockedThen: boolean }> = [];
  probe: (script: string, args: readonly string[]) => OsascriptOutcome = (script) =>
    script.endsWith('-probe') ? ok(this.probeText()) : ok('result=typed');
  /** What the reopened agent shows, read by the trust step. */
  menu: ScreenChoices | null = null;
  autoReopen = true;
  /** new-window: what was handed to `open`, and whether it takes it. */
  opened: Array<{ app: string; command: string }> = [];
  openOk = true;
  /** Executables that exist (the new window's shell). */
  executables = new Set(['/bin/zsh']);
  moved: number[] = [];
  enters = 0;
  clock = 1_800_000_000_000;
  invalidated = 0;

  constructor() {
    this.add({ pid: 200, ppid: 1, args: TERMINAL });
    this.add({ pid: 300, ppid: 200, args: 'login -pf u', tty: 'ttys001', pgid: 300, tpgid: 500 });
    this.add({ pid: 400, ppid: 300, args: '-zsh', tty: 'ttys001', pgid: 400, tpgid: 500 });
    this.add({
      pid: 500,
      ppid: 400,
      args: 'claude --dangerously-skip-permissions say hi',
      tty: 'ttys001',
      pgid: 500,
      tpgid: 500,
      lstart: LSTART,
    });
    this.sessions.set(500, {
      status: 'idle',
      statusUpdatedAt: this.clock - 60_000,
      kind: 'interactive',
      entrypoint: 'cli',
      sessionId: ID,
      cwd: CWD,
    });
  }

  add(proc: Proc): void {
    this.procs.set(proc.pid, proc);
  }

  probeText(contents = '❯ '): string {
    const agentHere = this.procs.has(500);
    return `result=found\nwindow=7\ntab=2\nbusy=${agentHere}\nagent=${agentHere}\n--contents--\n${contents}`;
  }

  table(): ProcessTable {
    const children = new Map<number, number[]>();
    const starts = new Map<number, string>();
    const args = new Map<number, string>();
    const procs = new Map<number, ProcInfo>();
    for (const proc of this.procs.values()) {
      children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
      starts.set(proc.pid, proc.lstart ?? 'Thu Oct 2 09:00:00 2026');
      args.set(proc.pid, proc.args);
      procs.set(proc.pid, {
        ppid: proc.ppid,
        pgid: proc.pgid ?? proc.pid,
        tpgid: proc.tpgid ?? -1,
        tty: proc.tty ?? null,
        stat: 'S',
        uid: 501,
      });
    }
    return { children, starts, args, procs, extended: true };
  }

  /** The agent exits as Claude does on SIGTERM (P1): the shell gets the tab back. */
  exitAgent(): void {
    this.procs.delete(500);
    this.sessions.delete(500);
    if (!this.shellNeverBack) {
      for (const proc of this.procs.values()) if (proc.tty === 'ttys001') proc.tpgid = 400;
    }
    this.transcript = { size: this.transcript.size + 120, flushed: true };
  }

  /** The agent was started by a script, not a prompt: its tab never gets a shell back. */
  shellNeverBack = false;

  /**
   * The line typed (or run in a new window, on `tty`): ut starts a forwarder and the reopened
   * Claude under it.
   */
  reopen(options: { underUt?: boolean; ours?: boolean; cwd?: string; tty?: string } = {}): void {
    const { underUt = true, ours = true, tty = 'ttys001' } = options;
    const fwd = 610;
    let shell = 400;
    if (tty !== 'ttys001') {
      shell = 900;
      this.add({ pid: shell, ppid: 200, args: '/bin/zsh -lic', tty, pgid: 900 });
    }
    if (underUt) this.add({ pid: fwd, ppid: shell, args: 'untether-fwd claude', tty });
    this.add({
      pid: 620,
      ppid: underUt ? fwd : shell,
      args: `claude --resume ${ID}`,
      tty,
      lstart: 'Thu Oct 2 11:00:00 2026',
    });
    this.sessions.set(620, { status: 'idle', kind: 'interactive', sessionId: ID, cwd: CWD });
    if (ours && underUt) {
      this.ut.push({
        id: 'fwd_1_610',
        command: ['claude', '--resume', ID],
        workingDir: options.cwd ?? CWD,
        status: 'running',
        startedAt: new Date(this.clock).toISOString(),
      });
    }
  }

  settings(overrides: Partial<MacShareSettings> = {}): MacShareSettings {
    return {
      on: true,
      supported: true,
      enabled: true,
      launcher: 'ut',
      autoTrust: true,
      startTimeoutSec: 30,
      ...overrides,
    };
  }

  deps(settings: Partial<MacShareSettings> = {}): MacShareDeps {
    const target: MacSessionTarget = {
      kind: 'agent',
      pid: 500,
      lstart: LSTART,
      agent: 'claude',
      cwd: CWD,
      claudeDir: '/Users/u/.claude',
    };
    return {
      settings: () => this.settings(settings),
      scanner: {
        resolve: async (id) => (id === MAC_ID ? target : undefined),
        invalidate: () => {
          this.invalidated++;
        },
        liveClaudeConversations: async () => new Map(this.live),
      },
      freshTable: async () => this.table(),
      screenLock: async () => {
        this.lockChecks++;
        return { known: true, locked: this.locked };
      },
      runner: {
        run: async (_app: string, script: OsascriptScript, args: readonly string[] = []) => {
          this.calls.push({ script: script.name, lockedThen: this.locked });
          return this.probe(script.name, args);
        },
      },
      sigterm: (pid) => {
        this.signals.push([pid, 'SIGTERM']);
        if (!this.stubborn && pid === 500) this.exitAgent();
      },
      openWindow: async (app, command) => {
        this.opened.push({ app, command });
        if (this.openOk && this.autoReopen) this.reopen({ tty: 'ttys009' });
        return this.openOk;
      },
      utSessions: () => this.ut,
      screen: {
        read: async () => this.menu,
        moveCursor: async (_id, _menu, target) => {
          this.moved.push(target);
          return true;
        },
        pressEnter: () => {
          this.enters++;
          this.menu = null;
        },
      },
      controlDir: '/Users/u/.untether/control',
      defaultControlDir: '/Users/u/.untether/control',
      readSession: (_dir, pid) => this.sessions.get(pid) ?? null,
      transcriptPath: () => '/Users/u/.claude/projects/x/t.jsonl',
      transcript: () => ({ ...this.transcript }),
      relaunchFs: {
        isDirectory: () => true,
        isExecutableFile: (file) => this.executables.has(file),
      },
      realpath: (folder) => folder,
      platform: 'darwin',
      now: () => this.clock,
      // A fake clock that still yields to the test between steps.
      sleep: async (ms) => {
        this.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  }
}

function ok(stdout: string): OsascriptOutcome {
  return { kind: 'ok', stdout, pid: 1 };
}

const FINAL = new Set(['shared', 'aborted', 'still-running', 'failed-after-close']);

/** Lets the job run until it ends (or `until` holds). */
async function settle(
  share: MacShare,
  jobId: string,
  until: (job: MacShareJob) => boolean = (job) => FINAL.has(job.state)
): Promise<MacShareJob> {
  for (let i = 0; i < 20_000; i++) {
    const job = share.job(jobId);
    if (job && until(job)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`job never settled: ${JSON.stringify(share.job(jobId))}`);
}

async function planError(share: MacShare, options = { allowPrompt: true }) {
  try {
    await share.plan(MAC_ID, options);
  } catch (error) {
    if (error instanceof MacShareError) return error.code;
    throw error;
  }
  return 'planned';
}

/**
 * Plans and starts. Unless `mac.autoReopen` is off, a typing that answers `typed` reopens the
 * agent under ut, as the real line would.
 */
async function share(
  mac: FakeMac,
  settings: Partial<MacShareSettings> = {},
  overrides: Partial<MacShareDeps> = {}
) {
  const typed = mac.probe;
  mac.probe = (script, args) => {
    const outcome = typed(script, args);
    if (script.endsWith('-type') && outcome.kind === 'ok' && mac.autoReopen) mac.reopen();
    return outcome;
  };
  const subject = new MacShare({ ...mac.deps(settings), ...overrides });
  const plan = await subject.plan(MAC_ID, { allowPrompt: true });
  const { jobId } = await subject.start(plan.token);
  return { subject, plan, jobId };
}

/** A SIGTERM that also does `then` (the Mac locks, the transcript shrinks…). */
function sigtermThen(mac: FakeMac, then: () => void): Partial<MacShareDeps> {
  const sigterm = mac.deps().sigterm;
  return {
    sigterm: (pid) => {
      sigterm(pid);
      then();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('share: plan', () => {
  it('plans the line for that tab, after a lock check and a probe', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    expect(plan).toMatchObject({
      agent: 'claude',
      app: 'Terminal',
      tty: 'ttys001',
      conversationId: ID,
      command: `cd '${CWD}' && ut claude --resume '${ID}' --dangerously-skip-permissions`,
      droppedPrompt: true,
    });
    expect(plan.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(mac.calls.map((call) => call.script)).toEqual(['terminal-probe']);
    expect(mac.lockChecks).toBe(1);
    expect(mac.signals).toEqual([]);
  });

  it('unlocked: same-tab', async () => {
    const mac = new FakeMac();
    const plan = await new MacShare(mac.deps()).plan(MAC_ID, { allowPrompt: true });
    expect(plan.mode).toBe('same-tab');
    expect(plan.windowApp).toBeUndefined();
  });

  it('locked screen: a new-window plan, with zero osascript calls and zero signals', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    // No explainer needed: nothing will be scripted.
    const plan = await new MacShare(mac.deps()).plan(MAC_ID, { allowPrompt: false });
    expect(plan).toMatchObject({
      mode: 'new-window',
      windowApp: 'Terminal',
      app: 'Terminal',
      command: WINDOW_COMMAND,
    });
    expect(mac.calls).toEqual([]);
    expect(mac.signals).toEqual([]);
    expect(mac.opened).toEqual([]);
  });

  it('locked, iTerm2: it reopens in a Terminal window', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    const server = mac.procs.get(200);
    if (server) server.args = ITERM_SERVER;
    const plan = await new MacShare(mac.deps()).plan(MAC_ID, { allowPrompt: true });
    expect(plan).toMatchObject({ app: 'iTerm', mode: 'new-window', windowApp: 'Terminal' });
    expect(mac.calls).toEqual([]);
  });

  it('locked with no path for its shell: refused as before', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    mac.executables.clear();
    expect(await planError(new MacShare(mac.deps()))).toBe('locked');
    expect(mac.calls).toEqual([]);
    expect(mac.signals).toEqual([]);
  });

  it('nothing is scripted before the phone showed the explainer', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    expect(await planError(subject, { allowPrompt: false })).toBe('automation-ask');
    expect(mac.calls).toEqual([]);
    // Once an app answered in this run, no explainer is needed for it.
    await subject.plan(MAC_ID, { allowPrompt: true });
    expect(await planError(subject, { allowPrompt: false })).toBe('planned');
  });

  it('a first probe that hangs with the screen unlocked: macOS is probably asking', async () => {
    const mac = new FakeMac();
    mac.probe = () => ({ kind: 'timeout', pid: 1 });
    const subject = new MacShare(mac.deps());
    expect(await planError(subject)).toBe('automation-pending');
    expect(mac.signals).toEqual([]);
  });

  it('a probe that hangs after the app answered once is unresponsive', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    await subject.plan(MAC_ID, { allowPrompt: true });
    mac.probe = () => ({ kind: 'timeout', pid: 1 });
    expect(await planError(subject)).toBe('unresponsive');
    expect(mac.signals).toEqual([]);
  });

  it('automation refused (-1743)', async () => {
    const mac = new FakeMac();
    mac.probe = () => ({ kind: 'error', error: 'denied', code: -1743, pid: 1 });
    expect(await planError(new MacShare(mac.deps()))).toBe('automation-denied');
  });

  it('busy, waiting, a draft, background work and a foreign shape are refused', async () => {
    const busy = new FakeMac();
    busy.sessions.set(500, { ...busy.sessions.get(500), status: 'busy' });
    expect(await planError(new MacShare(busy.deps()))).toBe('busy');

    const waiting = new FakeMac();
    waiting.sessions.set(500, { ...waiting.sessions.get(500), status: 'waiting' });
    expect(await planError(new MacShare(waiting.deps()))).toBe('waiting');

    const draft = new FakeMac();
    const box = '─'.repeat(40);
    draft.probe = () => ok(draft.probeText(`${box}\n❯ half a sentence\n${box}\n  status`));
    expect(await planError(new MacShare(draft.deps()))).toBe('draft');

    const background = new FakeMac();
    background.add({
      pid: 700,
      ppid: 500,
      args: '/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 300',
    });
    expect(await planError(new MacShare(background.deps()))).toBe('background-work');

    const notJob = new FakeMac();
    const agent = notJob.procs.get(500);
    if (agent) agent.tpgid = 400;
    expect(await planError(new MacShare(notJob.deps()))).toBe('not-shell-job');

    const tcsh = new FakeMac();
    const shell = tcsh.procs.get(400);
    if (shell) shell.args = '-tcsh';
    expect(await planError(new MacShare(tcsh.deps()))).toBe('not-shell-job');

    for (const mac of [busy, waiting, draft, background, notJob, tcsh]) {
      expect(mac.signals).toEqual([]);
    }
  });

  it('only when the feature is on, and never without a login', async () => {
    const mac = new FakeMac();
    expect(await planError(new MacShare(mac.deps({ enabled: false, reason: 'disabled' })))).toBe(
      'disabled'
    );
    expect(await planError(new MacShare(mac.deps({ enabled: false, reason: 'no-auth' })))).toBe(
      'no-auth'
    );
    const subject = new MacShare(mac.deps());
    await expect(subject.plan('t-1-2-3', {})).rejects.toMatchObject({ code: 'bad-id' });
    await expect(subject.plan('a-9-9', {})).rejects.toMatchObject({ code: 'gone' });
  });
});

describe('share: the job', () => {
  it('happy path: one SIGTERM, typed into the same tab, then shared', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    const mac = new FakeMac();
    const { subject, jobId } = await share(mac);
    const job = await settle(subject, jobId);
    expect(job).toMatchObject({ state: 'shared', sessionId: 'fwd_1_610', closed: true });
    expect(job.needs).toBeUndefined();
    expect(mac.signals).toEqual([[500, 'SIGTERM']]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mac.calls.map((call) => call.script)).toEqual([
      'terminal-probe', // plan
      'terminal-probe', // before closing
      'terminal-probe', // before typing
      'terminal-type',
    ]);
    expect(mac.calls.every((call) => !call.lockedThen)).toBe(true);
    expect(mac.invalidated).toBe(1);
    expect(subject.pendingConversations().size).toBe(0);
  });

  it('the conversation counts as live from the close until it reopens', async () => {
    const mac = new FakeMac();
    let pendingWhileTyping: string[] = [];
    let subjectRef: MacShare | undefined;
    const original = mac.probe;
    mac.probe = (script, args) => {
      if (script.endsWith('-type') && subjectRef) {
        pendingWhileTyping = [...subjectRef.pendingConversations().keys()];
      }
      return original(script, args);
    };
    const { subject, jobId } = await share(mac);
    subjectRef = subject;
    await settle(subject, jobId);
    expect(pendingWhileTyping).toEqual([ID]);
    expect(subject.pendingConversations().size).toBe(0);
  });

  it('busy again at the re-check: aborted, no signal', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.sessions.set(500, { ...mac.sessions.get(500), status: 'busy' });
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'aborted', error: 'busy' });
    expect(mac.signals).toEqual([]);
  });

  it('idle only moments ago: it waits for 3 s of idle before closing', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.sessions.set(500, { ...mac.sessions.get(500), statusUpdatedAt: mac.clock - 500 });
    const started = mac.clock;
    const { jobId } = await subject.start(plan.token);
    await settle(subject, jobId, (job) => job.closed || FINAL.has(job.state));
    expect(mac.clock - started).toBeGreaterThanOrEqual(2_500);
  });

  it('a pre-close probe that hangs: aborted, no signal', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.probe = () => ({ kind: 'timeout', pid: 1 });
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'aborted', error: 'unresponsive' });
    expect(mac.signals).toEqual([]);
  });

  it('locked before closing: it turns new-window, with zero calls while locked', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.locked = true;
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'shared',
      mode: 'new-window',
      windowApp: 'Terminal',
    });
    expect(mac.calls.map((call) => call.script)).toEqual(['terminal-probe']); // the plan's
    expect(mac.signals).toEqual([[500, 'SIGTERM']]);
    expect(mac.opened).toEqual([{ app: 'Terminal', command: WINDOW_COMMAND }]);
  });

  it("locked, its tab never gets a shell back: the new window doesn't need it", async () => {
    const mac = new FakeMac();
    mac.shellNeverBack = true;
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.locked = true;
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', mode: 'new-window' });
    expect(mac.opened).toEqual([{ app: 'Terminal', command: WINDOW_COMMAND }]);
  });

  it('no exit within 10 s: still-running, one SIGTERM and never anything else', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    const mac = new FakeMac();
    mac.stubborn = true;
    const { subject, jobId } = await share(mac);
    const job = await settle(subject, jobId);
    expect(job).toMatchObject({ state: 'still-running', closed: false });
    expect(mac.signals).toEqual([[500, 'SIGTERM']]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
    expect(subject.pendingConversations().size).toBe(0);
  });

  it('locked after the close: a new window right away, nothing typed', async () => {
    const mac = new FakeMac();
    const steps: string[] = [];
    const { subject, plan, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.locked = true;
      })
    );
    const started = mac.clock;
    for (;;) {
      const job = subject.job(jobId);
      if (!job) break;
      if (steps.at(-1) !== job.step) steps.push(job.step);
      if (FINAL.has(job.state)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(subject.job(jobId)).toMatchObject({
      state: 'shared',
      mode: 'new-window',
      sessionId: 'fwd_1_610',
      resumeCommand: LINE,
    });
    expect(plan.mode).toBe('same-tab');
    expect(steps).not.toContain('waiting-unlock');
    expect(steps).not.toContain('typing');
    expect(mac.clock - started).toBeLessThan(60_000);
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
    expect(mac.calls.filter((call) => call.lockedThen)).toEqual([]);
    expect(mac.opened).toHaveLength(1);
  });

  it('a typing-step probe that hangs because the Mac locked: a new window', async () => {
    const mac = new FakeMac();
    const original = mac.probe;
    let probes = 0;
    mac.probe = (script, args) => {
      if (script.endsWith('-probe') && ++probes === 3) {
        mac.locked = true;
        return { kind: 'timeout', pid: 1 };
      }
      return original(script, args);
    };
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', mode: 'new-window' });
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
    expect(mac.opened).toHaveLength(1);
  });

  it('no path for its shell, locked after the close: waits, then types once unlocked', async () => {
    const mac = new FakeMac();
    mac.executables.clear();
    const { subject, plan, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.locked = true;
      })
    );
    const waiting = await settle(subject, jobId, (job) => job.step === 'waiting-unlock');
    expect(waiting).toMatchObject({ state: 'running', closed: true, resumeCommand: plan.command });
    mac.clock += 5 * 60_000;
    mac.locked = false;
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared' });
    expect(mac.calls.filter((call) => call.lockedThen)).toEqual([]);
  });

  it('no path for its shell, never unlocked in 15 minutes: failed, with the command', async () => {
    const mac = new FakeMac();
    mac.executables.clear();
    const { subject, plan, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.locked = true;
      })
    );
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'locked',
      resumeCommand: plan.command,
    });
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
  });

  it('refused while typing (-1743): failed after close, with the command', async () => {
    const mac = new FakeMac();
    const original = mac.probe;
    mac.probe = (script, args) =>
      script.endsWith('-type')
        ? { kind: 'error', error: 'denied', code: -1743, pid: 1 }
        : original(script, args);
    const { subject, plan, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'denied',
      resumeCommand: plan.command,
    });
  });

  it('a typing that hangs: unknown, and the watcher flips it to shared when it appears', async () => {
    const mac = new FakeMac();
    const original = mac.probe;
    mac.probe = (script, args) =>
      script.endsWith('-type') ? { kind: 'timeout', pid: 1 } : original(script, args);
    const { subject, plan, jobId } = await share(mac);
    const unknown = await settle(subject, jobId, (job) => job.state === 'relaunch-unknown');
    expect(unknown).toMatchObject({ reason: 'unconfirmed', resumeCommand: plan.command });
    expect(subject.pendingConversations().has(ID)).toBe(true);
    mac.clock += 3 * 60_000;
    mac.reopen();
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', sessionId: 'fwd_1_610' });
  });

  it('a typing that hangs and never shows up: failed after 10 minutes', async () => {
    const mac = new FakeMac();
    const original = mac.probe;
    mac.probe = (script, args) =>
      script.endsWith('-type') ? { kind: 'timeout', pid: 1 } : original(script, args);
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'unconfirmed',
    });
  });

  it('reopened without ut: not here, and nothing lost', async () => {
    const mac = new FakeMac();
    mac.autoReopen = false;
    const original = mac.probe;
    mac.probe = (script, args) => {
      const outcome = original(script, args);
      if (script.endsWith('-type')) mac.reopen({ underUt: false });
      return outcome;
    };
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'not-shared',
    });
  });

  it('reopened under another Untether: other-instance', async () => {
    const mac = new FakeMac();
    mac.autoReopen = false;
    const original = mac.probe;
    mac.probe = (script, args) => {
      const outcome = original(script, args);
      if (script.endsWith('-type')) mac.reopen({ ours: false });
      return outcome;
    };
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'other-instance',
    });
  });

  it('nothing starts in time: unknown with the limit, then failed', async () => {
    const mac = new FakeMac();
    mac.autoReopen = false;
    const { subject, jobId } = await share(mac, { startTimeoutSec: 5 });
    const unknown = await settle(subject, jobId, (job) => job.state === 'relaunch-unknown');
    expect(unknown).toMatchObject({ reason: 'timeout', seconds: 5 });
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'timeout',
    });
  });

  it('a transcript cut short by the close: nothing is typed', async () => {
    const mac = new FakeMac();
    const { subject, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.transcript = { size: 10, flushed: true };
      })
    );
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'transcript',
    });
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
  });

  it('resumed elsewhere meanwhile: nothing is typed', async () => {
    const mac = new FakeMac();
    const { subject, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.live.set(ID, { where: 'terminal' });
      })
    );
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'already-open',
    });
    expect(mac.calls.map((call) => call.script)).not.toContain('terminal-type');
  });
});

describe('share: locked Mac, new window', () => {
  it('no AppleScript at all, one SIGTERM, `open` once with Terminal; old tab untouched', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    const mac = new FakeMac();
    mac.locked = true;
    const deps = mac.deps();
    const run = vi.spyOn(deps.runner, 'run');
    const openWindow = vi.spyOn(deps, 'openWindow');
    const subject = new MacShare(deps);
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    const { jobId } = await subject.start(plan.token);
    const job = await settle(subject, jobId);
    expect(job).toMatchObject({
      state: 'shared',
      mode: 'new-window',
      windowApp: 'Terminal',
      sessionId: 'fwd_1_610',
      closed: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(mac.calls).toEqual([]);
    expect(mac.signals).toEqual([[500, 'SIGTERM']]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith('Terminal', WINDOW_COMMAND);
    // The old tab's shell is left at its prompt: nothing was started on its tty.
    expect(
      [...mac.procs.values()].filter((proc) => proc.tty === 'ttys001').map((p) => p.pid)
    ).toEqual([300, 400]);
    expect(subject.pendingConversations().size).toBe(0);
  });

  it('iTerm2: one `open`, with Terminal', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    const server = mac.procs.get(200);
    if (server) server.args = ITERM_SERVER;
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'shared',
      app: 'iTerm',
      windowApp: 'Terminal',
    });
    expect(mac.opened.map((call) => call.app)).toEqual(['Terminal']);
    expect(mac.calls).toEqual([]);
  });

  it('still idle-checked: busy again means no signal and no window', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.sessions.set(500, { ...mac.sessions.get(500), status: 'busy' });
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'aborted', error: 'busy' });
    expect(mac.signals).toEqual([]);
    expect(mac.opened).toEqual([]);
  });

  it('background work: no signal and no window', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.add({ pid: 700, ppid: 500, args: '/bin/zsh -c source /x/.claude/shell-snapshots/s.sh' });
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'aborted',
      error: 'background-work',
    });
    expect(mac.signals).toEqual([]);
    expect(mac.opened).toEqual([]);
  });

  it('a transcript cut short by the close: no window', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    const { subject, jobId } = await share(
      mac,
      {},
      sigtermThen(mac, () => {
        mac.transcript = { size: 10, flushed: true };
      })
    );
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'transcript',
    });
    expect(mac.opened).toEqual([]);
  });

  it('`open` refused: failed after close, with the line to type in the old tab', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    mac.openOk = false;
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'window-failed',
      resumeCommand: LINE,
    });
    expect(mac.opened).toHaveLength(1);
    expect(mac.calls).toEqual([]);
  });

  it('reopened in the new window without ut: not-shared', async () => {
    const mac = new FakeMac();
    mac.locked = true;
    mac.autoReopen = false;
    const deps = mac.deps();
    const subject = new MacShare({
      ...deps,
      openWindow: async () => {
        mac.reopen({ tty: 'ttys009', underUt: false });
        return true;
      },
    });
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    const { jobId } = await subject.start(plan.token);
    expect(await settle(subject, jobId)).toMatchObject({
      state: 'failed-after-close',
      reason: 'not-shared',
    });
  });
});

describe('share: the trust dialog', () => {
  it('of the same folder: the cursor is moved and verified, then Enter', async () => {
    const mac = new FakeMac();
    mac.menu = TRUST;
    const { subject, jobId } = await share(mac);
    const job = await settle(subject, jobId);
    expect(job).toMatchObject({ state: 'shared' });
    expect(job.needs).toBeUndefined();
    expect(mac.moved).toEqual([1]);
    expect(mac.enters).toBe(1);
  });

  it('with auto-trust off: left to the user', async () => {
    const mac = new FakeMac();
    mac.menu = TRUST;
    const { subject, jobId } = await share(mac, { autoTrust: false });
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', needs: 'trust' });
    expect(mac.enters).toBe(0);
  });

  it('of another folder: left to the user', async () => {
    const mac = new FakeMac();
    mac.menu = TRUST;
    mac.autoReopen = false;
    const original = mac.probe;
    mac.probe = (script, args) => {
      const outcome = original(script, args);
      if (script.endsWith('-type')) mac.reopen({ cwd: '/Users/u' });
      return outcome;
    };
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', needs: 'trust' });
    expect(mac.moved).toEqual([]);
    expect(mac.enters).toBe(0);
  });

  it('any other dialog is never answered', async () => {
    const mac = new FakeMac();
    mac.menu = PERMISSION;
    const { subject, jobId } = await share(mac);
    expect(await settle(subject, jobId)).toMatchObject({ state: 'shared', needs: 'answer' });
    expect(mac.moved).toEqual([]);
    expect(mac.enters).toBe(0);
  });
});

describe('share: tokens', () => {
  it('single use: a second start gives the same job, an unknown token is expired', async () => {
    const mac = new FakeMac();
    const { subject, plan, jobId } = await share(mac);
    expect(await subject.start(plan.token)).toEqual({ jobId });
    await settle(subject, jobId);
    await expect(subject.start('A'.repeat(22))).rejects.toMatchObject({ code: 'plan-expired' });
    await expect(subject.start('../etc')).rejects.toMatchObject({ code: 'bad-token' });
    expect(mac.signals).toHaveLength(1);
  });

  it('expires after 2 minutes', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    mac.clock += 121_000;
    await expect(subject.start(plan.token)).rejects.toMatchObject({ code: 'plan-expired' });
    expect(mac.signals).toEqual([]);
  });

  it('a new plan replaces the old token', async () => {
    const mac = new FakeMac();
    let n = 0;
    const subject = new MacShare({
      ...mac.deps(),
      randomToken: () => String(++n).padStart(22, 'x'),
    });
    const first = await subject.plan(MAC_ID, { allowPrompt: true });
    await subject.plan(MAC_ID, { allowPrompt: true });
    await expect(subject.start(first.token)).rejects.toMatchObject({ code: 'plan-expired' });
  });

  it('the agent changed meanwhile (another process on that pid): plan-changed', async () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    const plan = await subject.plan(MAC_ID, { allowPrompt: true });
    const agent = mac.procs.get(500);
    if (agent) agent.lstart = 'Thu Oct 2 12:00:00 2026';
    await expect(subject.start(plan.token)).rejects.toMatchObject({ code: 'plan-changed' });
    expect(mac.signals).toEqual([]);
  });
});

describe('share: rows', () => {
  const row = (overrides: Partial<MacAgentSession> = {}): MacAgentSession => ({
    kind: 'agent',
    id: MAC_ID,
    chatId: MAC_ID,
    agent: 'claude',
    app: 'Terminal',
    status: { status: 'idle' },
    ...overrides,
  });

  it('offers the action only on an idle Claude in Terminal or iTerm2, outside tmux', () => {
    const mac = new FakeMac();
    const subject = new MacShare(mac.deps());
    expect(subject.availability(row())).toEqual({ can: true });
    expect(subject.availability(row({ app: 'iTerm' }))).toEqual({ can: true });
    expect(subject.availability(row({ app: 'Visual Studio Code' }))).toMatchObject({
      can: false,
      reason: 'unsupported-app',
    });
    expect(subject.availability(row({ inTmux: { server: '' } }))).toMatchObject({
      reason: 'in-tmux',
    });
    expect(subject.availability(row({ agent: 'codex' }))).toMatchObject({ reason: 'agent-off' });
    expect(subject.availability(row({ status: { status: 'busy' } }))).toMatchObject({
      reason: 'busy',
    });
    expect(subject.availability(row({ status: { status: 'waiting' } }))).toMatchObject({
      reason: 'waiting',
    });
    expect(
      new MacShare(mac.deps({ enabled: false, reason: 'disabled' })).availability(row())
    ).toBeUndefined();
  });

  it('a share in flight: the row reopens its progress', async () => {
    const mac = new FakeMac();
    mac.stubborn = true;
    const { subject, jobId } = await share(mac);
    expect(subject.availability(row())).toEqual({ can: false, reason: 'in-progress', jobId });
    await settle(subject, jobId);
    expect(subject.availability(row())).toEqual({ can: true });
  });
});
