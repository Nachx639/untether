/**
 * The copilot's LLM: Claude Haiku through the user's Max subscription, via the `claude` CLI.
 *
 * One warm `claude -p --input-format stream-json` process holds the conversation (first token
 * in ~0.5–0.8 s instead of ~1.2 s for a cold process). A spare process is kept warm so a
 * recycle (every RECYCLE_TURNS turns) or a reset costs nothing. If the warm process dies, the
 * turn falls back to a cold `claude -p`.
 *
 * Every claude process gets CLAUDE_CODE_OAUTH_TOKEN from the token file and
 * `--setting-sources ""`: a claude started without the token can break the login another tool
 * on this Mac relies on, so with no token nothing is started at all. Nothing starts before
 * warm() (a Conversar page opened); shutdown() ends every process. Their pids are recorded so
 * a server killed abruptly does not leave them behind.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { streamEventModel } from '../../../shared/agent-models.js';
import { modelRecorder } from '../model-observations.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const RECYCLE_TURNS = 30;
/** No first token after this long: run the same turn on the warm spare too, keep the faster one. */
const RACE_AFTER_MS = 1000;

export interface BrainConfig {
  model?: string;
  /** File holding the OAuth token (default ~/.config/claude/oauth-token). */
  tokenFile?: string;
  /** The claude program (default: found on PATH, ~/.local/bin, Homebrew). */
  claudeBin?: string | null;
  /** Where the running processes' pids are recorded. */
  pidFile?: string;
  recycleTurns?: number;
  raceAfterMs?: number;
}

export type BrainProblem = 'no-token' | 'no-claude';

export function defaultTokenFile(): string {
  return (
    process.env.UNTETHER_COPILOT_TOKEN_FILE ||
    path.join(os.homedir(), '.config', 'claude', 'oauth-token')
  );
}

/** The claude CLI: UNTETHER_COPILOT_CLAUDE, PATH, then the usual install places. */
export function findClaude(): string | null {
  const fromEnv = process.env.UNTETHER_COPILOT_CLAUDE;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  // The Mac app's server may start with a minimal PATH.
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The environment for a claude process, or the reason none may start. */
export function oauthEnv(tokenFile: string): NodeJS.ProcessEnv | BrainProblem {
  let token = '';
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return 'no-token';
  }
  if (!token) return 'no-token';
  return { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
}

/** The flags of every one-shot or warm `claude -p` (no tools, no settings, stream-json out). */
export function baseArgs(model: string, systemPrompt: string) {
  return [
    '-p',
    '--model',
    model,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt',
    systemPrompt,
  ];
}

/** Records and clears the pids of the claude processes this server started. */
class PidRecord {
  private readonly pids = new Set<number>();
  constructor(private readonly file: string | undefined) {}

  /** Leftovers of a server that did not shut down: only processes that still look like ours. */
  killLeftovers() {
    if (!this.file) return;
    let recorded: number[] = [];
    try {
      recorded = readFileSync(this.file, 'utf8')
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    } catch {
      return;
    }
    for (const pid of recorded) {
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
        });
        if (/claude/.test(command) && command.includes('--no-session-persistence')) {
          process.kill(pid, 'SIGTERM');
        }
      } catch {
        // Gone already.
      }
    }
    this.save();
  }

  add(pid: number | undefined) {
    if (!pid) return;
    this.pids.add(pid);
    this.save();
  }

  remove(pid: number | undefined) {
    if (!pid || !this.pids.delete(pid)) return;
    this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      if (this.pids.size) writeFileSync(this.file, [...this.pids].join('\n'), { mode: 0o600 });
      else rmSync(this.file, { force: true });
    } catch {
      // Best effort: closing stdin ends them anyway.
    }
  }
}

interface Spawner {
  bin: string;
  env: NodeJS.ProcessEnv;
  pids: PidRecord;
}

export interface TurnHandle {
  /** Text deltas as they stream. */
  onDelta: (fn: (text: string) => void) => void;
  /** Resolves with the full text when the turn ends. */
  done: Promise<{
    text: string;
    firstTokenMs?: number;
    totalMs: number;
    cold: boolean;
    raced?: boolean;
    error?: string;
  }>;
  /** Stop delivering deltas (barge-in). The process finishes the turn in the background. */
  cancel: () => void;
}

