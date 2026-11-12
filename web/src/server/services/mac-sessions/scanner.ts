/**
 * Mac Sessions scanner: the "On this Mac" list (GET /api/mac-sessions). One row per tmux session
 * on the user's own tmux servers, with the agents in its panes, and one per agent running
 * outside Untether and outside those sessions.
 *
 * Ids are made here and stay the same across scans: `t-<server pid>-<server start>-<N>` for
 * tmux session $N, `p-<server pid>-<server start>-<N>` for pane %N (a conversation to read),
 * `a-<pid>-<start>` for an agent on its own; a restarted tmux server or a reused pid gets new
 * ones. Each scan indexes its ids: clients only ever send one back, and the server looks up what
 * it names (a socket, a pid) here, never in the request.
 *
 * Order: waiting, busy, then idle agents, then tmux sessions without one; newest first within
 * each. A scan is reused for 3 s and callers at the same time share one; `force` runs a new one
 * at most once a second, and invalidate() (after an open, a disconnect or a mode change) drops
 * the cached one. Nothing runs while Mac Sessions is off. What agents' tools made for their own
 * tests is left out (agent-made.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { isForwardedSession } from '../../../shared/forwarded-session.js';
import type {
  MacAgentKind,
  MacAgentSession,
  MacAgentStatus,
  MacOpenMode,
  MacSessionItem,
  MacSessionsResponse,
  MacSessionsWarning,
  MacTmuxPaneAgent,
  MacTmuxSession,
} from '../../../shared/mac-sessions.js';
import type { MacShareAvailability, MacShareStatus } from '../../../shared/mac-share.js';
import type { SessionInfo } from '../../../shared/types.js';
import type { ProcessTable } from '../claude-chat.js';
import { paneLabel } from '../tmux-manager.js';
import { type AgentMadeFacts, agentScratchRoots, isAgentMade } from './agent-made.js';
import {
  type AgentFinderDeps,
  type LiveConversation,
  liveClaudeConversations,
  MacAgentFinder,
  type MacAgentState,
  type PlacedAgent,
  realAgentFinderDeps,
} from './agents.js';
import { ancestors, classifyProcess, type OwnershipContext } from './process-tree.js';
import { folderList, type MacSessionsSettings } from './settings.js';
import type { TmuxAvailability } from './tmux-run.js';
import {
  realTmuxDiscoveryDeps,
  type TmuxDiscovery,
  type TmuxDiscoveryDeps,
  type TmuxServer,
  TmuxServerFinder,
} from './tmux-servers.js';

export const SCAN_CACHE_MS = 3_000;
export const FORCE_MIN_MS = 1_000;
export const MAX_ITEMS = 100;
export const MAC_SESSIONS_ONLY_IN_ENV = 'UNTETHER_MAC_SESSIONS_ONLY_IN';

/** What an id names. */
export type MacSessionTarget =
  | {
      kind: 'tmux';
      socketPath: string;
      serverPid: number;
      /** Epoch seconds. */
      serverStartedAt: number;
      /** "$3" */
      tmuxSessionId: string;
      name: string;
    }
  | {
      kind: 'pane';
      socketPath: string;
      serverPid: number;
      serverStartedAt: number;
      /** "%7" */
      paneId: string;
      panePid: number;
      /** The agent in the pane: its pid and ps lstart (checked again before each read). */
      agentPid: number;
      agentStart: string;
      agent: MacAgentKind;
      cwd?: string;
    }
  | {
      kind: 'agent';
      pid: number;
      lstart: string;
      agent: MacAgentKind;
      cwd?: string;
      claudeDir?: string;
    };

/**
 * The ids the latest scan gave an agent process: its conversation, and for one in a tmux pane,
 * its tmux session (with its name) and the window it is in.
 */
export interface ListedAgentIds {
  chatId: string;
  tmuxId?: string;
  tmuxName?: string;
  windowIndex?: number;
}

/** The Untether sessions the scanner needs to know: the running ones own their processes. */
export type ScannerSession = Pick<SessionInfo, 'id' | 'pid' | 'status' | 'forwarderPid'>;

