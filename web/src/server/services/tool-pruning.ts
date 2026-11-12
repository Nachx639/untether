/**
 * Per-project tool pruning of task agents' Claude sessions (2026-11-03, opt-in per project:
 * ProjectSettings.toolPruning).
 *
 * Measured 2026-11-03 over 208 task transcripts: every task session loaded ~30k tokens of
 * listings it never used (the skill listing, ~300 deferred MCP tool names, mostly Vercel's,
 * the GitHub and Inkwell servers, plugin skills), re-read on every turn: ~13 % of the weighted
 * task cost. In 4 days tasks invoked 1 skill and one MCP tool (claude-mem's work_state_write).
 *
 * 1. What the project's tasks used is read from their own Claude transcripts (the files the
 *    budget already found for each task, TaskBudget.tokensBy): Skill calls, mcp__ tools, plugin
 *    agents, and the misses (a ToolSearch that found nothing, an "Unknown skill"), which count
 *    as wanted. Kept in ~/.untether/tool-usage.json per project, with each task's start
 *    context (its first turn's input tokens) so the saving shows.
 * 2. A task's session starts with the Claude Code settings that drop what none of the last
 *    `toolPruningWindow` task sessions of the project used, in the task's own `--settings` file
 *    (task-guard-setup.ts), the supported keys of Claude Code's settings schema (checked on
 *    2.1.316 against `claude -p --output-format stream-json`'s init event):
 *      enabledPlugins { "<plugin>@<marketplace>": false }  the plugin, its skills, MCP, hooks
 *      deniedMcpServers [{ serverName }]                    an MCP server (user, project, a
 *                                                           kept plugin's, claude.ai's)
 *      skillOverrides { "<skill>": "name-only" }            the skill listed without its
 *                                                           description, still invocable
 *      disableClaudeAiConnectors true                       the claude.ai connectors
 *    Never dropped: language/LSP plugins, Untether's own hooks (they are in the same file, not a
 *    plugin), anything in the project's toolKeep, anything used or wanted in the window. The
 *    user's CLAUDE.md files are not touched (they are not tools).
 * 3. A task that needs a dropped tool: its miss, or `ut project tools want <name>`, brings it
 *    back for the next tasks; `ut project tools` shows the list, `restore` brings all back.
 * 4. The list is fixed per task (its tool-profile.json, written at its first start): a resumed
 *    or reopened conversation gets the same one, so its prompt cache stays valid.
 *
 * Codex: not pruned (its MCP servers are two here and its rollouts do not record them the same
 * way); its tasks are skipped.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_PRUNING_WINDOW_DEFAULT } from '../../shared/projects.js';
import { type SavingAutoOff, taskSavingOn } from '../../shared/saving-features.js';
import { TASK_FINAL_STATES, type TaskRecord } from '../../shared/tasks.js';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { isCodexRollout } from './agent-usage.js';

/** Task sessions recorded in a project before anything is pruned (fewer: nothing is). */
export const TOOL_PRUNING_MIN_SESSIONS = 5;
/** Sessions kept per project in the usage file (the window is at most this). */
export const TOOL_USAGE_MAX_SESSIONS = 200;
/** Bytes of one task's transcripts read at most (a bigger one is read up to here). */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** A ToolSearch query that found nothing, kept this long at most. */
const MISS_MAX_CHARS = 200;

/** The group name of the claude.ai connectors (toolKeep, `ut project tools want`). */
export const CLAUDE_AI_GROUP = 'claude.ai';

// ── Names ──────────────────────────────────────────────────────────────────────────────────

/**
 * The part of an MCP server's tool names that names it (`mcp__<this>__tool`): Claude Code's own
 * normalization (2.1.316): anything but letters, digits, _ and - becomes _, and a claude.ai
 * connector's runs of _ are folded.
 */
export function mcpToolPrefix(serverName: string): string {
  let out = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (serverName.startsWith('claude.ai ')) out = out.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return out;
}

/** The server part of an MCP tool's name, or null. */
export function mcpPrefixOfTool(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const end = toolName.indexOf('__', 5);
  return end > 5 ? toolName.slice(5, end) : null;
}

/** A plugin's name from its id (`name@marketplace`). */
export function pluginName(id: string): string {
  const at = id.lastIndexOf('@');
  return at > 0 ? id.slice(0, at) : id;
}

