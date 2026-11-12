/**
 * Messages between the orchestrators of projects: project-tell, project-messages.
 */

import * as path from 'path';
import { z } from 'zod';
import {
  type AgentMessageParty,
  findUserDecision,
  partyLabel,
  replyReference,
  type UserDecisionQuote,
} from '../../shared/agent-messages.js';
import { orchestratorRelayMessage } from '../../shared/orchestrator-prompt.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { sameParty } from './agent-messages.js';
import { normalizeRepoPath } from './project-settings.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, issues, messageIdField, ok, ProjectSchema } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';

/** One request between orchestrators (a bug report with its evidence fits). */
export const PROJECT_TELL_MAX = 4000;

/** Requests one orchestrator may send per hour, all projects together (no ping-pong loops). */
export const PROJECT_TELL_PER_HOUR = 10;

const ProjectTellSchema = z.object({
  /** The other project: its folder name or path. */
  to: z.string().trim().min(1).max(1000),
  text: z.string().trim().min(1).max(PROJECT_TELL_MAX),
  /** The message this one answers (its id): that one is answered now. */
  replyTo: messageIdField.optional(),
  /** A notice: no answer is expected. */
  noReply: z.boolean().optional(),
  /**
   * A few words the user wrote to the sender: Untether attaches that turn of the user, word
   * for word, from the sender's conversation.
   */
  userDecision: z.string().trim().min(2).max(300).optional(),
});

const ProjectMessagesSchema = ProjectSchema.extend({
  /** Closed ones too (answered, or notices already read). */
  all: z.boolean().optional(),
});

/**
 * `ut project tell <project> "…"`: an orchestrator asks another project's orchestrator
 * (2026-10-20: Atlas's found an Untether bug and could only ask the user to pass it on).
 * The other one decides within its own project and rights; nobody gains any over another.
 */
