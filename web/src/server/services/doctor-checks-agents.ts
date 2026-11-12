/**
 * The doctor's checks of the agents themselves: Claude's status and events reaching Untether,
 * its version and what its transcripts look like.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MINUTE, readTail } from './doctor-checks-shared.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

/**
 * Status words Claude Code wrote that Untether does not know (2026-10-20: "shell"), and other
 * format surprises in its files (a new stop reason, a session file missing a field).
 */
export function claudeStatusCheck(deps: {
  unknown: () => string[];
  surprises?: () => string[];
}): DoctorCheck {
  return {
    id: 'claude-status',
    run: () => [
      ...deps.unknown().map((status) => ({
        key: `claude-status:${status}`,
        check: 'claude-status',
        severity: 'warning' as const,
        problem: `Claude Code reports a status Untether does not know: "${status}" (read as idle); teach claude-chat.ts withKnownStatus what it means`,
      })),
      ...(deps.surprises?.() ?? []).map((text) => ({
        key: `claude-format:${text}`,
        check: 'claude-status',
        severity: 'warning' as const,
        problem: `Claude Code's files changed: ${text}; check what claude-chat.ts reads from them`,
      })),
    ],
  };
}

/** A running session Untether started Claude in with its hooks (SessionInfo.agentHooks). */
export interface HookedSession {
  sessionId: string;
  /** When its Claude was last seen going busy (its status file), since the server started. */
  busySeenAt?: number;
  /** Its last hook event read (epoch ms), from before a restart too (agent-event-service.ts). */
  lastEventAt?: number;
  /** Since when it waits on a tool call still open (PreToolUse seen, no PostToolUse yet). */
  waitingSince?: number;
}

/**
 * A Claude seen at work this long with no hook event since is silent: a prompt fires
 * UserPromptSubmit at once, every tool call PreToolUse.
 */
export const HOOKS_SILENT_AFTER_MS = 2 * MINUTE;

/** Claude writes its status a moment after the hook of the same prompt ran. */
const HOOK_BEFORE_STATUS_MS = MINUTE;

/**
 * The agents' events (agent-events.ts, 2026-11-01): Claude sessions Untether starts carry its
 * hooks, and their state comes from them before the screen. Two ways that can break without
 * anyone seeing it, each turning every decision back into a screen read: the hook files can't
 * be written (healed by writing them again), or a Claude started with them sends nothing (its
 * user turned hooks off with disableAllHooks, a managed policy allows only its own, a Claude
 * version renamed the events). Also tells, as info, how many decisions still came from the
 * screen since the server started.
 */
export function agentEventsCheck(deps: {
  /** Writes the hook files again; false when they can't be written. */
  ensureHookFiles: () => boolean;
  sessions: () => HookedSession[];
  /** Decisions taken from the screen or the output time, and in all (SignalLedger). */
  screenShare?: () => { screen: number; total: number };
  /** When this server started (epoch ms). */
  serverStartedAt?: number;
  now?: () => number;
}): DoctorCheck {
  return {
    id: 'agent-events',
    run() {
      const findings: DoctorFinding[] = [];
      if (!deps.ensureHookFiles()) {
        findings.push({
          key: 'agent-events:hook-files',
          check: 'agent-events',
          severity: 'warning',
          problem:
            "Untether's Claude hook files (~/.untether/agent-hooks) can't be written: new Claude sessions start without hooks and their state is read from the screen",
        });
      }
      const now = (deps.now ?? Date.now)();
      for (const session of deps.sessions()) {
        const busy = session.busySeenAt;
        if (busy === undefined || now - busy < HOOKS_SILENT_AFTER_MS) continue;
        // In one long tool call its hooks told about (2026-11-03: a 9-minute command across a
        // restart was called hook-silent): the call's end is the next event, not a silence.
        if (session.waitingSince !== undefined) continue;
        // A silence that started before this server did (busy then, still busy now: a turn
        // that crossed the restart) counts from the server's start only.
        const started = deps.serverStartedAt;
        if (
          started !== undefined &&
          (session.lastEventAt === undefined || session.lastEventAt < started) &&
          now - Math.max(started, busy) < HOOKS_SILENT_AFTER_MS
        ) {
          continue;
        }
        if (
          session.lastEventAt !== undefined &&
          session.lastEventAt >= busy - HOOK_BEFORE_STATUS_MS
        ) {
          continue;
        }
        findings.push({
          key: `agent-events:silent:${session.sessionId}`,
          check: 'agent-events',
          severity: 'warning',
          problem: `Claude in session ${session.sessionId} was started with Untether's hooks and worked, but sent no hook event (hooks turned off by disableAllHooks or a managed policy, or renamed by a Claude update): its state is read from the screen`,
        });
      }
      const share = deps.screenShare?.();
      if (share && share.screen > 0) {
        findings.push({
          key: 'agent-events:screen-decisions',
          check: 'agent-events',
          severity: 'info',
          problem: `${share.screen} of ${share.total} decisions about agents since the server started came from the screen or the terminal's output time (see "[agent-state]" in the log)`,
        });
      }
      return findings;
    },
  };
}

