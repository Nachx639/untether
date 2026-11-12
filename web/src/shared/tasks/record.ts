/**
 * A task as it is kept (tasks.json) and sent to the phone: nothing but the fields of each area
 * put together. A new field goes in its area's file (tasks/queue.ts, tasks/merge.ts, ...), never
 * here.
 */

import type { TaskAgentsFields } from './agents.js';
import type { TaskAutofixFields } from './autofix.js';
import type { TaskBlockersFields } from './blockers.js';
import type { TaskChecksFields } from './checks.js';
import type { TaskCoreFields } from './core.js';
import type { TaskGuardFields } from './guard.js';
import type { TaskMergeFields } from './merge.js';
import type { TaskMetricsFields } from './metrics.js';
import type { TaskOverlapFields } from './overlap.js';
import type { TaskProgressFields } from './progress.js';
import type { TaskQueueFields } from './queue.js';
import type { TaskReportFields } from './report.js';
import type { TaskReviewFields } from './review.js';
import type { TaskSessionFields } from './session.js';

export interface TaskRecord
  extends TaskCoreFields,
    TaskBlockersFields,
    TaskAgentsFields,
    TaskSessionFields,
    TaskQueueFields,
    TaskReportFields,
    TaskChecksFields,
    TaskReviewFields,
    TaskAutofixFields,
    TaskMergeFields,
    TaskMetricsFields,
    TaskGuardFields,
    TaskProgressFields,
    TaskOverlapFields {}
