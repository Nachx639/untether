/** `ut project tools`: what a project's task sessions go without (tool-pruning.ts). */

import type { ToolsShow } from '../services/tool-pruning.js';
import { formatSettings } from './project-settings.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project tools [--repo DIR] [--json]       (what the project's task sessions go without:
                  plugins, MCP servers and skills none of its last toolPruningWindow task
                  sessions used, when toolPruning=true; never language servers or toolKeep)
  ut project tools want <name...>              (the next tasks get it back; a task's agent may
                                                run it when it misses a tool)
  ut project tools restore                     (everything pruned comes back for the next tasks)
  ut project tools keep|unkeep <name...>       (the keep list, toolKeep: never pruned)`;

/** `ut project tools`: what the project's task sessions go without, and why. */
export function formatTools(data: Record<string, unknown>): string {
  if (data.action === 'want') {
    const unknown = (data.unknown ?? []) as string[];
    return `The next tasks of ${String(data.repoPath)} get it back: ${((data.wanted ?? []) as string[]).join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`;
  }
  if (data.action === 'restore') {
    const restored = (data.restored ?? []) as string[];
    return restored.length
      ? `Everything pruned comes back for the next tasks (${restored.length}: ${restored.join(', ')}); unused for another window, it is pruned again (toolKeep keeps it for good)`
      : 'Nothing is pruned now';
  }
  if (data.action !== 'show') return formatSettings(data);
  const show = data as unknown as ToolsShow;
  const lines = [
    `${show.repoPath}`,
    `  toolPruning: ${show.enabled ? 'on' : 'off (ut project set toolPruning=true)'}, window ${show.window} task sessions, ${show.sessions} recorded`,
    `  keep: ${show.keep.length ? show.keep.join(', ') : '(none)'}  (ut project tools keep|unkeep <name>)`,
  ];
  const { startTokens: st } = show;
  if (st.fullCount || st.prunedCount) {
    lines.push(
      `  start context: ${st.full !== undefined ? `${(st.full / 1000).toFixed(1)}k tokens with every tool (${st.fullCount})` : 'no session with every tool'}; ${st.pruned !== undefined ? `${(st.pruned / 1000).toFixed(1)}k pruned (${st.prunedCount})` : 'none pruned yet'}`
    );
  }
  const plan = show.plan;
  if (!plan) {
    lines.push(
      `  pruned: nothing yet (${show.sessions} of the ${show.minSessions} task sessions needed first)`
    );
  } else {
    const hooks = new Set(show.inventory.plugins.filter((p) => p.hooks).map((p) => p.id));
    lines.push(
      `  pruned plugins: ${plan.plugins.length ? plan.plugins.map((id) => (hooks.has(id) ? `${id} (its hooks too)` : id)).join(', ') : '(none)'}`,
      `  pruned MCP servers: ${plan.mcpServers.length ? plan.mcpServers.join(', ') : '(none)'}${plan.claudeAi ? '; claude.ai connectors' : ''}`,
      `  skills by name only: ${plan.skills.length ? plan.skills.join(', ') : '(none)'}`
    );
    if (!show.enabled) lines.push('  (what would be pruned: toolPruning is off)');
  }
  const kept = show.inventory.plugins.filter((p) => p.lsp).map((p) => p.name);
  if (kept.length) lines.push(`  never pruned (language servers): ${kept.join(', ')}`);
  lines.push(
    `  used or wanted in the window: ${show.used.length ? show.used.join(', ') : '(nothing)'}`
  );
  if (show.misses.length) lines.push(`  searches that found nothing: ${show.misses.join(' | ')}`);
  lines.push(
    '  bring one back: ut project tools want <name>; all: ut project tools restore. A running task keeps its list (its prompt cache).'
  );
  return lines.join('\n');
}

export const projectTools: CommandFamily = {
  usage: USAGE,
  commands: {
    'project tools': {
      options: { value: ['repo'] },
      build: ({ positional, json, repo, deps }) => {
        const [action = 'show', ...names] = positional;
        if (!['show', 'want', 'restore', 'keep', 'unkeep'].includes(action)) {
          throw new UsageError('ut project tools takes show, want, restore, keep or unkeep');
        }
        return { op: 'project-tools', args: { repo, cwd: deps.cwd, action, names }, json };
      },
    },
  },
  print: {
    'project-tools': ({ data, deps }) => {
      deps.out(formatTools(data));
      return undefined;
    },
  },
};
