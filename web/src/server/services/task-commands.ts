/**
 * Every task-engine command, one implementation for the HTTP routes (routes/tasks.ts,
 * routes/projects.ts) and `ut task …` / `ut project …` over the API socket.
 *
 * Who may do what depends on the caller's role for the task's project:
 *
 *   user          the app (a signed-in phone or browser): may do everything
 *   orchestrator  the project's orchestrator session (registered per repository, P7, and
 *                 running): creates, sends, verifies and fixes tasks of its project; merges on
 *                 its own only the tasks it created whose policy is auto; discards on its own
 *                 only tasks with no work that exists nowhere else. Merging anything else,
 *                 merging with risk accepted, throwing work away, keeping one of a group and
 *                 changing settings wait for the user's OK
 *   session       any other caller: a session that runs no task, `ut` in a terminal outside
 *                 Untether, a local HTTP request without a login. Reads, creates and verifies;
 *                 everything that changes a task or a project waits for the user's OK
 *   task          the session of an open task: `done` / `ask` on itself and reads, nothing else
 *
 * `route` / `submit` (P6) send a prompt typed on the home screen to the open task it belongs to,
 * or start a new task: task-router.ts decides, Claude Haiku settles the unsure cases
 * (task-router-llm.ts), and sending or starting keeps the caller's rights above.
 *
 * "Waits for the user's OK" = a pending confirmation (task-confirmations.ts): pushed to the
 * phone, run as the user when approved there. With the user's autoApprove setting on
 * (config.json, opt-in, 2026-10-24) it is approved at once instead: it runs as the user right
 * away, the caller gets its result, and a "Done without asking" push tells the user.
 * `auto-approve on` from anyone but the signed-in app is itself one such OK (the one that
 * removes the others); `auto-approve off` never waits.
 *
 * The caller's session id comes from UNTETHER_SESSION_ID, which a process can unset or change:
 * dropping it makes a caller "session", and the server keeps it only when that session is
 * running. 2026-10-20: `ut` with no session id on a TTY (interactive, as the client claimed)
 * was the user, so an agent with a pseudo-terminal (`script`, tmux) could approve its own
 * merges and discards; no flag a client sends gives user rights any more. A determined agent
 * can still edit files the user can (projects.json included): this guards against an agent
 * acting on its own through the engine, not against a hostile one.
 *
 * This file only lists the families of ops: an op, its schema and what it does live in its
 * family's file (task-commands-look.ts, -new.ts, -talk.ts, -session.ts, -pipeline.ts,
 * -project.ts, -messages.ts, -orchestrate.ts, -connector.ts); task-commands-core.ts holds who
 * the caller is, the user's OK and the dispatch.
 */

import { connectorOps } from './task-commands-connector.js';
import { TaskCommandsCore } from './task-commands-core.js';
import { lookOps } from './task-commands-look.js';
import { messagesOps } from './task-commands-messages.js';
import { newOps } from './task-commands-new.js';
import { orchestrateOps } from './task-commands-orchestrate.js';
import { pipelineOps } from './task-commands-pipeline.js';
import { projectOps } from './task-commands-project.js';
import { sessionOps } from './task-commands-session.js';
import { talkOps } from './task-commands-talk.js';
import type { TaskCommandsDeps } from './task-commands-types.js';

export { readLogTail } from './task-commands-look.js';
export { PROJECT_TELL_MAX, PROJECT_TELL_PER_HOUR } from './task-commands-messages.js';
export { type RoutedTaskSummary, titleFromPrompt, withoutBypass } from './task-commands-new.js';
export {
  callerFromAuth,
  httpStatus,
  quickStartArgv,
  type RouteOutcome,
  resolveProjectRepo,
} from './task-commands-shared.js';
export type {
  ConnectorAdmin,
  OrchestratorEvents,
  TaskCaller,
  TaskCommandErrorCode,
  TaskCommandResult,
  TaskCommandsDeps,
  TaskRole,
} from './task-commands-types.js';

export class TaskCommands extends TaskCommandsCore {
  constructor(deps: TaskCommandsDeps) {
    super(deps, [
      lookOps,
      newOps,
      talkOps,
      sessionOps,
      pipelineOps,
      projectOps,
      messagesOps,
      orchestrateOps,
      connectorOps,
    ]);
  }
}
