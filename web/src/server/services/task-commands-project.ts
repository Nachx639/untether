/**
 * A project's settings and tools, the user's autoApprove and the state of a confirmation.
 */

import * as path from 'path';
import { z } from 'zod';
import { autoMergePaused } from '../../shared/projects.js';
import { run as runCommand } from '../utils/exec-file.js';
import { resolveProjectIcon } from './project-icon.js';
import {
  ProjectSettingsError,
  type ProjectSettingsPatch,
  ProjectSettingsPatchSchema,
} from './project-settings.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, issues, ok, ProjectSchema } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import { detectProjectChecks } from './task-verify.js';

const ProjectStatsSchema = ProjectSchema.extend({
  last: z.number().int().min(1).max(500).optional(),
});

const ProjectToolsSchema = ProjectSchema.extend({
  action: z.enum(['show', 'want', 'restore', 'keep', 'unkeep']).default('show'),
  names: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
});

const ConfirmationSchema = z.object({ id: z.string().trim().min(1).max(100) });

const AutoApproveSchema = z.object({ on: z.boolean() });

const ProjectSetSchema = ProjectSchema.extend({
  settings: z.record(z.string(), z.unknown()),
});

function formatSetting(value: unknown): string {
  if (value === undefined) return '(default)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * What became of a confirmation: still waiting, approved (and what it did), declined,
 * expired or failed; `unknown` after a restart. Read only, by its full id (only who asked
 * has it), so whoever asked can wait for the answer.
 */
function confirmationStatus(self: TaskCommandsCore, args: Record<string, unknown>) {
  const parsed = ConfirmationSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const outcome = self.confirmations.outcome(parsed.data.id);
  if (!outcome) return ok({ id: parsed.data.id, status: 'unknown' });
  const { status, confirmation } = outcome;
  return ok({
    id: confirmation.id,
    status,
    confirmation,
    ...(outcome.status === 'approved' ? { result: outcome.result } : {}),
    ...(outcome.status === 'failed' ? { message: outcome.message } : {}),
  });
}

/**
 * `ut project stats` (2026-11-03): over the project's last finished tasks, each token-saving
 * feature's tasks against those without it (shared/saving-features.ts). Read-only.
 */
async function projectStats(self: TaskCommandsCore, args: Record<string, unknown>) {
  const parsed = ProjectStatsSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repo is required');
  const repoPath = await self.resolveRepo(dir);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  const scheduler = self.deps.scheduler();
  if (!scheduler) return fail('unavailable', 'The task scheduler is not running');
  return ok({ report: scheduler.savingsReport(repoPath, parsed.data.last) });
}

async function projectShow(self: TaskCommandsCore, args: Record<string, unknown>) {
  const parsed = ProjectSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repo is required');
  const repoPath = await self.resolveRepo(dir);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  const settings = self.deps.settings.get(repoPath);
  // What a task's check runs (2026-10-20: `ut project show` printed no check at all when
  // none was set, though one is detected per package): the setting, else the detected ones.
  const detected = settings.checkCommand
    ? []
    : await (
        self.deps.projectChecks ??
        ((repo: string) =>
          detectProjectChecks(repo, (gitArgs) => runCommand('git', gitArgs, repo, 15_000)))
      )(repoPath).catch(() => []);
  return ok({
    repoPath,
    settings,
    stored: self.deps.settings.getStored(repoPath),
    check: settings.checkCommand
      ? { source: 'setting', command: settings.checkCommand }
      : {
          source: detected.length ? 'detected' : 'none',
          checks: detected.map((check) => ({
            dir: path.relative(repoPath, check.cwd) || '.',
            command: check.command,
          })),
        },
    ...(autoMergePaused(settings) ? { autoMergePaused: true } : {}),
    ...(self.deps.securityStatus ? { security: self.deps.securityStatus(repoPath) } : {}),
    autoApprove: self.deps.autoApprove?.get() === true,
  });
}

async function setAutoApprove(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = AutoApproveSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const setting = self.deps.autoApprove;
  if (!setting) return fail('unavailable', 'autoApprove is not available on this server');
  const { on } = parsed.data;
  if (!on || setting.get()) {
    if (setting.get() !== on) setting.set(on);
    return ok({ autoApprove: on });
  }
  if (ctx.caller.kind !== 'ui' && !ctx.confirmed) {
    return self.request(
      'auto-approve',
      {
        where: 'Untether',
        summary: 'Turn on autoApprove: nothing waits for your OK any more',
        detail: [
          'Every action an agent asks your OK for runs at once (merges with risk accepted, discards, settings, orchestrators, messages to other projects); you get a notice of each.',
          'A task held only for your merge OK merges after the usual 10-minute countdown, which you can stop.',
          'Turn it off in Settings or with `ut project auto-approve off`.',
        ],
      },
      ctx,
      { op: 'auto-approve', args: { on: true } }
    );
  }
  setting.set(true);
  self.deps.log?.('autoApprove turned on');
  // Nothing waits any more: tasks held only for a merge OK count down, and what was waiting
  // goes now (in the background).
  self.deps.scheduler()?.approveHeldMerges();
  void self.confirmations
    .approveAllWaiting()
    .then((outcomes) => {
      for (const outcome of outcomes) self.tellRequester(outcome.confirmation, 'approved');
    })
    .catch((error) => self.deps.log?.(`waiting confirmations not approved: ${error}`));
  return ok({ autoApprove: true });
}

/**
 * `ut project tools [want|restore|keep|unkeep] [names]` (2026-11-03, tool-pruning.ts): what
 * the project's task sessions go without and why. Bringing tools back (want, restore) is
 * anyone's to ask, a task's agent too: it only adds tools to the next sessions. The keep list
 * is a setting (toolKeep): changed through project-set, with its OK.
 */
async function projectTools(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = ProjectToolsSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const tools = self.deps.tools;
  if (!tools) return fail('unavailable', 'Tool pruning is not available on this server');
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repo is required');
  const repoPath = await self.resolveRepo(dir);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  const { action, names } = parsed.data;
  if ((action === 'want' || action === 'keep' || action === 'unkeep') && !names.length) {
    return fail('bad-request', `ut project tools ${action} needs one or more names`);
  }
  if (action === 'keep' || action === 'unkeep') {
    const current = self.deps.settings.get(repoPath).toolKeep ?? [];
    const lower = new Set(names.map((name) => name.toLowerCase()));
    const toolKeep =
      action === 'keep'
        ? [...new Set([...current, ...names])]
        : current.filter((name) => !lower.has(name.toLowerCase()));
    return projectSet(
      self,
      { repo: repoPath, settings: { toolKeep: toolKeep.length ? toolKeep : null } },
      ctx
    );
  }
  if (action === 'want') {
    const wanted = tools.want(repoPath, names);
    if (!wanted.keys.length) {
      return fail(
        'bad-request',
        `Unknown tool(s): ${wanted.unknown.join(', ')} (see \`ut project tools\` for the names)`
      );
    }
    return ok({ repoPath, action, wanted: wanted.keys, unknown: wanted.unknown });
  }
  if (action === 'restore') {
    const restored = await tools.restore(repoPath);
    return ok({ repoPath, action, restored });
  }
  return ok({ ...(await tools.show(repoPath)), action });
}

async function projectSet(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = ProjectSetSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repoPath is required');
  const repoPath = await self.resolveRepo(dir);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  const patch = ProjectSettingsPatchSchema.safeParse(parsed.data.settings);
  if (!patch.success) return fail('bad-request', issues(patch.error));
  const role = ctx.confirmed ? 'user' : self.roleFor(ctx.caller, repoPath);
  if (typeof patch.data.icon === 'string') {
    const icon = resolveProjectIcon(repoPath, patch.data.icon);
    if ('error' in icon) return fail('bad-request', icon.error);
  }
  // Its own project's icon is the orchestrator's to pick, with no OK (only a picture).
  const iconOnly = Object.keys(patch.data).every((key) => key === 'icon');
  // Who orchestrates a project is the orchestrator's own business (P7), never a setting
  // a session may hand itself.
  if ('orchestratorSessionId' in patch.data && ctx.caller.kind !== 'ui') {
    return fail('forbidden', 'orchestratorSessionId cannot be set from here');
  }
  if (role !== 'user' && !(iconOnly && role === 'orchestrator')) {
    const current = self.deps.settings.getStored(repoPath) as Record<string, unknown>;
    const detail = Object.entries(patch.data).map(
      ([field, value]) =>
        `${field}: ${formatSetting(current[field])} → ${value === null ? '(default)' : formatSetting(value)}`
    );
    return self.request(
      'project-set',
      {
        where: path.basename(repoPath),
        repoPath,
        summary: `Change the task settings of ${path.basename(repoPath)}`,
        detail,
      },
      ctx,
      { op: 'project-set', args: { repo: repoPath, settings: patch.data } }
    );
  }
  const change = { ...(patch.data as ProjectSettingsPatch) };
  if (change.autoMergePausedUntil === null) {
    // The user turned a paused auto-merge back on: the circuit breaker counts from now on
    // (2026-10-20: the same old undos paused it again at once), and the pause's why goes.
    const current = self.deps.settings.getStored(repoPath);
    if (current.autoMergePausedUntil) {
      change.autoMergeResumedAt = new Date(self.deps.now?.() ?? Date.now()).toISOString();
      change.autoMergePausedReason = null;
      change.autoMergePausedCode = null;
      change.autoMergePausedCount = null;
    }
  }
  try {
    const settings = self.deps.settings.update(repoPath, change);
    return ok({ repoPath, settings, stored: self.deps.settings.getStored(repoPath) });
  } catch (error) {
    if (error instanceof ProjectSettingsError) return fail('bad-request', error.message);
    throw error;
  }
}

export const projectOps: TaskOpFamily = {
  ops: {
    'project-show': (self, args) => projectShow(self, args),
    'project-stats': (self, args) => projectStats(self, args),
    'project-set': projectSet,
    'project-tools': projectTools,
    confirmation: (self, args) => confirmationStatus(self, args),
    'auto-approve': setAutoApprove,
  },
};