async function projectTell(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = ProjectTellSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  const [fromRepo] = sessionId ? self.orchestratedRepos(sessionId) : [];
  if (!sessionId || !fromRepo) {
    return fail(
      'forbidden',
      "Only a project's orchestrator can tell another project's orchestrator"
    );
  }
  const wanted = parsed.data.to;
  const projects = [
    fromRepo,
    ...self.deps.settings
      .list()
      .map((entry) => entry.repoPath)
      .filter((repo) => normalizeRepoPath(repo) !== normalizeRepoPath(fromRepo)),
  ];
  const named = (repo: string) => path.basename(repo).toLowerCase() === wanted.toLowerCase();
  // A name it had before a rename finds it too (2026-10-25: "No project toolshed" once toolshed
  // was bakery).
  const formerly = (repo: string) => {
    const { formerPaths = [], movedFrom } = self.deps.settings.getStored(repo);
    return [...formerPaths, ...(movedFrom ? [movedFrom] : [])].some(named);
  };
  const toRepo = wanted.includes('/')
    ? await self.resolveRepo(resolveAbsolutePath(wanted))
    : (projects.find(named) ?? projects.find(formerly));
  if (!toRepo) {
    const names = projects
      .slice(1)
      .map((repo) => path.basename(repo))
      .join(', ');
    return fail('not-found', `No project "${wanted}" (known: ${names || 'none'})`);
  }
  if (normalizeRepoPath(toRepo) === normalizeRepoPath(fromRepo)) {
    return fail('bad-request', 'That is your own project: start a task instead');
  }
  const now = self.deps.now?.() ?? Date.now();
  const recent = (self.told.get(sessionId) ?? []).filter((at) => now - at < 60 * 60 * 1000);
  if (recent.length >= PROJECT_TELL_PER_HOUR) {
    return fail(
      'forbidden',
      `${PROJECT_TELL_PER_HOUR} requests to other projects in the last hour: tell the user instead`
    );
  }
  const noOrchestrator = () =>
    fail(
      'not-found',
      `${path.basename(toRepo)} has no orchestrator running: ask the user to start one with \`ut project orchestrate --repo ${toRepo} - <<'EOF' … EOF\` (the goal: what it needs), or tell the user`
    );
  const orchestrator = self.deps.orchestrator?.();
  // Asked before anything is recorded; relay() below still has the last word.
  if (!orchestrator) return noOrchestrator();
  if (orchestrator.sessionFor && orchestrator.sessionFor(toRepo) === undefined) {
    return noOrchestrator();
  }
  // 2026-11-10: a decision of the user's passed on by an agent was only that agent's word.
  // The user's own turn is read here, from the sender's conversation, never from its text.
  let userDecision: UserDecisionQuote | undefined;
  if (parsed.data.userDecision !== undefined) {
    const turns = (await self.deps.conversation?.(sessionId).catch(() => [])) ?? [];
    userDecision = findUserDecision(turns, parsed.data.userDecision, sessionId) ?? undefined;
    if (!userDecision) {
      return fail(
        'not-found',
        `No turn of the user in your conversation holds "${parsed.data.userDecision}": --user-decision takes a few words exactly as the user wrote them to you (not your summary, and not a note Untether typed in). Without it, send it as your own reading and the other orchestrator asks the user`
      );
    }
  }
  const from: AgentMessageParty = { kind: 'project', repoPath: fromRepo };
  const to: AgentMessageParty = { kind: 'project', repoPath: toRepo };
  const replyTo = parsed.data.replyTo ? self.messages.get(parsed.data.replyTo) : undefined;
  if (replyTo && sameParty(replyTo.to, from) && !sameParty(replyTo.from, to)) {
    return fail(
      'bad-request',
      `Message ${replyTo.id} came from ${partyLabel(replyTo.from)}: reply to it there`
    );
  }
  const recorded = self.messages.record({
    from,
    to,
    text: parsed.data.text,
    ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
    ...(parsed.data.noReply ? { expectsReply: false } : {}),
    ...(userDecision ? { userDecision } : {}),
  });
  if (!recorded.ok) return fail('not-found', recorded.message);
  const { message, repliedTo } = recorded;
  const relayed = orchestrator.relay(
    toRepo,
    orchestratorRelayMessage({
      id: message.id,
      fromRepo,
      text: parsed.data.text,
      ...(repliedTo ? { inReplyTo: replyReference(repliedTo, sameParty(repliedTo.from, to)) } : {}),
      expectsReply: message.expectsReply,
      ...(userDecision ? { userDecision } : {}),
    }),
    message.id
  );
  if (!relayed) {
    self.messages.discard(message.id);
    return noOrchestrator();
  }
  self.told.set(sessionId, [...recent, now]);
  return ok({
    to: path.basename(toRepo),
    repoPath: toRepo,
    id: message.id,
    expectsReply: message.expectsReply,
    ...(repliedTo ? { replyTo: repliedTo.id } : {}),
    ...(userDecision ? { userDecision } : {}),
  });
}

/**
 * `ut project messages [--all]`: the messages between agents and how far each got (queued,
 * delivered, read, answered). An orchestrator sees those to or from its own project; with
 * --repo, that project's; otherwise all. Open ones only, unless --all.
 */
async function projectMessages(
  self: TaskCommandsCore,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = ProjectMessagesSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  const own = sessionId ? self.orchestratedRepos(sessionId) : [];
  let repos: string[] | undefined = own.length ? own : undefined;
  if (parsed.data.repo) {
    const repoPath = await self.resolveRepo(parsed.data.repo);
    if (!repoPath) return fail('bad-request', 'Not inside a git repository');
    repos = [repoPath];
  }
  const open = parsed.data.all !== true;
  const messages = repos
    ? repos.flatMap((repoPath) => self.messages.list({ repoPath, open }))
    : self.messages.list({ open });
  const seen = new Set<string>();
  return ok({
    messages: messages.filter((message) => !seen.has(message.id) && seen.add(message.id)),
    now: self.deps.now?.() ?? Date.now(),
    ...(repos ? { repos } : {}),
  });
}

export const messagesOps: TaskOpFamily = {
  ops: { 'project-tell': projectTell, 'project-messages': projectMessages },
};
