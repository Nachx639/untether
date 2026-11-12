/**
 * The merge pipeline's check: the command, its run in the worktree and what was written
 * meanwhile.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import type { TaskCheckLevel, TaskCheckLoad, TaskVerify } from '../../shared/tasks.js';
import { resolveNodeRuntime } from '../utils/node-runtime.js';
import {
  type CheckPass,
  checkIdentity,
  reusedLine,
  sharedCheckResults,
  worktreeTree,
} from './check-results.js';
import { ignoredInputs, ignoredInputsMessage, worktreeCreatedAt } from './task-ignored-inputs.js';
import { lastLines, type MergeLog, readLog } from './task-merge-log.js';
import type {
  CheckWrites,
  PipelineContext,
  PipelineOptions,
  PipelineTask,
} from './task-merge-types.js';
import {
  checkDiskGate,
  checkLimiter,
  checkLoadGate,
  type DetectedCheck,
  type DiskSample,
  diskFullOutput,
  failedTestNames,
  formatGB,
  type RunCheckResult,
  runCheck,
  shellWord,
  watchDisk,
  watchLoad,
} from './task-verify.js';
import { leftoverExcludes, unsavedChanges } from './task-worktree.js';

/** The checks as one command run from the worktree: `(cd web && pnpm run check) && …`. */
export function composeCheckCommand(worktreePath: string, checks: DetectedCheck[]): string {
  return checks
    .map((check) => {
      const rel = path.relative(worktreePath, check.cwd);
      return rel ? `(cd ${shellWord(rel)} && ${check.command})` : check.command;
    })
    .join(' && ');
}

/** HEAD and the hash of each modified tracked file (`exclude` aside). */
async function worktreeSnapshot(
  log: MergeLog,
  wt: string,
  exclude: string[]
): Promise<{ head: string | null; files: Map<string, string> } | null> {
  const head = await log.gitOut(wt, ['rev-parse', 'HEAD']);
  const unsaved = await unsavedChanges(wt, exclude);
  if (!unsaved) return null;
  const files = new Map<string, string>();
  if (unsaved.tracked.length) {
    const hashed = await log.git(wt, ['hash-object', '--', ...unsaved.tracked]);
    const hashes = hashed.code === 0 ? hashed.stdout.trim().split('\n') : [];
    for (const [i, file] of unsaved.tracked.entries()) {
      files.set(file, hashes[i] ?? 'unreadable');
    }
  }
  return { head, files };
}

function snapshotDiff(
  before: Awaited<ReturnType<typeof worktreeSnapshot>>,
  after: Awaited<ReturnType<typeof worktreeSnapshot>>,
  startedAt: number
): CheckWrites {
  if (!before || !after) return { headMoved: true, changed: [], startedAt };
  const changed = new Set<string>();
  for (const [file, hash] of after.files) if (before.files.get(file) !== hash) changed.add(file);
  for (const file of before.files.keys()) if (!after.files.has(file)) changed.add(file);
  return { headMoved: before.head !== after.head, changed: [...changed], startedAt };
}

/** Files changed during the check while the agent's session was at work: the agent's edits. */
export function agentEditing(wrote: CheckWrites, options: PipelineOptions): boolean {
  return wrote.changed.length > 0 && !!options.agentActiveSince?.(wrote.startedAt);
}

/**
 * Start the check on `head`: queued behind the limiter, a failed run goes once more (see
 * below). `current` is where it stands meanwhile (what a stopped check reports).
 */
