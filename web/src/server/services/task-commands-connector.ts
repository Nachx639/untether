/**
 * Connector channels: tokens for external apps to reach a project's orchestrator.
 */

import * as path from 'path';
import { z } from 'zod';
import { ConnectorTokenError } from './connector/connector-tokens.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, issues, ok, ProjectSchema } from './task-commands-shared.js';
import type { ConnectorAdmin, Context, TaskOpFamily } from './task-commands-types.js';

const ConnectorAddSchema = ProjectSchema.extend({ name: z.string().trim().min(1).max(40) });

const ConnectorActivateSchema = z.object({ id: z.string().regex(/^[0-9a-f]{12}$/) });

const ConnectorListSchema = ProjectSchema.extend({ all: z.boolean().optional() });

const ConnectorRevokeSchema = ProjectSchema.extend({ ref: z.string().trim().min(1).max(60) });

/**
 * `ut project auto-approve on|off` / PUT /api/confirmations/auto-approve: the user's global
 * autoApprove setting (2026-10-24). Off at once for anyone (asking less of no one is never a
 * risk). On at once from the signed-in app; from anyone else it waits for the user's OK on
 * the phone, the last one it asks. Once on, what was still waiting is approved too.
 */
/**
 * `ut project connector add <name>` (2026-10-31): a token for an external app to reach this
 * project's orchestrator (connector-service.ts). The user's is active at once. An agent's or
 * a script's is handed out now, so whoever asked can set it up, but lets nobody in until the
 * user approves it on the phone (autoApprove applies); declined or expired, it is dropped.
 */
async function connectorAdd(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const connector = self.deps.connector;
  if (!connector) return fail('unavailable', 'The connector is not available on this server');
  const parsed = ConnectorAddSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const dir = parsed.data.repo ?? parsed.data.cwd;
  const repoPath = dir ? await self.resolveRepo(dir) : null;
  if (!repoPath) return fail('bad-request', 'Not inside a git repository (give --repo)');
  const user = ctx.caller.kind === 'ui' || ctx.confirmed;
  const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  let made: ReturnType<ConnectorAdmin['add']>;
  try {
    made = connector.add({
      repoPath,
      name: parsed.data.name,
      createdBy: user ? 'user' : (sessionId ?? 'script'),
      active: user,
    });
  } catch (error) {
    if (error instanceof ConnectorTokenError) return fail(error.code, error.message);
    throw error;
  }
  const url = await connector.url();
  const given = { token: made.token, channel: made.channel, url };
  if (user) return ok(given);
  const name = path.basename(repoPath);
  const result = await self.request(
    'connector-add',
    {
      where: name,
      repoPath,
      summary: `Let the app "${made.channel.name}" talk to the orchestrator of ${name}`,
      detail: [
        `Project: ${repoPath}`,
        "The app's agents may send it requests (never as you), read its replies and see its tasks read-only. They can't start, merge or discard tasks or see other projects.",
        `Revoke it any time with \`ut project connector revoke ${made.channel.id}\`.`,
      ],
    },
    ctx,
    { op: 'connector-activate', args: { id: made.channel.id } }
  );
  if (result.ok && result.status === 'pending-confirmation') {
    connector.setConfirmation(made.channel.id, result.confirmation.id);
    return { ...result, data: { ...given, channel: { ...made.channel, active: false } } };
  }
  if (result.ok)
    return ok({ ...result.data, ...given, channel: { ...made.channel, active: true } });
  // The OK could not even be asked: the token must not wait forever.
  connector.revoke(made.channel.id);
  return result;
}

/** Runs only as the user's OK of a `connector-add`. */
async function connectorActivate(
  self: TaskCommandsCore,
  args: Record<string, unknown>,
  ctx: Context
) {
  const connector = self.deps.connector;
  if (!connector) return fail('unavailable', 'The connector is not available on this server');
  if (!ctx.confirmed && ctx.caller.kind !== 'ui') {
    return fail('forbidden', "Only the user's OK activates a connector token");
  }
  const parsed = ConnectorActivateSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  try {
    const channel = connector.activate(parsed.data.id);
    return ok({ channel, url: await connector.url() });
  } catch (error) {
    if (error instanceof ConnectorTokenError) return fail(error.code, error.message);
    throw error;
  }
}

/** `ut project connector list`: the project's channels (every project's with --all). */
async function connectorList(self: TaskCommandsCore, args: Record<string, unknown>) {
  const connector = self.deps.connector;
  if (!connector) return fail('unavailable', 'The connector is not available on this server');
  const parsed = ConnectorListSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  let repoPath: string | undefined;
  if (!parsed.data.all) {
    const dir = parsed.data.repo ?? parsed.data.cwd;
    const repo = dir ? await self.resolveRepo(dir) : null;
    if (!repo) return fail('bad-request', 'Not inside a git repository (give --repo or --all)');
    repoPath = repo;
  }
  return ok({ channels: connector.list(repoPath), url: await connector.url() });
}

/**
 * `ut project connector revoke <id|name>`: anyone may (it only takes access away). By name
 * it is looked for in the caller's project.
 */
async function connectorRevoke(self: TaskCommandsCore, args: Record<string, unknown>) {
  const connector = self.deps.connector;
  if (!connector) return fail('unavailable', 'The connector is not available on this server');
  const parsed = ConnectorRevokeSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const byId = /^[0-9a-f]{12}$/.test(parsed.data.ref);
  const dir = parsed.data.repo ?? parsed.data.cwd;
  const repoPath = !byId && dir ? ((await self.resolveRepo(dir)) ?? undefined) : undefined;
  try {
    return ok({ channel: connector.revoke(parsed.data.ref, repoPath) });
  } catch (error) {
    if (error instanceof ConnectorTokenError) return fail(error.code, error.message);
    throw error;
  }
}

export const connectorOps: TaskOpFamily = {
  ops: {
    'connector-add': connectorAdd,
    'connector-activate': connectorActivate,
    'connector-list': (self, args) => connectorList(self, args),
    'connector-revoke': (self, args) => connectorRevoke(self, args),
  },
};
