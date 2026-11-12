/**
 * Merges a restart cut short, checks failed under load or on a low disk.
 * The suite is in src/test/helpers/task-merge-suite.ts, split in parts that run side by side.
 */
import { taskMergeSuite } from '../../test/helpers/task-merge-suite.js';

taskMergeSuite('environment');
