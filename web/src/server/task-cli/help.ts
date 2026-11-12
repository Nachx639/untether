/** `ut task help`: every family's usage in order, then how tasks work. */

import type { CommandFamily } from './types.js';

const NOTES = `A task runs an agent on its own branch and worktree; when it is done it is checked, reviewed by
an AI and merged into the base branch. A failed check, a conflict or a blocking review is
handed back to its agent automatically (twice) before anyone is asked. Every worktree task has a budget
(time being worked on, agent time, rounds, tokens): at 75 % its orchestrator or the user is told
where it went; at the limit its agent is stopped, its work kept, until \`ut task budget\` gives it
more or it is discarded. Time queued, waiting for a check slot or paused by a usage limit does
not count. A risky change (auth or
session code) in a project with --merge auto merges on its own after a 10-minute countdown only
when a second, risk-focused review confirms it weakens nothing; CI, signing, credentials, config
and reverts never do. Actions an agent may not take on its own (merging risky changes the second
review did not confirm, throwing work away, changing a project's settings, starting an
orchestrator, forgetting or creating a project) wait for the user's OK on the phone. Unless the user turned on autoApprove: then
none waits, each runs at once (the command answers with its result, --wait returns at once) and
the user gets a notice of what was done; a task held only for the user's merge OK (risky changes,
a security fix, no check, a review that could not run for hours) merges after the same 10-minute
countdown. A failed check, real review issues, a conflict, policy ask or a paused project still
wait. Turning autoApprove on from an agent asks the user once; off never asks.
<id> is a task id, its first characters, or its branch (ut/<name>).
--route sends the prompt to the open task of the repository it clearly belongs to (like the
home screen's box) instead of starting a new one; when unsure it does nothing and lists the
candidates (exit code 3): then use 'ut task send <id>' or 'ut task new' without --route.`;

export function helpOf(families: readonly CommandFamily[]): string {
  return `Usage:\n${families.map((family) => family.usage).join('\n')}\n\n${NOTES}`;
}
