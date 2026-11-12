/**
 * The models Claude really answered with, and the doctor's «unexpected model» check (2026-11-08:
 * every Claude task ran for days on claude-opus-4-8, the account's default for a `claude`
 * without --model, while claude-opus-5-5 was out; nobody saw it).
 *
 *  - Untether's own `claude -p` runs (task review, security review, git-init review, router,
 *    copilot) record here the model their stream named (agent-models.ts streamEventModel).
 *  - Tasks carry theirs in their metrics (agent-usage.ts lastModel); sessions are read from
 *    their transcripts' tails by the server (server-doctor.ts).
 *  - The check warns when a run's real model is not the one asked or configured when it started
 *    (--model, taskModels, `model` in ~/.claude/settings.json at that moment: claudeStartSettings)
 *    and the user did not change it inside the run (transcriptModelChanged), and, when it asked for nothing in
 *    particular (no model, or an alias), when it is older than the newest model of its family
 *    seen on this Mac in the last days. One finding per (asked, real) pair, naming the runs.
 *  - Not Anthropic's (2026-11-08 false warning: a `claude-ablit` session on
 *    abliterated-model-large-flash flagged against the claude-opus-5-5 of settings.json): a run
 *    against another endpoint (ANTHROPIC_BASE_URL in its environment, a provider session), on a
 *    model of a configured provider, or answered by a model Anthropic's API never names, is the
 *    user's choice. The model a session asked for itself (--model, ANTHROPIC_MODEL in its
 *    environment) wins over settings.json.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  aliasFamily,
  compareVersions,
  isRealModel,
  modelMatches,
  parseClaudeModel,
} from '../../shared/agent-models.js';
import type { ClaudeStartSettings, Session } from '../../shared/types.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/** How long a model seen counts, for the newest of its family and for the runs looked at. */
export const MODEL_SEEN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** One run whose real model is known. */
export interface ModelUse {
  /** What it is, for the finding: `Task "x" (id)`, `task review`, `session s1`. */
  label: string;
  /** The model it asked for; undefined = the agent's own default. */
  requested?: string;
  /** Where `requested` came from (`--model`, `taskModels.claude.capable`, `~/.claude/settings.json`). */
  requestedFrom?: string;
  actual: string;
  /** ISO time of the message that named it. */
  at: string;
  /** The API base it talked to (ANTHROPIC_BASE_URL, a provider's); undefined = Anthropic's. */
  endpoint?: string;
}

/** Distinct (purpose, asked, real) records kept at most (the oldest go first). */
const MAX_OBSERVATIONS = 100;

/**
 * Each model Untether's own `claude -p` runs answered with, per purpose and model asked: a run
 * on an unexpected model stays until it is older than the doctor's window, even when later runs
 * of the same purpose got the right one (2026-11-08 review: one record per purpose lost it).
 */
class ModelObservations {
  private readonly seen = new Map<
    string,
    { purpose: string; requested?: string; actual: string; at: string; runs: number }
  >();

  record(purpose: string, requested: string | undefined, actual: string, now = Date.now()): void {
    if (!isRealModel(actual)) return;
    const key = JSON.stringify([purpose, requested ?? null, actual]);
    const runs = (this.seen.get(key)?.runs ?? 0) + 1;
    // Re-inserted: the map's order is oldest first.
    this.seen.delete(key);
    this.seen.set(key, {
      purpose,
      ...(requested ? { requested } : {}),
      actual,
      at: new Date(now).toISOString(),
      runs,
    });
    while (this.seen.size > MAX_OBSERVATIONS) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** One use per (purpose, asked, real): "task review (3 runs, last 12:00)". */
  list(): ModelUse[] {
    return [...this.seen.values()].map((entry) => ({
      label:
        entry.runs > 1 ? `${entry.purpose} (${entry.runs} runs, last ${entry.at})` : entry.purpose,
      ...(entry.requested ? { requested: entry.requested, requestedFrom: '--model' } : {}),
      actual: entry.actual,
      at: entry.at,
    }));
  }

