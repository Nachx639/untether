/**
 * The AI review in the pipeline once main moved under the task: merged into its branch, or
 * beside its check. The suite is in src/test/helpers/task-merge-suite.ts, split in parts that
 * run side by side.
 */
import { taskMergeSuite } from '../../test/helpers/task-merge-suite.js';

taskMergeSuite('review-base');
