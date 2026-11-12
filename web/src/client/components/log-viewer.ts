import { html, LitElement, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { HttpMethod } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { serverConfigService } from '../services/server-config-service.js';
import { confirmDialog } from '../utils/confirm-dialog.js';
import { setServerDefaultLook } from '../utils/look.js';

/** How much of the log's end each poll asks for: the server's ceiling (MAX_LOG_TAIL_BYTES). */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

interface LogEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  isClient: boolean;
}

@customElement('log-viewer')
export class LogViewer extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @state() private logs: LogEntry[] = [];
  @state() private loading = true;
  @state() private filter = '';
  @state() private levelFilter: Set<string> = new Set(['error', 'warn', 'log', 'debug']);
  @state() private autoScroll = true;
  @state() private logSize = '';
  @state() private showClient = true;
  @state() private showServer = true;

  private refreshInterval?: number;
  private isFirstLoad = true;
  /** A poll is in flight: the next tick skips instead of piling a second download on it. */
  private loadInFlight = false;
  /** Bumped on disconnect: a response that comes back after it is dropped. */
  private loadEpoch = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    // This standalone document has no untether-app to load the selected look's sheet.
    void serverConfigService
      .loadConfig()
      .then((config) => setServerDefaultLook(config.look))
      .catch(() => {});
    void this.loadLogs();
    // Refresh logs every 2 seconds
    this.refreshInterval = window.setInterval(() => void this.loadLogs(), 2000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.loadEpoch++;
    this.loadInFlight = false;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  override updated(): void {
    // logs.html ships an English <title>: follow the UI language, also after a change.
    const title = `Untether - ${t('logs.title')}`;
    if (document.title !== title) document.title = title;
  }

  private async loadLogs(): Promise<void> {
    if (this.loadInFlight) return;
    this.loadInFlight = true;
    const epoch = this.loadEpoch;
    try {
      // Get log info
      const infoResponse = await fetch('/api/logs/info', {
        headers: { ...authClient.getAuthHeader() },
      });
      if (epoch !== this.loadEpoch) return;
      if (infoResponse.ok) {
        const info = await infoResponse.json();
        if (epoch !== this.loadEpoch) return;
        this.logSize = info.sizeHuman || '';
      }

      // Get the end of the raw log: the file grows to 50 MB before it rotates and this polls
      // every 2 seconds (2026-11-10: it downloaded the whole file each time). `tail` is in
      // bytes and the server caps it at 4 MB (routes/logs.ts MAX_LOG_TAIL_BYTES).
      const response = await fetch(`/api/logs/raw?tail=${LOG_TAIL_BYTES}`, {
        headers: { ...authClient.getAuthHeader() },
      });
      if (epoch !== this.loadEpoch) return;
      if (!response.ok) {
        throw new Error('Failed to load logs');
      }

      const text = await response.text();
      if (epoch !== this.loadEpoch) return;
      this.parseLogs(text);
      this.loading = false;

      // Auto-scroll to bottom if enabled and user is near bottom (or first load)
      if (this.autoScroll) {
        requestAnimationFrame(() => {
          const container = this.querySelector('.log-container');
          if (container) {
            if (this.isFirstLoad) {
              // Always scroll to bottom on first load
              container.scrollTop = container.scrollHeight;
              this.isFirstLoad = false;
            } else {
              // Only scroll if we're within 100px of the bottom
              const isNearBottom =
                container.scrollHeight - container.scrollTop - container.clientHeight < 100;
              if (isNearBottom) {
                container.scrollTop = container.scrollHeight;
              }
            }
          }
        });
      }
    } catch (err) {
      // Error is logged but not displayed in UI
      if (epoch !== this.loadEpoch) return;
      console.error('Failed to load logs:', err);
      this.loading = false;
    } finally {
      if (epoch === this.loadEpoch) this.loadInFlight = false;
    }
  }

  private formatRelativeTime(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) {
      return t('time.secondsAgo', { n: diffSec });
    } else if (diffMin < 60) {
      return t('time.minutesAgo', { n: diffMin });
    } else if (diffHour < 24) {
      return t('time.hoursAgo', { n: diffHour });
    } else {
      // For older logs, show HH:MM:SS
      return date.toLocaleTimeString('en-US', { hour12: false });
    }
  }

  private parseLogs(text: string): void {
    const lines = text.split('\n');
    const logs: LogEntry[] = [];
    let currentLog: LogEntry | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Try to parse as a new log entry
      const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+(.*)$/);
      if (match) {
        // If we have a current log, push it before starting a new one
        if (currentLog) {
          logs.push(currentLog);
        }

        const [, timestamp, level, module, message] = match;
        const isClient = module.startsWith('CLIENT:');
        currentLog = {
          timestamp,
          level: level.trim().toLowerCase(),
          module: isClient ? module.substring(7) : module, // Remove CLIENT: prefix
          message,
          isClient,
        };
      } else if (currentLog) {
        // This is a continuation line - append to the current log's message
        currentLog.message += `\n${line}`;
      } else {
        // Unparseable line with no current log - create a new entry
        logs.push({
          timestamp: '',
          level: 'log',
          module: 'unknown',
          message: line,
          isClient: false,
        });
      }
    }

    // Don't forget the last log
    if (currentLog) {
      logs.push(currentLog);
    }

    this.logs = logs;
  }

  private toggleLevel(level: string): void {
    if (this.levelFilter.has(level)) {
      this.levelFilter.delete(level);
    } else {
      this.levelFilter.add(level);
    }
    this.levelFilter = new Set(this.levelFilter); // Trigger re-render
  }

  private async clearLogs(): Promise<void> {
    if (
      !(await confirmDialog({
        title: t('confirm.defaultTitle'),
        body: t('logs.clearConfirm'),
        confirmLabel: t('logs.clear'),
        tone: 'danger',
      }))
    ) {
      return;
    }

    try {
      const response = await fetch('/api/logs/clear', {
        method: HttpMethod.DELETE,
        headers: { ...authClient.getAuthHeader() },
      });
      if (!response.ok) {
        throw new Error('Failed to clear logs');
      }
      this.logs = [];
      this.logSize = '0 Bytes';
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  }

  private async downloadLogs(): Promise<void> {
    try {
      const response = await fetch('/api/logs/raw', {
        headers: { ...authClient.getAuthHeader() },
      });
      if (!response.ok) {
        throw new Error('Failed to download logs');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `untether-logs-${new Date().toISOString().split('T')[0]}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download logs:', err);
    }
  }

  private computeFilteredLogs(): LogEntry[] {
    return this.logs.filter((log) => {
      // Filter by level
      if (!this.levelFilter.has(log.level)) {
        return false;
      }

      // Filter by client/server
      if (!this.showClient && log.isClient) {
        return false;
      }
      if (!this.showServer && !log.isClient) {
        return false;
      }

      // Filter by search term
      if (this.filter) {
        const searchTerm = this.filter.toLowerCase();
        return (
          log.module.toLowerCase().includes(searchTerm) ||
          log.message.toLowerCase().includes(searchTerm)
        );
      }

      return true;
    });
  }

  override render(): TemplateResult {
    // Add custom scrollbar styles
    const scrollbarStyles = html`
      <style>
        .log-container {
          /* Hide scrollbar by default */
          scrollbar-width: none; /* Firefox */
        }

        .log-container::-webkit-scrollbar {
          width: 8px;
          background: transparent;
        }

        .log-container::-webkit-scrollbar-track {
          background: transparent;
        }

        .log-container::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: var(--ut-r-sm);
        }

        /* Show scrollbar on hover */
        .log-container:hover::-webkit-scrollbar-thumb {
          background: color-mix(in srgb, var(--color-text-bright) 20%, transparent);
        }

        .log-container::-webkit-scrollbar-thumb:hover {
          background: color-mix(in srgb, var(--color-text-bright) 30%, transparent);
        }

        /* Firefox */
        .log-container:hover {
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, var(--color-text-bright) 20%, transparent) transparent;
        }
      </style>
    `;

    if (this.loading) {
      return html`
        <div class="flex items-center justify-center h-screen bg-bg text-primary">
          <div class="text-center">
            <div
              class="animate-spin rounded-pill h-12 w-12 border-4 border-primary border-t-transparent mb-4 mx-auto"
            ></div>
            <div>${t('logs.loading')}</div>
          </div>
        </div>
      `;
    }

    const levels = ['error', 'warn', 'log', 'debug'];
    // Once per render: the list and the counter below both read it.
    const filteredLogs = this.computeFilteredLogs();

    return html`
      ${scrollbarStyles}
      <div class="flex flex-col h-full bg-bg text-primary font-mono">
        <!-- Header - single row on desktop, two rows on mobile -->
        <div class="ut-surface--bar ut-surface--material bg-bg-secondary border-b border-border/50 p-3 sm:p-4">
          <!-- Mobile layout (two rows) -->
          <div class="sm:hidden">
            <!-- Top row with back button and title -->
            <div class="flex items-center gap-2 mb-3">
              <!-- Back button -->
              <button
                class="ut-surface--control p-2 bg-bg border border-border/50 rounded-rem text-sm text-primary hover:border-primary hover:text-primary transition-colors flex items-center gap-1 flex-shrink-0"
                aria-label=${t('logs.back')}
                @click=${() => {
                  window.location.href = '/';
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>

              <h1
                class="text-base font-bold text-primary flex items-center gap-2 flex-shrink-0"
              >
                <terminal-icon size="20"></terminal-icon>
                <span>${t('logs.title')}</span>
              </h1>

              <!-- Auto-scroll toggle (mobile position) -->
              <div class="ml-auto">
                <button
                  class="ut-surface--control p-2 text-xs uppercase font-bold rounded-rem transition-colors ${
                    this.autoScroll
                      ? 'bg-primary text-on-fill'
                      : 'bg-bg-tertiary text-text-muted border border-border/50'
                  }"
                  @click=${() => {
                    this.autoScroll = !this.autoScroll;
                  }}
                  title=${t('logs.autoScroll')}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M12 5v14M19 12l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Filters row -->
            <div class="flex flex-wrap gap-2">
              <!-- Search input -->
              <input
                type="text"
                class="ut-surface--inset px-3 py-1.5 bg-bg border border-border/50 rounded-rem text-sm text-primary placeholder-text-muted focus:outline-none focus:border-primary transition-colors w-full"
                placeholder=${t('logs.filter')}
                .value=${this.filter}
                @input=${(e: Event) => {
                  this.filter = (e.target as HTMLInputElement).value;
                }}
              />

              <!-- Filters container -->
              <div class="flex gap-2 items-center">
                <!-- Level filters -->
                <div class="flex gap-1">
                  ${levels.map(
                    (level) => html`
                      <button
                        class="ut-surface--control px-1.5 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                          this.levelFilter.has(level)
                            ? level === 'error'
                              ? 'bg-status-error/20 text-status-error border border-status-error'
                              : level === 'warn'
                                ? 'bg-status-warning/20 text-status-warning border border-status-warning'
                                : level === 'debug'
                                  ? 'bg-bg-tertiary text-text-muted border border-border'
                                  : 'bg-primary/20 text-primary border border-primary'
                            : 'bg-bg-tertiary text-text-muted border border-border'
                        }"
                        @click=${() => this.toggleLevel(level)}
                        title=${t('logs.levelTitle', { level })}
                      >
                        ${
                          level === 'error'
                            ? 'ERR'
                            : level === 'warn'
                              ? 'WRN'
                              : level === 'debug'
                                ? 'DBG'
                                : 'LOG'
                        }
                      </button>
                    `
                  )}
                </div>

                <!-- Client/Server toggles -->
                <div class="flex gap-1">
                  <button
                    class="ut-surface--control px-1.5 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                      this.showClient
                        ? 'bg-status-warning/20 text-status-warning border border-status-warning'
                        : 'bg-bg-tertiary text-text-muted border border-border'
                    }"
                    @click=${() => {
                      this.showClient = !this.showClient;
                    }}
                    title=${t('logs.clientLogs')}
                  >
                    C
                  </button>
                  <button
                    class="ut-surface--control px-1.5 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                      this.showServer
                        ? 'bg-primary/20 text-primary border border-primary'
                        : 'bg-bg-tertiary text-text-muted border border-border'
                    }"
                    @click=${() => {
                      this.showServer = !this.showServer;
                    }}
                    title=${t('logs.serverLogs')}
                  >
                    S
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Desktop layout (single row) -->
          <div class="hidden sm:flex items-center gap-3">
            <!-- Back button -->
            <button
              class="ut-surface--control px-3 py-1.5 bg-bg border border-border rounded-rem text-sm text-primary hover:border-primary hover:text-primary transition-colors flex items-center gap-2 flex-shrink-0"
              @click=${() => {
                window.location.href = '/';
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
              ${t('logs.back')}
            </button>

            <h1 class="text-lg font-bold text-primary flex items-center gap-2 flex-shrink-0">
              <terminal-icon size="24"></terminal-icon>
              <span>${t('logs.title')}</span>
            </h1>

            <div class="flex-1 flex flex-wrap gap-2 items-center justify-end">
              <!-- Search input -->
              <input
                type="text"
                class="ut-surface--inset px-3 py-1.5 bg-bg border border-border rounded-rem text-sm text-primary placeholder-text-muted focus:outline-none focus:border-primary transition-colors flex-1 sm:flex-initial sm:w-64 md:w-80"
                placeholder=${t('logs.filter')}
                .value=${this.filter}
                @input=${(e: Event) => {
                  this.filter = (e.target as HTMLInputElement).value;
                }}
              />

              <!-- Level filters -->
              <div class="flex gap-1">
                ${levels.map(
                  (level) => html`
                    <button
                      class="ut-surface--control px-2 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                        this.levelFilter.has(level)
                          ? level === 'error'
                            ? 'bg-status-error/20 text-status-error border border-status-error'
                            : level === 'warn'
                              ? 'bg-status-warning/20 text-status-warning border border-status-warning'
                              : level === 'debug'
                                ? 'bg-bg-tertiary text-text-muted border border-border'
                                : 'bg-primary/20 text-primary border border-primary'
                          : 'bg-bg-tertiary text-text-muted border border-border'
                      }"
                      @click=${() => this.toggleLevel(level)}
                    >
                      ${level}
                    </button>
                  `
                )}
              </div>

              <!-- Client/Server toggles -->
              <div class="flex gap-1">
                <button
                  class="ut-surface--control px-2 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                    this.showClient
                      ? 'bg-status-warning/20 text-status-warning border border-status-warning'
                      : 'bg-bg-tertiary text-text-muted border border-border'
                  }"
                  @click=${() => {
                    this.showClient = !this.showClient;
                  }}
                >
                  ${t('logs.client')}
                </button>
                <button
                  class="ut-surface--control px-2 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                    this.showServer
                      ? 'bg-primary/20 text-primary border border-primary'
                      : 'bg-bg-tertiary text-text-muted border border-border'
                  }"
                  @click=${() => {
                    this.showServer = !this.showServer;
                  }}
                >
                  ${t('logs.server')}
                </button>
              </div>

              <!-- Auto-scroll toggle -->
              <button
                class="ut-surface--control px-3 py-1 text-xs uppercase font-bold rounded-rem transition-colors ${
                  this.autoScroll
                    ? 'bg-primary/20 text-primary border border-primary'
                    : 'bg-bg-tertiary text-text-muted border border-border'
                }"
                @click=${() => {
                  this.autoScroll = !this.autoScroll;
                }}
              >
                ${t('logs.autoScroll')}
              </button>
            </div>
          </div>
        </div>

        <!-- Log container -->
        <div
          class="log-container flex-1 overflow-y-auto p-4 bg-bg font-mono text-xs leading-relaxed"
        >
          ${
            filteredLogs.length === 0
              ? html`
                <div class="flex items-center justify-center h-full text-text-muted">
                  <div class="text-center">
                    <div>${t('logs.empty')}</div>
                  </div>
                </div>
              `
              : filteredLogs.map((log) => {
                  const isMultiline = log.message.includes('\n');
                  const messageLines = log.message.split('\n');

                  return html`
                  <div
                    class="group hover:bg-bg-secondary/50 transition-colors rounded-rem ${
                      log.isClient ? 'bg-status-warning/5 pl-2' : 'pl-2'
                    }"
                  >
                    <!-- Desktop layout (hidden on mobile) -->
                    <div class="hidden sm:flex items-start gap-2 py-0.5">
                      <!-- Timestamp -->
                      <span class="text-text-muted w-16 flex-shrink-0"
                        >${this.formatRelativeTime(log.timestamp)}</span
                      >

                      <!-- Level -->
                      <span
                        class="w-10 text-center font-mono uppercase tracking-wider flex-shrink-0 ${
                          log.level === 'error'
                            ? 'text-status-error bg-status-error/20 px-1 rounded-rem font-bold'
                            : log.level === 'warn'
                              ? 'text-status-warning bg-status-warning/20 px-1 rounded-rem font-bold'
                              : log.level === 'debug'
                                ? 'text-text-muted'
                                : 'text-primary'
                        }"
                        >${
                          log.level === 'error'
                            ? 'ERR'
                            : log.level === 'warn'
                              ? 'WRN'
                              : log.level === 'debug'
                                ? 'DBG'
                                : 'LOG'
                        }</span
                      >

                      <!-- Source indicator -->
                      <span
                        class="flex-shrink-0 ${
                          log.isClient ? 'text-status-warning font-bold' : 'text-primary'
                        }"
                        >${log.isClient ? '◆ C' : '▸ S'}</span
                      >

                      <!-- Module -->
                      <span class="text-text-muted flex-shrink-0 font-mono">${log.module}</span>

                      <!-- Separator -->
                      <span class="text-text-muted flex-shrink-0">│</span>

                      <!-- Message -->
                      <span
                        class="flex-1 ${
                          log.level === 'error'
                            ? 'text-status-error'
                            : log.level === 'warn'
                              ? 'text-status-warning'
                              : log.level === 'debug'
                                ? 'text-text-muted'
                                : log.isClient
                                  ? 'text-status-warning'
                                  : 'text-primary'
                        }"
                        >${messageLines[0]}</span
                      >
                    </div>

                    <!-- Mobile layout (visible only on mobile) -->
                    <div class="sm:hidden py-1">
                      <div class="flex items-center gap-2 text-xs">
                        <span class="text-text-muted"
                          >${this.formatRelativeTime(log.timestamp)}</span
                        >
                        <span
                          class="${
                            log.level === 'error'
                              ? 'text-status-error font-bold'
                              : log.level === 'warn'
                                ? 'text-status-warning font-bold'
                                : log.level === 'debug'
                                  ? 'text-text-muted'
                                  : 'text-primary'
                          } uppercase"
                          >${log.level}</span
                        >
                        <span class="${log.isClient ? 'text-status-warning' : 'text-primary'}"
                          >${log.isClient ? '[C]' : '[S]'}</span
                        >
                        <span class="text-text-muted">${log.module}</span>
                      </div>
                      <div
                        class="mt-1 ${
                          log.level === 'error'
                            ? 'text-status-error'
                            : log.level === 'warn'
                              ? 'text-status-warning'
                              : log.level === 'debug'
                                ? 'text-text-muted'
                                : log.isClient
                                  ? 'text-status-warning'
                                  : 'text-primary'
                        }"
                      >
                        ${messageLines[0]}
                      </div>
                    </div>
                    ${
                      isMultiline
                        ? html`
                          <div
                            class="hidden sm:block ml-36 ${
                              log.level === 'error'
                                ? 'text-status-error'
                                : log.level === 'warn'
                                  ? 'text-status-warning'
                                  : 'text-text-muted'
                            }"
                          >
                            ${messageLines
                              .slice(1)
                              .map((line) => html`<div class="py-0.5">${line}</div>`)}
                          </div>
                          <div
                            class="sm:hidden mt-1 ${
                              log.level === 'error'
                                ? 'text-status-error'
                                : log.level === 'warn'
                                  ? 'text-status-warning'
                                  : 'text-text-muted'
                            }"
                          >
                            ${messageLines
                              .slice(1)
                              .map((line) => html`<div class="py-0.5">${line}</div>`)}
                          </div>
                        `
                        : ''
                    }
                  </div>
                `;
                })
          }
        </div>

        <!-- Footer -->
        <div
          class="ut-surface--bar ut-surface--material flex items-center justify-between p-3 bg-bg-secondary border-t border-border text-xs"
        >
          <div class="text-text-muted">
            ${t('logs.count', { shown: filteredLogs.length, total: this.logs.length })}
            ${this.logSize ? html` <span class="text-text-muted">• ${this.logSize}</span>` : ''}
          </div>
          <div class="flex gap-2">
            <button
              class="ut-surface--control px-3 py-1 bg-bg border border-border rounded-rem hover:border-primary hover:text-primary transition-colors"
              @click=${this.downloadLogs}
            >
              ${t('logs.download')}
            </button>
            <button
              class="ut-surface--control px-3 py-1 bg-bg border border-status-error text-status-error rounded-rem hover:bg-status-error hover:text-on-solid transition-colors"
              @click=${this.clearLogs}
            >
              ${t('logs.clear')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