export interface MacSessionsScannerDeps {
  /** The effective settings (config.json, env, CLI, platform, HQ), read on every scan. */
  settings(): MacSessionsSettings;
  /** The shared process table (processTable). */
  table(): Promise<ProcessTable>;
  /** Untether's sessions (ptyManager.listSessions()). */
  utSessions(): ScannerSession[];
  /** Whether tmux is installed and can open sessions (tmuxVersion). */
  tmuxVersion(): Promise<TmuxAvailability>;
  /** This server's control dir: its shield tmux server is never listed. */
  controlPath?: string;
  /** What discovery and the agent scan read; this machine unless given (never under vitest). */
  discovery?: TmuxDiscoveryDeps;
  agents?: AgentFinderDeps;
  serverPid?: number;
  platform?: NodeJS.Platform;
  /** For UNTETHER_MAC_SESSIONS_ONLY_IN. */
  env?: Record<string, string | undefined>;
  /** A folder with its links resolved (the ONLY_IN and hidden-folder filters). */
  realpath?: (folder: string) => string;
  now?: () => number;
  /**
   * "Share with phone" (share.ts): the response's `share` and each agent row's. Read when the
   * list is answered, not when it was scanned, so a share in flight shows at once; cheap (no
   * AppleScript, no ps).
   */
  share?: () => MacShareRows | undefined;
}

/** What the scanner asks of MacShare. */
export interface MacShareRows {
  status(): MacShareStatus;
  availability(row: MacAgentSession): MacShareAvailability | undefined;
}

interface PaneAgent {
  agent: PlacedAgent;
  state: MacAgentState;
}

const iso = (epochSec: number) => new Date(epochSec * 1000).toISOString();
/** Needs you, then working, then the rest (busy waiting on background agents among them). */
const urgency = (status: MacAgentStatus | undefined) =>
  status?.status === 'waiting'
    ? 0
    : status?.status === 'busy' && !status.waitingForBackground
      ? 1
      : 2;

