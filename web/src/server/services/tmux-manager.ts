import { execFile, execFileSync } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import type { TmuxPane, TmuxSession, TmuxWindow } from '../../shared/tmux-types.js';
import { type SessionCreateOptions, TitleMode } from '../../shared/types.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createLogger } from '../utils/logger.js';
import { terminalSessionEnv } from '../utils/session-env.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('TmuxManager');

/**
 * Between the fields of tmux's list output. Names, paths and titles are free text: with "|",
 * a path holding one spilled into the title and a pane title holding one shifted every field
 * after it (review of 2026-10-03). Printable ASCII on purpose: tmux 3.4/3.5 escape control
 * characters as "\\037", and 3.6+ turn them into "_" for a client without a UTF-8 locale.
 */
export const TMUX_FIELD_SEPARATOR = '~|ut|~';
const FIELD = TMUX_FIELD_SEPARATOR;
const fields = (...formats: string[]) => formats.join(FIELD);

/**
 * No tmux server to ask: "no server running", or, from tmux on macOS, "error connecting to
 * /private/tmp/tmux-501/default (No such file or directory)" (no socket) or "(Connection
 * refused)" (a stale one). An empty list, not an error: logged as ERROR and answered with a
 * 500 on every session list poll (2026-10-03).
 */
export function isNoTmuxServer(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? ''}\n${(error as { stderr?: string })?.stderr ?? ''}`;
  return (
    text.includes('no server running') ||
    /error connecting to .*\((?:No such file or directory|Connection refused)\)/.test(text)
  );
}

/**
 * What tells tmux sessions apart in the phone's list, beyond "0" and "1": the active pane's
 * title (Claude Code sets it to the conversation's, "✳ StableGrowthCoin simulator"; its
 * status glyph is dropped, and tmux's default, the host name, is not a title), its program
 * (Claude Code's native binary runs under its version, "2.1.283": shown as "claude") and its
 * folder.
 */
export function paneLabel(
  command: string | undefined,
  path: string | undefined,
  rawTitle: string | undefined
): { title?: string; command?: string; path?: string } {
  const host = os.hostname();
  const title = (rawTitle ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // 2026-10-03: a pane keeps the host name tmux gave it when it was made, and macOS renames the
  // Mac when its name is taken on the network (My-Mac-1234.local → My-Mac-5678.local).
  // After that every plain shell was titled with the old name, so a Bonjour name (one word
  // ending in .local) counts as the host too: programs don't title themselves like that.
  const isHost =
    !title || title === host || title === host.split('.')[0] || /^\S+\.local$/i.test(title);
  const program = command?.trim();
  return {
    ...(isHost ? {} : { title }),
    ...(program ? { command: /^\d+(?:\.\d+)+$/.test(program) ? 'claude' : program } : {}),
    ...(path?.trim() ? { path: path.trim() } : {}),
  };
}

export class TmuxManager {
  private static instance: TmuxManager;
  private ptyManager: PtyManager;

  private constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager;
  }

  /**
   * Validate session name to prevent command injection
   */
  private validateSessionName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Session name must be a non-empty string');
    }
    // Only allow alphanumeric, dash, underscore, and dot
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(
        'Session name can only contain letters, numbers, dots, dashes, and underscores'
      );
    }
    if (name.length > 100) {
      throw new Error('Session name too long (max 100 characters)');
    }
  }

  /**
   * Validate window index
   */
  private validateWindowIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 999) {
      throw new Error('Window index must be an integer between 0 and 999');
    }
  }

  /**
   * Validate pane index
   */
  private validatePaneIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 999) {
      throw new Error('Pane index must be an integer between 0 and 999');
    }
  }

  static getInstance(ptyManager: PtyManager): TmuxManager {
    if (!TmuxManager.instance) {
      TmuxManager.instance = new TmuxManager(ptyManager);
    }
    return TmuxManager.instance;
  }

  /**
   * Check if tmux is installed and available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['tmux']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all tmux sessions
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-sessions',
        '-F',
        fields(
          '#{session_name}',
          '#{session_windows}',
          '#{session_created}',
          '#{?session_attached,attached,detached}',
          '#{session_activity}',
          '#{?session_active,active,}',
          '#{pane_current_command}',
          '#{pane_current_path}',
          '#{pane_title}'
        ),
      ]);

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line?.includes(FIELD))
        .map((line) => {
          const [name, windows, created, attached, activity, current, command, path, title] =
            line.split(FIELD);
          return {
            name,
            windows: Number.parseInt(windows, 10),
            created,
            attached: attached === 'attached',
            activity,
            current: current === 'active',
            ...paneLabel(command, path, title ?? ''),
          };
        });
    } catch (error) {
      if (isNoTmuxServer(error)) return [];
      throw error;
    }
  }

  /**
   * List windows in a tmux session
   */
  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    this.validateSessionName(sessionName);

    try {
      const { stdout } = await execFileAsync('tmux', [
        'list-windows',
        '-t',
        sessionName,
        '-F',
        fields(
          '#{session_name}',
          '#{window_index}',
          '#{window_name}',
          '#{?window_active,active,}',
          '#{window_panes}'
        ),
      ]);

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line)
        .map((line) => {
          const [session, index, name, active, panes] = line.split(FIELD);
          return {
            session,
            index: Number.parseInt(index, 10),
            name,
            active: active === 'active',
            panes: Number.parseInt(panes, 10),
          };
        });
    } catch (error) {
      logger.error('Failed to list windows', { sessionName, error });
      throw error;
    }
  }

  /**
   * List panes in a window
   */
  async listPanes(sessionName: string, windowIndex?: number): Promise<TmuxPane[]> {
    this.validateSessionName(sessionName);
    if (windowIndex !== undefined) {
      this.validateWindowIndex(windowIndex);
    }

    try {
      const targetArgs =
        windowIndex !== undefined ? [sessionName, String(windowIndex)].join(':') : sessionName;

      const { stdout } = await execFileAsync('tmux', [
        'list-panes',
        '-t',
        targetArgs,
        '-F',
        fields(
          '#{session_name}',
          '#{window_index}',
          '#{pane_index}',
          '#{?pane_active,active,}',
          '#{pane_title}',
          '#{pane_pid}',
          '#{pane_current_command}',
          '#{pane_width}',
          '#{pane_height}',
          '#{pane_current_path}'
        ),
      ]);

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line)
        .map((line) => {
          const [session, window, index, active, title, pid, command, width, height, currentPath] =
            line.split(FIELD);
          return {
            session,
            window: Number.parseInt(window, 10),
            index: Number.parseInt(index, 10),
            active: active === 'active',
            title: title || undefined,
            pid: pid ? Number.parseInt(pid, 10) : undefined,
            command: command || undefined,
            width: Number.parseInt(width, 10),
            height: Number.parseInt(height, 10),
            currentPath: currentPath || undefined,
          };
        });
    } catch (error) {
      logger.error('Failed to list panes', { sessionName, windowIndex, error });
      throw error;
    }
  }

  /**
   * Create a new tmux session
   */
  async createSession(name: string, command?: string[]): Promise<void> {
    this.validateSessionName(name);

    try {
      const args = ['new-session', '-d', '-s', name];

      // If command is provided, add it as separate arguments
      if (command && command.length > 0) {
        // Validate command arguments
        for (const arg of command) {
          if (typeof arg !== 'string') {
            throw new Error('Command arguments must be strings');
          }
        }
        args.push(...command);
      }

      // 2026-10-04: this may start the tmux server, and the server and every pane in it keep
      // the environment it starts with: give it a session's environment, not the server's
      // (no UNTETHER_PASSWORD, JWT_SECRET or launching Claude Code identity).
      await execFileAsync('tmux', args, { env: terminalSessionEnv(process.env, {}) });
      logger.info('Created tmux session', { name, command });
    } catch (error) {
      logger.error('Failed to create tmux session', { name, error });
      throw error;
    }
  }

  /**
   * Attach to a tmux session/window/pane through Untether
   */
  async attachToTmux(
    sessionName: string,
    windowIndex?: number,
    paneIndex?: number,
    options?: Partial<SessionCreateOptions>
  ): Promise<string> {
    let target = sessionName;
    if (windowIndex !== undefined) {
      target = `${sessionName}:${windowIndex}`;
      if (paneIndex !== undefined) {
        target = `${target}.${paneIndex}`;
      }
    }

    // Always attach to session/window level, not individual panes
    // This gives users full control over pane management once attached
    const attachTarget = windowIndex !== undefined ? `${sessionName}:${windowIndex}` : sessionName;
    const tmuxCommand = ['tmux', 'attach-session', '-t', attachTarget];

    // Create a new Untether session that runs tmux attach
    const sessionOptions: SessionCreateOptions = {
      name: `tmux: ${target}`,
      workingDir: options?.workingDir || process.env.HOME || '/',
      cols: options?.cols || 80,
      rows: options?.rows || 24,
      titleMode: options?.titleMode || TitleMode.STATIC,
    };

    const session = await this.ptyManager.createSession(tmuxCommand, sessionOptions);
    return session.sessionId;
  }

  /**
   * Kill a tmux session
   */
  async killSession(sessionName: string): Promise<void> {
    this.validateSessionName(sessionName);

    try {
      await execFileAsync('tmux', ['kill-session', '-t', sessionName]);
      logger.info('Killed tmux session', { sessionName });
    } catch (error) {
      logger.error('Failed to kill tmux session', { sessionName, error });
      throw error;
    }
  }

  /**
   * Kill a tmux window
   */
  async killWindow(sessionName: string, windowIndex: number): Promise<void> {
    this.validateSessionName(sessionName);
    this.validateWindowIndex(windowIndex);

    try {
      const target = `${sessionName}:${windowIndex}`;
      await execFileAsync('tmux', ['kill-window', '-t', target]);
      logger.info('Killed tmux window', { sessionName, windowIndex });
    } catch (error) {
      logger.error('Failed to kill tmux window', { sessionName, windowIndex, error });
      throw error;
    }
  }

  /**
   * Kill a tmux pane
   */
  async killPane(sessionName: string, paneId: string): Promise<void> {
    // Validate paneId format (should be session:window.pane)
    if (!paneId || typeof paneId !== 'string') {
      throw new Error('Pane ID must be a non-empty string');
    }

    // Basic validation for pane ID format
    if (!/^[a-zA-Z0-9._:-]+$/.test(paneId)) {
      throw new Error('Invalid pane ID format');
    }

    try {
      await execFileAsync('tmux', ['kill-pane', '-t', paneId]);
      logger.info('Killed tmux pane', { sessionName, paneId });
    } catch (error) {
      logger.error('Failed to kill tmux pane', { sessionName, paneId, error });
      throw error;
    }
  }

  /**
   * Check if inside a tmux session
   */
  isInsideTmux(): boolean {
    return !!process.env.TMUX;
  }

  /**
   * Get the current tmux session name if inside tmux
   */
  getCurrentSession(): string | null {
    if (!this.isInsideTmux()) {
      return null;
    }
    try {
      const result = execFileSync('tmux', ['display-message', '-p', '#{session_name}'], {
        encoding: 'utf8',
      });
      return result.trim();
    } catch {
      return null;
    }
  }
}