  clear(): void {
    this.seen.clear();
  }
}

/** The one record of the server's `claude -p` runs. */
export const modelObservations = new ModelObservations();

/** A stream-json line's model, recorded once per run (the first real model it names wins). */
export function modelRecorder(purpose: string, requested: string | undefined) {
  let recorded: string | undefined;
  return (model: string | undefined): void => {
    if (!model || model === recorded) return;
    recorded = model;
    modelObservations.record(purpose, requested, model);
  };
}

/** `model` in Claude Code's user settings (what a `claude` without --model runs with). */
export function claudeSettingsModel(claudeDir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as {
      model?: unknown;
    };
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    // `default` asks for nothing in particular, like no model at all.
    return model && model.toLowerCase() !== 'default' ? model : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of a transcript line this file reads. */
interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  /** A subagent's turn: its model says nothing about the conversation's. */
  isSidechain?: boolean;
  content?: unknown;
  message?: { model?: unknown; content?: unknown };
}

function parseTranscriptEntry(line: string): TranscriptEntry | undefined {
  // Only assistant turns and local command replies are looked at.
  if (!line.includes('"assistant"') && !line.includes('Set model to')) return undefined;
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return undefined; // A cut line.
  }
}

/** The newest real model a transcript's lines name (its last assistant message's). */
export function lastTranscriptModel(
  lines: readonly string[]
): { model: string; at?: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptEntry(lines[i]);
    if (!entry || entry.isSidechain) continue;
    const model = entry.type === 'assistant' ? entry.message?.model : undefined;
    if (isRealModel(model)) return { model, ...(entry.timestamp ? { at: entry.timestamp } : {}) };
  }
  return undefined;
}

/** The last `bytes` of a file as lines (the first, maybe cut, dropped); [] when unreadable. */
export function tailLines(file: string, bytes = 256 * 1024): string[] {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(handle);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    return length < size ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * The models of the Claude conversations written on this Mac in the last `windowMs` (newest
 * `count` transcripts, their tails only): the newest model of each family in use here.
 */
export function recentTranscriptModels(
  claudeDir: string,
  now = Date.now(),
  windowMs = MODEL_SEEN_WINDOW_MS,
  count = 40
): Array<{ model: string; at?: string }> {
  const projects = path.join(claudeDir, 'projects');
  const found: Array<{ file: string; mtime: number }> = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(projects, dir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(projects, dir, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (now - mtime <= windowMs) found.push({ file, mtime });
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count)
    .map(({ file, mtime }) => {
      const last = lastTranscriptModel(tailLines(file, 64 * 1024));
      return last ? { model: last.model, at: last.at ?? new Date(mtime).toISOString() } : undefined;
    })
    .filter((seen): seen is { model: string; at: string } => !!seen);
}

/** `--model x` / `--model=x` in an argv or a command line. */
export function modelFlag(args: readonly string[] | string | undefined): string | undefined {
  const argv = typeof args === 'string' ? args.split(/\s+/) : (args ?? []);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' && argv[i + 1]) return argv[i + 1];
    if (arg.startsWith('--model=')) return arg.slice('--model='.length) || undefined;
  }
  return undefined;
}

/** Whether an API base is Anthropic's own (empty = the default, Anthropic's). */
export function isAnthropicEndpoint(url: string | undefined): boolean {
  if (!url?.trim()) return true;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

/** A name Anthropic's API could answer with or Claude Code resolves (claude-*, an alias). */
function isClaudeName(model: string): boolean {
  return (
    !!parseClaudeModel(model) ||
    !!aliasFamily(model) ||
    model.trim().toLowerCase().startsWith('claude')
  );
}

/** ANTHROPIC_BASE_URL and ANTHROPIC_MODEL of an environment (nothing else is read or kept). */
export function anthropicEnv(env: Record<string, string | undefined> | undefined): {
  baseUrl?: string;
  model?: string;
} {
  const baseUrl = env?.ANTHROPIC_BASE_URL?.trim();
  const model = env?.ANTHROPIC_MODEL?.trim();
  return { ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) };
}

/** How a running claude was launched: its --model and its ANTHROPIC_BASE_URL/_MODEL. */
export interface ClaudeLaunch {
  baseUrl?: string;
  model?: string;
  /** `--model` on its own command line (a `claude --model x` typed in a shell session). */
  flag?: string;
}

/**
 * A process' launch out of `ps -ww -o command=` (`command`) and `ps -E -ww -o command=`
 * (`withEnv`: the same command line, then the environment): --model from the command line, the
 * last ANTHROPIC_BASE_URL / ANTHROPIC_MODEL of the environment. Values are read up to the next
 * space; no other variable (the key, ANTHROPIC_AUTH_TOKEN) is ever looked at.
 */
export function parsePsLaunch(command: string, withEnv: string): ClaudeLaunch {
  const args = command.trim();
  const all = withEnv.trim();
  const envText = args && all.startsWith(args) ? all.slice(args.length) : all;
  const last = (name: string) => {
    let found: string | undefined;
    for (const match of envText.matchAll(new RegExp(`(?:^|\\s)${name}=(\\S+)`, 'g'))) {
      found = match[1];
    }
    return found;
  };
  const flag = modelFlag(args);
  return {
    ...anthropicEnv({
      ANTHROPIC_BASE_URL: last('ANTHROPIC_BASE_URL'),
      ANTHROPIC_MODEL: last('ANTHROPIC_MODEL'),
    }),
    ...(flag ? { flag } : {}),
  };
}

/** The running claude of a conversation: its <claudeDir>/sessions/<pid>.json, pid alive. */
export function claudePidOfConversation(
  claudeDir: string,
  conversationId: string,
  alive: (pid: number) => boolean = processAlive
): number | undefined {
  const dir = path.join(claudeDir, 'sessions');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (entry.sessionId !== conversationId || typeof entry.pid !== 'number') continue;
      if (alive(entry.pid)) return entry.pid;
    } catch {
      // Being rewritten.
    }
  }
  return undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function psOutput(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, out) =>
      resolve(error ? '' : String(out))
    );
  });
}