export function startCheck(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  ctx: PipelineContext,
  command: string,
  head: string,
  /** Which check this is (two-level projects) and the log it writes (default verify.log). */
  kind: {
    level?: TaskCheckLevel;
    logName?: string;
    fullReason?: string;
    relatedFiles?: number;
  } = {}
): {
  done: Promise<TaskVerify>;
  current: () => TaskVerify;
  stop: () => TaskVerify;
  /** What changed in the worktree since it was decided (read now); undefined before it ran. */
  writes: () => Promise<CheckWrites | undefined>;
} {
  const controller = new AbortController();
  let checkStart: number | undefined;
  // Taken as the check is decided, on `head` with the leftovers committed: whatever changes
  // from here on (queued for a slot or running) changed under it; the check starts once it is
  // read. The second one is taken when the pipeline asks, right after the check's result.
  const signal = controller.signal;
  const settings = options.settings ?? DEFAULT_PROJECT_SETTINGS;
  const now = options.now ?? Date.now;
  const wt = task.worktreePath as string;
  const snapshotExclude = leftoverExcludes(settings.cloneDirs);
  const snapshotBefore = worktreeSnapshot(log, wt, snapshotExclude).catch(() => null);
  // What it would run on (check-results.ts): the tree of `head`, the very one a merge takes.
  const results =
    options.checkResults === null ? undefined : (options.checkResults ?? sharedCheckResults());
  const identity = results
    ? checkIdentity(wt, { commit: head }).catch(() => null)
    : Promise.resolve(null);
  // A check the user asked for by name (`ut task verify`) runs; its pass is kept like any other.
  const mayReuse = options.mode !== 'verify';
  const keptPass = async (): Promise<CheckPass | undefined> => {
    const id = await identity;
    return id && mayReuse ? results?.find(id, command, 'untether') : undefined;
  };
  /** The worktree's files are exactly `head`'s tree (nothing edited, nothing left over). */
  const untouched = async (): Promise<boolean> => {
    const id = await identity;
    return !!id && (await worktreeTree(wt, snapshotExclude).catch(() => null)) === id.tree;
  };
  let reused: CheckPass | undefined;
  let cleanBefore = false;
  const logPath = path.join(options.logDir, kind.logName ?? 'verify.log');
  const firstLogPath = logPath.replace(/\.log$/, '-first.log');
  const level = kind.level;
  // Still waiting in line for this commit before a restart: in line since then (the limiter's
  // order and its "start anyway" deadline), 2026-11-02. Only the same check: a batch's whole
  // check is not the task's own related one.
  const prior = task.verify;
  const priorSince =
    prior?.queued && prior.headSha === head && prior.exitCode === undefined && prior.level === level
      ? Date.parse(prior.startedAt)
      : Number.NaN;
  const queuedSince = Number.isFinite(priorSince) ? Math.min(priorSince, now()) : now();
  const current: TaskVerify = {
    command,
    cwd: wt,
    startedAt: new Date(queuedSince).toISOString(),
    logPath,
    queued: true,
    headSha: head,
    ...(level ? { level } : {}),
    ...(kind.fullReason ? { fullReason: kind.fullReason } : {}),
    ...(kind.relatedFiles !== undefined ? { relatedFiles: kind.relatedFiles } : {}),
  };
  options.onProgress?.({ state: 'verifying', verify: { ...current } });
  const limiter = options.limiter ?? checkLimiter;
  // Run with the Node the project asks for (2026-11-02: Homebrew node 26 as the default and
  // engines.node "<25": the check's `pnpm run build` refused to run in every worktree).
  const check = async (logFile: string) =>
    (options.runCheck ?? runCheck)({
      command,
      cwd: wt,
      timeoutSec: settings.verifyTimeoutSec,
      logPath: logFile,
      signal,
      node: await (options.nodeRuntime ?? resolveNodeRuntime)(wt),
    });
  // A failed check counts as the task's at once, unless the Mac was over its load threshold
  // (or short of memory) at some point while it ran (2026-11-02: load 35-177 on 12 cores with
  // several checks, agents and Time Machine; sessions-api e2e 500, shielded-tmux, css-watch,
  // ut-title-integration, logger-fresh failed, each passing alone, and each failure cost the
  // task an automatic fix attempt). Then it runs once more when the load is back under the
  // threshold (up to checkLoad.maxWaitSec, then anyway), shown as queued again: a pass keeps the
  // tests the first run failed as flaky under load (verify.flakyUnderLoad and the project's
  // list in `ut doctor`), never silent; a second failure is the task's as before. A timeout is
  // not rerun: it would only double the wait. (2026-10-23/24 reran every failure, or only
  // timeouts under load; a quiet Mac's failure is real and its rerun only cost minutes.)
  // Failed while the disk was low (sampled during the run) or with ENOSPC in its output
  // (2026-11-01: ~1 GB free, a bakery check failed in 7 tests by the environment and went
  // back to its agent): not the task's. It runs again once the disk recovers, once; if that
  // run fails with the disk low again, the pipeline stops as Untether's (retried by itself,
  // never an automatic fix), see diskLow.again.
  let ignoredNote: string[] | undefined;
  let flakyFirstRun: string | undefined;
  let firstRunLoad: number | undefined;
  let flakyUnderLoad: string[] | undefined;
  let lastLoad: TaskCheckLoad | undefined;
  const loadGate = options.loadGate ?? checkLoadGate;
  const diskGate = options.diskGate ?? checkDiskGate;
  const diskPaths = [task.repoPath, wt].filter((dir): dir is string => !!dir);
  const queuedAt = now();
  let runStart = queuedAt;
  const stopped = (): RunCheckResult => ({
    exitCode: null,
    tail: '',
    timedOut: false,
    cancelled: true,
  });
  const showDiskWait = (low: DiskSample | undefined) => {
    if (low) current.waitingDisk = { path: low.path, freeBytes: low.freeBytes };
    else delete current.waitingDisk;
    options.onProgress?.({ state: 'verifying', verify: { ...current } });
  };
  /**
   * One run, the disk and the load sampled all along; `low`: the emptiest moment while the
   * disk was low; `load`: the Mac's load during it.
   */
  const watchedCheck = async (logFile: string) => {
    const watch = watchDisk(diskGate, diskPaths);
    const loadWatch = watchLoad(loadGate, options.loadSampleMs);
    let stopped = false;
    const ranAt = now();
    try {
      const result = await check(logFile);
      const low = watch.stop();
      lastLoad = loadWatch.stop();
      stopped = true;
      if (!result.cancelled) {
        ctx.checks.runs += 1;
        ctx.checks.runMs += Math.max(0, now() - ranAt);
      }
      return { result, low, load: lastLoad };
    } finally {
      if (!stopped) {
        watch.stop();
        loadWatch.stop();
      }
    }
  };
  const failed = (result: RunCheckResult) =>
    result.exitCode !== 0 && !result.cancelled && !signal.aborted;
  // The check, and once more when it failed (see above).
  const runs = async (): Promise<RunCheckResult> => {
    const { result: first, low: firstLow, load: firstLoad } = await watchedCheck(logPath);
    const firstOutput = () => readLog(logPath) ?? first.tail;
    const enospc = failed(first) && !firstLow && diskFullOutput(firstOutput());
    if (failed(first) && (firstLow || enospc)) {
      current.diskLow = {
        ...(firstLow ? { path: firstLow.path, freeBytes: firstLow.freeBytes } : {}),
        ...(enospc ? { enospc: true } : {}),
      };
      try {
        fs.renameSync(logPath, firstLogPath);
      } catch {
        // No log to keep.
      }
      log.write(
        `# check failed while the disk was low (${
          firstLow
            ? `${formatGB(firstLow.freeBytes)} free on ${firstLow.path}`
            : 'the output says the disk was full'
        }): not the task's, it runs again once the disk recovers`
      );
      ctx.stamp('verify', runStart, 'failed (disk)', level);
      current.queued = true;
      const waitStart = now();
      const lowNow = diskGate.sample(diskPaths);
      if (lowNow?.low) showDiskWait(lowNow);
      else options.onProgress?.({ state: 'verifying', verify: { ...current } });
      await diskGate.waitForSpace(diskPaths, signal);
      if (signal.aborted) return stopped();
      const after = diskGate.sample(diskPaths);
      log.write(
        `# disk${after ? `: ${formatGB(after.freeBytes)} free on ${after.path}` : ''}: check runs again`
      );
      ctx.stamp('queue', waitStart, 'disk');
      current.queued = false;
      delete current.waitingDisk;
      current.startedAt = new Date(now()).toISOString();
      runStart = now();
      options.onProgress?.({ state: 'verifying', verify: { ...current } });
      const { result: second, low: secondLow } = await watchedCheck(logPath);
      if (failed(second) && secondLow) {
        // Only the sampled disk counts now: a test that merely prints ENOSPC must not
        // keep its own failure from its agent forever.
        current.diskLow = {
          path: secondLow.path,
          freeBytes: secondLow.freeBytes,
          again: true,
        };
        log.write(
          `# check failed again while the disk was low (${formatGB(secondLow.freeBytes)} free on ${secondLow.path})`
        );
      } else if (second.exitCode === 0 && !second.timedOut && !second.cancelled) {
        flakyFirstRun = lastLines(first.tail, 1)[0] ?? 'failed';
      }
      return second;
    }
    if (first.exitCode === 0 || first.timedOut || first.cancelled || signal.aborted) {
      return first;
    }
    if (!firstLoad.high) return first;
    // Failed under load: the tests it named, before the log is moved aside.
    const firstFailed = failedTestNames(firstOutput());
    firstRunLoad = firstLoad.peak;
    try {
      fs.renameSync(logPath, firstLogPath);
    } catch {
      // No log to keep.
    }
    log.write(
      `# check failed with the Mac under load (peak ${firstLoad.peak}, mean ${firstLoad.mean}, over ${firstLoad.threshold}${firstLoad.memory ? `; ${firstLoad.memory}` : ''}): run again when the load is back down`
    );
    ctx.stamp('verify', runStart, 'failed (load)', level);
    ctx.checks.loadFailed += 1;
    current.queued = true;
    options.onProgress?.({ state: 'verifying', verify: { ...current, firstRunLoad } });
    const waitStart = now();
    const dropped = await loadGate.waitForLow(signal);
    log.write(
      `# load ${Math.round(loadGate.sample().load * 10) / 10}${dropped ? '' : ` still high after ${Math.round(loadGate.maxWaitMs / 1000)} s`}: check runs again`
    );
    ctx.stamp('queue', waitStart, 'load');
    if (signal.aborted) return stopped();
    current.queued = false;
    current.startedAt = new Date(now()).toISOString();
    runStart = now();
    options.onProgress?.({ state: 'verifying', verify: { ...current, firstRunLoad } });
    const { result: second, low: secondLow } = await watchedCheck(logPath);
    if (failed(second) && secondLow) {
      // The disk filled while it ran again: the same as a first run on a low disk.
      current.diskLow = { path: secondLow.path, freeBytes: secondLow.freeBytes, again: true };
      log.write(
        `# check failed again while the disk was low (${formatGB(secondLow.freeBytes)} free on ${secondLow.path})`
      );
    } else if (second.exitCode === 0 && !second.timedOut && !second.cancelled) {
      flakyFirstRun = lastLines(first.tail, 1)[0] ?? 'failed';
      flakyUnderLoad = firstFailed;
      log.write(
        `# flaky under load (passed on the rerun): ${firstFailed.length ? firstFailed.join('; ') : 'no test named in the first run'}`
      );
    }
    return second;
  };
  const stoppedResult = stopped;
  /**
   * A pass is kept for the next time this tree is asked about: only when the files were the
   * commit's before and after the run (an agent editing meanwhile, a check that rewrites
   * files: its pass says nothing sure about the tree). A failure is never kept.
   */
  const keepPass = async (result: RunCheckResult): Promise<void> => {
    if (!results || result.exitCode !== 0 || result.timedOut || result.cancelled) return;
    try {
      const id = await identity;
      if (id && cleanBefore && (await untouched())) {
        results.record({
          ...id,
          command,
          runner: 'untether',
          ms: now() - runStart,
          taskId: task.id,
        });
      } else {
        log.write('# check: its pass is not kept (the worktree is not exactly the commit)');
      }
    } catch (error) {
      log.write(`# check: its pass could not be kept: ${error}`);
    }
  };
  // Looked at while it waits for its turn; read at its turn.
  const createdAt = worktreeCreatedAt(wt);
  const strayFiles =
    createdAt === null
      ? Promise.resolve(null)
      : ignoredInputs(wt, {
          cloneDirs: settings.cloneDirs,
          artifactPaths: settings.artifactPaths,
          since: createdAt,
        }).catch(() => null);
  const inLine = (): Promise<RunCheckResult> =>
    limiter.run(
      async () => {
        // Its turn: a run of the same check on the same tree may have passed while it waited
        // (the same tree in line twice runs once).
        reused = await keptPass();
        if (reused) return { exitCode: 0, tail: '', timedOut: false };
        if (signal.aborted) return stoppedResult();
        // 2026-11-11: a check read a fixture git ignored, passed in the worktree and the merge
        // left the file behind (base red, ENOENT). Files on disk that git ignores do not
        // travel: such a check says nothing about the merged tree, so it is not run. The
        // task's own failure, with the files named for its agent.
        const stray = await strayFiles;
        if (stray?.note.length) {
          ignoredNote = stray.note.slice(0, 50);
          log.write(
            `# check: ignored files that are not artifacts (not blocking): ${ignoredNote.join(', ')}`
          );
        }
        if (stray?.blocking.length) {
          const message = ignoredInputsMessage(stray.blocking);
          log.write(
            `# check: not run, ignored files that do not travel with the merge: ${stray.blocking.join(', ')}`
          );
          try {
            fs.writeFileSync(logPath, `${message}\n`);
          } catch {
            // The tail still carries it.
          }
          return { exitCode: 1, tail: message, timedOut: false };
        }
        checkStart = now();
        [, cleanBefore] = await Promise.all([snapshotBefore, results ? untouched() : false]);
        const result = await runs();
        // Kept before its slot goes to the next in line: the same tree waiting there finds it.
        await keepPass(result);
        return result;
      },
      () => {
        if (now() - queuedAt >= 1000) ctx.stamp('queue', queuedAt);
        runStart = now();
        current.queued = false;
        delete current.waitingDisk;
        current.startedAt = new Date(now()).toISOString();
        options.onProgress?.({ state: 'verifying', verify: { ...current } });
      },
      signal,
      // Fast lane: marked urgent, it takes the next free slot before the others waiting.
      () => options.mergePriority?.() === 'urgent',
      { paths: diskPaths, onWait: showDiskWait },
      queuedSince
    );
  // With nothing to look up it joins the line at once, as it always did (the review that starts
  // alongside shows it running, not queued).
  const asked: Promise<RunCheckResult> =
    results && mayReuse
      ? keptPass().then((pass): Promise<RunCheckResult> | RunCheckResult => {
          // Passed before on this very tree: it does not even join the line.
          reused = pass;
          if (reused) return { exitCode: 0, tail: '', timedOut: false };
          return signal.aborted ? stopped() : inLine();
        })
      : inLine();
  const done = asked
    .catch((error: unknown): RunCheckResult => {
      // Taken out of the line before it started: not needed any more.
      if (signal.aborted) return stopped();
      throw error;
    })
    .then((result): TaskVerify => {
      if (reused && !result.cancelled) {
        const at = now();
        const line = reusedLine(reused, at);
        if (!stoppedHere) {
          ctx.stamp('verify', at, 'reused', level).savedMs = reused.ms;
          ctx.checks.reused += 1;
          ctx.checks.savedMs += reused.ms;
        }
        log.write(`# ${line} (${command})`);
        const { waitingDisk: _waiting, ...shown } = current;
        return {
          ...shown,
          queued: false,
          startedAt: new Date(at).toISOString(),
          finishedAt: new Date(at).toISOString(),
          exitCode: 0,
          tail: line,
          reused: {
            at: new Date(reused.at).toISOString(),
            ms: reused.ms,
            tree: reused.tree,
            ...(reused.taskId && reused.taskId !== task.id ? { taskId: reused.taskId } : {}),
          },
        };
      }
      const outcome = result.cancelled
        ? 'cancelled'
        : result.timedOut
          ? 'timed out'
          : result.exitCode === 0
            ? flakyFirstRun
              ? 'passed (second run)'
              : 'passed'
            : 'failed';
      if (!stoppedHere) ctx.stamp('verify', runStart, outcome, level);
      const verify: TaskVerify = {
        ...current,
        queued: false,
        finishedAt: new Date(now()).toISOString(),
        exitCode: result.exitCode,
        tail: result.tail,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
        ...(flakyFirstRun ? { flakyFirstRun } : {}),
        ...(ignoredNote ? { ignoredNote } : {}),
        ...(firstRunLoad !== undefined ? { firstRunLoad } : {}),
        ...(flakyUnderLoad ? { flakyUnderLoad } : {}),
        ...(lastLoad ? { load: lastLoad } : {}),
      };
      delete verify.waitingDisk;
      log.write(
        `# check: ${command} → ${result.cancelled ? 'stopped' : result.exitCode}${result.timedOut ? ' (timed out)' : ''}${flakyFirstRun ? ` (passed on a second run; first: ${flakyFirstRun})` : ''}${firstRunLoad !== undefined ? ` (rerun after a run under a load of ${firstRunLoad})` : ''}`
      );
      return verify;
    });
  // Stopped by the pipeline (the review came back with problems first): its time is stamped
  // now, while the pipeline's timings are still being collected.
  let stoppedHere = false;
  const stop = (): TaskVerify => {
    if (!stoppedHere && !signal.aborted) {
      stoppedHere = true;
      if (current.queued) {
        if (now() - queuedAt >= 1000) ctx.stamp('queue', queuedAt, 'cancelled');
      } else {
        ctx.stamp('verify', runStart, 'cancelled', level);
      }
      log.write('# check: stopped, the review found problems first');
      controller.abort();
    }
    return {
      ...current,
      queued: false,
      finishedAt: new Date(now()).toISOString(),
      cancelled: true,
    };
  };
  const writes = async () =>
    checkStart === undefined
      ? undefined
      : snapshotDiff(
          await snapshotBefore,
          await worktreeSnapshot(log, wt, snapshotExclude),
          checkStart
        );
  return { done, current: () => ({ ...current }), stop, writes };
}