class WarmProcess {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
  turns = 0;
  dead = false;
  isReady = false;
  /** A cancelled turn is still finishing on it (no text had arrived when the user cut in). */
  draining: Promise<void> | null = null;
  private listener: ((o: Record<string, unknown>) => void) | null = null;

  constructor(model: string, systemPrompt: string, sp: Spawner) {
    this.child = spawn(
      sp.bin,
      [...baseArgs(model, systemPrompt), '--input-format', 'stream-json'],
      {
        env: sp.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    sp.pids.add(this.child.pid);
    this.child.stderr.on('data', () => undefined);
    this.child.stdin.on('error', () => undefined);
    const rl = createInterface({ input: this.child.stdout });
    const noteModel = modelRecorder('copilot', model);
    rl.on('line', (line) => {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      noteModel(streamEventModel(o));
      this.listener?.(o);
    });
    this.child.on('exit', () => {
      sp.pids.remove(this.child.pid);
      this.dead = true;
      this.listener?.({ type: 'result', is_error: true, result: '', subtype: 'process-exit' });
    });
    this.child.on('error', () => {
      sp.pids.remove(this.child.pid);
      this.dead = true;
      this.listener?.({ type: 'result', is_error: true, result: '', subtype: 'process-exit' });
    });
    // Warm-up turn: loads the CLI and primes the prompt cache with the system prompt.
    this.ready = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000);
      this.listener = (o) => {
        if (o.type === 'result') {
          clearTimeout(t);
          this.listener = null;
          this.isReady = !o.is_error && !this.dead;
          resolve(!o.is_error);
        }
      };
      this.write('ESTADO: (sin sesiones)\nEVENTO: arranque del copiloto. Responde solo: @none');
    });
  }

  write(content: string) {
    if (this.dead || !this.child.stdin.writable) return;
    this.child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
    );
  }

  turn(content: string, onEvent: (o: Record<string, unknown>) => void) {
    this.turns++;
    this.listener = onEvent;
    this.write(content);
  }

  release() {
    this.listener = null;
  }

  /** Replace the listener (used to watch a cancelled turn finish). */
  listener_(fn: (o: Record<string, unknown>) => void) {
    this.listener = fn;
  }

  kill() {
    this.dead = true;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // gone
    }
  }
}

export class Brain {
  readonly model: string;
  readonly systemPrompt: string;
  private readonly tokenFile: string;
  private readonly claudeBin: string | null;
  private readonly pids: PidRecord;
  private readonly recycleTurns: number;
  private readonly raceAfterMs: number;
  private leftoversKilled = false;
  private closed = false;
  private current: WarmProcess | null = null;
  private spare: WarmProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** A short memory carried over when the process is recycled. */
  private carry: string[] = [];
  /** Why no process could start (the last attempt). */
  problem: BrainProblem | null = null;
  state: 'off' | 'starting' | 'ready' | 'error' = 'off';

  constructor(systemPrompt: string, config: BrainConfig = {}) {
    this.systemPrompt = systemPrompt;
    this.model = config.model || process.env.UNTETHER_COPILOT_MODEL || DEFAULT_MODEL;
    this.tokenFile = config.tokenFile ?? defaultTokenFile();
    this.claudeBin = config.claudeBin === undefined ? findClaude() : config.claudeBin;
    this.pids = new PidRecord(config.pidFile);
    this.recycleTurns = config.recycleTurns ?? RECYCLE_TURNS;
    this.raceAfterMs = config.raceAfterMs ?? RACE_AFTER_MS;
  }

  /** How to start a claude process right now, or null (and `problem` says why). */
  private spawner(): Spawner | null {
    if (this.closed) return null;
    if (!this.claudeBin) {
      this.problem = 'no-claude';
      return null;
    }
    const env = oauthEnv(this.tokenFile);
    if (typeof env === 'string') {
      this.problem = env;
      return null;
    }
    this.problem = null;
    if (!this.leftoversKilled) {
      this.leftoversKilled = true;
      this.pids.killLeftovers();
    }
    return { bin: this.claudeBin, env, pids: this.pids };
  }

  private spawnWarm(): WarmProcess | null {
    const sp = this.spawner();
    return sp ? new WarmProcess(this.model, this.systemPrompt, sp) : null;
  }

