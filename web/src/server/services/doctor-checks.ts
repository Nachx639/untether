/**
 * The checks Untether's doctor runs (untether-doctor.ts). Each looks for one class of trouble
 * seen for real, through narrow functions the server hands it, so each is testable alone.
 *
 * This file only lists them: a check lives in its area's file (doctor-checks-tasks.ts,
 * -agents.ts, -storage.ts, -sessions.ts, -machine.ts, -build.ts, -server.ts).
 */

export {
  agentEventsCheck,
  claudeStatusCheck,
  claudeVersionCheck,
  HOOKS_SILENT_AFTER_MS,
  type HookedSession,
  probeClaudeCompat,
  recentTranscriptTails,
} from './doctor-checks-agents.js';
export {
  cachedBinaryBuild,
  cliBuildCheck,
  forwarderBuildCheck,
  forwarderSourceHash,
  nativePtyCheck,
  newestForwarderSource,
  readForwarderSourceHash,
  rebuildNativeModules,
  rustToolchainFound,
} from './doctor-checks-build.js';
export {
  configValidCheck,
  configWritableCheck,
  githubRepoOf,
  PUBLIC_RULES_EVERY_MS,
  publishGuardCheck,
  resourcesCheck,
  securitySweepCheck,
} from './doctor-checks-machine.js';
export { loopFailuresCheck, serverCrashesCheck } from './doctor-checks-server.js';
export {
  closeShieldServer,
  envNamesFromPs,
  movedProjectsCheck,
  processEnvNames,
  replacedSessionsCheck,
  STALE_TEST_DIR_AGE_MS,
  STRAY_SHIELD_MIN_AGE_MS,
  scanShieldServers,
  sessionEnvCheck,
  stableTmuxCheck,
  staleTestDirsCheck,
  strayShieldTmuxCheck,
  unshieldedCheck,
} from './doctor-checks-sessions.js';
export {
  BACKUPD_BUSY_HOURS,
  backupdCpuCheck,
  backupExclusionCheck,
  bigCastsCheck,
  compactCastsWithForwarder,
  controlDirCheck,
  diskCheck,
  logErrorsCheck,
} from './doctor-checks-storage.js';
export {
  finishedTaskSessionsCheck,
  flakyUnderLoadCheck,
  orchestratorsCheck,
  stuckTasksCheck,
  taskGuardCheck,
  taskNodeCheck,
  taskOrphansCheck,
  typicalCheckMs,
  unansweredMessagesCheck,
} from './doctor-checks-tasks.js';
export { dirInUse, findTestDirs } from './stray-tmux.js';
