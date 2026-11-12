/**
 * What holds a task's branch at ready (no check, policy, risk, the agent's result) and the
 * check's command. The suite is in src/test/helpers/task-merge-suite.ts, split in parts that run
 * side by side.
 */
import { taskMergeSuite } from '../../test/helpers/task-merge-suite.js';

taskMergeSuite('pipeline-rules');