// ── Inventory: what this Mac's Claude Code would load ──────────────────────────────────────

export interface InventoryPlugin {
  /** `name@marketplace`, the enabledPlugins key. */
  id: string;
  name: string;
  /** Its MCP servers' names as Claude Code names them (`plugin:<name>:<server>`). */
  servers: string[];
  /** A language server plugin: never pruned. */
  lsp: boolean;
  /** It has hooks of its own (shown: pruning it turns them off for the task). */
  hooks: boolean;
}

export interface ToolInventory {
  plugins: InventoryPlugin[];
  /** MCP servers not from a plugin: the user's, the project's (.mcp.json, ~/.claude.json). */
  mcpServers: string[];
  /** Skills of the user's and the project's skills folders (not plugins', not bundled). */
  skills: string[];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The servers of an MCP config object (`{ mcpServers: {…} }`, or the servers themselves). */
function serverNames(config: unknown): string[] {
  const object = record(config);
  const servers = 'mcpServers' in object ? record(object.mcpServers) : object;
  return Object.keys(servers).filter((name) => name.length > 0 && name.length <= 200);
}

/** The skills in a skills folder: each subfolder with a SKILL.md (its frontmatter name wins). */
function skillsIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.slice(0, 1000)) {
    if (entry.startsWith('.')) continue;
    const file = path.join(dir, entry, 'SKILL.md');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8').slice(0, 4096);
    } catch {
      continue;
    }
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const named = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front)?.[1]?.trim();
    out.push(named || entry);
  }
  return out;
}

export interface InventoryOptions {
  /** The project's main checkout. */
  repo: string;
  claudeDir?: string;
  /** ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json). */
  claudeJson?: string;
}

/** The plugin's language servers, from its own files or its marketplace's entry. */
function pluginHasLsp(
  claudeDir: string,
  id: string,
  dir: string | undefined,
  manifest: Record<string, unknown>
): boolean {
  const name = pluginName(id);
  if (/(^|[-_])lsp($|[-_])/i.test(name)) return true;
  if ('lspServers' in manifest) return true;
  if (dir && fs.existsSync(path.join(dir, '.lsp.json'))) return true;
  const marketplace = id.slice(id.lastIndexOf('@') + 1);
  const listing = record(
    readJson(
      path.join(
        claudeDir,
        'plugins',
        'marketplaces',
        marketplace,
        '.claude-plugin',
        'marketplace.json'
      )
    )
  );
  const entries = Array.isArray(listing.plugins) ? listing.plugins : [];
  return entries.some((entry) => {
    const plugin = record(entry);
    return plugin.name === name && 'lspServers' in plugin;
  });
}