function realpathOr(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/** Where an item runs, for the ONLY_IN and hidden-folder filters. */
const folderOf = (item: MacSessionItem) => (item.kind === 'tmux' ? item.current.cwd : item.cwd);

function stateRank(item: MacSessionItem): number {
  if (item.kind === 'tmux') {
    return item.agents.length > 0 ? urgency(item.agents[0].status) : 3;
  }
  return urgency(item.status);
}

function startOf(item: MacSessionItem): number {
  const start = item.kind === 'tmux' ? item.createdAt : item.startedAt;
  return start ? Date.parse(start) : 0;
}

/** The server's order: by state, then newest first; the id keeps ties stable. */
export function compareItems(a: MacSessionItem, b: MacSessionItem): number {
  return (
    stateRank(a) - stateRank(b) ||
    startOf(b) - startOf(a) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export class MacSessionsScanner {
  private readonly now: () => number;
  private tmuxFinder?: TmuxServerFinder;
  private agentFinder?: MacAgentFinder;
  private discoveryDeps?: TmuxDiscoveryDeps;
  private last: { at: number; response: MacSessionsResponse } | null = null;
  private inFlight: { generation: number; promise: Promise<MacSessionsResponse> } | null = null;
  private generation = 0;
  private index = new Map<string, MacSessionTarget>();
  /** `${pid}|${lstart}` of each agent listed → its ids (History's live marks). */
  private agentIds = new Map<string, ListedAgentIds>();
  private lastSockets = new Map<number, string>();
  private scratchRoots?: string[];

  constructor(private readonly deps: MacSessionsScannerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private discovery(): TmuxDiscoveryDeps {
    this.discoveryDeps ??=
      this.deps.discovery ??
      realTmuxDiscoveryDeps({ controlPath: this.deps.controlPath, platform: this.platform() });
    return this.discoveryDeps;
  }

  private finders(): { tmux: TmuxServerFinder; agents: MacAgentFinder } {
    this.tmuxFinder ??= new TmuxServerFinder(this.discovery());
    this.agentFinder ??= new MacAgentFinder(
      this.deps.agents ?? realAgentFinderDeps(this.platform()),
      this.now
    );
    return { tmux: this.tmuxFinder, agents: this.agentFinder };
  }

  private ownershipContext(
    sessions: ScannerSession[],
    tmuxSockets: ReadonlyMap<number, string>
  ): OwnershipContext {
    const discovery = this.discovery();
    const sessionPids = new Map<number, string>();
    const forwardedSessionIds = new Set<string>();
    for (const session of sessions) {
      if (session.status === 'running' && typeof session.pid === 'number') {
        sessionPids.set(session.pid, session.id);
      }
      if (isForwardedSession(session)) forwardedSessionIds.add(session.id);
    }
    return {
      serverPid: this.deps.serverPid ?? process.pid,
      sessionPids,
      forwardedSessionIds,
      uid: discovery.uid,
      socketDir: discovery.socketDir,
      ownShieldSocket: discovery.ownShieldSocket,
      tmuxSockets,
      platform: this.platform(),
    };
  }

  /** The list, from the cache unless it is older than 3 s (or `force`, at most once a second). */
  async scan(options: { force?: boolean } = {}): Promise<MacSessionsResponse> {
    const settings = this.deps.settings();
    const platform = this.platform();
    if (!settings.enabled) {
      this.last = null;
      this.index = new Map();
      this.agentIds = new Map();
      return {
        enabled: false,
        ...(settings.reason ? { reason: settings.reason } : {}),
        platform,
        openMode: settings.openMode,
        items: [],
        warnings: [],
      };
    }
    if (this.inFlight?.generation === this.generation) {
      return this.inFlight.promise.then((response) => this.withShare(response));
    }
    const now = this.now();
    const age = this.last ? now - this.last.at : Number.POSITIVE_INFINITY;
    if (this.last && age >= 0 && age < SCAN_CACHE_MS && !(options.force && age >= FORCE_MIN_MS)) {
      return this.withShare({ ...this.last.response, openMode: settings.openMode });
    }
    const generation = this.generation;
    const promise = this.run(settings, now)
      .then((response) => {
        if (generation === this.generation) this.last = { at: now, response };
        return response;
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
    this.inFlight = { generation, promise };
    return promise.then((response) => this.withShare(response));
  }

  /** The response with "Share with phone" on it, while that feature is wired in. */
  private withShare(response: MacSessionsResponse): MacSessionsResponse {
    const share = this.deps.share?.();
    if (!share) return response;
    const status = share.status();
    return {
      ...response,
      share: status,
      items: response.items.map((item) => {
        if (item.kind !== 'agent') return item;
        const availability = status.enabled ? share.availability(item) : undefined;
        if (!availability) {
          const { share: _old, ...rest } = item;
          return rest;
        }
        return { ...item, share: availability };
      }),
    };
  }

  /** Drop the cached list: the next scan runs again (after an open, a disconnect…). */
  invalidate(): void {
    this.generation++;
    this.last = null;
  }

  /** What an id from the latest scan names. */
  target(id: string): MacSessionTarget | undefined {
    return this.index.get(id);
  }

  /** What an id names, scanning again once when the latest scan doesn't have it. */
  async resolve(id: string): Promise<MacSessionTarget | undefined> {
    const known = this.target(id);
    if (known) return known;
    await this.scan({ force: true });
    return this.target(id);
  }

  /** The ids the latest scan gave an agent process (pid and ps lstart). */
  idsForProcess(pid: number, lstart: string): ListedAgentIds | undefined {
    return this.agentIds.get(`${pid}|${lstart}`);
  }

  /**
   * Claude conversations live outside Untether right now (History never resumes them). Runs
   * even with Mac Sessions off: it only reads Claude's session files and the shared ps.
   */
  async liveClaudeConversations(): Promise<Map<string, LiveConversation>> {
    const table = await this.deps.table();
    const ctx = this.ownershipContext(this.deps.utSessions(), this.lastSockets);
    return liveClaudeConversations(table, ctx, {
      claudeDir: this.finders().agents.claudeDir(),
      ids: (pid, lstart) => this.idsForProcess(pid, lstart),
    });
  }

  private async run(settings: MacSessionsSettings, now: number): Promise<MacSessionsResponse> {
    // Before anything runs: under vitest, without injected dependencies, this refuses.
    const finders = this.finders();
    const warnings: MacSessionsWarning[] = [];
    const table = await this.deps.table();
    const tmux = await this.deps.tmuxVersion();
    let discovery: TmuxDiscovery = { servers: [], unlisted: [], sockets: new Map(), warnings: [] };
    if (!tmux.available) {
      warnings.push({ code: 'tmux-unavailable' });
    } else {
      try {
        discovery = await finders.tmux.discover(table);
      } catch {
        warnings.push({ code: 'scan-partial', detail: 'tmux' });
      }
    }
    warnings.push(...discovery.warnings);
    if (!table.extended) warnings.push({ code: 'scan-partial', detail: 'ps' });
    this.lastSockets = discovery.sockets;

    const ctx = this.ownershipContext(this.deps.utSessions(), discovery.sockets);
    let agents: PaneAgent[] = [];
    try {
      const found = await finders.agents.find(table, { includeHeadless: settings.includeHeadless });
      const placed = await finders.agents.outsideUntether(found, table, ctx);
      const states = await Promise.all(
        placed.map((agent) => finders.agents.state(agent).catch((): MacAgentState => ({})))
      );
      agents = placed.map((agent, i) => ({ agent, state: states[i] }));
    } catch {
      warnings.push({ code: 'scan-partial', detail: 'agents' });
    }

    const index = new Map<string, MacSessionTarget>();
    const agentIds = new Map<string, ListedAgentIds>();
    const servers = new Map(discovery.servers.map((server) => [server.pid, server]));
    const inPanes = new Map<string, PaneAgent[]>();
    const alone: PaneAgent[] = [];
    for (const entry of agents) {
      const { owner } = entry.agent;
      const server = owner.owner === 'tmux' ? servers.get(owner.serverPid) : undefined;
      if (owner.owner === 'tmux' && server) {
        const pane = server.panes.find((candidate) => candidate.panePid === owner.panePid);
        // A pane not listed has just closed, or is in a session never shown.
        if (!pane) continue;
        const key = `${server.pid}:${pane.paneId}`;
        inPanes.set(key, [...(inPanes.get(key) ?? []), entry]);
      } else {
        alone.push(entry);
      }
    }

    const items: MacSessionItem[] = [];
    for (const server of discovery.servers) {
      items.push(...this.tmuxRows(server, table, ctx, tmux, inPanes, index, agentIds));
    }
    for (const entry of alone) {
      if (this.isHiddenAgent(entry.agent, discovery)) continue;
      items.push(this.agentRow(entry, discovery, index, agentIds));
    }

    const shown = this.visible(items, settings);
    shown.sort(compareItems);
    if (shown.length > MAX_ITEMS) warnings.push({ code: 'truncated' });
    const listed = shown.slice(0, MAX_ITEMS);

    // Only what is listed can be acted on.
    const listedIds = new Set<string>();
    for (const item of listed) {
      listedIds.add(item.id);
      if (item.kind === 'tmux') for (const agent of item.agents) listedIds.add(agent.chatId);
    }
    this.index = new Map([...index].filter(([id]) => listedIds.has(id)));
    this.agentIds = new Map([...agentIds].filter(([, ids]) => listedIds.has(ids.chatId)));

    return {
      enabled: true,
      platform: this.platform(),
      scannedAt: new Date(now).toISOString(),
      openMode: settings.openMode,
      tmux: {
        available: tmux.available,
        ...(tmux.version ? { version: tmux.version } : {}),
        canOpen: tmux.canOpen,
      },
      items: listed,
      warnings,
    };
  }

  private tmuxRows(
    server: TmuxServer,
    table: ProcessTable,
    ctx: OwnershipContext,
    tmux: TmuxAvailability,
    inPanes: Map<string, PaneAgent[]>,
    index: Map<string, MacSessionTarget>,
    agentIds: Map<string, ListedAgentIds>
  ): MacTmuxSession[] {
    const sessions = new Map<string, TmuxServer['panes']>();
    for (const pane of server.panes) {
      sessions.set(pane.sessionId, [...(sessions.get(pane.sessionId) ?? []), pane]);
    }
    const rows: MacTmuxSession[] = [];
    for (const [sessionId, panes] of sessions) {
      const id = `t-${server.pid}-${server.startSec}-${sessionId.slice(1)}`;
      const first = panes[0];
      const current =
        panes.find((pane) => pane.windowActive && pane.paneActive) ??
        panes.find((pane) => pane.windowActive) ??
        first;
      index.set(id, {
        kind: 'tmux',
        socketPath: server.socketPath,
        serverPid: server.pid,
        serverStartedAt: server.startSec,
        tmuxSessionId: sessionId,
        name: first.sessionName,
      });

      const agents: Array<MacTmuxPaneAgent & { paneIndex: number }> = [];
      for (const pane of panes) {
        const here = inPanes.get(`${server.pid}:${pane.paneId}`);
        if (!here) continue;
        // Of agents in one pane (one started from another), the one nearest the pane.
        const { agent, state } = here.reduce((a, b) =>
          ancestors(table, b.agent.pid).length < ancestors(table, a.agent.pid).length ? b : a
        );
        const chatId = `p-${server.pid}-${server.startSec}-${pane.paneId.slice(1)}`;
        index.set(chatId, {
          kind: 'pane',
          socketPath: server.socketPath,
          serverPid: server.pid,
          serverStartedAt: server.startSec,
          paneId: pane.paneId,
          panePid: pane.panePid,
          agentPid: agent.pid,
          agentStart: agent.lstart,
          agent: agent.agent,
          ...(agent.cwd || pane.path ? { cwd: agent.cwd || pane.path } : {}),
        });
        agentIds.set(`${agent.pid}|${agent.lstart}`, {
          chatId,
          tmuxId: id,
          tmuxName: first.sessionName,
          windowIndex: pane.windowIndex,
        });
        agents.push({
          agent: agent.agent,
          chatId,
          ...(state.status ? { status: state.status } : {}),
          ...(state.title ? { title: state.title } : {}),
          ...(state.conversationId ? { conversationId: state.conversationId } : {}),
          startedAt: agent.startedAt,
          ...(agent.cwd || pane.path ? { cwd: agent.cwd || pane.path } : {}),
          windowIndex: pane.windowIndex,
          windowName: pane.windowName,
          inCurrentWindow: pane.windowActive,
          activePane: pane.paneActive,
          paneIndex: pane.paneIndex,
        });
      }
      // The primary first: the most urgent, then the pane on screen, the current window, the
      // lowest window.
      agents.sort(
        (a, b) =>
          urgency(a.status) - urgency(b.status) ||
          Number(b.inCurrentWindow && b.activePane) - Number(a.inCurrentWindow && a.activePane) ||
          Number(b.inCurrentWindow) - Number(a.inCurrentWindow) ||
          a.windowIndex - b.windowIndex ||
          a.paneIndex - b.paneIndex
      );

      const alsoOpenIn = new Set<string>();
      // The Untether session attached to it: one whose own program is the client first (ending
      // it only disconnects), else one the client runs in (`tmux attach` typed in its shell).
      let ut: { id: string; mode: MacOpenMode; client: boolean } | undefined;
      for (const client of server.clients) {
        if (client.sessionId !== sessionId) continue;
        const owner = classifyProcess(table, client.pid, ctx);
        if (owner.owner === 'untether') {
          if (!owner.sessionId || ut?.client) continue;
          // A `ut tmux attach` in a terminal window is that window's client, not Untether's.
          // 2026-10-20: checked by id only, so a Terminal-window session spawned from the web
          // (UUID id, `forwarderPid` in session.json) counted as Untether's own client and
          // ending it was offered as "only disconnects" while it closed the window's program.
          const own =
            ctx.sessionPids.get(client.pid) === owner.sessionId &&
            !ctx.forwardedSessionIds?.has(owner.sessionId) &&
            !isForwardedSession({ id: owner.sessionId });
          if (!ut || own) {
            ut = { id: owner.sessionId, mode: client.readOnly ? 'watch' : 'control', client: own };
          }
        } else if (owner.owner === 'mac' && owner.app) {
          alsoOpenIn.add(owner.app);
        }
      }

      if (
        this.isHiddenAgentMade({
          inAppTerminal: alsoOpenIn.size > 0,
          serverMarked: server.agentMarked,
          defaultServer: server.isDefault,
          folders: panes.map((pane) => pane.path),
        })
      ) {
        continue;
      }

      const label = paneLabel(current.command, current.path, current.title);
      const since = agents[0]?.status?.since;
      const activity = Math.max(first.sessionActivity * 1000, since ?? 0);
      rows.push({
        kind: 'tmux',
        id,
        name: first.sessionName,
        server: { label: server.label, isDefault: server.isDefault },
        windows: first.sessionWindows,
        createdAt: iso(first.sessionCreated),
        activityAt: new Date(activity).toISOString(),
        current: {
          windowIndex: current.windowIndex,
          windowName: current.windowName,
          ...(label.command ? { command: label.command } : {}),
          ...(label.title ? { title: label.title } : {}),
          ...(label.path ? { cwd: label.path } : {}),
          width: current.windowWidth,
          height: current.windowHeight,
        },
        agents: agents.map(({ paneIndex: _paneIndex, ...agent }) => agent),
        alsoOpenIn: [...alsoOpenIn],
        ...(ut ? { utSessionId: ut.id, utMode: ut.mode, utClient: ut.client } : {}),
        canOpen: tmux.canOpen,
        ...(tmux.canOpen ? {} : { cannotOpenReason: 'tmux-too-old' as const }),
      });
    }
    return rows;
  }

  /** An agent on its own: in an agent-made server nobody can list, or in a scratch folder. */
  private isHiddenAgent(agent: PlacedAgent, discovery: TmuxDiscovery): boolean {
    const { owner } = agent;
    const server =
      owner.owner === 'tmux'
        ? discovery.unlisted.find((candidate) => candidate.pid === owner.serverPid)
        : undefined;
    return this.isHiddenAgentMade({
      inAppTerminal: owner.owner === 'mac' && !!owner.app,
      serverMarked: !!server?.agentMarked,
      defaultServer: !!server?.isDefault,
      folders: [agent.cwd],
    });
  }

  private isHiddenAgentMade(facts: AgentMadeFacts): boolean {
    if (this.onlyInFolders().length > 0) return false;
    this.scratchRoots ??= agentScratchRoots(this.discovery().uid, this.deps.env ?? process.env);
    return isAgentMade(facts, this.scratchRoots);
  }

  private agentRow(
    { agent, state }: PaneAgent,
    discovery: TmuxDiscovery,
    index: Map<string, MacSessionTarget>,
    agentIds: Map<string, ListedAgentIds>
  ): MacAgentSession {
    const id = `a-${agent.pid}-${agent.startSec}`;
    index.set(id, {
      kind: 'agent',
      pid: agent.pid,
      lstart: agent.lstart,
      agent: agent.agent,
      ...(agent.cwd ? { cwd: agent.cwd } : {}),
      ...(agent.claudeDir ? { claudeDir: agent.claudeDir } : {}),
    });
    agentIds.set(`${agent.pid}|${agent.lstart}`, { chatId: id });
    const { owner } = agent;
    let inTmux: MacAgentSession['inTmux'];
    if (owner.owner === 'tmux') {
      // A tmux server that can't be listed (socket deleted, no answer): read-only on its own.
      const unlisted = discovery.unlisted.find((server) => server.pid === owner.serverPid);
      const name = owner.socketPath ? path.basename(owner.socketPath) : 'default';
      inTmux = { server: unlisted?.label ?? (name === 'default' ? '' : name) };
    }
    return {
      kind: 'agent',
      id,
      chatId: id,
      agent: agent.agent,
      ...(state.status ? { status: state.status } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(state.conversationId ? { conversationId: state.conversationId } : {}),
      startedAt: agent.startedAt,
      ...(agent.cwd ? { cwd: agent.cwd } : {}),
      ...(owner.owner === 'mac' && owner.app ? { app: owner.app } : {}),
      ...(agent.tty ? { tty: agent.tty } : {}),
      ...(inTmux ? { inTmux } : {}),
    };
  }

  /**
   * What the folder filters let through. With ONLY_IN set, only what runs inside its folders,
   * hidden or not: a QA server limited to its own folder still lists it when the shared
   * config.json hides that folder from the user's live server. Otherwise everything but what
   * runs inside a hidden folder (settings.hideIn). Folders are compared with links resolved.
   */
  private visible(items: MacSessionItem[], settings: MacSessionsSettings): MacSessionItem[] {
    const onlyIn = this.onlyInFolders();
    if (onlyIn.length > 0) return items.filter((item) => this.isInside(folderOf(item), onlyIn));
    const hideIn = this.realFolders(settings.hideIn ?? []);
    if (hideIn.length === 0) return items;
    return items.filter((item) => !this.isInside(folderOf(item), hideIn));
  }

  private onlyInFolders(): string[] {
    return this.realFolders(folderList((this.deps.env ?? process.env)[MAC_SESSIONS_ONLY_IN_ENV]));
  }

  private realFolders(folders: string[]): string[] {
    const realpath = this.deps.realpath ?? realpathOr;
    return folders.map((folder) => realpath(folder));
  }

  private isInside(folder: string | undefined, roots: string[]): boolean {
    if (!folder) return false;
    const real = (this.deps.realpath ?? realpathOr)(folder);
    return roots.some(
      (root) =>
        real === root || real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
    );
  }
}