/** How a running process was launched (macOS ps, Linux /proc): see ClaudeLaunch. */
export async function processClaudeLaunch(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<ClaudeLaunch> {
  if (platform === 'linux') {
    const read = (name: string) =>
      fs.promises.readFile(`/proc/${pid}/${name}`, 'utf8').catch(() => '');
    const [environ, cmdline] = await Promise.all([read('environ'), read('cmdline')]);
    const env: Record<string, string> = {};
    for (const entry of environ.split('\0')) {
      const eq = entry.indexOf('=');
      const name = eq > 0 ? entry.slice(0, eq) : '';
      if (name === 'ANTHROPIC_BASE_URL' || name === 'ANTHROPIC_MODEL') {
        env[name] = entry.slice(eq + 1);
      }
    }
    const flag = modelFlag(cmdline.split('\0').filter(Boolean));
    return { ...anthropicEnv(env), ...(flag ? { flag } : {}) };
  }
  if (platform !== 'darwin') return {};
  const [command, withEnv] = await Promise.all([
    psOutput(['-ww', '-o', 'command=', '-p', String(pid)]),
    psOutput(['-E', '-ww', '-o', 'command=', '-p', String(pid)]),
  ]);
  return parsePsLaunch(command, withEnv);
}

/**
 * Whether a transcript line is Claude Code's own reply to /model: «Set model to `Fable 5.2` and
 * saved as your default…». It names a label, not a model id (2026-11-09: reading ids only lost
 * every real reply). A tool result or a message quoting the reply is not one.
 */
function isModelCommandReply(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user' && entry.type !== 'system') return false;
  const raw = entry.message?.content ?? entry.content;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && typeof raw[0]?.text === 'string'
        ? raw[0].text
        : '';
  return text.trimStart().startsWith('<local-command-stdout>') && text.includes('Set model to');
}

/** Per transcript: how far it was read, its last model, whether the model was changed. */
const modelHistories = new Map<string, { size: number; last?: string; changed: boolean }>();
const MODEL_HISTORIES_MAX = 200;

/**
 * Whether the conversation's model was changed after it started: a /model reply, or two turns
 * answered by different models (2026-11-09: a session launched with --model claude-sonnet-5-5
 * and moved to Fable with /model was flagged against its --model). Subagents' turns don't count.
 * Read once from the start (async: a transcript can be hundreds of MB), then only what was
 * appended since (a file that shrank is read again); cached per file.
 */
export async function transcriptModelChanged(file: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const known = modelHistories.get(file);
    const resumed = known && known.size <= size ? known : undefined;
    if (resumed?.changed) return true;
    let last = resumed?.last;
    let changed = false;
    const chunk = Buffer.alloc(1024 * 1024);
    let pending = Buffer.alloc(0);
    let position = resumed?.size ?? 0;
    let done = position;
    while (position < size && !changed) {
      const { bytesRead: read } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - position),
        position
      );
      if (read <= 0) break;
      position += read;
      const bytes = Buffer.concat([pending, chunk.subarray(0, read)]);
      const cut = bytes.lastIndexOf(0x0a);
      // Whole lines only (a multi-byte character is never split): the rest waits for more.
      pending = Buffer.from(cut >= 0 ? bytes.subarray(cut + 1) : bytes);
      if (cut < 0) continue;
      done = position - pending.length;
      for (const line of bytes.subarray(0, cut).toString('utf8').split('\n')) {
        const entry = parseTranscriptEntry(line);
        if (!entry || entry.isSidechain) continue;
        if (isModelCommandReply(entry)) changed = true;
        const model = entry.type === 'assistant' ? entry.message?.model : undefined;
        if (!isRealModel(model)) continue;
        if (last && !modelMatches(last, model)) changed = true;
        last = model;
      }
    }
    // A last line still being written is read again next time.
    modelHistories.delete(file);
    modelHistories.set(file, { size: done, ...(last ? { last } : {}), changed });
    while (modelHistories.size > MODEL_HISTORIES_MAX) {
      const oldest = modelHistories.keys().next().value;
      if (oldest === undefined) break;
      modelHistories.delete(oldest);
    }
    return changed;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * What ~/.claude/settings.json said when this claude started, kept on its session
 * (Session.claudeStartSettings): that value is what the claude was asked, whatever settings.json
 * says later (2026-11-09: /model in any session rewrites it, and two sessions on claude-opus-5-5
 * were flagged against the new fable). `pid` keeps it across a /clear or /resume inside the same
 * claude, which gets a new conversation but keeps its model; `conversations` lists them.
 */