/** What Claude Code loads for a session in the project: enabled plugins, MCP servers, skills. */
export function readToolInventory(options: InventoryOptions): ToolInventory {
  const claudeDir = options.claudeDir ?? claudeConfigDir();
  const claudeJson =
    options.claudeJson ??
    (process.env.CLAUDE_CONFIG_DIR?.trim()
      ? path.join(claudeDir, '.claude.json')
      : path.join(os.homedir(), '.claude.json'));
  const repo = options.repo;

  // enabledPlugins: user < project < local (the project's own files).
  const enabled = new Map<string, boolean>();
  for (const file of [
    path.join(claudeDir, 'settings.json'),
    path.join(repo, '.claude', 'settings.json'),
    path.join(repo, '.claude', 'settings.local.json'),
  ]) {
    for (const [id, value] of Object.entries(record(record(readJson(file)).enabledPlugins))) {
      enabled.set(id, value !== false && value !== null && value !== undefined);
    }
  }
  const installed = record(
    record(readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'))).plugins
  );
  const plugins: InventoryPlugin[] = [];
  for (const [id, on] of enabled) {
    if (!on || !id.includes('@') || id.endsWith('@builtin')) continue;
    const entries = (Array.isArray(installed[id]) ? installed[id] : []) as unknown[];
    const entry = record(
      entries.find((e) => record(e).projectPath === repo) ??
        entries.find((e) => record(e).scope === 'user') ??
        entries[0]
    );
    const dir = typeof entry.installPath === 'string' ? entry.installPath : undefined;
    const manifest = dir ? record(readJson(path.join(dir, '.claude-plugin', 'plugin.json'))) : {};
    const name = pluginName(id);
    const servers = new Set<string>();
    if (dir) {
      for (const server of serverNames(readJson(path.join(dir, '.mcp.json')))) servers.add(server);
      const own = manifest.mcpServers;
      const fromManifest =
        typeof own === 'string'
          ? serverNames(readJson(path.resolve(dir, own)))
          : Array.isArray(own)
            ? own.flatMap((file) =>
                typeof file === 'string' ? serverNames(readJson(path.resolve(dir, file))) : []
              )
            : serverNames(own);
      for (const server of fromManifest) servers.add(server);
    }
    plugins.push({
      id,
      name,
      servers: [...servers].map((server) => `plugin:${name}:${server}`),
      lsp: pluginHasLsp(claudeDir, id, dir, manifest),
      hooks: 'hooks' in manifest || (!!dir && fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))),
    });
  }

  const userConfig = record(readJson(claudeJson));
  const mcpServers = new Set<string>(serverNames(userConfig.mcpServers ?? {}));
  for (const server of serverNames(record(record(userConfig.projects)[repo]).mcpServers ?? {})) {
    mcpServers.add(server);
  }
  for (const server of serverNames(readJson(path.join(repo, '.mcp.json')))) mcpServers.add(server);

  const skills = new Set<string>([
    ...skillsIn(path.join(claudeDir, 'skills')),
    ...skillsIn(path.join(repo, '.claude', 'skills')),
  ]);
  return {
    plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)),
    mcpServers: [...mcpServers].sort(),
    skills: [...skills].sort(),
  };
}

// ── Transcripts: what a task's agent used ──────────────────────────────────────────────────

export interface TranscriptToolUse {
  /** `plugin:<name>`, `mcp:<tool prefix>`, `skill:<name>`: used, or asked for and missed. */
  used: string[];
  /** ToolSearch queries that found nothing (lower case). */
  misses: string[];
  /** The first turn's input tokens (input, cache writes, cache reads): the fixed overhead. */
  startTokens?: number;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = record(part);
        return typeof block.text === 'string' ? block.text : '';
      })
      .join('\n');
  }
  return '';
}

