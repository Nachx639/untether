/** `ut project set` and `auto-approve`: a project's settings and the user's autoApprove. */

import { settingTakesNumber } from '../services/project-settings.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project set [--repo DIR] [--merge auto|ask] [--check "cmd"] [key=value ...]
                 (value "" or null clears; lists are comma-separated; securitySweep=true
                  turns on the project's security sweep; securityConnectors takes JSON, e.g.
                  '[{"provider":"tailscale","credential":{"from":"env","name":"VAR"}}]';
                  maxActiveTasks=N: at most N of its tasks run at once, the rest wait queued
                  and start by themselves in order; maxActiveTasks= removes the limit;
                  modelRouting=true: each task's prompt picks its agent's fast or capable
                  model; agentFallback=offer|auto|off: when an agent hits its usage limit,
                  another one (the other agent, or this Mac's taskFallbacks) is offered
                  (offer, the default), takes over the task in its worktree (auto), or not);
                  taskBudget=wall=3h,agent=2h,rounds=6,tokens=100M,warn=75: its tasks' budget
                  (any of them, 0 = no limit; those are the defaults), taskBudget= the defaults;
                  stallMinutes=N: a task's agent with no progress for N minutes while it waits
                  on one thing (Monitor, background work, a sleep) is nudged and its
                  orchestrator told (default 20, 0 = never); failureLoopNudge=false: a
                  task's agent failing the same way 3 times in a turn is no longer typed a note
                  to try another approach (default on; its orchestrator is told when the same
                  failure repeats 3 more times after the note); baseSync=false: a working
                  task is no longer brought up to date when another task merges files it
                  touches too (default on: the base is merged into its branch at a gap of its
                  agent when that is clean, its agent told the files when it conflicts);
                  zones=web/src/client/**=client,mac/**=mac: path patterns and the zone they
                  give a new task whose prompt names a path under them (** any folders, * within
                  a name, a plain folder covers what is in it); two tasks of a zone never work
                  at once, the later one waits for the earlier (ut task new takes a zone too);
                  digestMinutes=N: informational task notes reach its orchestrator together
                  every N minutes, those that need it at once (default 15, 0 = every note at
                  once); memoryDir=auto|/folder:
                  where a merged task's memory note is saved (auto = Claude Code's memory folder
                  of the project, when it exists; memoryDir= turns it off: the orchestrator
                  gets the note); savingHoldoutPct=N: the share of tasks run without the
                  token-saving features (summarizeOutput, failureLoopNudge) as a baseline
                  (default 10); savingAutoOff= turns on again what the quality guard turned off)
  ut project auto-approve on|off [--json]
                 (the user's setting for all projects: nothing waits for their OK on the phone;
                  'on' from an agent or a script asks their OK once, 'off' never asks)`;

export function formatSettings(data: Record<string, unknown>): string {
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  const stored = (data.stored ?? {}) as Record<string, unknown>;
  const lines = [`${data.repoPath}`];
  for (const [key, value] of Object.entries(settings)) {
    const shown = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`  ${key}: ${shown}${key in stored ? '' : ' (default)'}`);
  }
  const check = data.check as
    | { source: 'setting'; command: string }
    | { source: 'detected' | 'none'; checks: Array<{ dir: string; command: string }> }
    | undefined;
  if (check) {
    if (check.source === 'setting')
      lines.push(`  check that runs: ${check.command} (the project's setting)`);
    else if (check.source === 'none') {
      lines.push(
        '  check that runs: none detected (set one with `ut project set --check "<cmd>"`; until then a task merges on its own only with allowMergeWithoutCheck or docs-only changes)'
      );
    } else {
      lines.push('  check that runs: detected per package:');
      for (const entry of check.checks) lines.push(`    ${entry.dir}: ${entry.command}`);
    }
  }
  if ('aiReview' in settings) {
    lines.push(
      settings.aiReview
        ? '  AI review: on (nothing merges without it)'
        : '  AI review: off for this project (set aiReview=true to turn it on)'
    );
    if (settings.aiReview) {
      lines.push(
        settings.crossReview === false
          ? '  cross review: off (Claude reviews every task; set crossReview=true for the other model family)'
          : '  cross review: on (Codex reviews Claude tasks, Claude reviews Codex tasks; Claude if Codex cannot answer)'
      );
    }
  }
  const security = data.security as
    | {
        enabled: boolean;
        paused: boolean;
        running: boolean;
        lastRoundAt?: string;
        lastResult?: string;
        nextRoundAt?: string;
        exposure?: { checkedAt?: string; surface: string[]; findings: unknown[]; errors: string[] };
      }
    | undefined;
  if (security) {
    lines.push(
      !security.enabled
        ? '  security sweep: off (set securitySweep=true to turn it on)'
        : `  security sweep: ${security.paused ? 'paused' : security.running ? 'sweeping now' : 'on'}${security.lastRoundAt ? `, last ${security.lastRoundAt} (${security.lastResult ?? '?'})` : ''}${security.nextRoundAt ? `, next ${security.nextRoundAt}` : ''}`
    );
    const exposure = security.exposure;
    if (security.enabled && exposure?.checkedAt) {
      lines.push(
        `  exposure: ${exposure.surface.length ? exposure.surface.join('; ') : 'nothing reachable found'} (checked ${exposure.checkedAt}; ${exposure.findings.length} finding(s)${exposure.errors.length ? `, ${exposure.errors.length} not looked at` : ''})`
      );
    }
  }
  if (data.autoMergePaused) {
    lines.push(
      `  auto-merge: paused until ${String(settings.autoMergePausedUntil)} (${String(settings.autoMergePausedReason ?? '')})`
    );
  }
  if (data.autoApprove === true) {
    lines.push(
      "  autoApprove: on, all projects (nothing waits for the user's OK; `ut project auto-approve off`)"
    );
  }
  return lines.join('\n');
}

/** `key=value` of `ut project set`: "" / null clear, true/false, numbers, comma lists. */
export function parseSettingValue(key: string, raw: string): unknown {
  if (raw === '' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Guard patterns are regular expressions (commas in them): a JSON array, or one pattern.
  if (key === 'guardDeny' || key === 'guardAllow' || key === 'summarizeCommands') {
    if (raw.trim().startsWith('[')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return [raw];
  }
  if (
    key === 'cloneDirs' ||
    key === 'artifactPaths' ||
    key === 'riskIgnore' ||
    key === 'securitySections' ||
    key === 'guardOff' ||
    key === 'toolKeep' ||
    key === 'zones'
  ) {
    return raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (key === 'securityConnectors') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (/^\d+$/.test(raw) && settingTakesNumber(key, raw)) return Number(raw);
  return raw;
}

export const projectSettings: CommandFamily = {
  usage: USAGE,
  commands: {
    'project set': {
      options: { value: ['repo', 'merge', 'check'] },
      build: ({ flags, positional, json, repo, deps }) => {
        const settings: Record<string, unknown> = {};
        if (typeof flags.merge === 'string') settings.mergePolicy = flags.merge;
        if (typeof flags.check === 'string')
          settings.checkCommand = parseSettingValue('checkCommand', flags.check);
        for (const pair of positional) {
          const eq = pair.indexOf('=');
          if (eq <= 0) throw new UsageError(`expected key=value, got "${pair}"`);
          const key = pair.slice(0, eq);
          settings[key] = parseSettingValue(key, pair.slice(eq + 1));
        }
        if (!Object.keys(settings).length) throw new UsageError('nothing to set');
        return { op: 'project-set', args: { repo, cwd: deps.cwd, settings }, json };
      },
    },
    'project auto-approve': {
      options: {},
      build: ({ positional, json }) => {
        const [value] = positional;
        if (value !== 'on' && value !== 'off') {
          throw new UsageError('ut project auto-approve needs on or off');
        }
        return { op: 'auto-approve', args: { on: value === 'on' }, json };
      },
    },
  },
  print: {
    'project-set': ({ data, deps }) => {
      deps.out(formatSettings(data));
      return undefined;
    },
    'auto-approve': ({ data, deps }) => {
      deps.out(
        data.autoApprove
          ? "autoApprove is on: nothing waits for the user's OK on the phone"
          : "autoApprove is off: actions that need the user's OK wait for it on the phone"
      );
      return undefined;
    },
  },
};
