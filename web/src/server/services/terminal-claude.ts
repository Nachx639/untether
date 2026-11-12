/**
 * A terminal (a plain shell, a script) in which Claude Code is running, whatever launched it.
 *
 * 2026-11-08: the shield tmux server restarted and sessions started as `claude` came back on
 * their conversation, but a `zsh` where the user had launched Claude through their own script
 * or alias came back as an empty shell: restoring looked at the session's command, which names
 * no Claude. What runs is told here from the process tree instead: a process under the pane
 * with an entry in Claude Code's own registry (`sessions/<pid>.json`), so no launcher, path or
 * provider is known to this code and nobody registers anything.
 *
 * What is written to session.json, while Claude runs and at every change, is TerminalClaude:
 * the conversation, the folder, safe flags, and the NAMES of the environment variables that a
 * plain resume would not reproduce. Environment values are read in memory only and never kept.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { ProviderSessionMarker, Session, TerminalClaude } from '../../shared/types.js';
import type { ModelProvider } from '../../types/config.js';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import { terminalSessionEnv } from '../utils/session-env.js';
import { descendants, type ProcessTable, processTable, readSessionFile } from './claude-chat.js';
import { startsCodex } from './codex-thread.js';
import { providerForBaseUrl, providerModels } from './model-providers.js';
import { commandNamesClaude } from './shielded-tmux.js';

const logger = createLogger('terminal-claude');
const execFileAsync = promisify(execFile);

/** One process's environment (in memory only). */
export type ProcessEnv = Map<string, string>;

/**
 * Variables that decide which backend, account or Claude home a Claude Code talks to. These are
 * Claude Code's own names, the same for every provider.
 */
function decidesClaudeBackend(name: string): boolean {
  return (
    name.startsWith('ANTHROPIC_') ||
    name.startsWith('CLAUDE_CODE_USE_') ||
    name === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    name === 'CLAUDE_CONFIG_DIR'
  );
}

/**
 * The environment words of a `ps -E` line, once its command line is taken off. Values with
 * spaces are cut at the next `NAME=` word: a cut value differs from what is compared with it,
 * which ends as "cannot resume on its own", never as a resume on the wrong backend.
 */
export function parseProcessEnv(words: string): ProcessEnv {
  const env: ProcessEnv = new Map();
  const matches = [...words.matchAll(/(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g)];
  matches.forEach((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? words.length) : words.length;
    env.set(match[1], words.slice(start, end));
  });
  return env;
}