/** Adds what one Skill name stands for: the skill, and a plugin skill's plugin. */
function addSkill(used: Set<string>, skill: string): void {
  const name = skill.trim().replace(/^\//, '');
  if (!name || name.length > 200) return;
  used.add(`skill:${name}`);
  const colon = name.indexOf(':');
  if (colon > 0) used.add(`plugin:${name.slice(0, colon)}`);
}

/** Reads a Claude transcript's lines (JSONL) for its tool use. */
export function scanClaudeTranscript(lines: Iterable<string>): TranscriptToolUse {
  const used = new Set<string>();
  const misses: string[] = [];
  const searches = new Map<string, string>();
  const skillCalls = new Set<string>();
  let startTokens: number | undefined;
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) {
      if (startTokens !== undefined || !line.includes('"usage"')) continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    const message = record(entry.message);
    const content = Array.isArray(message.content) ? message.content : [];
    if (entry.type === 'assistant') {
      const usage = record(message.usage);
      if (startTokens === undefined && Object.keys(usage).length) {
        const count = (key: string) =>
          typeof usage[key] === 'number' && Number.isFinite(usage[key])
            ? (usage[key] as number)
            : 0;
        startTokens =
          count('input_tokens') +
          count('cache_creation_input_tokens') +
          count('cache_read_input_tokens');
      }
      for (const part of content) {
        const block = record(part);
        if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const input = record(block.input);
        const id = typeof block.id === 'string' ? block.id : '';
        const prefix = mcpPrefixOfTool(block.name);
        if (prefix) used.add(`mcp:${prefix}`);
        else if (block.name === 'Skill' && typeof input.skill === 'string') {
          addSkill(used, input.skill);
          if (id) skillCalls.add(id);
        } else if (
          (block.name === 'Agent' || block.name === 'Task') &&
          typeof input.subagent_type === 'string' &&
          input.subagent_type.includes(':')
        ) {
          used.add(`plugin:${input.subagent_type.slice(0, input.subagent_type.indexOf(':'))}`);
        } else if (block.name === 'ToolSearch' && typeof input.query === 'string' && id) {
          searches.set(id, input.query);
        }
      }
    } else if (entry.type === 'user') {
      for (const part of content) {
        const block = record(part);
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const query = searches.get(block.tool_use_id);
        const text = textOf(block.content);
        if (query !== undefined && text.includes('No matching deferred tools found')) {
          // `select:mcp__github__create_issue,…`: the servers it named; any other: its words.
          const named = [...query.matchAll(/mcp__([A-Za-z0-9_-]+?)__/g)].map((m) => m[1]);
          for (const prefix of named) used.add(`mcp:${prefix}`);
          if (!named.length) misses.push(query.toLowerCase().slice(0, MISS_MAX_CHARS));
        }
        if (skillCalls.has(block.tool_use_id)) {
          const unknown = /Unknown skill:\s*([^\s"'`]+)/.exec(text)?.[1];
          if (unknown) addSkill(used, unknown);
        }
      }
    }
  }
  return {
    used: [...used].sort(),
    misses: [...new Set(misses)],
    ...(startTokens !== undefined ? { startTokens } : {}),
  };
}

// ── The plan: what a new session of the project goes without ───────────────────────────────

/** One task session of the project, or a `want` (an explicit ask: id want:<time>). */
export interface ToolSession {
  id: string;
  /** When the task started (or the ask was made). */
  at: string;
  used: string[];
  misses?: string[];
  startTokens?: number;
  /** It started with a pruned tool list. */
  pruned?: boolean;
  /** Its transcripts as last read (sizes): read again only when they grew. */
  stamp?: string;
}

export interface ToolPruning {
  /** Plugin ids turned off (enabledPlugins false). */
  plugins: string[];
  /** MCP servers denied (deniedMcpServers). */
  mcpServers: string[];
  /** Skills listed by name only (skillOverrides name-only). */
  skills: string[];
  /** The claude.ai connectors off (disableClaudeAiConnectors). */
  claudeAi: boolean;
  /** Task sessions the decision was made from, and the window. */
  sessions: number;
  window: number;
}

const GENERIC_WORDS = new Set([
  'plugin',
  'plugins',
  'mcp',
  'server',
  'servers',
  'tool',
  'tools',
  'claude',
  'skill',
  'skills',
  'select',
  'the',
  'and',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word));
}

/** The sessions in the window: the last `window` task sessions and the asks made meanwhile. */
export function windowSessions(sessions: readonly ToolSession[], window: number): ToolSession[] {
  const sorted = [...sessions].sort((a, b) => b.at.localeCompare(a.at));
  const out: ToolSession[] = [];
  let tasks = 0;
  for (const session of sorted) {
    const ask = session.id.startsWith('want:');
    if (!ask && tasks >= window) break;
    out.push(session);
    if (!ask) tasks++;
  }
  return out;
}

export interface PlanInput {
  inventory: ToolInventory;
  sessions: readonly ToolSession[];
  window?: number;
  keep?: readonly string[];
  minSessions?: number;
}

/** What is kept and why (for `ut project tools`), and what goes. */
export function planToolPruning(input: PlanInput): ToolPruning | null {
  const window = input.window ?? TOOL_PRUNING_WINDOW_DEFAULT;
  const recent = windowSessions(input.sessions, window);
  const taskSessions = recent.filter((session) => !session.id.startsWith('want:')).length;
  if (taskSessions < Math.min(window, input.minSessions ?? TOOL_PRUNING_MIN_SESSIONS)) {
    return null;
  }
  const used = new Set(recent.flatMap((session) => session.used));
  const missWords = new Set(recent.flatMap((session) => (session.misses ?? []).flatMap(words)));
  const keep = new Set((input.keep ?? []).map((name) => name.trim().toLowerCase()));
  const kept = (...names: string[]) => names.some((name) => keep.has(name.toLowerCase()));
  const mentioned = (name: string) => words(name).some((word) => missWords.has(word));
  const serverUsed = (server: string) => used.has(`mcp:${mcpToolPrefix(server)}`);
  const serverKept = (server: string, short = server) =>
    kept(server, short) || serverUsed(server) || mentioned(short);

  const plugins: string[] = [];
  const mcpServers: string[] = [];
  for (const plugin of input.inventory.plugins) {
    const keepIt =
      plugin.lsp ||
      kept(plugin.id, plugin.name) ||
      used.has(`plugin:${plugin.name}`) ||
      plugin.servers.some((server) => serverUsed(server)) ||
      mentioned(plugin.name);
    if (!keepIt) {
      plugins.push(plugin.id);
      continue;
    }
    // A plugin kept for its skills or hooks still goes without the MCP servers nobody used.
    for (const server of plugin.servers) {
      if (!serverKept(server, server.split(':').pop() ?? server)) mcpServers.push(server);
    }
  }
  for (const server of input.inventory.mcpServers) {
    if (!serverKept(server)) mcpServers.push(server);
  }
  const claudeAiUsed = [...used].some((key) => key.startsWith('mcp:claude_ai_'));
  // Asked for by name in a failed search: read from the raw text, since words() drops "claude".
  const claudeAiMissed = recent.some((session) =>
    (session.misses ?? []).some((miss) => /claude[._ ]ai\b/i.test(miss))
  );
  const claudeAi = !(claudeAiUsed || kept(CLAUDE_AI_GROUP) || claudeAiMissed);
  const skills = input.inventory.skills.filter(
    (skill) => !(kept(skill) || used.has(`skill:${skill}`) || mentioned(skill))
  );
  return {
    plugins,
    mcpServers: [...new Set(mcpServers)],
    skills,
    claudeAi,
    sessions: taskSessions,
    window,
  };
}

/** Whether a plan drops anything at all. */
export function prunesAnything(plan: ToolPruning | null | undefined): plan is ToolPruning {
  return (
    !!plan &&
    (plan.plugins.length > 0 ||
      plan.mcpServers.length > 0 ||
      plan.skills.length > 0 ||
      plan.claudeAi)
  );
}

/** The Claude Code settings of a plan (merged into the task's --settings file). */
export function pruningSettings(plan: ToolPruning): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (plan.plugins.length) {
    out.enabledPlugins = Object.fromEntries(plan.plugins.map((id) => [id, false]));
  }
  if (plan.mcpServers.length) {
    out.deniedMcpServers = plan.mcpServers.map((serverName) => ({ serverName }));
  }
  if (plan.skills.length) {
    out.skillOverrides = Object.fromEntries(plan.skills.map((skill) => [skill, 'name-only']));
  }
  if (plan.claudeAi) out.disableClaudeAiConnectors = true;
  return out;
}

