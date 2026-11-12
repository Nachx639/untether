/**
 * Share with phone: the AppleScript that finds the agent's tab in Terminal or iTerm2 by its
 * tty, and later types the relaunch line into that same tab. Fixed text, run through the
 * osascript runner with every value as argv; nothing is ever interpolated into a script.
 *
 * Rules every script follows:
 * - the app is addressed by bundle id, and `is running` is checked first, so nothing is ever
 *   launched;
 * - every Apple Event is inside `with timeout of 4 seconds` (the runner kills at 5 s anyway);
 * - never System Events, keystrokes, `activate`, "front window" or "selected tab": a tab is
 *   found by its tty, and addressed as "tab N of window id W" (Terminal tabs have no id) or by
 *   the iTerm2 session's own id;
 * - typing re-checks that the tab still has that tty and that the agent is no longer in it.
 *
 * Output is `key=value` lines, `result=` first; the tab's contents, when asked for, come last
 * after a `--contents--` line, so nothing in them can be read as a key.
 *
 * Not yet run against the real apps (the Mac was locked while this was written): the
 * property names come from each app's .sdef (Terminal: tab `tty`, `busy`, `processes`,
 * `contents`, `do script … in`; iTerm2 3.5: session `id`, `tty`, `contents`, `write text`).
 */
import type { MacShareApp, MacShareErrorCode } from '../../../shared/mac-share.js';
import { defineOsascript, type OsascriptOutcome, type OsascriptScript } from './osascript.js';

const CONTENTS_MARKER = '--contents--';

/** argv: tty ("/dev/ttys001"), agent process name ("claude"), "1" to also read contents. */
export const TERMINAL_PROBE: OsascriptScript = defineOsascript('terminal-probe', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'set agentName to item 2 of argv',
  'set wantContents to item 3 of argv',
  'if not (application id "com.apple.Terminal" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.apple.Terminal"',
  'set hits to {}',
  'set winIds to id of every window',
  'repeat with i from 1 to count of winIds',
  'set wid to item i of winIds',
  'try',
  'set ttys to tty of every tab of window id wid',
  'repeat with j from 1 to count of ttys',
  'set t to item j of ttys',
  'if t is wantTty or ("/dev/" & t) is wantTty then set end of hits to {wid, j}',
  'end repeat',
  'on error errMsg number errNum',
  // A window without tabs (Settings) is skipped; a refusal or a hang is not.
  'if errNum is -1743 or errNum is -1712 then error errMsg number errNum',
  'end try',
  'end repeat',
  'if (count of hits) is not 1 then return "result=matches" & linefeed & "matches=" & (count of hits)',
  'set {wid, idx} to item 1 of hits',
  'set isBusy to busy of tab idx of window id wid',
  'set procs to processes of tab idx of window id wid',
  'set out to "result=found" & linefeed & "window=" & wid & linefeed & "tab=" & idx',
  'set out to out & linefeed & "busy=" & isBusy & linefeed & "agent=" & (procs contains agentName)',
  'if wantContents is "1" then set out to out & linefeed & "--contents--" & linefeed & (contents of tab idx of window id wid)',
  'return out',
  'end tell',
  'end timeout',
  'end run',
]);

/** argv: tty, window id, tab index (from the probe), agent process name, the line. */
export const TERMINAL_TYPE: OsascriptScript = defineOsascript('terminal-type', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'set wid to (item 2 of argv) as integer',
  'set idx to (item 3 of argv) as integer',
  'set agentName to item 4 of argv',
  'set lineText to item 5 of argv',
  'if not (application id "com.apple.Terminal" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.apple.Terminal"',
  'try',
  'set t to tty of tab idx of window id wid',
  'on error errMsg number errNum',
  'if errNum is -1728 or errNum is -1719 then return "result=gone"',
  'error errMsg number errNum',
  'end try',
  'if t is not wantTty and ("/dev/" & t) is not wantTty then return "result=moved"',
  'if busy of tab idx of window id wid then return "result=busy"',
  'if (processes of tab idx of window id wid) contains agentName then return "result=agent-running"',
  'do script lineText in tab idx of window id wid',
  'end tell',
  'end timeout',
  'return "result=typed"',
  'end run',
]);