/** The environment each of `pids` was started with (`ps -E`); missing: could not be read. */
export async function readProcessEnvs(
  pids: number[],
  table: Pick<ProcessTable, 'args'>
): Promise<Map<number, ProcessEnv>> {
  const envs = new Map<number, ProcessEnv>();
  if (pids.length === 0) return envs;
  // Never logged: this output holds the processes' secrets.
  const { stdout } = await execFileAsync('ps', ['-wwE', '-o', 'pid=,command=', '-p', pids.join()], {
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = table.args.get(pid);
    if (args === undefined || !match[2].startsWith(args)) continue;
    envs.set(pid, parseProcessEnv(match[2].slice(args.length).trimStart()));
  }
  return envs;
}

/** A Claude Code found running under a terminal's process tree. */
export interface LiveClaude {
  pid: number;
  conversationId: string;
  cwd: string;
}

export interface TerminalClaudeLookDeps {
  claudeDir?: string;
  table?: () => Promise<ProcessTable>;
  readEnvs?: typeof readProcessEnvs;
}

/** The interactive CLI of `pid` in the registry at `claudeDir`, if it is one. */
function liveClaudeAt(claudeDir: string, pid: number, table: ProcessTable): LiveClaude | null {
  const file = readSessionFile(claudeDir, pid, table.starts);
  if (!file?.sessionId || !file.cwd) return null;
  // `claude -p` and SDK-driven runs are one-off: not something a terminal comes back to.
  if ((file.kind ?? 'interactive') !== 'interactive') return null;
  if ((file.entrypoint ?? 'cli') !== 'cli') return null;
  return { pid, conversationId: file.sessionId, cwd: file.cwd };
}

/**
 * The Claude Code under each of `rootPids`, the outermost of its tree. A launcher may point
 * Claude at another home with CLAUDE_CONFIG_DIR, so a tree with no entry in the usual registry
 * is looked up in the home each of its processes names.
 */
export async function lookForTerminalClaudes(
  rootPids: number[],
  deps: TerminalClaudeLookDeps = {}
): Promise<{ claudes: Map<number, LiveClaude>; table: ProcessTable | null }> {
  const claudes = new Map<number, LiveClaude>();
  if (rootPids.length === 0) return { claudes, table: null };
  const claudeDir = deps.claudeDir ?? claudeConfigDir();
  const table = await (deps.table ?? processTable)();
  const unresolved = new Map<number, number[]>();
  for (const root of rootPids) {
    const tree = descendants(table, root);
    let found: LiveClaude | null = null;
    for (const pid of tree) {
      found = liveClaudeAt(claudeDir, pid, table);
      if (found) break;
    }
    if (found) claudes.set(root, found);
    else if (tree.length > 1) unresolved.set(root, tree);
  }
  if (unresolved.size > 0) {
    const readEnvs = deps.readEnvs ?? readProcessEnvs;
    const envs = await readEnvs([...unresolved.values()].flat(), table).catch(
      () => new Map<number, ProcessEnv>()
    );
    for (const [root, tree] of unresolved) {
      for (const pid of tree) {
        const otherHome = envs.get(pid)?.get('CLAUDE_CONFIG_DIR');
        if (!otherHome || path.resolve(otherHome) === path.resolve(claudeDir)) continue;
        if (!fs.existsSync(path.join(otherHome, 'sessions', `${pid}.json`))) continue;
        const found = liveClaudeAt(otherHome, pid, table);
        if (found) {
          claudes.set(root, found);
          break;
        }
      }
    }
  }
  return { claudes, table };
}

/** Flags brought back with the resume; values kept only when they look like plain settings. */
const PERMISSION_BOOLEAN_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);
const PERMISSION_MODE_FLAG = '--permission-mode';
const SAFE_VALUE_FLAGS = new Set(['--model', PERMISSION_MODE_FLAG, '--effort']);
const SAFE_VALUE = /^[\w.:[\]-]+$/;

/**
 * The flags of a running Claude's command line a resume may carry. An allow-list, unlike
 * carriedClaudeArgs (a command Untether built itself): any other flag's value can hold a secret.
 *
 * `ps` joins argv with spaces, so words after an argument with spaces are indistinguishable
 * from real flags (a prompt saying "--dangerously-skip-permissions" must not switch permissions
 * off on restore). Only the leading run of known flags is read: the first other word (a prompt,
 * an unknown flag, `--`) ends it. Permission flags count only before a free-form value (`--model
 * "x --permission-mode …"`); after one they are dropped, so a restore can only ask more.
 */
export function safeClaudeFlags(commandLine: string): string[] {
  const words = commandLine.split(/\s+/).filter(Boolean).slice(1);
  const flags: string[] = [];
  let permissionsUnambiguous = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (PERMISSION_BOOLEAN_FLAGS.has(word)) {
      if (permissionsUnambiguous) flags.push(word);
      continue;
    }
    const eq = word.indexOf('=');
    const name = eq > 0 ? word.slice(0, eq) : word;
    if (!SAFE_VALUE_FLAGS.has(name)) break;
    const value = eq > 0 ? word.slice(eq + 1) : words[++i];
    if (value === undefined || !SAFE_VALUE.test(value)) break;
    if (name === PERMISSION_MODE_FLAG) {
      if (permissionsUnambiguous) flags.push(...(eq > 0 ? [word] : [name, value]));
      continue;
    }
    flags.push(...(eq > 0 ? [word] : [name, value]));
    permissionsUnambiguous = false;
  }
  return flags;
}

