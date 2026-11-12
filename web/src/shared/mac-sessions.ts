/**
 * Mac Sessions ("On this Mac"): the phone lists the tmux sessions on the user's own tmux
 * servers and the Claude Code, Codex or Gemini processes running outside Untether. These are
 * the types of GET /api/mac-sessions and its actions, shared by the server and the client.
 *
 * Ids are opaque and made by the server, stable across scans:
 * - `t-<serverPid>-<serverStartSec>-<N>`: tmux session `$N`
 * - `p-<serverPid>-<serverStartSec>-<N>`: tmux pane `%N` (a conversation to read)
 * - `a-<pid>-<startSec>`: an agent outside tmux
 * Start seconds come from the process start time, so a restarted tmux server or a reused pid
 * gets a new id. A client only ever sends one of these ids back, never a socket path, pid or
 * tmux target: an `-S` path from a client would let it make the server connect to any socket.
 */

import type { MacShareAvailability, MacShareStatus } from './mac-share.js';

export const MAC_SESSION_ID_RE = /^(t|p|a)-\d{1,10}-\d{1,12}(-\d{1,10})?$/;

/** Whether `value` has the shape of a Mac session id (the server still looks it up). */
export function isMacSessionId(value: unknown): value is string {
  return typeof value === 'string' && MAC_SESSION_ID_RE.test(value);
}

/**
 * tmux 3.2 brought `attach-session -f <client flags>`, the `ignore-size` client flag and `-N`
 * (never start a server): opening a tmux session needs it. Older servers are only listed.
 */
export const TMUX_MIN_OPEN_VERSION = '3.2';

export type MacAgentKind = 'claude' | 'codex' | 'gemini';
/** control: what the phone types reaches the session; watch: a read-only tmux client. */
export type MacOpenMode = 'control' | 'watch';
/** others: the other terminals keep the window's size; here: it follows this screen too. */
export type MacSizing = 'others' | 'here';

/** Same shape as Session['claudeStatus'] without `choices` (no screen for Mac agents). */
export interface MacAgentStatus {
  status: string;
  waitingFor?: string;
  title?: string;
  preview?: { role: 'user' | 'assistant'; text: string };
  since?: number;
  activity?: {
    kind: 'thinking' | 'writing' | 'tool';
    tool?: string;
    target?: string;
    since?: number;
  };
  /** Busy only because background agents or tasks run: the reply is over. */
  waitingForBackground?: boolean;
}

export interface MacAgent {
  agent: MacAgentKind;
  /** Id of its read-only conversation (GET /api/mac-sessions/:chatId/chat). */
  chatId: string;
  status?: MacAgentStatus;
  title?: string;
  /** Claude's sessionId, Codex's thread id. */
  conversationId?: string;
  startedAt?: string;
  cwd?: string;
}

export interface MacTmuxPaneAgent extends MacAgent {
  windowIndex: number;
  windowName: string;
  inCurrentWindow: boolean;
  activePane: boolean;
}

export interface MacTmuxSession {
  kind: 'tmux';
  id: string;
  name: string;
  /** label is empty for the default server, the name for `-L name`, the file name for `-S`. */
  server: { label: string; isDefault: boolean };
  windows: number;
  createdAt?: string;
  activityAt?: string;
  /** The active pane of the current window. */
  current: {
    windowIndex: number;
    windowName: string;
    command?: string;
    title?: string;
    cwd?: string;
    width: number;
    height: number;
  };
  /** One per pane running an agent, the primary one first. */
  agents: MacTmuxPaneAgent[];
  /** Host apps of the clients attached outside Untether ("Terminal", "iTerm"). */
  alsoOpenIn: string[];
  /** The Untether session already attached to it, and how. */
  utSessionId?: string;
  utMode?: MacOpenMode;
  /**
   * With utSessionId: that session's own program is the tmux client (opened from here or the
   * tmux list), so ending it only disconnects. False for a client that runs inside it (a shell
   * where `tmux attach` was typed) or in a terminal window (`ut`): ending that session would end
   * the shell, or what runs in the window.
   */
  utClient?: boolean;
  canOpen: boolean;
  cannotOpenReason?: 'tmux-too-old' | 'unreachable';
}

