/**
 * Queue and admission: the per-project task limit, the wait for memory and the order queued tasks
 * start in.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import {
  stoppedText,
  WAIT_OVER_STATES,
  WAIT_STOPPED_STATES,
  waitingText,
  zonesNamed,
} from '../../shared/task-serial.js';
import {
  TASK_QUEUE_NEEDS_YOU_HOLD_MS,
  type TaskQueued,
  type TaskRecord,
  type TaskWaitFor,
} from '../../shared/tasks.js';
import { normalizeRepoPath } from './project-settings.js';
import type { AdmissionVerdict } from './resource-monitor.js';
import { TaskSchedulerBreaker } from './task-scheduler-breaker.js';
import {
  clockSpan,
  fairest,
  fitsSlots,
  isFinal,
  SLOT_STATES,
  STARTABLE_STATES,
} from './task-scheduler-rules.js';
import type { TaskActionResult } from './task-scheduler-types.js';
import { resolveMainRepo } from './task-worktree.js';

export abstract class TaskSchedulerQueue extends TaskSchedulerBreaker {
  /**
   * Zoned tasks let through by waitsForSlot whose run() has not marked them started yet (it
   * goes on a turn of the event loop later): another task of the zone due at the same moment
   * already finds them ahead. Per task, the stateSince it was let through with: a task that
   * changed state since (it started, or failed again later) is no longer "starting".
   */
  private zoneStarting = new Map<string, string>();

  protected override forget(taskId: string): void {
    this.zoneStarting.delete(taskId);
    super.forget(taskId);
  }

  /**
   * `owner` stopped working on its branch (finished, or its pipeline ended): tasks that wait
   * to merge into that branch (dirty-base: it held the owner's work in progress) try again on
   * their own (2026-10-18: a fix task stayed blocked after the agent it waited for was done).
   * When the owner merged, its branch is gone: they merge into the owner's base instead.
   */
  protected releaseDependents(owner: TaskRecord): void {
    if (!owner.branch || this.piping.has(owner.id)) return;
    if (owner.state === 'working' || owner.state === 'verifying' || owner.state === 'merging') {
      return;
    }
    for (const task of this.tasks) {
      if (task.id === owner.id || task.baseBranch !== owner.branch) continue;
      const waiting = this.waitsForBase(task);
      if (!waiting && (task.state !== 'needs_you' || task.blocker?.kind !== 'dirty-base')) continue;
      if (this.piping.has(task.id)) continue;
      if (owner.state === 'merged' && owner.baseBranch) task.baseBranch = owner.baseBranch;
      this.deps.onError?.(`Task ${task.id}: ${owner.branch} is free again, merging it`);
      const { readyNote, mode, ...merge } = task.baseWait?.run ?? { mode: 'auto' as const };
      this.track(this.pipe(task, mode, merge, readyNote));
    }
  }

  // --- the project's line (maxActiveTasks, 2026-11-01) ------------------------------------

  /**
   * Whether a task due now waits in its project's line instead of starting: the project limits
   * its tasks (maxActiveTasks), and either others wait already (first in first out) or there is
   * no slot for it (its whole parallel group: they start together); or the Mac has no room for
   * one more task (deps.admission), or others of any project wait for room already (the line
   * picks fairly among projects). Then it (with its group) is queued and whoever it reports
   * to hears where it stands. True also when another call started or queued it meanwhile.
   * No await at all while no project sets a limit and nothing judges room.
   */
  protected async waitsForSlot(task: TaskRecord): Promise<boolean> {
    const admission = this.deps.admission;
    if (!admission && !this.anyProjectLimited() && !this.serial(task)) return false;
    const repo = await this.projectOf(task);
    await this.resolveSlotHolders();
    await this.resolveZoned();
    // Its group's first task (or a discard) dealt with it while git answered. A failed task
    // tried again waits in line like a new one.
    if (task.state !== 'scheduled' && task.state !== 'failed') return true;
    // Outside git it still waits for room, in a line of its own folder.
    const key = repo ?? normalizeRepoPath(task.repoPath ?? task.workingDir);
    const max = repo ? this.deps.settings?.get(repo).maxActiveTasks : undefined;
    const entry =
      task.groupId && task.state === 'scheduled'
        ? this.tasks.filter(
            (other) => other.groupId === task.groupId && other.state === 'scheduled'
          )
        : [task];
    // Counted with their project from the moment they start (not after git answers again).
    for (const mate of entry) this.taskProject.set(mate.id, key);
    const active = this.activeTasks(key);
    // Started after other tasks (--after, its zone): it waits for them in the line, whatever
    // room there is. No await from here on: two tasks of a zone due together never both pass.
    if (entry.some((mate) => this.waitsOn(mate, key).length)) {
      this.enqueue(entry, key, max, active, 'after');
      return true;
    }
    // Entries that wait for other tasks hold no one behind them back.
    const inLine = this.queueEntries(key).some((queued) => !this.entryWaits(queued));
    const projectRoom = max === undefined || (!inLine && fitsSlots(entry.length, active, max));
    if (!projectRoom) {
      this.enqueue(entry, key, max, active, 'project');
      return true;
    }
    const room = admission?.check(this.longestRoomWait());
    if (!room || (room.ok && !this.roomCandidates().length)) {
      if (room) admission?.started();
      for (const mate of entry) {
        if (mate.zones?.length) this.zoneStarting.set(mate.id, mate.stateSince);
      }
      this.startGroupMates(task, entry);
      return false;
    }
    // No room, or others wait for it already: behind them; the line decides who goes first.
    this.enqueue(entry, key, max, active, room.ok ? 'behind' : room);
    this.requestPump();
    return true;
  }

  /** The other tasks of a parallel group start with the one that found room for them all. */
  protected startGroupMates(task: TaskRecord, entry: TaskRecord[]): void {
    for (const mate of entry) {
      if (mate !== task) this.track(this.run(mate, { admitted: true }));
    }
  }

  /** A project sets maxActiveTasks (none: tasks start as they always did, nothing awaited). */
  protected anyProjectLimited(): boolean {
    const settings = this.deps.settings;
    if (!settings?.list) return false;
    try {
      return settings.list().some(({ settings }) => !!settings.maxActiveTasks);
    } catch {
      return false;
    }
  }

  /** The project (main checkout, normalized) a task belongs to; undefined outside git. */
  protected async projectOf(task: TaskRecord): Promise<string | undefined> {
    const known = this.taskProject.get(task.id) ?? task.queued?.repoPath;
    if (known) return known;
    const resolve = this.deps.mainRepo ?? resolveMainRepo;
    const repo = await resolve(task.repoPath ?? task.workingDir).catch(() => null);
    if (!repo) return undefined;
    const key = normalizeRepoPath(repo);
    this.taskProject.set(task.id, key);
    return key;
  }

  /** Every task that may hold a slot knows its project before they are counted. */
  protected async resolveSlotHolders(): Promise<void> {
    const unknown = this.tasks.filter(
      (task) => SLOT_STATES.includes(task.state) && !this.taskProject.has(task.id)
    );
    await Promise.all(unknown.map((task) => this.projectOf(task)));
  }

  /**
   * A task holds one of its project's slots: its agent or the engine is at it (preparing,
   * working, checking, merging), or it waits for an answer with its session running, for
   * TASK_QUEUE_NEEDS_YOU_HOLD_MS (the agent goes on once answered; a forgotten question must
   * not hold the line for good). Ready ones do not: the agent's turn is over, what is left
   * is the user's decision, and a forgotten ready task would block the project for days.
   * Paused ones neither: their agent waits for its limit, maybe for hours.
   */
  protected holdsSlot(task: TaskRecord): boolean {
    // Paused, its limit over, waiting for a slot to go on (resumeWhenRoom): its place is kept.
    if (task.state === 'paused') return !!task.halt?.slotWait;
    if (task.state === 'needs_you') {
      return (
        !!task.sessionId &&
        this.deps.sessionStatus(task.sessionId) === 'running' &&
        this.now() - Date.parse(task.stateSince) < TASK_QUEUE_NEEDS_YOU_HOLD_MS
      );
    }
    return SLOT_STATES.includes(task.state);
  }

  /**
   * Whether its project has a slot for a task that is to go (back) to work outside the line: a
   * paused one sent on, a failed one tried again, one held for its agent started now. The
   * others that hold a slot are counted, itself not; among paused tasks that wait for a slot,
   * only those that waited longer are in front of it. Always room when its project sets no limit.
   * 2026-11-10: bakery (maxActiveTasks 3) had 5 at work.
   */
  protected async projectRoom(
    task: TaskRecord
  ): Promise<{ ok: true } | { ok: false; active: number; max: number }> {
    if (!this.anyProjectLimited()) return { ok: true };
    const repo = await this.projectOf(task);
    const max = repo ? this.deps.settings?.get(repo).maxActiveTasks : undefined;
    if (!repo || !max) return { ok: true };
    await this.resolveSlotHolders();
    const mine = task.state === 'paused' ? task.halt?.slotWait : undefined;
    const active = this.tasks.filter((other) => {
      if (other.id === task.id || this.taskProject.get(other.id) !== repo) return false;
      if (!this.holdsSlot(other)) return false;
      if (other.state !== 'paused' || !mine) return true;
      const theirs = other.halt?.slotWait ?? '';
      return theirs < mine || (theirs === mine && other.id < task.id);
    }).length;
    return active < max ? { ok: true } : { ok: false, active, max };
  }

  /** What `ut task retry` answers when its project has no slot for the task. */
  protected limitRefusal(
    task: TaskRecord,
    room: { active: number; max: number },
    then: string
  ): TaskActionResult {
    const ref = task.id.slice(0, 8);
    return {
      ok: false,
      code: 'limit',
      message: `Its project already runs ${room.active} of ${room.max} tasks (maxActiveTasks): ${then} \`ut task retry ${ref} --force\` does it now, past the limit`,
    };
  }

  /** How many of the project's tasks hold a slot now. */
  protected activeTasks(repo: string): number {
    return this.tasks.filter(
      (task) => this.taskProject.get(task.id) === repo && this.holdsSlot(task)
    ).length;
  }

  /** The project's line, first first: one entry per task, a parallel group as one. */
  protected queueEntries(repo: string): TaskRecord[][] {
    const queued = this.tasks
      .filter((task) => task.state === 'queued' && task.queued?.repoPath === repo)
      .sort(
        (a, b) =>
          // «Urgente» on a waiting task: first of its project's line.
          Number(!!b.urgent) - Number(!!a.urgent) ||
          (a.queued?.order ?? 0) - (b.queued?.order ?? 0) ||
          a.createdAt.localeCompare(b.createdAt) ||
          (a.groupIndex ?? 0) - (b.groupIndex ?? 0)
      );
    const entries: TaskRecord[][] = [];
    for (const task of queued) {
      const last = entries[entries.length - 1];
      if (last && task.groupId && last[0].groupId === task.groupId) last.push(task);
      else entries.push([task]);
    }
    return entries;
  }

  /** Where a queued task stands: its place (1 = next), the line's length, slots held now. */
  protected queuePlace(task: TaskRecord): { position: number; of: number; active: number } {
    const repo = task.queued?.repoPath ?? '';
    const entries = this.queueEntries(repo);
    const at = entries.findIndex((entry) => entry.some((other) => other.id === task.id));
    return { position: at + 1, of: entries.length, active: this.activeTasks(repo) };
  }

  /**
   * Into the line, last, as one entry; whoever they report to hears where they stand, unless
   * it only waits for the last task let in to settle (a few seconds: no push for that).
   */
  protected enqueue(
    entry: TaskRecord[],
    repo: string,
    max: number | undefined,
    active: number,
    /**
     * 'project': its project's limit; 'after': the tasks it starts after; else the Mac's room
     * (or others waiting for it).
     */
    why: 'project' | 'after' | 'behind' | AdmissionVerdict = 'project'
  ): void {
    const room = typeof why === 'object' ? why : undefined;
    const order =
      Math.max(0, ...this.queueEntries(repo).map((queued) => queued[0].queued?.order ?? 0)) + 1;
    const since = new Date(this.now()).toISOString();
    for (const task of entry) {
      this.taskProject.set(task.id, repo);
      this.setState(task, 'queued');
      task.queued = {
        repoPath: repo,
        since,
        order,
        ...(max !== undefined ? { limit: max } : {}),
        ...(room ? { resources: this.resourcesNote(room) } : {}),
      };
    }
    this.save();
    if (why === 'after') {
      // Whoever it reports to hears what it waits for (and of one that already stopped).
      this.settleWaits();
      this.requestPump();
      return;
    }
    // Waiting for room without anything short (settling, others first): seconds, no word yet.
    if (why === 'project' || room?.short.length) this.tellQueued(entry, active);
  }

  // --- started after other tasks (--after, zones; 2026-11-11, shared/task-serial.ts) ----------

  /** Started after other tasks: named with --after, or in a zone. */
  protected serial(task: TaskRecord): boolean {
    return !!task.after?.length || !!task.zones?.length;
  }

  /** A task's project as far as it is known without asking git. */
  protected knownProject(task: TaskRecord): string | undefined {
    return this.taskProject.get(task.id) ?? task.queued?.repoPath;
  }

  /** Every open task with a zone knows its project before zones are compared. */
  protected async resolveZoned(): Promise<void> {
    const unknown = this.tasks.filter(
      (task) => !!task.zones?.length && !isFinal(task) && !this.knownProject(task)
    );
    await Promise.all(unknown.map((task) => this.projectOf(task)));
  }

  /**
   * The zones a new task falls in by its project's rules (ProjectSettings.zones) and the paths
   * its prompt names. Git is asked only when some project has rules.
   */
  protected async projectZones(dir: string, prompt: string): Promise<string[]> {
    const settings = this.deps.settings;
    if (!settings?.list) return [];
    let any = false;
    try {
      any = settings.list().some(({ settings }) => !!settings.zones?.length);
    } catch {
      return [];
    }
    if (!any) return [];
    const resolve = this.deps.mainRepo ?? resolveMainRepo;
    const repo = await resolve(dir).catch(() => null);
    if (!repo) return [];
    return zonesNamed(prompt, this.deps.settings?.get(normalizeRepoPath(repo)).zones);
  }

  /**
   * Whether `other`, of the same zone, goes before `task`: it started (preparing up to ready,
   * whatever it waits on now), or it is due too (queued, or failed and to be tried again) and
   * older. One not due yet (scheduled) is not in the way. Older-first is one order for every
   * task, so two tasks never wait for each other.
   */
  private aheadInZone(other: TaskRecord, task: TaskRecord): boolean {
    if (!STARTABLE_STATES.includes(other.state)) {
      this.zoneStarting.delete(other.id);
      return true;
    }
    if (this.zoneStarting.get(other.id) === other.stateSince) return true;
    this.zoneStarting.delete(other.id);
    if (other.state === 'scheduled') return false;
    return (
      other.createdAt < task.createdAt || (other.createdAt === task.createdAt && other.id < task.id)
    );
  }

  /**
   * The tasks a task due to start still waits for: those named with --after that are not
   * merged or done (one discarded, failed or never run is marked stopped; one dropped from the
   * list while it was waited for counts as discarded), and the tasks of its project that share
   * a zone with it and go before it. `repo`: its project, when known.
   */
  protected waitsOn(task: TaskRecord, repo: string | undefined): TaskWaitFor[] {
    if (!this.serial(task)) return [];
    const waits: TaskWaitFor[] = [];
    const add = (other: TaskRecord, why: 'after' | 'zone', zone?: string) =>
      waits.push({
        taskId: other.id,
        name: other.name,
        why,
        ...(zone ? { zone } : {}),
        state: other.state,
        ...(WAIT_STOPPED_STATES.includes(other.state) ? { stopped: true } : {}),
      });
    for (const id of task.after ?? []) {
      const other = this.tasks.find((entry) => entry.id === id);
      if (other) {
        if (!WAIT_OVER_STATES.includes(other.state)) add(other, 'after');
        continue;
      }
      const known = task.queued?.waitsFor?.find((wait) => wait.taskId === id);
      if (known) waits.push({ ...known, state: 'discarded', stopped: true });
    }
    if (!task.zones?.length || !repo) return waits;
    for (const other of this.tasks) {
      if (other === task || isFinal(other) || !other.zones?.length) continue;
      if (task.groupId && other.groupId === task.groupId) continue;
      if (waits.some((wait) => wait.taskId === other.id)) continue;
      const zone = task.zones.find((name) => other.zones?.includes(name));
      if (!zone || this.knownProject(other) !== repo) continue;
      if (this.aheadInZone(other, task)) add(other, 'zone', zone);
    }
    return waits;
  }

  /** A queued entry (a task, a whole group) that still waits for other tasks. */
  protected entryWaits(entry: TaskRecord[]): boolean {
    return entry.some((task) => this.waitsOn(task, task.queued?.repoPath).length > 0);
  }

  /**
   * What every queued task waits for, as it is now (TaskQueued.waitsFor). Whoever a task
   * reports to hears once that it waits and for what, and once of each waited-for task that
   * was discarded, failed or never ran: then it does not start by itself. No git, no await.
   */
  protected settleWaits(): void {
    let changed = false;
    for (const task of this.tasks) {
      const place = task.state === 'queued' ? task.queued : undefined;
      if (!place || !this.serial(task)) continue;
      const waits = this.waitsOn(task, place.repoPath);
      if (JSON.stringify(waits) !== JSON.stringify(place.waitsFor ?? [])) {
        if (waits.length) place.waitsFor = waits;
        else delete place.waitsFor;
        changed = true;
      }
      if (!waits.length) continue;
      place.waited = true;
      const stopped = waits.filter((wait) => wait.stopped).map((wait) => wait.taskId);
      const news = stopped.filter((id) => !place.stoppedTold?.includes(id));
      if (place.told && !news.length) continue;
      place.told = true;
      if (stopped.length) place.stoppedTold = stopped;
      changed = true;
      const detail = news.length ? stoppedText(task, waits) : waitingText(waits);
      this.deps.onError?.(`Task ${task.id}: ${detail}`);
      this.save();
      this.notifyQueue(task, 'task-queued', detail);
    }
    if (changed) this.save();
  }

  /** The queued push and log line for an entry; marks it told (its start is told too). */
  protected tellQueued(entry: TaskRecord[], active?: number): void {
    const first = entry[0];
    const place = first.queued;
    if (!place) return;
    for (const task of entry) if (task.queued) task.queued.told = true;
    const { position, of } = this.queuePlace(first);
    const running = active ?? this.activeTasks(place.repoPath);
    const max = place.limit;
    const room = place.resources;
    const id = first.id.slice(0, 8);
    // Short: a push and its orchestrator's event keep 200 characters (what to do is in the
    // orchestrator's next step and in `ut task status`).
    const detail = room?.paced
      ? `Queued ${position} of ${of}: tasks are let in one at a time (${room.detail}).`
      : room?.short.length
        ? `Queued ${position} of ${of}: the Mac is short of ${room.short.join(' and ')} (${room.detail}). It starts by itself when there is room.`
        : [
            // 2026-11-02: with free slots it waits behind tasks the Mac lets in one at a time
            // (settling); "N of max run" alone read as a limit reached that was not.
            max !== undefined && running < max
              ? `Queued ${position} of ${of}: ${running} of ${max} tasks of the project run; it waits behind those queued before it, let in one at a time.`
              : `Queued ${position} of ${of}: ${running} of ${max} tasks of the project run.`,
            max !== undefined && entry.length > max
              ? `Its group of ${entry.length} is larger than the limit: it starts when no other task of the project runs.`
              : entry.length > 1
                ? `Its group of ${entry.length} starts together, when there is room for all.`
                : 'It starts by itself when one ends.',
          ].join(' ');
    this.deps.onError?.(
      room?.short.length
        ? `Task ${first.id}: queued ${position}/${of}, ${room.paced ? 'let in one at a time' : `waiting for ${room.short.join(', ')}`} (${room.detail}); \`ut task retry ${id} --force\` starts it now`
        : `Task ${first.id}: queued ${position}/${of} (${running}/${max} running); \`ut task retry ${id} --force\` starts it now`
    );
    this.save();
    this.notifyQueue(first, 'task-queued', detail);
  }

  /** `before`: its note so far; the wait for room goes on from when it began. */
  protected resourcesNote(
    room: AdmissionVerdict,
    before?: TaskQueued['resources']
  ): NonNullable<TaskQueued['resources']> {
    const at = new Date(this.now()).toISOString();
    return {
      short: room.short,
      ...(room.settling ? { settling: true } : {}),
      ...(room.steadySwap || room.warmingUp ? { paced: true } : {}),
      detail: room.detail,
      at,
      since: before?.since ?? at,
    };
  }

  /** How long the entry waiting longest for the Mac's room has waited (ms; 0: none waits). */
  protected longestRoomWait(): number {
    let longest = 0;
    for (const entry of this.roomCandidates()) {
      const from = Date.parse(entry[0].queued?.resources?.since ?? '');
      if (Number.isFinite(from)) longest = Math.max(longest, this.now() - from);
    }
    return longest;
  }

  /** Look at the lines soon (once per turn of the event loop), when any task waits in one. */
  protected requestPump(): void {
    if (this.pumpArmed || !this.tasks.some((task) => task.state === 'queued')) return;
    this.pumpArmed = true;
    this.track(
      Promise.resolve().then(() => {
        this.pumpArmed = false;
        return this.pumpQueue();
      })
    );
  }

  /** Start, first first, every queued entry its project has room for. One run at a time. */
  protected async pumpQueue(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpOnce();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  protected async pumpOnce(): Promise<void> {
    if (!this.tasks.some((task) => task.state === 'queued' && task.queued)) return;
    await this.resolveSlotHolders();
    await this.resolveZoned();
    this.settleWaits();
    const admission = this.deps.admission;
    for (;;) {
      const candidates = this.roomCandidates();
      if (!candidates.length) break;
      const room = admission?.check(this.longestRoomWait());
      if (room && !room.ok) {
        this.markWaitingForRoom(room);
        break;
      }
      if (room) admission?.started();
      this.startEntry(
        fairest(candidates, (repo) => this.activeTasks(repo), this.now()),
        'slot'
      );
    }
    // Waiting only for their project now: what the Mac was short of is not theirs any more.
    const waiting = new Set(this.roomCandidates().flat());
    for (const task of this.tasks) {
      if (task.state === 'queued' && task.queued?.resources && !waiting.has(task)) {
        delete task.queued.resources;
      }
    }
  }

  /**
   * Every queued entry its project has room for (its maxActiveTasks, counted in line order;
   * none set: all of them): these wait for the Mac's room only. A project's first such entry
   * is the one that may start. An entry that waits for other tasks (--after, its zone) is
   * passed over: it keeps its place and holds back no one behind it.
   */
  protected roomCandidates(): TaskRecord[][] {
    const repos = new Set(
      this.tasks
        .filter((task) => task.state === 'queued' && task.queued)
        .map((task) => task.queued?.repoPath as string)
    );
    const out: TaskRecord[][] = [];
    for (const repo of repos) {
      // Unset (or lowered) since: nothing more to wait for, or the new limit.
      const max = this.deps.settings?.get(repo).maxActiveTasks;
      let active = this.activeTasks(repo);
      for (const entry of this.queueEntries(repo)) {
        if (this.entryWaits(entry)) continue;
        if (max !== undefined && !fitsSlots(entry.length, active, max)) break;
        out.push(entry);
        active += entry.length;
      }
    }
    return out;
  }

  /** What the Mac is short of, on each task waiting for it; the user hears once per task. */
  protected markWaitingForRoom(room: AdmissionVerdict): void {
    let changed = false;
    for (const entry of this.roomCandidates()) {
      for (const task of entry) {
        if (!task.queued) continue;
        const before = task.queued.resources;
        const note = this.resourcesNote(room, before);
        if (before?.short.join() !== note.short.join() || !!before?.settling !== !!note.settling) {
          changed = true;
        }
        task.queued.resources = note;
      }
      // Queued quietly (settling, or behind others) and now really short: it is told.
      if (room.short.length && !entry[0].queued?.told) this.tellQueued(entry);
    }
    if (changed) this.save();
  }

  /** A queued entry (a task, or a whole group) starts; whoever it reports to hears it. */
  protected startEntry(entry: TaskRecord[], why: 'slot' | 'user'): void {
    const first = entry[0];
    const since = first.queued?.since;
    const room = first.queued?.resources;
    const waited = !!first.queued?.waited;
    const waitsFor = first.queued?.waitsFor;
    // Queued without a word (it only let the last one settle): started without one either.
    const told = !!first.queued?.told;
    for (const task of entry) {
      // Counted at once: the next entry of the line is looked at right after this one starts
      // (2026-11-01 test: after a restart the started task was not counted yet, two started).
      if (task.queued) this.taskProject.set(task.id, task.queued.repoPath);
      this.track(this.run(task, { admitted: true }));
    }
    const inLine = since ? ` after ${clockSpan(this.now() - Date.parse(since))} in line` : '';
    const detail =
      why === 'user'
        ? waitsFor?.length
          ? `Started now, without waiting for ${waitsFor.map((wait) => wait.taskId.slice(0, 8)).join(', ')}, as asked${inLine}.`
          : `Started now, past the project's limit and the Mac's room, as asked${inLine}.`
        : room
          ? `Started: the Mac has room again${inLine}.`
          : waited
            ? `Started: the tasks it waited for are merged or closed${inLine}.`
            : `Started: a slot of the project freed up${inLine}.`;
    this.deps.onError?.(`Task ${first.id}: ${detail}`);
    if (told || why === 'user') this.notifyQueue(first, 'task-started', detail);
  }

  /**
   * «Empezar ya» on a queued task: it (its group) starts now, past the project's limit and the
   * Mac's room. Only when asked so (`force`: the phone's button, `ut task retry --force`).
   * 2026-11-10: a script of an orchestrator ran `ut task retry` on every queued task and
   * bakery, limited to 3, had 5 at work.
   */
  protected startQueuedNow(task: TaskRecord, force: boolean): TaskActionResult {
    const repo = task.queued?.repoPath ?? '';
    if (!force) {
      const { position, of, active } = this.queuePlace(task);
      const ref = task.id.slice(0, 8);
      const waits = this.waitsOn(task, repo);
      if (waits.length) {
        return {
          ok: false,
          code: 'limit',
          message: waits.some((wait) => wait.stopped)
            ? stoppedText(task, waits)
            : `${waitingText(waits)} \`ut task retry ${ref} --force\` starts it now, without that work`,
        };
      }
      const max = task.queued?.limit;
      const why = task.queued?.resources?.short.length
        ? `the Mac is short of ${task.queued.resources.short.join(' and ')}`
        : max !== undefined
          ? `${active} of ${max} tasks of its project run`
          : 'tasks are let in one at a time';
      return {
        ok: false,
        code: 'limit',
        message: `The task waits in line (${position} of ${of}; ${why}) and starts by itself at its turn. \`ut task retry ${ref} --force\` starts it now, past the limit; \`ut task move ${ref} 1\` puts it first in line`,
      };
    }
    const entry = this.queueEntries(repo).find((queued) => queued.includes(task)) ?? [task];
    this.startEntry(entry, 'user');
    return { ok: true, task: this.copy(task) };
  }

  /**
   * Move a queued task (its group) to `position` (1 = next) in its project's line; past the
   * end it goes last. The others keep their order.
   */
  moveQueued(id: string, position: number): TaskActionResult {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (task.state !== 'queued' || !task.queued) {
      return { ok: false, code: 'not-open', message: `The task is ${task.state}, not queued` };
    }
    const entries = this.queueEntries(task.queued.repoPath);
    const from = entries.findIndex((entry) => entry.includes(task));
    const [moving] = entries.splice(from, 1);
    const to = Math.max(0, Math.min(entries.length, Math.floor(position) - 1));
    entries.splice(to, 0, moving);
    entries.forEach((entry, index) => {
      for (const queued of entry) if (queued.queued) queued.queued.order = index + 1;
    });
    this.save();
    this.requestPump();
    return { ok: true, task: this.copy(task) };
  }

  /** "Queued" / "started" for the user's phone and the task's orchestrator. */
  protected notifyQueue(
    task: TaskRecord,
    type: 'task-queued' | 'task-started',
    detail: string
  ): void {
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const payload = this.taskPayload(task, type, detail);
    if (!task.notify) payload.data = { ...payload.data, quiet: true };
    this.post(payload);
  }
}