/** A Claude Code update: what Untether reads from it may have changed. Told once per version. */
export function claudeVersionCheck(deps: {
  version: () => Promise<string | undefined>;
  statePath: string;
  /**
   * A compatibility probe run when the version changed (2026-10-20 review): what in the new
   * Claude Code no longer reads as Untether expects, one line each.
   */
  probe?: () => Promise<string[]>;
}): DoctorCheck {
  return {
    id: 'claude-version',
    async run() {
      const version = (await deps.version())?.trim();
      if (!version) return [];
      let previous: string | undefined;
      try {
        previous = fs.readFileSync(deps.statePath, 'utf8').trim() || undefined;
      } catch {
        // First look.
      }
      if (previous === version) return [];
      fs.mkdirSync(path.dirname(deps.statePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(deps.statePath, `${version}\n`, { mode: 0o600 });
      if (!previous) return [];
      const problems = await (deps.probe?.() ?? Promise.resolve([])).catch((error) => [
        `the compatibility probe failed: ${error}`,
      ]);
      return [
        {
          key: `claude-version:${version}`,
          check: 'claude-version',
          severity: 'info',
          problem: `Claude Code changed from ${previous} to ${version}${problems.length ? '' : '; the compatibility probe found nothing'}`,
        },
        ...problems.map((problem) => ({
          key: `claude-compat:${version}:${problem}`,
          check: 'claude-version',
          severity: 'warning' as const,
          problem: `after the Claude Code ${version} update: ${problem}`,
        })),
      ];
    },
  };
}

/**
 * What the compatibility probe looks at in a Claude Code install: its `--help` (flags the
 * relaunch table doesn't know) and its newest transcripts (replies but no turn end read).
 */
export async function probeClaudeCompat(deps: {
  help: () => Promise<string | undefined>;
  unknownFlags: (help: string) => string[];
  recentTranscriptLines: () => string[][];
  turnEndSeen: (lines: string[]) => boolean;
}): Promise<string[]> {
  const problems: string[] = [];
  const help = await deps.help();
  if (help) {
    const unknown = deps.unknownFlags(help);
    if (unknown.length) {
      problems.push(
        `claude --help lists flags the relaunch table does not know: ${unknown.join(', ')} (mac-sessions/relaunch-command.ts CLAUDE_FLAGS)`
      );
    }
  }
  // A format change shows in every transcript; one agent still mid-turn (only tool calls so
  // far) shows none yet (2026-10-20: the first probe flagged two working Atlas tasks). Told
  // only when no sampled transcript with replies has a turn end Untether can read.
  const sampled = deps
    .recentTranscriptLines()
    .filter((lines) => lines.filter((line) => line.includes('"type":"assistant"')).length >= 3);
  if (sampled.length && !sampled.some((lines) => deps.turnEndSeen(lines))) {
    problems.push(
      `none of ${sampled.length} recent transcripts with replies has a turn end Untether can read (claude-chat.ts turnAfter)`
    );
  }
  return problems;
}

/** The tails of the newest transcripts under Claude's projects folder (the probe's sample). */
export function recentTranscriptTails(claudeDir: string, count = 6): string[][] {
  const projects = path.join(claudeDir, 'projects');
  const found: Array<{ file: string; mtime: number }> = [];
  const since = Date.now() - 24 * 60 * MINUTE;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(projects, dir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(projects, dir, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= since) found.push({ file, mtime });
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count)
    .map(({ file }) =>
      readTail(file, 2 * 1024 * 1024)
        .split('\n')
        .slice(1)
    );
}