export function claudeStartSettings(
  claudeDir: string,
  conversationId: string | undefined,
  previous?: ClaudeStartSettings,
  alive: (pid: number) => boolean = processAlive
): ClaudeStartSettings {
  const pid = conversationId
    ? claudePidOfConversation(claudeDir, conversationId, alive)
    : undefined;
  // Missing a pid proves nothing by itself. Continuity needs: the session's own command being
  // this claude (`spawned`), the same pid, or, with none readable now, the kept one still alive.
  const sameClaude =
    !!previous &&
    (!!previous.spawned ||
      (previous.pid !== undefined &&
        (pid !== undefined ? previous.pid === pid : alive(previous.pid))));
  if (previous && sameClaude) {
    // Every conversation for as long as this claude runs: the oldest may hold its /model.
    const conversations = [
      ...new Set([...(previous.conversations ?? []), ...(conversationId ? [conversationId] : [])]),
    ];
    return {
      ...previous,
      ...(pid !== undefined ? { pid, spawned: undefined } : {}),
      conversations,
    };
  }
  const model = claudeSettingsModel(claudeDir);
  return {
    ...(pid !== undefined ? { pid } : {}),
    ...(model ? { model } : {}),
    ...(conversationId ? { conversations: [conversationId] } : {}),
  };
}

/**
 * Whether the model of a session's claude was changed inside it: in its conversation or in an
 * earlier one of the same claude (a /model, then a /clear: the new conversation shows no change).
 */
export async function sessionModelChanged(
  session: Pick<Session, 'claudeSessionId' | 'claudeStartSettings'>,
  transcriptOf: (conversationId: string) => string | null | undefined
): Promise<boolean> {
  const ids = new Set([
    ...(session.claudeStartSettings?.conversations ?? []),
    ...(session.claudeSessionId ? [session.claudeSessionId] : []),
  ]);
  for (const id of ids) {
    const file = transcriptOf(id);
    if (file && (await transcriptModelChanged(file))) return true;
  }
  return false;
}