/** What the task's agent is told once, with its brief: what it goes without, how to ask. */
export function pruningNote(plan: ToolPruning): string | null {
  const parts: string[] = [];
  if (plan.plugins.length) parts.push(`plugins ${plan.plugins.map(pluginName).join(', ')}`);
  if (plan.mcpServers.length) parts.push(`MCP servers ${plan.mcpServers.join(', ')}`);
  if (plan.claudeAi) parts.push('the claude.ai connectors');
  if (!parts.length) return null;
  return `[untether] To save context, this session starts without the tools no recent task of this project used: ${parts.join('; ')}. Skills nobody used are listed by name only (still usable). If you need one of these, run \`ut project tools want <name>\`: the next tasks get it back (this session keeps its tool list).`;
}

/** Turns a name the user or an agent gave into the usage keys it stands for (null: unknown). */
export function wantedKeys(inventory: ToolInventory, name: string): string[] | null {
  const wanted = name.trim();
  const lower = wanted.toLowerCase();
  if (!wanted) return null;
  if (lower === CLAUDE_AI_GROUP || lower.startsWith('claude.ai ')) {
    return [`mcp:${lower === CLAUDE_AI_GROUP ? 'claude_ai_' : mcpToolPrefix(wanted)}`];
  }
  const plugin = inventory.plugins.find(
    (p) => p.id.toLowerCase() === lower || p.name.toLowerCase() === lower
  );
  // A plugin asked for comes back whole: its MCP servers too.
  if (plugin) {
    return [
      `plugin:${plugin.name}`,
      ...plugin.servers.map((server) => `mcp:${mcpToolPrefix(server)}`),
    ];
  }
  const server =
    inventory.mcpServers.find((s) => s.toLowerCase() === lower) ??
    inventory.plugins
      .flatMap((p) => p.servers)
      .find((s) => s.toLowerCase() === lower || s.split(':').pop()?.toLowerCase() === lower);
  if (server) return [`mcp:${mcpToolPrefix(server)}`];
  const skill = inventory.skills.find((s) => s.toLowerCase() === lower);
  if (skill) return [`skill:${skill}`];
  return null;
}