export interface MacAgentSession extends MacAgent {
  kind: 'agent';
  /** Same as chatId. */
  id: string;
  /** Host app: an app bundle's name ("Visual Studio Code"), "iTerm", "SSH"… */
  app?: string;
  tty?: string;
  /** It runs in a pane of a tmux server that can't be listed (socket removed, no answer). */
  inTmux?: { server: string };
  /** "Share with phone" (shared/mac-share.ts): set only while the feature is on. */
  share?: MacShareAvailability;
}

export type MacSessionItem = MacTmuxSession | MacAgentSession;

export interface MacSessionsWarning {
  code:
    | 'tmux-unavailable'
    | 'tmux-socket-missing'
    | 'tmux-unreachable'
    | 'scan-partial'
    | 'truncated';
  /** Never arguments or environment. */
  detail?: string;
  ref?: string;
}

export interface MacSessionsResponse {
  enabled: boolean;
  reason?: 'disabled' | 'unsupported' | 'hq';
  platform: string;
  scannedAt?: string;
  /** What a tap on a tmux session opens (the user's setting). */
  openMode: MacOpenMode;
  tmux?: { available: boolean; version?: string; canOpen: boolean };
  /** In the server's order: waiting, busy, idle agents, then tmux sessions without agents. */
  items: MacSessionItem[];
  warnings: MacSessionsWarning[];
  /** "Share with phone" for this server (shared/mac-share.ts). */
  share?: MacShareStatus;
}

/** POST /api/mac-sessions/:id/open */
export interface MacOpenRequest {
  mode?: MacOpenMode;
  cols?: number;
  rows?: number;
}

export interface MacOpenResponse {
  sessionId: string;
  /** An Untether session was already attached: that one, in its own mode. */
  reused: boolean;
  mode: MacOpenMode;
}

/** POST /api/mac-sessions/attached/:sessionId/mode */
export interface MacModeRequest {
  mode?: MacOpenMode;
  sizing?: MacSizing;
}

export interface MacModeResponse {
  mode: MacOpenMode;
  sizing: MacSizing;
}

export type MacSessionsErrorCode =
  | 'bad-id'
  | 'bad-request'
  | 'gone'
  | 'disabled'
  | 'not-openable'
  | 'tmux-too-old'
  | 'open-failed'
  | 'not-attached'
  | 'client-not-found'
  | 'mode-failed';

/** Body of every error answer of the Mac Sessions API. */
export interface MacSessionsErrorBody {
  error: MacSessionsErrorCode;
  details?: string;
}

/**
 * A Claude conversation running right now outside this Untether's sessions (a terminal tab,
 * a tmux pane, another Untether instance's session), never resumed here: `live` on each such
 * conversation of GET /api/claude/conversations, and in the 409 that refuses `claude --resume`
 * of it (POST /api/sessions).
 */
export interface MacLiveConversation {
  where: 'tmux' | 'terminal';
  /** The app of the terminal it runs in; "Untether" in another Untether's session. */
  app?: string;
  /**
   * While "On this Mac" lists it: its read-only conversation (a Mac session id), and for a
   * tmux pane its tmux session to open, that session's name and the window it is in.
   */
  chatId?: string;
  tmuxId?: string;
  tmuxName?: string;
  windowIndex?: number;
}

// Client window events. Their detail types live here too, so the client modules that send and
// handle them don't depend on each other.

/** Something changed the list (open, disconnect, mode change, settings saved): reload it now. */
export const MAC_SESSIONS_CHANGED_EVENT = 'ut-mac-sessions-changed';
/** Open the read-only conversation sheet of an agent or a tmux pane. */
export const MAC_SESSION_VIEW_EVENT = 'ut-open-mac-session-view';
/** Open a tmux session from the list, or go to the Untether session already attached. */
export const MAC_TMUX_OPEN_EVENT = 'ut-open-mac-tmux';

export interface MacSessionViewDetail {
  chatId: string;
  kind: 'agent' | 'pane';
  agent: MacAgentKind;
  title?: string;
  app?: string;
  cwd?: string;
  /** For an agent in a pane of a tmux server that can't be listed (MacAgentSession.inTmux). */
  inTmux?: { server: string };
  /** For an agent on its own: "Share with phone" (MacAgentSession.share). */
  share?: MacShareAvailability;
  /** For a pane: its tmux session's id and name, and the window it is in. */
  tmuxId?: string;
  tmuxName?: string;
  windowIndex?: number;
}

export interface MacTmuxOpenDetail {
  id: string;
  mode?: MacOpenMode;
}