/** Why a use is unexpected, or undefined when it is not. */
function surprise(
  use: ModelUse,
  newest: Map<string, string>,
  providerModels: ReadonlySet<string>
): string | undefined {
  // Another endpoint, or a configured provider's model: the user's choice, not Anthropic's.
  if (!isAnthropicEndpoint(use.endpoint)) return undefined;
  // A provider's claude-* id stays checked: Anthropic's API answers with that name too.
  if (!isClaudeName(use.actual) && providerModels.has(use.actual.trim().toLowerCase())) {
    return undefined;
  }
  // A Claude model asked for and a name Anthropic's API never answers with: another endpoint.
  if (use.requested && isClaudeName(use.requested) && !isClaudeName(use.actual)) return undefined;
  if (use.requested && !modelMatches(use.requested, use.actual)) {
    return `asked for ${use.requested}${use.requestedFrom ? ` (${use.requestedFrom})` : ''}`;
  }
  // A concrete model asked for and got: the user's choice, even an old one.
  if (use.requested && !aliasFamily(use.requested)) return undefined;
  const id = parseClaudeModel(use.actual);
  const best = id ? newest.get(id.family) : undefined;
  const bestId = best ? parseClaudeModel(best) : undefined;
  if (!id || !best || !bestId || compareVersions(id, bestId) >= 0) return undefined;
  const asked = use.requested ? `asked for ${use.requested}` : 'nothing configured';
  return `${asked}, while ${best} is the newest ${id.family} seen on this Mac`;
}

/**
 * Claude runs whose real model is not the expected one (see the file comment). `seen` are the
 * models seen on this Mac lately (every run's and the recent transcripts'), for the newest of
 * each family.
 */
export function unexpectedModelsCheck(deps: {
  uses: () => ModelUse[] | Promise<ModelUse[]>;
  seen?: () =>
    | Array<{ model: string; at?: string }>
    | Promise<Array<{ model: string; at?: string }>>;
  /** Model ids of the configured providers (models, defaultModel, their /v1/models). */
  providerModels?: () => Iterable<string> | Promise<Iterable<string>>;
  now?: () => number;
}): DoctorCheck {
  return {
    id: 'unexpected-model',
    async run() {
      const now = deps.now?.() ?? Date.now();
      const recent = (at: string | undefined) => {
        const time = at ? Date.parse(at) : Number.NaN;
        return !Number.isFinite(time) || now - time <= MODEL_SEEN_WINDOW_MS;
      };
      const uses = (await deps.uses()).filter((use) => recent(use.at));
      const newest = new Map<string, string>();
      const seen = [
        ...uses.map((use) => ({ model: use.actual, at: use.at })),
        ...((await deps.seen?.()) ?? []),
      ];
      for (const { model, at } of seen) {
        if (!recent(at)) continue;
        const id = parseClaudeModel(model);
        if (!id) continue;
        const known = newest.get(id.family);
        const knownId = known ? parseClaudeModel(known) : undefined;
        if (!knownId || compareVersions(id, knownId) > 0) newest.set(id.family, model);
      }
      const providerModels = new Set(
        [...((await deps.providerModels?.()) ?? [])].map((id) => id.trim().toLowerCase())
      );
      const groups = new Map<string, { why: string; actual: string; labels: string[] }>();
      for (const use of uses) {
        const why = surprise(use, newest, providerModels);
        if (!why) continue;
        const key = `unexpected-model:${use.requested ?? 'default'}:${use.actual}`;
        const group = groups.get(key) ?? { why, actual: use.actual, labels: [] };
        if (!group.labels.includes(use.label)) group.labels.push(use.label);
        groups.set(key, group);
      }
      const findings: DoctorFinding[] = [];
      for (const [key, group] of groups) {
        const shown = group.labels.slice(0, 5).join(', ');
        const more = group.labels.length > 5 ? ` and ${group.labels.length - 5} more` : '';
        findings.push({
          key,
          check: 'unexpected-model',
          severity: 'warning',
          problem:
            `Sessions with an unexpected model: ${shown}${more} ran with ${group.actual} (${group.why}). ` +
            'Fix it with "model" in ~/.claude/settings.json (what a claude without --model uses), ' +
            'taskModels.claude.capable/fast in ~/.untether/config.json for tasks, or --model on the run',
        });
      }
      return findings;
    },
  };
}