// ── The usage file ─────────────────────────────────────────────────────────────────────────

interface UsageFile {
  version: 1;
  projects: Record<string, ToolSession[]>;
}

/** ~/.untether/tool-usage.json: each project's task sessions' tool use, newest kept. */
export class ToolUsageStore {
  private projects: Record<string, ToolSession[]> = {};

  constructor(private readonly file: string) {
    const data = record(readJson(file));
    for (const [repo, sessions] of Object.entries(record(data.projects))) {
      if (!Array.isArray(sessions)) continue;
      this.projects[repo] = sessions.filter(
        (s): s is ToolSession =>
          !!s &&
          typeof (s as ToolSession).id === 'string' &&
          typeof (s as ToolSession).at === 'string' &&
          Array.isArray((s as ToolSession).used)
      );
    }
  }

  sessions(repo: string): ToolSession[] {
    return [...(this.projects[repo] ?? [])];
  }

  get(repo: string, id: string): ToolSession | undefined {
    return this.projects[repo]?.find((session) => session.id === id);
  }

  /** Adds or replaces a session (by id); the oldest go past TOOL_USAGE_MAX_SESSIONS. */
  put(repo: string, session: ToolSession): void {
    const list = (this.projects[repo] ?? []).filter((other) => other.id !== session.id);
    list.push(session);
    list.sort((a, b) => a.at.localeCompare(b.at));
    this.projects[repo] = list.slice(-TOOL_USAGE_MAX_SESSIONS);
    this.save();
  }

  /** A project folder renamed or moved (ProjectSettingsStore.followedBy). */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let changed = 0;
    for (const { from, to } of moved) {
      const sessions = this.projects[from];
      if (!sessions) continue;
      const into = this.projects[to] ?? [];
      const ids = new Set(into.map((session) => session.id));
      this.projects[to] = [...into, ...sessions.filter((session) => !ids.has(session.id))]
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-TOOL_USAGE_MAX_SESSIONS);
      delete this.projects[from];
      changed++;
    }
    if (changed) this.save();
    return changed;
  }

  private save(): void {
    const data: UsageFile = { version: 1, projects: this.projects };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Kept in memory; written again with the next change.
    }
  }
}

// ── The pruner: scans, decides per task, answers `ut project tools` ────────────────────────

/** A task's tool list, fixed at its first start (its guard folder's tool-profile.json). */
export interface TaskToolProfile {
  /** null: it started with everything (pruning off, or not enough sessions yet). */
  pruning: ToolPruning | null;
  at: string;
}

export interface ToolPrunerSettings {
  toolPruning?: boolean;
  /** What the quality guard turned off (a task from before metrics falls back on it). */
  savingAutoOff?: SavingAutoOff[];
  toolPruningWindow?: number;
  toolKeep?: string[];
}