  /** Start the warm process (and a spare). Resolves when the first one answered its warm-up. */
  async warm(): Promise<boolean> {
    if (!this.current || this.current.dead) this.current = this.spawnWarm();
    if (!this.current) {
      this.state = 'error';
      return false;
    }
    if (!this.current.isReady) this.state = 'starting';
    const ok = await this.current.ready;
    if (!this.current) return false; // shut down meanwhile
    this.state = ok ? 'ready' : 'error';
    if (!this.spare || this.spare.dead) this.spare = this.spawnWarm();
    return ok;
  }

  /** Forget the conversation (next turn starts on the spare process). */
  reset() {
    this.carry = [];
    this.current?.kill();
    this.current = this.spare;
    this.spare = this.spawnWarm();
  }

  get running(): boolean {
    return Boolean(this.current && !this.current.dead);
  }

  remember(line: string) {
    this.carry.push(line);
    if (this.carry.length > 8) this.carry.shift();
  }

  /** For good: a conversation that stopped gets a new Brain when it comes back. */
  shutdown() {
    this.closed = true;
    this.current?.kill();
    this.spare?.kill();
    this.current = this.spare = null;
    this.carry = [];
    this.state = 'off';
  }

  /** One turn at a time; deltas stream through the handle. */
  turn(content: string): TurnHandle {
    type Done = {
      text: string;
      firstTokenMs?: number;
      totalMs: number;
      cold: boolean;
      raced?: boolean;
      error?: string;
    };
    let deltaFn: (t: string) => void = () => undefined;
    let cancelled = false;
    let finished = false;
    let resolveDone!: (v: Done) => void;
    const done = new Promise<Done>((r) => {
      resolveDone = r;
    });
    let text = '';
    let first: number | undefined;
    let t0 = Date.now();
    const finish = (v: Done) => {
      if (finished) return;
      finished = true;
      resolveDone(v);
    };
    /** Processes working on this turn (the current one, maybe a racer). */
    const active = new Set<WarmProcess>();
    let onCancel: () => void = () => undefined;
    const run = async () => {
      if (cancelled) return finish({ text: '', totalMs: 0, cold: false });
      await this.ensure();
      const proc = this.current;
      if (cancelled) return finish({ text: '', totalMs: 0, cold: false });
      if (!proc || proc.dead) {
        finish(await this.cold(content, (d) => !cancelled && deltaFn(d)));
        return;
      }
      t0 = Date.now();
      let winner: WarmProcess | null = null;
      let raced = false;
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (raceTimer) clearTimeout(raceTimer);
        for (const p of active) p.release();
        active.clear();
        if (!this.spare || this.spare.dead) this.spare = this.spawnWarm();
      };
      onCancel = () => {
        // Barge-in: the turn ends now. A process that already streamed text is recycled (it could
        // talk for seconds). One that had not produced a token yet is left to finish in the
        // background ("draining", usually < 1 s), so two cuts in a row do not leave only a spare
        // that is still booting (latency judge r3: 1982 ms on the third question).
        if (raceTimer) clearTimeout(raceTimer);
        for (const p of active) {
          if (!text && p === this.current && !p.dead) {
            p.draining = new Promise<void>((res) => {
              const t = setTimeout(() => {
                p.kill();
                res();
              }, 6000);
              p.listener_((o) => {
                if (o.type === 'result') {
                  clearTimeout(t);
                  p.release();
                  p.draining = null;
                  res();
                }
              });
            });
            active.delete(p);
            continue;
          }
          p.kill();
          if (p === this.current) this.current = null;
        }
        if (raceTimer) clearTimeout(raceTimer);
        for (const p of active) p.release();
        active.clear();
        if (!this.spare || this.spare.dead) this.spare = this.spawnWarm();
        finish({ text, firstTokenMs: first, totalMs: Date.now() - t0, cold: false, raced });
      };
      const listen = (p: WarmProcess) => (o: Record<string, unknown>) => {
        if (finished) return;
        if (winner && winner !== p) return;
        if (o.type === 'stream_event') {
          const ev = o.event as { type?: string; delta?: { type?: string; text?: string } };
          if (
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text
          ) {
            if (!winner) {
              winner = p;
              first = Date.now() - t0;
              if (raceTimer) clearTimeout(raceTimer);
              for (const other of active) {
                if (other === p) continue;
                other.kill();
                active.delete(other);
              }
              if (p !== this.current) {
                // The racer won: it becomes the conversation from now on.
                this.current = p;
              }
            }
            text += ev.delta.text;
            if (!cancelled) deltaFn(ev.delta.text);
          }
        } else if (o.type === 'result') {
          if (o.subtype === 'process-exit' && !text) {
            active.delete(p);
            if (active.size) return; // the other one is still on it
            settle();
            // Warm process died mid-turn: cold fallback.
            void this.cold(content, (d) => !cancelled && deltaFn(d)).then(finish);
            return;
          }
          const final = typeof o.result === 'string' && o.result ? o.result : text;
          settle();
          finish({
            text: final,
            firstTokenMs: first,
            totalMs: Date.now() - t0,
            cold: false,
            raced,
          });
        }
      };
      const send = (p: WarmProcess) => {
        const carry =
          p.turns === 0 && this.carry.length
            ? `CONVERSACIÓN ANTERIOR (resumen):\n${this.carry.join('\n')}\n\n`
            : '';
        active.add(p);
        p.turn(carry + content, listen(p));
      };
      send(proc);
      raceTimer = setTimeout(() => {
        if (winner || finished || cancelled) return;
        const spare = this.spare;
        if (!spare || spare.dead || !spare.isReady) return;
        this.spare = null;
        raced = true;
        send(spare);
      }, this.raceAfterMs);
      await done;
    };
    this.queue = this.queue.then(run, run);
    return {
      onDelta: (fn) => {
        deltaFn = fn;
      },
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (active.size) onCancel();
        else finish({ text, firstTokenMs: first, totalMs: Date.now() - t0, cold: false });
      },
    };
  }

  private async ensure() {
    const cur = this.current;
    if (cur && !cur.dead && cur.draining) {
      // Still finishing a cut turn: use the spare if it is ready, else wait for the drain.
      if (this.spare && !this.spare.dead && this.spare.isReady) {
        const old = cur;
        this.current = this.spare;
        this.spare = null;
        // Its history now differs from the conversation: retire it once the cut turn is done.
        void old.draining?.then(() => old.kill());
        return;
      }
      await cur.draining;
    }
    if (this.current && !this.current.dead && this.current.turns < this.recycleTurns) {
      await this.current.ready;
      return;
    }
    this.current?.kill();
    this.current = this.spare && !this.spare.dead ? this.spare : this.spawnWarm();
    this.spare = this.current ? this.spawnWarm() : null;
    const cur2 = this.current;
    if (!cur2) return;
    await cur2.ready;
    cur2.isReady = !cur2.dead;
  }

  private cold(content: string, onDelta: (t: string) => void) {
    return new Promise<{
      text: string;
      firstTokenMs?: number;
      totalMs: number;
      cold: boolean;
      error?: string;
    }>((resolve) => {
      const t0 = Date.now();
      let first: number | undefined;
      let text = '';
      const sp = this.spawner();
      if (!sp) {
        this.state = 'error';
        resolve({ text: '', totalMs: 0, cold: true, error: this.problem ?? 'brain' });
        return;
      }
      const child = spawn(sp.bin, [...baseArgs(this.model, this.systemPrompt), content], {
        env: sp.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      sp.pids.add(child.pid);
      child.on('error', () => {
        sp.pids.remove(child.pid);
        resolve({
          text,
          firstTokenMs: first,
          totalMs: Date.now() - t0,
          cold: true,
          error: 'brain',
        });
      });
      const rl = createInterface({ input: child.stdout });
      const noteModel = modelRecorder('copilot', this.model);
      rl.on('line', (line) => {
        try {
          const o = JSON.parse(line);
          noteModel(streamEventModel(o));
          if (
            o.type === 'stream_event' &&
            o.event?.type === 'content_block_delta' &&
            o.event.delta?.text
          ) {
            if (first === undefined) first = Date.now() - t0;
            text += o.event.delta.text;
            onDelta(o.event.delta.text);
          } else if (o.type === 'result' && typeof o.result === 'string' && o.result) {
            text = o.result;
          }
        } catch {
          // ignore
        }
      });
      child.on('close', () => {
        sp.pids.remove(child.pid);
        resolve({
          text,
          firstTokenMs: first,
          totalMs: Date.now() - t0,
          cold: true,
          ...(text ? {} : { error: 'brain' }),
        });
      });
    });
  }
}