/** argv: tty, "1" to also read contents. */
export const ITERM_PROBE: OsascriptScript = defineOsascript('iterm-probe', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'set wantContents to item 2 of argv',
  'if not (application id "com.googlecode.iterm2" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.googlecode.iterm2"',
  'set hits to {}',
  'set winIds to id of every window',
  'repeat with i from 1 to count of winIds',
  'set wid to item i of winIds',
  'try',
  'set tabCount to count of tabs of window id wid',
  'repeat with ti from 1 to tabCount',
  'set ttys to tty of every session of tab ti of window id wid',
  'set sids to id of every session of tab ti of window id wid',
  'repeat with k from 1 to count of ttys',
  'set t to item k of ttys',
  'if t is wantTty or ("/dev/" & t) is wantTty then set end of hits to {wid, ti, k, item k of sids}',
  'end repeat',
  'end repeat',
  'on error errMsg number errNum',
  'if errNum is -1743 or errNum is -1712 then error errMsg number errNum',
  'end try',
  'end repeat',
  'if (count of hits) is not 1 then return "result=matches" & linefeed & "matches=" & (count of hits)',
  'set {wid, ti, k, sid} to item 1 of hits',
  'set out to "result=found" & linefeed & "window=" & wid & linefeed & "tab=" & ti & linefeed & "session=" & sid',
  'if wantContents is "1" then set out to out & linefeed & "--contents--" & linefeed & (contents of session k of tab ti of window id wid)',
  'return out',
  'end tell',
  'end timeout',
  'end run',
]);

/** argv: tty, session id (from the probe), the line. */
export const ITERM_TYPE: OsascriptScript = defineOsascript('iterm-type', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'set wantId to item 2 of argv',
  'set lineText to item 3 of argv',
  'if not (application id "com.googlecode.iterm2" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.googlecode.iterm2"',
  'set hits to {}',
  'set winIds to id of every window',
  'repeat with i from 1 to count of winIds',
  'set wid to item i of winIds',
  'try',
  'set tabCount to count of tabs of window id wid',
  'repeat with ti from 1 to tabCount',
  'set sids to id of every session of tab ti of window id wid',
  'repeat with k from 1 to count of sids',
  'if (item k of sids) is wantId then set end of hits to {wid, ti, k}',
  'end repeat',
  'end repeat',
  'on error errMsg number errNum',
  'if errNum is -1743 or errNum is -1712 then error errMsg number errNum',
  'end try',
  'end repeat',
  'if (count of hits) is 0 then return "result=gone"',
  'if (count of hits) is not 1 then return "result=moved"',
  'set {wid, ti, k} to item 1 of hits',
  'set s to session k of tab ti of window id wid',
  'if (id of s) is not wantId then return "result=moved"',
  'set t to tty of s',
  'if t is not wantTty and ("/dev/" & t) is not wantTty then return "result=moved"',
  'tell s to write text lineText',
  'end tell',
  'end timeout',
  'return "result=typed"',
  'end run',
]);

/**
 * Llevar a Untether (2026-10-25): the window a `ut` session ran in, closed once its program
 * moved to Untether, only when it is that tab alone and nothing runs in it but its shell.
 * argv: tty.
 */
export const TERMINAL_CLOSE_IDLE: OsascriptScript = defineOsascript('terminal-close-idle', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'if not (application id "com.apple.Terminal" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.apple.Terminal"',
  'set hits to {}',
  'set winIds to id of every window',
  'repeat with i from 1 to count of winIds',
  'set wid to item i of winIds',
  'try',
  'set ttys to tty of every tab of window id wid',
  'repeat with j from 1 to count of ttys',
  'set t to item j of ttys',
  'if t is wantTty or ("/dev/" & t) is wantTty then set end of hits to {wid, j}',
  'end repeat',
  'on error errMsg number errNum',
  'if errNum is -1743 or errNum is -1712 then error errMsg number errNum',
  'end try',
  'end repeat',
  'if (count of hits) is not 1 then return "result=matches" & linefeed & "matches=" & (count of hits)',
  'set {wid, idx} to item 1 of hits',
  'if (count of tabs of window id wid) is not 1 then return "result=kept"',
  'if busy of tab idx of window id wid then return "result=kept"',
  'close window id wid',
  'end tell',
  'end timeout',
  'return "result=closed"',
  'end run',
]);