/** Names of the backend variables a plain resume (`baseline`) would not give Claude. */
export function differingBackendVars(live: ProcessEnv, baseline: Record<string, string>): string[] {
  const names = new Set([...live.keys(), ...Object.keys(baseline)].filter(decidesClaudeBackend));
  return [...names].filter((name) => live.get(name) !== baseline[name]).sort();
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/** What a launch on a provider sets and removes (the restore's own resolver). */
export interface RebuiltProviderEnv {
  env: Record<string, string>;
  unset: string[];
}

/** A provider's marker; the model only when its config lists it, so none comes from `live`. */
function providerMarker(provider: ModelProvider, live: ProcessEnv): ProviderSessionMarker {
  const running = live.get('ANTHROPIC_MODEL');
  const known = providerModels(provider).some((model) => model.id === running);
  return { id: provider.id, model: known && running ? running : '' };
}

/**
 * The configured provider whose endpoint this environment uses, as a candidate only: the
 * endpoint says nothing about the account (providerReproduces decides). The model is taken only
 * when the provider's config lists it, so what is saved never comes from the environment.
 */
export function configuredProviderFor(
  live: ProcessEnv,
  providers: ModelProvider[] | undefined
): ProviderSessionMarker | undefined {
  const baseUrl = live.get('ANTHROPIC_BASE_URL');
  if (!baseUrl) return undefined;
  const provider = providers?.find(
    (candidate) => withoutTrailingSlash(candidate.baseUrl) === withoutTrailingSlash(baseUrl)
  );
  return provider ? providerMarker(provider, live) : undefined;
}

/**
 * The configured provider this Claude talks to, by the host of its base URL only: enough to mark
 * its row, not to resume on it (configuredProviderFor, providerReproduces). Only the provider's
 * own id and a model its config lists come out; the URL is compared and dropped.
 */
export function detectedProviderFor(
  live: ProcessEnv,
  providers: ModelProvider[] | undefined
): ProviderSessionMarker | undefined {
  const baseUrl = live.get('ANTHROPIC_BASE_URL');
  if (!baseUrl) return undefined;
  const provider = providerForBaseUrl({ modelProviders: providers }, baseUrl);
  return provider ? providerMarker(provider, live) : undefined;
}

/**
 * Whether a launch on the provider gives Claude exactly the environment it has now. Checked over
 * everything the launch touches, not only `customEnv` (what differs from a plain resume): a
 * credential Claude inherited equals the baseline, so it is no difference, yet the provider
 * would replace or remove it and the conversation would continue on another account. Every
 * variable the launch sets must already have that value (credential included), every one it
 * removes must already be absent, and no difference may be left that the launch does not touch.
 * Compared in memory, never kept.
 */
export function providerReproduces(
  live: ProcessEnv,
  customEnv: string[],
  rebuilt: RebuiltProviderEnv
): boolean {
  // A variable both removed and set ends up set (applyProviderEnv removes first).
  const sets = (name: string) => name in rebuilt.env;
  return (
    Object.entries(rebuilt.env).every(([name, value]) => live.get(name) === value) &&
    rebuilt.unset.every((name) => sets(name) || !live.has(name)) &&
    customEnv.every((name) => sets(name) || rebuilt.unset.includes(name))
  );
}

export interface TerminalClaudeRecorderOptions extends TerminalClaudeLookDeps {
  listSessions: () => Session[];
  rootPid: (session: Session) => number | undefined;
  save: (sessionId: string, record: TerminalClaude | undefined) => void;
  isAlive: (pid: number) => boolean;
  providers: () => ModelProvider[] | undefined;
  /** What the restore would launch on this provider; null when it cannot be rebuilt. */
  rebuildProviderEnv: (marker: ProviderSessionMarker) => Promise<RebuiltProviderEnv | null>;
  /** What a plain resume's Claude would get (default: the restore's own environment). */
  baselineEnv?: () => Record<string, string>;
  intervalMs?: number;
}

/** Sessions whose command does not say Claude: the ones this module has to tell apart. */
function isTerminal(session: Session): boolean {
  return (
    session.status === 'running' &&
    !!session.shielded &&
    !commandNamesClaude(session.command) &&
    !startsCodex(session.command)
  );
}

/** The provider that can bring this exact environment back, if one can. */
async function reproducingProvider(
  env: ProcessEnv,
  customEnv: string[],
  options: TerminalClaudeRecorderOptions
): Promise<ProviderSessionMarker | undefined> {
  const marker = configuredProviderFor(env, options.providers());
  if (!marker) return undefined;
  // Its key is read here only for a Claude already using this provider's endpoint.
  const rebuilt = await options.rebuildProviderEnv(marker).catch(() => null);
  return rebuilt && providerReproduces(env, customEnv, rebuilt) ? marker : undefined;
}

function sameRecord(a: TerminalClaude, b: TerminalClaude): boolean {
  return a.conversationId === b.conversationId && a.cwd === b.cwd;
}

/**
 * A Claude already recorded that may still get its provider mark: one recorded before detection
 * existed, or whose provider was configured after it started. Only one with a base URL of its
 * own, and only while some provider is configured, so the usual terminal is not read again.
 */
function mayGainProvider(known: TerminalClaude, providers: ModelProvider[] | undefined): boolean {
  return (
    !known.detectedProvider && known.customEnv.includes('ANTHROPIC_BASE_URL') && !!providers?.length
  );
}

/**
 * One look: running terminals get what Claude runs in them, and lose it when Claude ended. The
 * environment is read once per Claude process; a process already recorded only follows its
 * conversation and folder (and looks for its provider mark, mayGainProvider). A pane that is gone
 * says nothing: Claude was alive at the last look, which is exactly what a restore needs to know.
 */
export async function recordTerminalClaudes(options: TerminalClaudeRecorderOptions): Promise<void> {
  const targets = new Map<number, Session>();
  for (const session of options.listSessions()) {
    if (!isTerminal(session)) continue;
    const pid = options.rootPid(session);
    if (pid) targets.set(pid, session);
  }
  const { claudes, table } = await lookForTerminalClaudes([...targets.keys()], options);
  const needEnv: Array<{ session: Session; live: LiveClaude }> = [];
  const needProvider: Array<{ session: Session; record: TerminalClaude }> = [];
  for (const [root, session] of targets) {
    const live = claudes.get(root);
    const known = session.terminalClaude;
    if (!live) {
      if (known && options.isAlive(root)) options.save(session.id, undefined);
      continue;
    }
    if (known?.pid !== live.pid) {
      needEnv.push({ session, live });
      continue;
    }
    const updated = { ...known, conversationId: live.conversationId, cwd: live.cwd };
    if (!sameRecord(known, updated)) options.save(session.id, updated);
    if (mayGainProvider(updated, options.providers())) {
      needProvider.push({ session, record: updated });
    }
  }
  if ((needEnv.length === 0 && needProvider.length === 0) || !table) return;
  const readEnvs = options.readEnvs ?? readProcessEnvs;
  // Unreadable now: not recorded, the next look tries again.
  const envs = await readEnvs(
    [...needEnv.map(({ live }) => live.pid), ...needProvider.map(({ record }) => record.pid)],
    table
  );
  for (const { session, record } of needProvider) {
    const env = envs.get(record.pid);
    const detectedProvider = env && detectedProviderFor(env, options.providers());
    if (detectedProvider) options.save(session.id, { ...record, detectedProvider });
  }
  const baseline = options.baselineEnv?.() ?? terminalSessionEnv(process.env, {});
  for (const { session, live } of needEnv) {
    const env = envs.get(live.pid);
    if (!env) continue;
    const customEnv = differingBackendVars(env, baseline);
    const provider =
      customEnv.length > 0 ? await reproducingProvider(env, customEnv, options) : null;
    const detectedProvider = detectedProviderFor(env, options.providers());
    options.save(session.id, {
      conversationId: live.conversationId,
      pid: live.pid,
      cwd: live.cwd,
      flags: safeClaudeFlags(table.args.get(live.pid) ?? ''),
      customEnv,
      ...(provider ? { modelProvider: provider } : {}),
      ...(detectedProvider ? { detectedProvider } : {}),
    });
    logger.debug(`session ${session.id} runs Claude conversation ${live.conversationId}`);
  }
}

/** Looks every `intervalMs` (default 20 s); returns the stop function. */
export function startTerminalClaudeRecorder(options: TerminalClaudeRecorderOptions): () => void {
  let running = false;
  const timer = every(
    'terminal claude',
    () => {
      if (running) return;
      running = true;
      recordTerminalClaudes(options)
        .catch((error) => logger.debug(`look for Claude in terminals failed: ${error}`))
        .finally(() => {
          running = false;
        });
    },
    options.intervalMs ?? 20_000
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
