/**
 * A project's task settings, from the gear in its home header (2026-10-18): whether a
 * finished task merges on its own ("Fusionar sola si todo va bien", the default) or always
 * waits ("Preguntarme siempre"), the check it must pass (empty: the detected one, offered with
 * "Usar"), whether an AI reviews each task's diff before it merges (aiReview, on by default
 * since 2026-10-20: nothing merges unreviewed), the security sweep (one switch, off by default,
 * 2026-10-23; its last and next round and what its reviewer dismissed shown under it; since
 * 2026-10-26 also what the project exposes while it runs, and its provider connectors),
 * the command that prepares each new task folder, and globs never treated as risky.
 *
 * Reads GET /api/projects/settings and /api/projects/detect-check, saves with PUT
 * /api/projects/settings (an empty field clears the setting). Lazy (deferred-views.ts), in
 * <body> with the answer sheet's look (ans-*).
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  type AgentFallbackMode,
  MAX_ACTIVE_TASKS_MAX,
  type ProjectSettings,
} from '../../shared/projects.js';
import {
  type ConnectorProvider,
  SECURITY_CONNECTORS,
  type SecurityConnector,
  type SecurityRoundResult,
  type SecuritySeverity,
  type SecuritySweepStatus,
} from '../../shared/security.js';
import type { TaskMergePolicy } from '../../shared/tasks.js';
import { getLocale, LocaleController, type MessageKey, t, tAround } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { serverConfigService } from '../services/server-config-service.js';
import { taskStore } from '../services/task-store.js';
import { toast } from '../utils/action-toast.js';
import { followKeyboard } from '../utils/follow-keyboard.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { mergePauseText } from '../utils/project-notice.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { projectSettingsErrorText, taskErrorText } from '../utils/task-status.js';
import { icon } from './icons.js';

export interface ProjectSettingsSheetOptions {
  repoPath: string;
  name: string;
}

interface DetectedCheck {
  command: string;
  dir: string;
  reason?: string;
}

/** A detected check as one command to type in the field ("cd web && pnpm run check"). */
export function checkCommandFor(check: DetectedCheck): string {
  if (!check.dir || check.dir === '.') return check.command;
  const dir = /^[A-Za-z0-9_./-]+$/.test(check.dir)
    ? check.dir
    : `'${check.dir.replace(/'/g, `'\\''`)}'`;
  return `cd ${dir} && ${check.command}`;
}

const OPEN_GUARD_MS = 500;

const SEVERITY_KEYS: Record<SecuritySeverity, MessageKey> = {
  high: 'projectSettings.severity.high',
  medium: 'projectSettings.severity.medium',
  low: 'projectSettings.severity.low',
};

/** A connector as the sheet edits it (off: kept, not saved). */
interface ConnectorDraft {
  on: boolean;
  from: 'env' | 'keychain';
  name: string;
  account: string;
  options: Record<string, string>;
}

function connectorDraft(connector?: SecurityConnector): ConnectorDraft {
  return {
    on: !!connector,
    from: connector?.credential.from ?? 'keychain',
    name: connector?.credential.name ?? '',
    account: connector?.credential.account ?? '',
    options: { ...(connector?.options ?? {}) },
  };
}

/** The drafts the user turned on, as settings (null: none). */
export function connectorsToSave(
  drafts: Partial<Record<ConnectorProvider, ConnectorDraft>>
): SecurityConnector[] | null {
  const out: SecurityConnector[] = [];
  for (const spec of SECURITY_CONNECTORS) {
    const draft = drafts[spec.provider];
    if (!draft?.on || !draft.name.trim()) continue;
    const options = Object.fromEntries(
      spec.options
        .map((key) => [key, (draft.options[key] ?? '').trim()] as const)
        .filter(([, value]) => value)
    );
    out.push({
      provider: spec.provider,
      credential: {
        from: draft.from,
        name: draft.name.trim(),
        ...(draft.from === 'keychain' && draft.account.trim()
          ? { account: draft.account.trim() }
          : {}),
      },
      ...(Object.keys(options).length ? { options } : {}),
    });
  }
  return out.length ? out : null;
}

const RESULT_KEYS: Record<SecurityRoundResult, MessageKey> = {
  clean: 'projectSettings.securityResult.clean',
  confirmed: 'projectSettings.securityResult.confirmed',
  dismissed: 'projectSettings.securityResult.dismissed',
  abandoned: 'projectSettings.securityResult.abandoned',
};

@customElement('project-settings-sheet')
export class ProjectSettingsSheet extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) options: ProjectSettingsSheetOptions = { repoPath: '', name: '' };

  @state() private phase: 'loading' | 'ready' | 'saving' | 'error' = 'loading';
  @state() private mergePolicy: TaskMergePolicy = 'auto';
  @state() private checkCommand = '';
  /** maxActiveTasks as typed: empty = no limit. */
  @state() private maxActiveTasks = '';
  @state() private aiReview = true;
  /** Model by difficulty (off unless turned on). */
  @state() private modelRouting = false;
  /** Another agent at a usage limit: offered (default), automatic or never. */
  @state() private agentFallback: AgentFallbackMode = 'offer';
  @state() private securitySweep = false;
  @state() private security: SecuritySweepStatus | null = null;
  /** Provider connectors (2026-10-26), one draft per known provider. */
  @state() private connectors: Partial<Record<ConnectorProvider, ConnectorDraft>> = {};
  /** Automatic merges paused by the server (recent merges reverted or failing), and why. */
  @state() private pausedUntil = '';
  /** The user's autoApprove: a task with no check counts down instead of waiting for them. */
  @state() private autoApprove = false;
  /** Why, as the server's code and count (its English reason is never shown). */
  @state() private pausedCode = '';
  @state() private pausedCount: number | undefined = undefined;
  @state() private resuming = false;
  @state() private setupCommand = '';
  @state() private riskIgnore = '';
  @state() private detected: DetectedCheck[] = [];
  @state() private error = '';
  /** The server's own (English) answer behind `error`, under «Detalles». */
  @state() private errorDetail = '';

  private openedAt = 0;
  private touchedAt = 0;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    void this.load();
  }

  firstUpdated() {
    const sheet = this.querySelector<HTMLElement>('.ans-sheet');
    this.releaseFocus = holdSheetFocus(sheet, this.close, document.activeElement);
    requestAnimationFrame(() => sheet?.classList.add('open'));
    if (sheet) {
      const stopDrag = attachSheetDrag(sheet, {
        scroller: sheet.querySelector<HTMLElement>('.ans-body'),
        onDismiss: this.close,
      });
      // Guardar sits at the bottom: above the keyboard while a command is typed.
      const stopKeyboard = followKeyboard(sheet);
      this.detachDrag = () => {
        stopDrag();
        stopKeyboard();
      };
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseFocus?.();
    this.releaseFocus = null;
    this.detachDrag?.();
    this.detachDrag = null;
  }

  close = () => {
    this.remove();
  };

  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < OPEN_GUARD_MS) return;
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse' || endsADrag(p)) return;
          this.touchedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private headers() {
    return { 'Content-Type': 'application/json', ...authClient.getAuthHeader() };
  }

  private async load() {
    this.phase = 'loading';
    // Fresh: the switch may have just been turned in Settings (2026-10-24).
    void serverConfigService
      .loadConfig(true)
      .then((config) => {
        this.autoApprove = config.autoApprove === true;
      })
      .catch(() => {});
    const repo = encodeURIComponent(this.options.repoPath);
    try {
      const [settingsRes, detectRes] = await Promise.all([
        fetch(`/api/projects/settings?repo=${repo}`, { headers: this.headers() }),
        fetch(`/api/projects/detect-check?repo=${repo}`, { headers: this.headers() }),
      ]);
      if (!settingsRes.ok) throw new Error(String(settingsRes.status));
      const body = (await settingsRes.json()) as {
        settings?: Partial<ProjectSettings> & {
          autoMergePausedUntil?: string;
          autoMergePausedCode?: string;
          autoMergePausedCount?: number;
        };
        security?: SecuritySweepStatus;
      };
      const settings = body.settings ?? {};
      this.mergePolicy = settings.mergePolicy === 'ask' ? 'ask' : 'auto';
      this.checkCommand = settings.checkCommand ?? '';
      this.maxActiveTasks =
        typeof settings.maxActiveTasks === 'number' ? String(settings.maxActiveTasks) : '';
      // On unless turned off: nothing merges without a review.
      this.aiReview = settings.aiReview !== false;
      this.modelRouting = settings.modelRouting === true;
      this.agentFallback =
        settings.agentFallback === 'auto' || settings.agentFallback === 'off'
          ? settings.agentFallback
          : 'offer';
      // Off unless the user turned it on.
      this.securitySweep = settings.securitySweep === true;
      this.security = body.security ?? null;
      this.connectors = Object.fromEntries(
        SECURITY_CONNECTORS.map((spec) => [
          spec.provider,
          connectorDraft(
            (settings.securityConnectors ?? []).find((each) => each.provider === spec.provider)
          ),
        ])
      );
      this.pausedUntil =
        typeof settings.autoMergePausedUntil === 'string' ? settings.autoMergePausedUntil : '';
      this.pausedCode =
        typeof settings.autoMergePausedCode === 'string' ? settings.autoMergePausedCode : '';
      this.pausedCount =
        typeof settings.autoMergePausedCount === 'number'
          ? settings.autoMergePausedCount
          : undefined;
      this.setupCommand = settings.setupCommand ?? '';
      this.riskIgnore = (settings.riskIgnore ?? []).join('\n');
      if (detectRes.ok) {
        const detect = (await detectRes.json()) as {
          checks?: DetectedCheck[];
          suggestions?: Array<{ command: string; reason?: string }>;
        };
        this.detected = [
          ...(detect.checks ?? []),
          ...(detect.suggestions ?? []).map((entry) => ({ ...entry, dir: '.' })),
        ];
      }
      this.phase = 'ready';
    } catch {
      this.phase = 'error';
    }
  }

  private async save() {
    if (this.phase !== 'ready') return;
    this.phase = 'saving';
    this.error = '';
    this.errorDetail = '';
    const lines = this.riskIgnore
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const response = await fetch('/api/projects/settings', {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          repoPath: this.options.repoPath,
          settings: {
            mergePolicy: this.mergePolicy,
            checkCommand: this.checkCommand.trim() || null,
            // Empty: no limit (the server refuses anything but a whole number from 1 to 50).
            maxActiveTasks: this.maxActiveTasks.trim() ? Number(this.maxActiveTasks.trim()) : null,
            // Said either way: turning it off is a choice the server keeps.
            aiReview: this.aiReview,
            modelRouting: this.modelRouting ? true : null,
            agentFallback: this.agentFallback === 'offer' ? null : this.agentFallback,
            securitySweep: this.securitySweep ? true : null,
            securityConnectors: connectorsToSave(this.connectors),
            setupCommand: this.setupCommand.trim() || null,
            riskIgnore: lines.length ? lines : null,
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        // The server's answer is English (a refused value, no right): the user gets their own
        // words, the raw text sits under «Detalles» (2026-10-20 verify).
        const worded = projectSettingsErrorText({
          ok: false,
          status: response.status,
          error: typeof body.error === 'string' ? body.error : response.statusText,
          message: typeof body.message === 'string' ? body.message : undefined,
        });
        this.error = t('projectSettings.failed', { error: worded.text });
        this.errorDetail = worded.raw !== worded.text ? worded.raw : '';
        this.phase = 'ready';
        return;
      }
      toast({
        kind: response.status === 202 ? 'info' : 'success',
        text: response.status === 202 ? t('board.toast.pending') : t('projectSettings.saved'),
      });
      this.close();
    } catch (error) {
      // Offline or no answer.
      this.error = t('projectSettings.failed', { error: t('board.error.network') });
      this.errorDetail = error instanceof Error ? error.message : String(error);
      this.phase = 'ready';
    }
  }

  /** «Reactivar»: the pause on automatic merges cleared at once (not on Guardar). */
  private async resumeMerges() {
    if (this.resuming) return;
    this.resuming = true;
    try {
      const result = await taskStore.setProjectSettings(this.options.repoPath, {
        autoMergePausedUntil: null,
      });
      if (result.ok) {
        this.pausedUntil = '';
        toast({
          kind: result.status === 202 ? 'info' : 'success',
          text:
            result.status === 202
              ? t('board.toast.pending')
              : t('board.mergesResumed', { name: this.options.name }),
        });
      } else {
        toast({ kind: 'error', text: t('board.toast.failed', { error: taskErrorText(result) }) });
      }
    } finally {
      this.resuming = false;
    }
  }

  private renderPause() {
    const pause = mergePauseText({
      repoPath: this.options.repoPath,
      autoMergePausedUntil: this.pausedUntil || undefined,
      autoMergePausedCode: this.pausedCode || undefined,
      autoMergePausedCount: this.pausedCount,
    });
    if (!pause) return nothing;
    const resume = this.tap(() => void this.resumeMerges());
    return html`<div class="prj-pause pss-pause" role="status" data-testid="project-settings-paused">
      <span class="prj-pause-text"
        >${pause}</span
      >
      <button
        type="button"
        class="ut-surface--control tsk-btn"
        data-testid="project-settings-resume"
        aria-busy=${this.resuming ? 'true' : 'false'}
        ?disabled=${this.resuming}
        @pointerup=${resume}
        @click=${resume}
      >
        ${t('board.resumeMerges')}
      </button>
    </div>`;
  }

  /** The security sweep's switch, and how it has gone (last round, next, what it dismissed). */
  private renderSecurity() {
    const toggle = this.tap(() => {
      this.securitySweep = !this.securitySweep;
    });
    const status = this.security;
    const when = (iso: string) =>
      new Date(iso).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
    const dismissed = (status?.log ?? []).filter((entry) => entry.verdict === 'dismissed');
    return html`<div class="tks-field">
      <button
        type="button"
        role="switch"
        class="ut-surface--inset tks-switch"
        aria-checked=${this.securitySweep ? 'true' : 'false'}
        aria-describedby="pss-security-hint"
        data-testid="project-security-sweep"
        @pointerup=${toggle}
        @click=${toggle}
      >
        <span class="tks-option-label">${t('projectSettings.securitySweep')}</span>
        <span class="tks-knob ${this.securitySweep ? 'on' : ''}" aria-hidden="true"><span></span></span>
      </button>
      <span class="tks-hint" id="pss-security-hint">${t('projectSettings.securitySweepHint')}</span>
      ${
        status?.enabled
          ? html`<span class="tks-hint" data-testid="project-security-status">
              ${
                status.running
                  ? t('projectSettings.securityRunning')
                  : status.lastRoundAt
                    ? t('projectSettings.securityLast', {
                        when: when(status.lastRoundAt),
                        result: t(RESULT_KEYS[status.lastResult ?? 'clean']),
                      })
                    : nothing
              }
              ${
                status.paused
                  ? t('projectSettings.securityPaused')
                  : status.nextRoundAt
                    ? t('projectSettings.securityNext', { when: when(status.nextRoundAt) })
                    : nothing
              }
            </span>`
          : nothing
      }
      ${this.securitySweep ? this.renderExposure() : nothing}
      ${this.securitySweep ? this.renderConnectors() : nothing}
      ${
        dismissed.length
          ? html`<details class="tks-hint" data-testid="project-security-dismissed">
              <summary>
                ${t('projectSettings.securityDismissed', { count: dismissed.length })}
              </summary>
              <ul>
                ${dismissed.map(
                  (entry) =>
                    html`<li>
                      <strong>${entry.finding.title}</strong>
                      (${entry.finding.file}${entry.finding.line ? `:${entry.finding.line}` : ''})
                      — ${entry.reason}
                    </li>`
                )}
              </ul>
            </details>`
          : nothing
      }
    </div>`;
  }

  /** What the project exposes while it runs (2026-10-26): its surface, findings, blind spots. */
  private renderExposure() {
    const exposure = this.security?.exposure;
    if (!exposure?.checkedAt) {
      return html`<span class="tks-hint" data-testid="project-exposure-pending"
        >${t('projectSettings.exposurePending')}</span
      >`;
    }
    const when = new Date(exposure.checkedAt).toLocaleString(getLocale(), {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return html`<div class="tks-hint" data-testid="project-exposure">
      <span>
        ${
          exposure.surface.length
            ? t('projectSettings.exposureSurface', { what: exposure.surface.join(' · ') })
            : t('projectSettings.exposureNone')
        }
        ${t('projectSettings.exposureChecked', { when })}
      </span>
      ${
        exposure.findings.length
          ? html`<details data-testid="project-exposure-findings" ?open=${exposure.findings.some((finding) => finding.severity === 'high')}>
              <summary>${t('projectSettings.exposureFindings', { count: exposure.findings.length })}</summary>
              <ul>
                ${exposure.findings.map(
                  (finding) =>
                    html`<li>
                      <strong>${t(SEVERITY_KEYS[finding.severity])}: ${finding.title}</strong>
                      ${finding.file ? html` (<code dir="ltr">${finding.file}</code>)` : nothing}
                      — ${finding.fix}
                      ${finding.fixable ? nothing : html` <em>${t('projectSettings.exposureOutside')}</em>`}
                    </li>`
                )}
              </ul>
            </details>`
          : exposure.surface.length
            ? html`<span data-testid="project-exposure-clean"> ${t('projectSettings.exposureClean')}</span>`
            : nothing
      }
      ${
        exposure.errors.length
          ? html`<details data-testid="project-exposure-errors">
              <summary>${t('projectSettings.exposureErrors', { count: exposure.errors.length })}</summary>
              <ul>
                ${exposure.errors.map((error) => html`<li><code dir="ltr">${error}</code></li>`)}
              </ul>
            </details>`
          : nothing
      }
    </div>`;
  }

  /** Provider connectors: off by default; on, where the credential comes from. */
  private renderConnectors() {
    const update = (provider: ConnectorProvider, change: Partial<ConnectorDraft>) => {
      const draft = this.connectors[provider] ?? connectorDraft();
      this.connectors = { ...this.connectors, [provider]: { ...draft, ...change } };
    };
    return html`<div class="tks-field" data-testid="project-connectors">
      <span class="tks-label">${t('projectSettings.connectors')}</span>
      <span class="tks-hint">${t('projectSettings.connectorsHint')}</span>
      ${SECURITY_CONNECTORS.map((spec) => {
        const draft = this.connectors[spec.provider] ?? connectorDraft();
        const toggle = this.tap(() => update(spec.provider, { on: !draft.on }));
        const field = (
          label: string,
          value: string,
          change: (value: string) => void,
          testid: string,
          placeholder = ''
        ) => html`<label class="tks-field">
          <span class="tks-label">${label}</span>
          <input
            class="tks-input mono ut-surface--inset"
            data-testid=${testid}
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            dir="ltr"
            placeholder=${placeholder}
            .value=${value}
            @input=${(e: Event) => change((e.target as HTMLInputElement).value)}
          />
        </label>`;
        return html`<button
            type="button"
            role="switch"
            class="ut-surface--inset tks-switch"
            aria-checked=${draft.on ? 'true' : 'false'}
            data-testid="project-connector-${spec.provider}"
            @pointerup=${toggle}
            @click=${toggle}
          >
            <span class="tks-option-label">${spec.name}</span>
            <span class="tks-knob ${draft.on ? 'on' : ''}" aria-hidden="true"><span></span></span>
          </button>
          ${
            draft.on
              ? html`<label class="tks-field">
                    <span class="tks-label">${t('projectSettings.connectorFrom')}</span>
                    <select
                      class="tks-input ut-surface--inset"
                      data-testid="project-connector-${spec.provider}-from"
                      .value=${draft.from}
                      @change=${(e: Event) =>
                        update(spec.provider, {
                          from:
                            (e.target as HTMLSelectElement).value === 'env' ? 'env' : 'keychain',
                        })}
                    >
                      <option value="keychain" ?selected=${draft.from === 'keychain'}>
                        ${t('projectSettings.connectorFromKeychain')}
                      </option>
                      <option value="env" ?selected=${draft.from === 'env'}>
                        ${t('projectSettings.connectorFromEnv')}
                      </option>
                    </select>
                  </label>
                  ${field(
                    t(
                      draft.from === 'env'
                        ? 'projectSettings.connectorEnvName'
                        : 'projectSettings.connectorService'
                    ),
                    draft.name,
                    (value) => update(spec.provider, { name: value }),
                    `project-connector-${spec.provider}-name`
                  )}
                  ${
                    draft.from === 'keychain'
                      ? field(
                          t('projectSettings.connectorAccount'),
                          draft.account,
                          (value) => update(spec.provider, { account: value }),
                          `project-connector-${spec.provider}-account`
                        )
                      : nothing
                  }
                  ${spec.options.map((option) =>
                    field(
                      t(`projectSettings.connectorOption.${option}` as MessageKey),
                      draft.options[option] ?? '',
                      (value) =>
                        update(spec.provider, { options: { ...draft.options, [option]: value } }),
                      `project-connector-${spec.provider}-${option}`
                    )
                  )}
                  <span class="tks-hint">${t('projectSettings.connectorReadOnly')}</span>`
              : nothing
          }`;
      })}
    </div>`;
  }

  private renderFallback(mode: AgentFallbackMode) {
    const on = this.agentFallback === mode;
    const pick = this.tap(() => {
      this.agentFallback = mode;
    });
    const keys = {
      offer: ['projectSettings.fallbackOffer', 'projectSettings.fallbackOfferHint'],
      auto: ['projectSettings.fallbackAuto', 'projectSettings.fallbackAutoHint'],
      off: ['projectSettings.fallbackOff', 'projectSettings.fallbackOffHint'],
    } as const;
    const [label, hint] = keys[mode];
    return html`<button
      type="button"
      role="radio"
      aria-checked=${on ? 'true' : 'false'}
      class="tks-option ${on ? 'selected' : ''} ut-surface--control"
      data-testid="project-fallback-${mode}"
      @pointerup=${pick}
      @click=${pick}
    >
      <span class="tks-radio" aria-hidden="true"></span>
      <span class="tks-option-text"
        ><span class="tks-option-label">${t(label)}</span><span class="tks-hint">${t(hint)}</span></span
      >
    </button>`;
  }

  /** Model by difficulty and the other agent at a usage limit (2026-11-01). */
  private renderAgents() {
    return html`<div class="tks-field">
        <button
          type="button"
          role="switch"
          class="ut-surface--inset tks-switch"
          aria-checked=${this.modelRouting ? 'true' : 'false'}
          aria-describedby="pss-model-routing-hint"
          data-testid="project-model-routing"
          @pointerup=${this.tap(() => {
            this.modelRouting = !this.modelRouting;
          })}
          @click=${this.tap(() => {
            this.modelRouting = !this.modelRouting;
          })}
        >
          <span class="tks-option-label">${t('projectSettings.modelRouting')}</span>
          <span class="tks-knob ${this.modelRouting ? 'on' : ''}" aria-hidden="true"
            ><span></span
          ></span>
        </button>
        <span class="tks-hint" id="pss-model-routing-hint"
          >${t('projectSettings.modelRoutingHint')}</span
        >
      </div>
      <div class="tks-field">
        <span class="tks-label" id="pss-fallback">${t('projectSettings.fallback')}</span>
        <div class="tks-options" role="radiogroup" aria-labelledby="pss-fallback">
          ${this.renderFallback('offer')} ${this.renderFallback('auto')}
          ${this.renderFallback('off')}
        </div>
      </div>`;
  }

  private renderPolicy(policy: TaskMergePolicy, label: string, hint: string) {
    const on = this.mergePolicy === policy;
    const pick = this.tap(() => {
      this.mergePolicy = policy;
    });
    return html`<button
      type="button"
      role="radio"
      aria-checked=${on ? 'true' : 'false'}
      class="tks-option ${on ? 'selected' : ''} ut-surface--control"
      data-testid="project-merge-${policy}"
      @pointerup=${pick}
      @click=${pick}
    >
      <span class="tks-radio" aria-hidden="true"></span>
      <span class="tks-option-text"
        ><span class="tks-option-label">${label}</span><span class="tks-hint">${hint}</span></span
      >
    </button>`;
  }

  private renderForm() {
    const busy = this.phase === 'saving';
    return html`
      ${this.renderPause()}
      <div class="tks-field">
        <span class="tks-label" id="pss-merge">${t('projectSettings.merge')}</span>
        <div class="tks-options" role="radiogroup" aria-labelledby="pss-merge">
          ${this.renderPolicy('auto', t('projectSettings.mergeAuto'), t('projectSettings.mergeAutoHint'))}
          ${this.renderPolicy('ask', t('projectSettings.mergeAsk'), t('projectSettings.mergeAskHint'))}
        </div>
      </div>
      <label class="tks-field">
        <span class="tks-label">${t('projectSettings.check')}</span>
        <input
          class="tks-input mono ut-surface--inset"
          data-testid="project-check"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          dir="ltr"
          placeholder=${t('projectSettings.checkPlaceholder')}
          .value=${this.checkCommand}
          @input=${(e: Event) => {
            this.checkCommand = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="tks-hint">${t('projectSettings.checkHint')}</span>
      </label>
      <div class="tks-detected" data-testid="project-detected">
        ${
          this.detected.length
            ? this.detected.slice(0, 4).map((check) => {
                const command = checkCommandFor(check);
                const use = this.tap(() => {
                  this.checkCommand = command;
                });
                const [before, value, after] = tAround(
                  'projectSettings.detected',
                  { command },
                  'command'
                );
                return html`<div class="tks-detected-row">
                  <span class="tks-detected-text"
                    >${before}<code dir="ltr">${value}</code>${after}</span
                  >
                  <button
                    type="button"
                    class="ut-surface--control tsk-btn"
                    data-testid="project-use-detected"
                    @pointerup=${use}
                    @click=${use}
                  >
                    ${t('projectSettings.useDetected')}
                  </button>
                </div>`;
              })
            : html`<span class="tks-hint" data-testid="project-detected-none"
                >${t(
                  // autoApprove gives the merge OK only where tasks merge on their own.
                  this.autoApprove && this.mergePolicy === 'auto' && !this.pausedUntil
                    ? 'projectSettings.detectedNoneAutoApprove'
                    : 'projectSettings.detectedNone'
                )}</span
              >`
        }
      </div>
      <div class="tks-field">
        <button
          type="button"
          role="switch"
          class="ut-surface--inset tks-switch"
          aria-checked=${this.aiReview ? 'true' : 'false'}
          aria-describedby="pss-ai-review-hint"
          data-testid="project-ai-review"
          @pointerup=${this.tap(() => {
            this.aiReview = !this.aiReview;
          })}
          @click=${this.tap(() => {
            this.aiReview = !this.aiReview;
          })}
        >
          <span class="tks-option-label">${t('projectSettings.aiReview')}</span>
          <span class="tks-knob ${this.aiReview ? 'on' : ''}" aria-hidden="true"><span></span></span>
        </button>
        <span class="tks-hint" id="pss-ai-review-hint">${t('projectSettings.aiReviewHint')}</span>
      </div>
      ${this.renderAgents()}
      ${this.renderSecurity()}
      <label class="tks-field">
        <span class="tks-label">${t('projectSettings.setup')}</span>
        <input
          class="tks-input mono ut-surface--inset"
          data-testid="project-setup"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          dir="ltr"
          placeholder=${t('projectSettings.setupPlaceholder')}
          .value=${this.setupCommand}
          @input=${(e: Event) => {
            this.setupCommand = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="tks-hint">${t('projectSettings.setupHint')}</span>
      </label>
      <label class="tks-field">
        <span class="tks-label">${t('projectSettings.maxActiveTasks')}</span>
        <input
          class="tks-input ut-surface--inset"
          id="project-max-active-tasks"
          data-testid="project-max-active-tasks"
          type="number"
          inputmode="numeric"
          min="1"
          max=${MAX_ACTIVE_TASKS_MAX}
          step="1"
          placeholder=${t('projectSettings.maxActiveTasksPlaceholder')}
          .value=${this.maxActiveTasks}
          @input=${(e: Event) => {
            this.maxActiveTasks = (e.target as HTMLInputElement).value;
          }}
        />
        <span class="tks-hint">${t('projectSettings.maxActiveTasksHint')}</span>
      </label>
      <label class="tks-field">
        <span class="tks-label">${t('projectSettings.riskIgnore')}</span>
        <textarea
          class="tks-input mono ut-surface--inset"
          rows="3"
          data-testid="project-risk-ignore"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          dir="ltr"
          placeholder="docs/**"
          .value=${this.riskIgnore}
          @input=${(e: Event) => {
            this.riskIgnore = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <span class="tks-hint">${t('projectSettings.riskIgnoreHint')}</span>
      </label>
      ${this.error ? html`<p class="ans-error" role="alert" data-testid="project-settings-error">${this.error}</p>` : nothing}
      ${
        this.error && this.errorDetail
          ? html`<details class="ans-error-details" data-testid="project-settings-error-details">
              <summary>${t('common.errorDetails')}</summary>
              <code dir="ltr">${this.errorDetail}</code>
            </details>`
          : nothing
      }
      <div class="tks-foot">
        <button
          type="button"
          class="tks-primary ut-surface--control ut-surface--primary"
          data-testid="project-settings-save"
          aria-busy=${busy ? 'true' : 'false'}
          ?disabled=${busy}
          @pointerup=${this.tap(() => void this.save())}
          @click=${this.tap(() => void this.save())}
        >
          ${busy ? html`<span class="tsk-spinner" aria-hidden="true"></span>` : nothing}${t('projectSettings.save')}
        </button>
      </div>
    `;
  }

  render() {
    const close = this.tap(this.close);
    return html`
      <div class="ans-backdrop" @click=${close}></div>
      <div
        class="ans-sheet tks-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        data-testid="project-settings-sheet"
        data-phase=${this.phase}
      >
        <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
        <div class="ans-head" data-sheet-handle>
          <div class="ans-head-text">
            <h2 id="project-settings-title" class="ans-title">
              ${t('projectSettings.title', { name: this.options.name })}
            </h2>
          </div>
          <button
            class="ans-x ut-icon-btn"
            aria-label=${t('common.close')}
            @pointerup=${close}
            @click=${close}
          >
            ${icon('x', 20)}
          </button>
        </div>
        <div class="ans-body">
          ${
            this.phase === 'loading'
              ? html`<p class="ans-note">${t('projectSettings.loading')}</p>`
              : this.phase === 'error'
                ? html`<p class="ans-error" role="alert">${t('projectSettings.loadFailed')}</p>
                    <div class="tks-foot">
                      <button
                        type="button"
                        class="tks-primary ut-surface--control ut-surface--primary"
                        data-testid="project-settings-retry"
                        @pointerup=${this.tap(() => void this.load())}
                        @click=${this.tap(() => void this.load())}
                      >
                        ${t('confirm.retry')}
                      </button>
                    </div>`
                : this.renderForm()
          }
        </div>
      </div>
    `;
  }
}

/** Open the sheet in <body> (one at a time). */
export function openProjectSettingsSheet(
  options: ProjectSettingsSheetOptions
): ProjectSettingsSheet {
  document.querySelector('project-settings-sheet')?.remove();
  const sheet = document.createElement('project-settings-sheet') as ProjectSettingsSheet;
  sheet.options = options;
  document.body.appendChild(sheet);
  return sheet;
}

declare global {
  interface HTMLElementTagNameMap {
    'project-settings-sheet': ProjectSettingsSheet;
  }
}