/** The same for iTerm2: the window closed when that session is alone in it. argv: tty. */
export const ITERM_CLOSE_IDLE: OsascriptScript = defineOsascript('iterm-close-idle', [
  'on run argv',
  'set wantTty to item 1 of argv',
  'if not (application id "com.googlecode.iterm2" is running) then return "result=not-running"',
  'with timeout of 4 seconds',
  'tell application id "com.googlecode.iterm2"',
  'set hits to {}',
  'set winIds to id of every window',
  'repeat with i from 1 to count of winIds',
  'set wid to item i of winIds',
  'try',
  'set tabCount to count of tabs of window id wid',
  'repeat with ti from 1 to tabCount',
  'set ttys to tty of every session of tab ti of window id wid',
  'repeat with k from 1 to count of ttys',
  'set t to item k of ttys',
  'if t is wantTty or ("/dev/" & t) is wantTty then set end of hits to {wid, ti, k}',
  'end repeat',
  'end repeat',
  'on error errMsg number errNum',
  'if errNum is -1743 or errNum is -1712 then error errMsg number errNum',
  'end try',
  'end repeat',
  'if (count of hits) is not 1 then return "result=matches" & linefeed & "matches=" & (count of hits)',
  'set {wid, ti, k} to item 1 of hits',
  'if (count of tabs of window id wid) is not 1 then return "result=kept"',
  'if (count of sessions of tab ti of window id wid) is not 1 then return "result=kept"',
  'close window id wid',
  'end tell',
  'end timeout',
  'return "result=closed"',
  'end run',
]);

export const TERMINAL_SCRIPTS: readonly OsascriptScript[] = [
  TERMINAL_PROBE,
  TERMINAL_TYPE,
  ITERM_PROBE,
  ITERM_TYPE,
  TERMINAL_CLOSE_IDLE,
  ITERM_CLOSE_IDLE,
];

/** The close script for the window of `tty` in `app`; undefined for any other app. */
export function closeIdleArgs(app: string, tty: string): ProbeArgs | undefined {
  const full = scriptTty(tty);
  if (!full) return undefined;
  if (app === 'Terminal') return { script: TERMINAL_CLOSE_IDLE, args: [full] };
  if (app === 'iTerm') return { script: ITERM_CLOSE_IDLE, args: [full] };
  return undefined;
}

/** What a close script answered. */
export function parseCloseIdle(stdout: string): 'closed' | 'kept' | 'not-found' | 'unparsable' {
  const result = readHeader(stdout.replace(/\r\n/g, '\n')).fields.get('result');
  if (result === 'closed' || result === 'kept') return result;
  if (result === 'matches' || result === 'not-running') return 'not-found';
  return 'unparsable';
}

const TTY_RE = /^\/dev\/tty[A-Za-z0-9]{1,16}$/;
const AGENT_NAME_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const ITERM_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** The tty as the scripts compare it: `/dev/ttys001`, also from `ttys001`. */
export function scriptTty(tty: string): string | undefined {
  const full = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  return TTY_RE.test(full) ? full : undefined;
}

export type ProbeArgs = { script: OsascriptScript; args: string[] };

export function probeArgs(
  app: MacShareApp,
  tty: string,
  agentName: string,
  withContents: boolean
): ProbeArgs | undefined {
  const full = scriptTty(tty);
  if (!full || !AGENT_NAME_RE.test(agentName)) return undefined;
  const contents = withContents ? '1' : '0';
  return app === 'Terminal'
    ? { script: TERMINAL_PROBE, args: [full, agentName, contents] }
    : { script: ITERM_PROBE, args: [full, contents] };
}

/** Where the probe found the tab: the identity the typing must find again. */
export type TabRef =
  | { app: 'Terminal'; windowId: number; tabIndex: number }
  | { app: 'iTerm'; windowId: number; tabIndex: number; sessionId: string };

export function typeArgs(
  tab: TabRef,
  tty: string,
  agentName: string,
  line: string
): ProbeArgs | undefined {
  const full = scriptTty(tty);
  if (!full || !AGENT_NAME_RE.test(agentName) || line === '' || line.startsWith('-')) {
    return undefined;
  }
  if (tab.app === 'Terminal') {
    return {
      script: TERMINAL_TYPE,
      args: [full, String(tab.windowId), String(tab.tabIndex), agentName, line],
    };
  }
  if (!ITERM_SESSION_RE.test(tab.sessionId)) return undefined;
  return { script: ITERM_TYPE, args: [full, tab.sessionId, line] };
}

