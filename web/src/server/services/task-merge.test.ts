/**
 * The pipeline itself: merges, conflicts, checks, risk and results.
 * The suite is in src/test/helpers/task-merge-suite.ts, split in parts that run side by side.
 */
import { taskMergeSuite } from '../../test/helpers/task-merge-suite.js';

taskMergeSuite('pipeline');