export interface ToolPrunerOptions {
  store: ToolUsageStore;
  /** The project's settings (its main checkout). */
  settings: (repo: string) => ToolPrunerSettings;
  /** Every task Untether knows (null: tasks not ready). */
  tasks: () => readonly TaskRecord[] | null;
  /** Where a task's profile file goes (its guard folder). */
  profileFile: (taskId: string) => string;
  inventory?: (repo: string) => ToolInventory;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ToolsShow {
  repoPath: string;
  enabled: boolean;
  window: number;
  keep: string[];
  /** Task sessions recorded in the window, and the minimum before anything is pruned. */
  sessions: number;
  minSessions: number;
  plan: ToolPruning | null;
  inventory: ToolInventory;
  /** What the window's sessions used or asked for (usage keys). */
  used: string[];
  misses: string[];
  /** Average start context of recent sessions, pruned and not. */
  startTokens: { pruned?: number; prunedCount: number; full?: number; fullCount: number };
}

/** A task's tools as `ut task status` shows them (shared with the CLI as plain JSON). */
export interface TaskToolsInfo {
  /** Its first turn's input tokens: the fixed overhead its session started with. */
  startTokens?: number;
  /** What its session went without (null: everything loaded; unset: no profile). */
  pruned?: { plugins: number; mcpServers: number; skills: number; claudeAi: boolean } | null;
}

function isClaudeTask(task: TaskRecord): boolean {
  return task.agent === 'claude';
}

export function createToolPruner(options: ToolPrunerOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const inventoryOf = options.inventory ?? ((repo: string) => readToolInventory({ repo }));
  const windowOf = (repo: string) =>
    options.settings(repo).toolPruningWindow ?? TOOL_PRUNING_WINDOW_DEFAULT;
  let scanning: Promise<void> | null = null;

  const readProfile = (taskId: string): TaskToolProfile | undefined => {
    const data = record(readJson(options.profileFile(taskId)));
    return 'pruning' in data ? (data as unknown as TaskToolProfile) : undefined;
  };

  /** The transcripts of a task's Claude (the budget's files, not Codex rollouts). */
  const transcriptsOf = (task: TaskRecord): string[] =>
    Object.keys(task.budget?.tokensBy ?? {}).filter(
      (file) => file.startsWith('/') && !isCodexRollout(file)
    );

  const scanTask = async (task: TaskRecord, repo: string): Promise<void> => {
    const files = transcriptsOf(task);
    if (!files.length) return;
    const sizes: string[] = [];
    for (const file of files) {
      try {
        sizes.push(String((await fs.promises.stat(file)).size));
      } catch {
        sizes.push('-');
      }
    }
    const stamp = sizes.join(',');
    const known = options.store.get(repo, task.id);
    if (known?.stamp === stamp) return;
    const used = new Set<string>();
    const misses = new Set<string>();
    let startTokens: number | undefined;
    for (const file of files) {
      let text: string;
      try {
        const handle = await fs.promises.open(file, 'r');
        try {
          const { size } = await handle.stat();
          const buffer = Buffer.alloc(Math.min(size, MAX_TRANSCRIPT_BYTES));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      const found = scanClaudeTranscript(text.split('\n'));
      for (const key of found.used) used.add(key);
      for (const miss of found.misses) misses.add(miss);
      startTokens ??= found.startTokens;
    }
    const profile = readProfile(task.id);
    options.store.put(repo, {
      id: task.id,
      at: task.startedAt ?? task.createdAt,
      used: [...used].sort(),
      ...(misses.size ? { misses: [...misses] } : {}),
      ...(startTokens !== undefined ? { startTokens } : {}),
      ...(prunesAnything(profile?.pruning) ? { pruned: true } : {}),
      stamp,
    });
  };

  /** Reads the transcripts of the projects' Claude tasks that changed since the last scan. */
  const scan = (repo?: string): Promise<void> => {
    if (scanning) return scanning;
    scanning = (async () => {
      const tasks = options.tasks() ?? [];
      for (const task of tasks) {
        if (!isClaudeTask(task) || !task.repoPath) continue;
        if (repo && task.repoPath !== repo) continue;
        // Every task of an opted-in project (or the one asked about); elsewhere only open
        // tasks, for their start context in `ut task status`.
        const open = !TASK_FINAL_STATES.includes(task.state);
        if (!repo && !open && !options.settings(task.repoPath).toolPruning) continue;
        try {
          await scanTask(task, task.repoPath);
        } catch (error) {
          log(`[tool-pruning] ${task.id}: transcript not read: ${error}`);
        }
      }
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  const planFor = (repo: string): ToolPruning | null =>
    planToolPruning({
      inventory: inventoryOf(repo),
      sessions: options.store.sessions(repo),
      window: windowOf(repo),
      keep: options.settings(repo).toolKeep ?? [],
    });

  /**
   * The tool list of a task's session: the one fixed at its first start, else decided now and
   * fixed (written) for the rest of its life. Null: everything (not Claude, pruning off, not
   * enough sessions, or nothing to drop).
   */
  const profileFor = (task: TaskRecord): ToolPruning | null => {
    if (!isClaudeTask(task) || !task.repoPath) return null;
    const known = readProfile(task.id);
    if (known) return prunesAnything(known.pruning) ? known.pruning : null;
    let pruning: ToolPruning | null = null;
    // As the task recorded it (holdout, the quality guard: shared/saving-features.ts).
    if (taskSavingOn(task, 'tool-pruning', options.settings(task.repoPath))) {
      try {
        pruning = planFor(task.repoPath);
      } catch (error) {
        log(`[tool-pruning] ${task.id}: no plan, the task gets every tool: ${error}`);
      }
    }
    const profile: TaskToolProfile = {
      pruning: prunesAnything(pruning) ? pruning : null,
      at: new Date(now()).toISOString(),
    };
    try {
      const file = options.profileFile(task.id);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      // Not fixed: a resume could get another list (and pay its prompt cache again), so the
      // task gets everything instead.
      log(`[tool-pruning] ${task.id}: profile not written, the task gets every tool: ${error}`);
      return null;
    }
    return profile.pruning;
  };

  /** The task's fixed profile, if it has one. */
  const profileOf = (taskId: string): TaskToolProfile | undefined => readProfile(taskId);

  /** What `ut task status` shows: its start context and what its session went without. */
  const taskTools = (task: TaskRecord): TaskToolsInfo | undefined => {
    if (!isClaudeTask(task) || !task.repoPath) return undefined;
    const profile = readProfile(task.id);
    const session = options.store.get(task.repoPath, task.id);
    if (!profile && session?.startTokens === undefined) return undefined;
    const pruning = profile?.pruning;
    return {
      ...(session?.startTokens !== undefined ? { startTokens: session.startTokens } : {}),
      ...(profile
        ? {
            pruned: pruning
              ? {
                  plugins: pruning.plugins.length,
                  mcpServers: pruning.mcpServers.length,
                  skills: pruning.skills.length,
                  claudeAi: pruning.claudeAi,
                }
              : null,
          }
        : {}),
    };
  };

  const show = async (repo: string): Promise<ToolsShow> => {
    await scan(repo);
    const settings = options.settings(repo);
    const window = windowOf(repo);
    const inventory = inventoryOf(repo);
    const sessions = options.store.sessions(repo);
    const recent = windowSessions(sessions, window);
    const plan = planToolPruning({ inventory, sessions, window, keep: settings.toolKeep ?? [] });
    const average = (list: ToolSession[]) => {
      const values = list.map((s) => s.startTokens).filter((n): n is number => !!n);
      return values.length
        ? { avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length), n: values.length }
        : { n: 0 };
    };
    const tasks = recent.filter((s) => !s.id.startsWith('want:'));
    const pruned = average(tasks.filter((s) => s.pruned));
    const full = average(tasks.filter((s) => !s.pruned));
    return {
      repoPath: repo,
      enabled: !!settings.toolPruning,
      window,
      keep: settings.toolKeep ?? [],
      sessions: tasks.length,
      minSessions: Math.min(window, TOOL_PRUNING_MIN_SESSIONS),
      plan,
      inventory,
      used: [...new Set(recent.flatMap((s) => s.used))].sort(),
      misses: [...new Set(recent.flatMap((s) => s.misses ?? []))],
      startTokens: {
        ...(pruned.avg !== undefined ? { pruned: pruned.avg } : {}),
        prunedCount: pruned.n,
        ...(full.avg !== undefined ? { full: full.avg } : {}),
        fullCount: full.n,
      },
    };
  };

  /** Records an ask for these tools: the next tasks of the project get them. */
  const want = (repo: string, names: string[]): { keys: string[]; unknown: string[] } => {
    const inventory = inventoryOf(repo);
    const keys: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const found = wantedKeys(inventory, name);
      if (found) keys.push(...found);
      else unknown.push(name);
    }
    if (keys.length) {
      const at = new Date(now()).toISOString();
      options.store.put(repo, { id: `want:${at}:${keys.join(',')}`.slice(0, 300), at, used: keys });
    }
    return { keys, unknown };
  };

  /** Every tool the current plan drops comes back for the next tasks (one ask for all). */
  const restore = async (repo: string): Promise<string[]> => {
    await scan(repo);
    const plan = planFor(repo);
    if (!prunesAnything(plan)) return [];
    const names = [
      ...plan.plugins,
      ...plan.mcpServers,
      ...plan.skills,
      ...(plan.claudeAi ? [CLAUDE_AI_GROUP] : []),
    ];
    want(repo, names);
    return names;
  };

  return { scan, profileFor, profileOf, taskTools, show, want, restore, planFor };
}

export type ToolPruner = ReturnType<typeof createToolPruner>;