export type ProbeResult =
  | {
      kind: 'found';
      tab: TabRef;
      /** Terminal only: a process other than the shell runs in the tab. */
      busy?: boolean;
      /** Terminal only: the agent's name is among the tab's processes. */
      agentPresent?: boolean;
      /** The visible screen, when asked for. Never logged or kept. */
      contents?: string;
    }
  | { kind: 'matches'; count: number }
  | { kind: 'not-running' }
  | { kind: 'unparsable' };

function readHeader(stdout: string): { fields: Map<string, string>; contents?: string } {
  const lines = stdout.split('\n');
  const fields = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === CONTENTS_MARKER) {
      return { fields, contents: lines.slice(i + 1).join('\n') };
    }
    const eq = lines[i].indexOf('=');
    if (eq > 0 && !fields.has(lines[i].slice(0, eq))) {
      fields.set(lines[i].slice(0, eq), lines[i].slice(eq + 1));
    }
  }
  return { fields };
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,10}$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function parseProbe(app: MacShareApp, stdout: string): ProbeResult {
  const { fields, contents } = readHeader(stdout.replace(/\r\n/g, '\n'));
  const result = fields.get('result');
  if (result === 'not-running') return { kind: 'not-running' };
  if (result === 'matches') {
    const count = Number(fields.get('matches'));
    return Number.isInteger(count) && count >= 0 && count !== 1
      ? { kind: 'matches', count }
      : { kind: 'unparsable' };
  }
  if (result !== 'found') return { kind: 'unparsable' };
  const windowId = positiveInt(fields.get('window'));
  const tabIndex = positiveInt(fields.get('tab'));
  if (windowId === undefined || tabIndex === undefined) return { kind: 'unparsable' };
  const withContents = contents === undefined ? {} : { contents };
  if (app === 'Terminal') {
    const busy = bool(fields.get('busy'));
    const agentPresent = bool(fields.get('agent'));
    if (busy === undefined || agentPresent === undefined) return { kind: 'unparsable' };
    return {
      kind: 'found',
      tab: { app, windowId, tabIndex },
      busy,
      agentPresent,
      ...withContents,
    };
  }
  const sessionId = fields.get('session');
  if (!sessionId || !ITERM_SESSION_RE.test(sessionId)) return { kind: 'unparsable' };
  return { kind: 'found', tab: { app, windowId, tabIndex, sessionId }, ...withContents };
}

export type TypeResult =
  | 'typed'
  | 'moved'
  | 'busy'
  | 'agent-running'
  | 'gone'
  | 'not-running'
  | 'unparsable';

const TYPE_RESULTS = new Set<TypeResult>([
  'typed',
  'moved',
  'busy',
  'agent-running',
  'gone',
  'not-running',
]);

export function parseType(stdout: string): TypeResult {
  const result = readHeader(stdout.replace(/\r\n/g, '\n')).fields.get('result');
  return TYPE_RESULTS.has(result as TypeResult) ? (result as TypeResult) : 'unparsable';
}

/** The same tab: what the plan probed is what the pre-close probe and the typing find. */
export function sameTab(a: TabRef, b: TabRef): boolean {
  if (a.app !== b.app || a.windowId !== b.windowId || a.tabIndex !== b.tabIndex) return false;
  return a.app === 'Terminal' || (b.app === 'iTerm' && a.sessionId === b.sessionId);
}

/**
 * A probe that found no single tab, as the plan's error. 0 tabs, or the app not running:
 * tab-not-found; more than one: tab-ambiguous; an answer that can't be read: unresponsive.
 */
export function probeProblem(result: ProbeResult): MacShareErrorCode | undefined {
  switch (result.kind) {
    case 'found':
      return undefined;
    case 'not-running':
      return 'tab-not-found';
    case 'matches':
      return result.count === 0 ? 'tab-not-found' : 'tab-ambiguous';
    default:
      return 'unresponsive';
  }
}

/**
 * A runner outcome that isn't `ok`, as the plan's error: -1743 is automation-denied; the
 * window or tab gone (or the app quit) is tab-not-found; a hang, a refused concurrent call
 * or anything else is unresponsive. (The share job turns a first-ever timeout with the screen
 * unlocked into automation-pending: macOS is probably asking.)
 */
export function outcomeProblem(outcome: OsascriptOutcome): MacShareErrorCode | undefined {
  switch (outcome.kind) {
    case 'ok':
      return undefined;
    case 'error':
      if (outcome.error === 'denied') return 'automation-denied';
      if (outcome.error === 'gone' || outcome.error === 'not-running') return 'tab-not-found';
      return 'unresponsive';
    default:
      return 'unresponsive';
  }
}
