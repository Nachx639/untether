import type { PropertyValues } from 'lit';
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type {
  MultiplexerStatus,
  MultiplexerTarget,
  MultiplexerType,
  TmuxPane,
  TmuxWindow,
} from '../../shared/multiplexer-types.js';
import { LocaleController, t } from '../i18n/index.js';
import { apiClient } from '../services/api-client.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import './modal-wrapper.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { icon } from './icons.js';

@customElement('multiplexer-modal')
export class MultiplexerModal extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind classes
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean, reflect: true })
  open = false;

  @state()
  private activeTab: MultiplexerType = 'tmux';

  @state()
  private multiplexerStatus: MultiplexerStatus | null = null;

  @state()
  private windows: Map<string, TmuxWindow[]> = new Map();

  @state()
  private panes: Map<string, TmuxPane[]> = new Map();

  @state()
  private expandedSessions: Set<string> = new Set();

  @state()
  private expandedWindows: Set<string> = new Set();

  @state()
  private loading = true;

  @state()
  private error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    // 2026-11-10: a modal mounted already open loaded twice (here and in its first updated()).
    // Only a reconnect after the first render needs its own load.
    if (this.open && this.hasUpdated) void this.loadMultiplexerStatus();
  }

  protected updated(changedProps: PropertyValues) {
    if (changedProps.has('open') && this.open) {
      void this.loadMultiplexerStatus();
    }
  }

  private async loadMultiplexerStatus() {
    this.loading = true;
    this.error = null;

    try {
      // Get status of all multiplexers
      const statusResponse = await apiClient.get<MultiplexerStatus>('/multiplexer/status');
      this.multiplexerStatus = statusResponse;

      // Set active tab to first available multiplexer
      if (!statusResponse.tmux.available) {
        if (statusResponse.zellij.available) {
          this.activeTab = 'zellij';
        } else if (statusResponse.screen.available) {
          this.activeTab = 'screen';
        }
      }

      // Load windows for tmux sessions
      this.windows.clear();
      if (statusResponse.tmux.available) {
        for (const session of statusResponse.tmux.sessions) {
          try {
            const windowsResponse = await apiClient.get<{ windows: TmuxWindow[] }>(
              `/multiplexer/tmux/sessions/${encodeURIComponent(session.name)}/windows`
            );
            this.windows.set(session.name, windowsResponse.windows);
          } catch (error) {
            console.error(`Failed to load windows for tmux session ${session.name}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load multiplexer status:', error);
      this.error = t('tmux.error.load');
    } finally {
      this.loading = false;
    }
  }

  private toggleSession(sessionName: string) {
    if (this.expandedSessions.has(sessionName)) {
      this.expandedSessions.delete(sessionName);
    } else {
      this.expandedSessions.add(sessionName);
    }
    this.requestUpdate();
  }

  private toggleWindow(sessionName: string, windowIndex: number) {
    const key = `${sessionName}:${windowIndex}`;
    if (this.expandedWindows.has(key)) {
      this.expandedWindows.delete(key);
    } else {
      this.expandedWindows.add(key);
      // Load panes for this window if not already loaded
      this.loadPanesForWindow(sessionName, windowIndex);
    }
    this.requestUpdate();
  }

  private async loadPanesForWindow(sessionName: string, windowIndex: number) {
    const key = `${sessionName}:${windowIndex}`;
    if (this.panes.has(key)) return; // Already loaded

    try {
      const response = await apiClient.get<{ panes: TmuxPane[] }>(
        `/multiplexer/tmux/sessions/${encodeURIComponent(sessionName)}/panes?window=${windowIndex}`
      );
      this.panes.set(key, response.panes);
      this.requestUpdate();
    } catch (error) {
      console.error(`Failed to load panes for window ${key}:`, error);
    }
  }

  private formatTimestamp(timestamp: string): string {
    const ts = Number.parseInt(timestamp, 10);
    if (Number.isNaN(ts)) return timestamp;

    const now = Math.floor(Date.now() / 1000);
    const diff = now - ts;

    if (diff < 60) return t('time.secondsAgo', { n: diff });
    if (diff < 3600) return t('time.minutesAgo', { n: Math.floor(diff / 60) });
    if (diff < 86400) return t('time.hoursAgo', { n: Math.floor(diff / 3600) });
    return t('time.daysAgo', { n: Math.floor(diff / 86400) });
  }

  private formatPaneInfo(pane: TmuxPane): string {
    // If we have a meaningful title that's not just the hostname, use it
    if (pane.title && !pane.title.includes('< /dev/null') && !pane.title.match(/^[\w.-]+$/)) {
      return pane.title;
    }

    // If we have a current path, show it with the command
    if (pane.currentPath && pane.command) {
      // Simple home directory replacement for display
      const shortPath = pane.currentPath.replace(/^\/Users\/[^/]+/, '~');
      return `${pane.command} (${shortPath})`;
    }

    // Otherwise just show command or 'shell'
    return pane.command || 'shell';
  }

  private async attachToSession(target: MultiplexerTarget) {
    this.error = null;
    try {
      const response = await apiClient.post<{
        success: boolean;
        sessionId?: string;
        command?: string;
      }>('/multiplexer/attach', {
        type: target.type,
        sessionName: target.session,
        windowIndex: target.window,
        paneIndex: target.pane,
        cols: window.innerWidth > 768 ? 120 : 80,
        rows: window.innerHeight > 600 ? 30 : 24,
        titleMode: 'static',
        metadata: {
          source: 'multiplexer-modal',
        },
      });

      if (response.success) {
        // Close modal and navigate to the new session
        this.handleClose();
        // Dispatch navigation event that the app can handle
        this.dispatchEvent(
          new CustomEvent('navigate-to-session', {
            detail: { sessionId: response.sessionId },
            bubbles: true,
            composed: true,
          })
        );
      }
    } catch (error) {
      console.error(`Failed to attach to ${target.type} session:`, error);
      this.error = t('tmux.error.attach', { multiplexer: target.type });
    }
  }

  private async createNewSession() {
    this.error = null;
    try {
      // Generate a unique session name
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const sessionName = `session-${timestamp}`;

      if (this.activeTab === 'tmux' || this.activeTab === 'screen') {
        // For tmux and screen, create the session first
        const createResponse = await apiClient.post<{ success: boolean }>('/multiplexer/sessions', {
          type: this.activeTab,
          name: sessionName,
        });

        if (!createResponse.success) {
          throw new Error(`Failed to create ${this.activeTab} session`);
        }
      }

      // For all multiplexers, attach to the session
      // Zellij will create the session automatically with the -c flag
      const attachResponse = await apiClient.post<{
        success: boolean;
        sessionId?: string;
        command?: string;
      }>('/multiplexer/attach', {
        type: this.activeTab,
        sessionName: sessionName,
        cols: window.innerWidth > 768 ? 120 : 80,
        rows: window.innerHeight > 600 ? 30 : 24,
        titleMode: 'static',
        metadata: {
          source: 'multiplexer-modal-new',
        },
      });

      if (attachResponse.success) {
        // Close modal and navigate to the new session
        this.handleClose();
        this.dispatchEvent(
          new CustomEvent('navigate-to-session', {
            detail: { sessionId: attachResponse.sessionId },
            bubbles: true,
            composed: true,
          })
        );
      }
    } catch (error) {
      console.error(`Failed to create new ${this.activeTab} session:`, error);
      this.error = t('tmux.error.create', { multiplexer: this.activeTab });
    }
  }

  private async killSession(type: MultiplexerType, sessionName: string) {
    if (
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('tmux.confirmKillSession', { name: sessionName }),
        confirmLabel: t('tmux.kill'),
        tone: 'danger',
      }))
    ) {
      return;
    }

    this.error = null;
    try {
      const response = await apiClient.delete<{ success: boolean }>(
        `/multiplexer/${encodeURIComponent(type)}/sessions/${encodeURIComponent(sessionName)}`
      );
      if (response.success) {
        await this.loadMultiplexerStatus();
      }
    } catch (error) {
      console.error(`Failed to kill ${type} session:`, error);
      this.error = t('tmux.error.killSession', { multiplexer: type });
    }
  }

  private async killWindow(sessionName: string, windowIndex: number) {
    if (
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('tmux.confirmKillWindow', { index: windowIndex }),
        confirmLabel: t('tmux.killWindow'),
        tone: 'danger',
      }))
    ) {
      return;
    }

    this.error = null;
    try {
      const response = await apiClient.delete<{ success: boolean }>(
        `/multiplexer/tmux/sessions/${encodeURIComponent(sessionName)}/windows/${windowIndex}`
      );
      if (response.success) {
        await this.loadMultiplexerStatus();
      }
    } catch (error) {
      console.error(`Failed to kill window:`, error);
      this.error = t('tmux.error.killWindow');
    }
  }

  private async killPane(sessionName: string, paneId: string) {
    if (
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('tmux.confirmKillPane'),
        confirmLabel: t('tmux.killPane'),
        tone: 'danger',
      }))
    ) {
      return;
    }

    this.error = null;
    try {
      const response = await apiClient.delete<{ success: boolean }>(
        `/multiplexer/tmux/sessions/${encodeURIComponent(sessionName)}/panes/${encodeURIComponent(paneId)}`
      );
      if (response.success) {
        // Reload panes for the affected window
        this.panes.clear();
        this.expandedWindows.forEach((key) => {
          const [session, windowStr] = key.split(':');
          if (session === sessionName) {
            this.loadPanesForWindow(session, Number.parseInt(windowStr, 10));
          }
        });
      }
    } catch (error) {
      console.error(`Failed to kill pane:`, error);
      this.error = t('tmux.error.killPane');
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private switchTab(type: MultiplexerType) {
    this.activeTab = type;
  }

  render() {
    if (!this.open) return null;

    const status = this.multiplexerStatus;
    const activeMultiplexer = status ? status[this.activeTab] : null;

    return html`
      <!-- The fixed modal-wrapper frames one root: header, tabs + list, footer (design spec
           5.3). min-w-0 so a long tmux title never pushes the dialog past a phone. -->
      <modal-wrapper
        class="min-w-0"
        .open=${this.open}
        .ariaLabel=${t('tmux.title')}
        contentClass="ut-dialog ut-dialog--md mx-dialog"
        initialFocus='[role="tab"][aria-selected="true"]'
        @close=${this.handleClose}
      >
        <div>
          <div class="ut-dialog-header">
            <h2 class="m-0 text-title font-semibold text-text-bright truncate">${t('tmux.title')}</h2>
            <button
              type="button"
              class="ut-icon-btn"
              data-modal-close
              aria-label=${t('common.close')}
              title=${`${t('common.close')} (⎋)`}
              @click=${this.handleClose}
            >
              ${icon('x')}
            </button>
          </div>
          <div class="ut-dialog-body mx-body">
            <!-- 2026-11-10: a failed attach or kill replaced the whole list with its message;
                 now it sits above the list, which stays. -->
            ${
              this.error
                ? html`<div class="mb-4 p-3 rounded-card bg-bg-tertiary text-text-muted text-center" role="alert" data-testid="multiplexer-error">${this.error}</div>`
                : nothing
            }
            ${
              status &&
              (status.tmux.available || status.zellij.available || status.screen.available)
                ? html`
                <div class="ut-segmented mb-4" role="tablist">
                  ${
                    status.tmux.available
                      ? html`
                      <button
                        type="button"
                        role="tab"
                        aria-selected=${this.activeTab === 'tmux' ? 'true' : 'false'}
                        @click=${() => this.switchTab('tmux')}
                      >
                        tmux
                        <span class="text-text-dim tnum">${status.tmux.sessions.length}</span>
                      </button>
                    `
                      : null
                  }
                  ${
                    status.zellij.available
                      ? html`
                      <button
                        type="button"
                        role="tab"
                        aria-selected=${this.activeTab === 'zellij' ? 'true' : 'false'}
                        @click=${() => this.switchTab('zellij')}
                      >
                        Zellij
                        <span class="text-text-dim tnum">${status.zellij.sessions.length}</span>
                      </button>
                    `
                      : null
                  }
                  ${
                    status.screen.available
                      ? html`
                      <button
                        type="button"
                        role="tab"
                        aria-selected=${this.activeTab === 'screen' ? 'true' : 'false'}
                        @click=${() => this.switchTab('screen')}
                      >
                        Screen
                        <span class="text-text-dim tnum">${status.screen.sessions.length}</span>
                      </button>
                    `
                      : null
                  }
                </div>
              `
                : null
            }

            ${
              this.loading
                ? html`<div class="mb-4 p-3 rounded-card bg-bg-tertiary text-text-muted text-center">${t('tmux.loading')}</div>`
                : !status
                  ? html`<div class="mb-4 p-3 rounded-card bg-bg-tertiary text-text-muted text-center">${t('tmux.noStatus')}</div>`
                  : !status.tmux.available && !status.zellij.available && !status.screen.available
                    ? html`
                      <div class="text-center py-10 text-text-muted">
                        <h3 class="m-0 mb-2 text-title font-semibold text-text">${t('tmux.noneInstalled.title')}</h3>
                        <p>${t('tmux.noneInstalled.body')}</p>
                        <p>${t('tmux.noneInstalled.hint')}</p>
                      </div>
                    `
                    : !activeMultiplexer?.available
                      ? html`
                        <div class="text-center py-10 text-text-muted">
                          <h3 class="m-0 mb-2 text-title font-semibold text-text">${t('tmux.unavailable.title', { multiplexer: this.activeTab })}</h3>
                          <p>${t('tmux.unavailable.body', { multiplexer: this.activeTab })}</p>
                          <p>${t('tmux.unavailable.hint', { multiplexer: this.activeTab })}</p>
                        </div>
                      `
                      : activeMultiplexer.sessions.length === 0
                        ? html`
                            <div class="text-center py-10 text-text-muted">
                              <h3 class="m-0 mb-2 text-title font-semibold text-text">${t('tmux.noSessions.title', { multiplexer: this.activeTab })}</h3>
                              <p>${t('tmux.noSessions.body', { multiplexer: this.activeTab })}</p>
                              <button type="button" class="ut-btn ut-btn--primary mt-4" @click=${this.createNewSession}>
                                ${t('tmux.createSession')}
                              </button>
                            </div>
                          `
                        : html`
                            <div class="flex flex-col gap-2">
                              ${repeat(
                                activeMultiplexer.sessions,
                                (session) => `${session.type}-${session.name}`,
                                (session) => {
                                  const sessionWindows = this.windows.get(session.name) || [];
                                  const isExpanded = this.expandedSessions.has(session.name);

                                  return html`
                          <div class="border border-border rounded-card overflow-hidden transition-colors hover:border-border-strong">
                            <!-- Stacked on phones: the buttons took half the row, cutting the title
                                 to "0 · Stable…" and covering "last activity". -->
                            <div
                              class="px-3 py-2.5 bg-bg-elevated cursor-pointer flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between transition-colors hover:bg-surface-hover"
                              data-testid="multiplexer-session-row"
                              @click=${() =>
                                session.type === 'tmux' ? this.toggleSession(session.name) : null}
                              style="cursor: ${session.type === 'tmux' ? 'pointer' : 'default'}"
                            >
                              <div class="flex-1 min-w-0">
                                <!-- "0" and "1" told nothing: the pane's title (Claude's
                                     conversation) and its program and folder do. -->
                                <div class="text-text mb-1 truncate" data-testid="multiplexer-session-name">
                                  <span class="font-semibold">${session.name}</span>${
                                    session.title
                                      ? html`<span class="text-text-muted"> · ${session.title}</span>`
                                      : nothing
                                  }
                                </div>
                                ${
                                  session.command || session.path
                                    ? html`<div
                                        class="text-xs text-text-muted font-mono truncate mb-1"
                                        data-testid="multiplexer-session-where"
                                      >
                                        ${[
                                          session.command,
                                          session.path ? formatPathForDisplay(session.path) : '',
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </div>`
                                    : nothing
                                }
                                <div class="text-caption text-text-muted flex gap-4">
                                  ${
                                    session.windows !== undefined
                                      ? html`<span>${t('tmux.windows', { n: session.windows })}</span>`
                                      : null
                                  }
                                  ${
                                    session.exited
                                      ? html`<span class="ut-status" data-status="exited-error"><span class="ut-dot"></span>${t('tmux.exited')}</span>`
                                      : null
                                  }
                                  ${
                                    session.activity
                                      ? html`<span>${t('tmux.lastActivity', { time: this.formatTimestamp(session.activity) })}</span>`
                                      : null
                                  }
                                </div>
                              </div>
                              <div class="flex items-center justify-end gap-2">
                                ${
                                  session.attached
                                    ? html`<span class="ut-dot" data-status="working" title=${t('tmux.attached')}></span>`
                                    : null
                                }
                                ${
                                  session.current
                                    ? html`<span class="ut-chip">${t('tmux.current')}</span>`
                                    : null
                                }
                                <button
                                  type="button"
                                  class="ut-btn ut-btn--secondary ut-btn--sm"
                                  @click=${(e: Event) => {
                                    e.stopPropagation();
                                    this.attachToSession({
                                      type: session.type,
                                      session: session.name,
                                    });
                                  }}
                                >
                                  ${t('tmux.attach')}
                                </button>
                                <button
                                  type="button"
                                  class="ut-btn ut-btn--danger-ghost ut-btn--sm"
                                  @click=${(e: Event) => {
                                    e.stopPropagation();
                                    this.killSession(session.type, session.name);
                                  }}
                                  title=${t('sessions.row.kill')}
                                >
                                  ${t('tmux.kill')}
                                </button>
                                ${
                                  session.type === 'tmux'
                                    ? html`<span class="inline-flex text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}">${icon('chevronRight', 14)}</span>`
                                    : null
                                }
                              </div>
                            </div>

                            ${
                              session.type === 'tmux' && isExpanded && sessionWindows.length > 0
                                ? html`
                                  <div class="px-2 py-2 pl-6 bg-bg-secondary border-t border-border">
                                    ${repeat(
                                      sessionWindows,
                                      (window) => `${session.name}-${window.index}`,
                                      (window) => {
                                        const windowKey = `${session.name}:${window.index}`;
                                        const isWindowExpanded =
                                          this.expandedWindows.has(windowKey);
                                        const windowPanes = this.panes.get(windowKey) || [];

                                        return html`
                                          <div>
                                            <div
                                              class="p-2 mb-1 rounded-rem cursor-pointer flex items-center justify-between transition-colors hover:bg-surface-hover ${window.active ? 'bg-bg-tertiary font-medium' : ''}"
                                              @click=${(e: Event) => {
                                                e.stopPropagation();
                                                if (window.panes > 1) {
                                                  this.toggleWindow(session.name, window.index);
                                                } else {
                                                  this.attachToSession({
                                                    type: session.type,
                                                    session: session.name,
                                                    window: window.index,
                                                  });
                                                }
                                              }}
                                            >
                                              <div class="flex items-center gap-2">
                                                <span class="font-mono text-sm text-text-muted">${window.index}:</span>
                                                <span>${window.name}</span>
                                              </div>
                                              <div class="flex items-center gap-2">
                                                <button
                                                  type="button" class="ut-btn ut-btn--danger-ghost ut-btn--sm"
                                                  @click=${(e: Event) => {
                                                    e.stopPropagation();
                                                    this.killWindow(session.name, window.index);
                                                  }}
                                                  title=${t('tmux.killWindow')}
                                                >
                                                  ${t('tmux.kill')}
                                                </button>
                                                <span class="text-xs text-text-dim">
                                                  ${t('tmux.panes', { n: window.panes })}
                                                  ${window.panes > 1 ? html`<span class="ml-2 inline-flex transition-transform ${isWindowExpanded ? 'rotate-90' : ''}">${icon('chevronRight', 12)}</span>` : ''}
                                                </span>
                                              </div>
                                            </div>
                                            
                                            ${
                                              isWindowExpanded && windowPanes.length > 0
                                                ? html`
                                                  <div class="px-1 py-1 pl-6 bg-bg-secondary border-t border-border">
                                                    ${repeat(
                                                      windowPanes,
                                                      (pane) =>
                                                        `${session.name}:${window.index}.${pane.index}`,
                                                      (pane) => html`
                                                        <div
                                                          class="px-2 py-1.5 mb-0.5 rounded-rem cursor-pointer flex items-center justify-between text-sm transition-colors hover:bg-surface-hover ${pane.active ? 'bg-bg-tertiary font-medium' : ''}"
                                                          @click=${(e: Event) => {
                                                            e.stopPropagation();
                                                            this.attachToSession({
                                                              type: session.type,
                                                              session: session.name,
                                                              window: window.index,
                                                              pane: pane.index,
                                                            });
                                                          }}
                                                        >
                                                          <div class="flex items-center gap-2">
                                                            <span class="font-mono text-xs text-text-muted">%${pane.index}</span>
                                                            <span class="text-text">${this.formatPaneInfo(pane)}</span>
                                                          </div>
                                                          <div class="flex items-center gap-2">
                                                            <button
                                                              type="button" class="ut-btn ut-btn--danger-ghost ut-btn--sm"
                                                              @click=${(e: Event) => {
                                                                e.stopPropagation();
                                                                this.killPane(
                                                                  session.name,
                                                                  `${session.name}:${window.index}.${pane.index}`
                                                                );
                                                              }}
                                                              title=${t('tmux.killPane')}
                                                            >
                                                              ${t('tmux.kill')}
                                                            </button>
                                                            <span class="text-xs text-text-dim">${pane.width}×${pane.height}</span>
                                                          </div>
                                                        </div>
                                                      `
                                                    )}
                                                  </div>
                                                `
                                                : null
                                            }
                                          </div>
                                        `;
                                      }
                                    )}
                                  </div>
                                `
                                : null
                            }
                          </div>
                        `;
                                }
                              )}
                  </div>
                `
            }

          </div>
          <div class="ut-dialog-footer">
            <button type="button" class="ut-btn ut-btn--ghost" @click=${this.handleClose}>
              ${t('common.close')} <kbd class="ut-kbd">⎋</kbd>
            </button>
            ${
              !this.loading && activeMultiplexer?.available && activeMultiplexer.sessions.length > 0
                ? html`
                  <button type="button" class="ut-btn ut-btn--primary" @click=${this.createNewSession}>
                    ${icon('plus')} ${t('actionBar.newSession')}
                  </button>
                `
                : null
            }
          </div>
        </div>
      </modal-wrapper>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multiplexer-modal': MultiplexerModal;
  }
}
