/**
 * `ut task …` / `ut project …`: the families of commands, in the order `ut task help` shows
 * them. This file only registers them: a command, its options, its help and how its answer is
 * shown live in its family's file under task-cli/ (task-cli/run.ts reads the command line and
 * talks to the server). A new family is one file there and one line here.
 */

import { projectConnector } from './task-cli/project-connector.js';
import { projectLifecycle } from './task-cli/project-lifecycle.js';
import { projectLook } from './task-cli/project-look.js';
import { projectMessages } from './task-cli/project-messages.js';
import { projectOrchestrate } from './task-cli/project-orchestrate.js';
import { projectSettings } from './task-cli/project-settings.js';
import { projectTools } from './task-cli/project-tools.js';
import { createTaskCli } from './task-cli/run.js';
import { taskLook } from './task-cli/task-look.js';
import { taskNew } from './task-cli/task-new.js';
import { taskPipeline } from './task-cli/task-pipeline.js';
import { taskSession } from './task-cli/task-session.js';
import { taskTalk } from './task-cli/task-talk.js';
import { taskWait } from './task-cli/task-wait.js';

export const {
  help: TASK_CLI_HELP,
  options: COMMAND_OPTIONS,
  run: runTaskCli,
} = createTaskCli([
  taskNew,
  taskLook,
  taskTalk,
  taskWait,
  taskSession,
  taskPipeline,
  projectLook,
  projectMessages,
  projectConnector,
  projectSettings,
  projectOrchestrate,
  projectTools,
  projectLifecycle,
]);
