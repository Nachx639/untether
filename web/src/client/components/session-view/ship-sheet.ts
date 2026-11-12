/**
 * Ship from the phone: commit, push or open a pull request for a session's repository, on
 * top of the Changes sheet. Each action is a form, then a confirm view stating exactly what
 * will run, then the git/gh output.
 *
 * Confirm buttons act on pointerup (iOS may eat the first tap on a fresh button as a hover)
 * and swallow the click that follows; nothing acts in the first 500 ms after a view appears,
 * so the tap that opened the confirm view cannot also confirm it. All repository content
 * goes through Lit text bindings, never innerHTML.
 */

import { html, nothing, render } from 'lit';
import { t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import {
  type CommitMessageProvider,
  defaultCommitMessageProvider,
} from '../../utils/commit-message.js';
import { Z_INDEX } from '../../utils/constants.js';
import { followKeyboard } from '../../utils/follow-keyboard.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { holdSheetFocus } from '../../utils/sheet-a11y.js';

export const CONFIRM_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

export type ShipMode = 'commit' | 'push' | 'pr';

interface ShipFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface ShipStatus {
  repoPath: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  ahead: number;
  behind: number;
  remotes: string[];
  protectedBranch: boolean;
  files: ShipFile[];
  pr?: {
    gh: { available: boolean; authenticated: boolean; defaultBranch?: string; message?: string };
    base: string;
    bases: string[];
    title: string;
    body: string;
    commits: { subject: string }[];
  };
}

interface ShipError {
  error: string;
  code?: string;
  output?: string;
}

let openHost: HTMLElement | null = null;
let releaseFocus: (() => void) | null = null;
let stopKeyboard: (() => void) | null = null;
let abort: AbortController | null = null;

export function closeShipSheet(): void {
  if (!openHost) return;
  abort?.abort();
  abort = null;
  render(nothing, openHost);
  openHost.remove();
  openHost = null;
  releaseFocus?.();
  releaseFocus = null;
  stopKeyboard?.();
  stopKeyboard = null;
}

export function isShipSheetOpen(): boolean {
  return openHost !== null;
}

const PROTECTED = new Set(['main', 'master']);

export interface ShipSheetOptions {
  /** Called after a commit or push succeeded, so the Changes list can refresh. */
  onDone?: () => void;
  /** Commit message generator; deterministic by default (an LLM can plug in here later). */
  messageProvider?: CommitMessageProvider;
}

export function openShipSheet(
  sessionId: string,
  mode: ShipMode,
  options: ShipSheetOptions = {}
): void {
  closeShipSheet();
  const host = document.createElement('div');
  host.dataset.testid = 'ship-sheet';
  document.body.appendChild(host);
  openHost = host;
  const controller = new AbortController();
  abort = controller;
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/git`;
  const provider = options.messageProvider ?? defaultCommitMessageProvider;

  type View = 'loading' | 'form' | 'confirm' | 'running' | 'done' | 'error';
  let view: View = 'loading';
  let viewShownAt = Date.now();
  let status: ShipStatus | null = null;
  let loadError = '';
  let result: { ok: boolean; message: string; output?: string; url?: string } | null = null;

  // Commit form
  const selected = new Set<string>();
  let message = '';
  // Push form
  let confirmMain = false;
  // PR form
  let prTitle = '';
  let prBody = '';
  let prBase = '';
  // What the user typed is theirs: choosing another base asks for the suggestion again, and
  // it used to replace a title and body already written (2026-11-10).
  let prTitleEdited = false;
  let prBodyEdited = false;
  // The newest status request; an older answer arriving late is dropped.
  let loadSeq = 0;
  let prDraft = false;

  const setView = (next: View) => {
    view = next;
    viewShownAt = Date.now();
    draw();
  };

  let touchActedAt = 0;
  let down: { x: number; y: number } | null = null;
  const act = (fn: () => void) => ({
    handleEvent: (e: Event) => {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent;
        down = { x: p.clientX, y: p.clientY };
        return;
      }
      if (Date.now() - viewShownAt < CONFIRM_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        const moved = down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > TAP_SLOP_PX;
        down = null;
        if (moved) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn();
    },
  });

  const headers = () => ({ ...authClient.getAuthHeader(), 'Content-Type': 'application/json' });

  const load = async () => {
    const seq = ++loadSeq;
    setView('loading');
    const query =
      mode === 'pr' ? `?pr=1${prBase ? `&base=${encodeURIComponent(prBase)}` : ''}` : '';
    try {
      const res = await fetch(`${base}/ship-status${query}`, {
        headers: authClient.getAuthHeader(),
        signal: controller.signal,
      });
      const data = await res.json();
      if (seq !== loadSeq) return;
      if (!res.ok) throw new Error((data as ShipError).error || `HTTP ${res.status}`);
      status = data as ShipStatus;
      if (mode === 'commit' && selected.size === 0) {
        for (const f of status.files) selected.add(f.path);
      }
      if (mode === 'pr' && status.pr) {
        if (!prBase) prBase = status.pr.base;
        if (!prTitleEdited) prTitle = status.pr.title;
        if (!prBodyEdited) prBody = status.pr.body;
      }
      setView('form');
    } catch (error) {
      if (controller.signal.aborted || seq !== loadSeq) return;
      loadError = error instanceof Error ? error.message : String(error);
      setView('error');
    }
  };

  const post = async (path: string, body: unknown) => {
    setView('running');
    try {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data as ShipError;
        result = { ok: false, message: errorText(err), output: err.output };
      } else {
        result = { ok: true, message: '', output: data.output, url: data.url };
        options.onDone?.();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    setView('done');
  };

  const errorText = (err: ShipError): string => {
    switch (err.code) {
      case 'gh-missing':
        return t('ship.ghMissing');
      case 'gh-unauthenticated':
        return t('ship.ghUnauthenticated');
      case 'detached':
        return t('ship.detached');
      case 'protected':
        return t('ship.protectedRefused');
      case 'busy':
        return t('ship.busy');
      case 'commit-failed':
        return t('ship.commitFailed');
      case 'push-failed':
        return t('ship.pushFailed');
      default:
        return err.error || t('ship.failed');
    }
  };

  const chosenFiles = () => (status?.files ?? []).filter((f) => selected.has(f.path));
  const pushTarget = () => {
    if (!status?.branch) return null;
    if (status.upstream && status.upstreamRemote && status.upstreamBranch) {
      return {
        remote: status.upstreamRemote,
        branch: status.upstreamBranch,
        command: `git push ${status.upstreamRemote} ${status.branch}:${status.upstreamBranch}`,
        setUpstream: false,
      };
    }
    if (!status.remotes.includes('origin')) return null;
    return {
      remote: 'origin',
      branch: status.branch,
      command: `git push -u origin ${status.branch}`,
      setUpstream: true,
    };
  };
  const needsMainConfirm = () => {
    const target = pushTarget();
    return (
      !!status?.branch && (PROTECTED.has(status.branch) || PROTECTED.has(target?.branch ?? ''))
    );
  };

  const close = act(closeShipSheet);
  const toConfirm = act(() => setView('confirm'));
  const pushNext = act(() => openShipSheet(sessionId, 'push', options));
  const backToForm = act(() => setView('form'));
  const generate = act(() => {
    void Promise.resolve(provider(chosenFiles())).then((m) => {
      message = m;
      draw();
    });
  });
  const confirm = act(() => {
    if (mode === 'commit') {
      void post('commit', {
        files: chosenFiles().map((f) =>
          f.oldPath ? { path: f.path, oldPath: f.oldPath } : { path: f.path }
        ),
        message,
      });
    } else if (mode === 'push') {
      if (needsMainConfirm() && !confirmMain) return;
      void post('push', { setUpstream: pushTarget()?.setUpstream === true, confirmMain });
    } else {
      void post('pr', { title: prTitle, body: prBody, base: prBase, draft: prDraft });
    }
  });

  const renderOutput = (text?: string) =>
    text
      ? html`<pre class="ut-ship-out" dir="ltr" data-testid="ship-output">${text}</pre>`
      : nothing;

  const branchLine = () =>
    status?.branch
      ? html`<div class="ut-ship-kv"><span>${t('ship.branch')}</span><code dir="ltr">${status.branch}</code></div>`
      : nothing;

  const renderCommitForm = (s: ShipStatus) => {
    if (s.files.length === 0)
      return html`<div class="ut-ship-note">${t('ship.nothingToCommit')}</div>`;
    return html`
      ${branchLine()}
      <ul class="ut-ship-files" role="list">
        ${s.files.map(
          (f) => html`<li>
            <label class="ut-ship-file">
              <input
                type="checkbox"
                data-testid="ship-file"
                .checked=${selected.has(f.path)}
                @change=${(e: Event) => {
                  if ((e.target as HTMLInputElement).checked) selected.add(f.path);
                  else selected.delete(f.path);
                  draw();
                }}
              />
              <span class="ut-ship-status">${f.status === '??' ? 'U' : f.status}</span>
              <span class="ut-ship-path" dir="ltr">${f.path}</span>
            </label>
          </li>`
        )}
      </ul>
      <label class="ut-ship-label" for="ut-ship-message">${t('ship.message')}</label>
      <textarea
        id="ut-ship-message"
        data-testid="ship-message"
        rows="5"
        dir="auto"
        .value=${message}
        placeholder=${t('ship.messagePlaceholder')}
        @input=${(e: Event) => {
          message = (e.target as HTMLTextAreaElement).value;
          draw();
        }}
      ></textarea>
      <div class="ut-ship-actions">
        <button
          data-testid="ship-generate"
          ?disabled=${selected.size === 0}
          @pointerdown=${generate}
          @pointerup=${generate}
          @click=${generate}
        >
          ${t('ship.generate')}
        </button>
        <button
          class="ut-ship-primary"
          data-testid="ship-review"
          ?disabled=${selected.size === 0 || !message.trim()}
          @pointerdown=${toConfirm}
          @pointerup=${toConfirm}
          @click=${toConfirm}
        >
          ${t('ship.reviewCommit')}
        </button>
      </div>
    `;
  };

  const renderPushForm = (s: ShipStatus) => {
    if (s.detached || !s.branch)
      return html`<div class="ut-ship-note" data-testid="ship-detached">${t('ship.detached')}</div>`;
    const target = pushTarget();
    return html`
      ${branchLine()}
      <div class="ut-ship-kv">
        <span>${t('ship.upstream')}</span>
        <code dir="ltr">${s.upstream ?? t('ship.noUpstream')}</code>
      </div>
      <div class="ut-ship-kv" data-testid="ship-ahead">
        <span>${t('ship.aheadBehind')}</span>
        <code>↑${s.ahead} ↓${s.behind}</code>
      </div>
      ${s.behind > 0 ? html`<div class="ut-ship-warn">${t('ship.behindWarning')}</div>` : nothing}
      ${
        target
          ? html`<div class="ut-ship-actions">
              <button
                class="ut-ship-primary"
                data-testid="ship-review"
                ?disabled=${s.upstream !== null && s.ahead === 0}
                @pointerdown=${toConfirm}
                @pointerup=${toConfirm}
                @click=${toConfirm}
              >
                ${s.upstream ? t('ship.reviewPush') : t('ship.reviewPublish')}
              </button>
            </div>`
          : html`<div class="ut-ship-note">${t('ship.noOrigin')}</div>`
      }
    `;
  };

  const renderPrForm = (s: ShipStatus) => {
    const pr = s.pr;
    if (!pr) return html`<div class="ut-ship-note">${t('ship.failed')}</div>`;
    if (!pr.gh.available)
      return html`<div class="ut-ship-note" data-testid="ship-gh-missing">${t('ship.ghMissing')}</div>`;
    if (!pr.gh.authenticated) {
      return html`<div class="ut-ship-note" data-testid="ship-gh-unauth">${t('ship.ghUnauthenticated')}</div>`;
    }
    if (!s.branch) return html`<div class="ut-ship-note">${t('ship.detached')}</div>`;
    const unpushed = !s.upstream || s.ahead > 0;
    return html`
      ${branchLine()}
      ${unpushed ? html`<div class="ut-ship-warn" data-testid="ship-pr-unpushed">${t('ship.prPushFirst')}</div>` : nothing}
      <label class="ut-ship-label" for="ut-ship-base">${t('ship.prBase')}</label>
      <select
        id="ut-ship-base"
        data-testid="ship-pr-base"
        .value=${prBase}
        @change=${(e: Event) => {
          prBase = (e.target as HTMLSelectElement).value;
          void load();
        }}
      >
        ${pr.bases.map((b) => html`<option value=${b} ?selected=${b === prBase}>${b}</option>`)}
      </select>
      <label class="ut-ship-label" for="ut-ship-title">${t('ship.prTitle')}</label>
      <input
        id="ut-ship-title"
        data-testid="ship-pr-title"
        dir="auto"
        .value=${prTitle}
        @input=${(e: Event) => {
          prTitle = (e.target as HTMLInputElement).value;
          prTitleEdited = true;
          draw();
        }}
      />
      <label class="ut-ship-label" for="ut-ship-body">${t('ship.prBody')}</label>
      <textarea
        id="ut-ship-body"
        data-testid="ship-pr-body"
        rows="6"
        dir="auto"
        .value=${prBody}
        @input=${(e: Event) => {
          prBody = (e.target as HTMLTextAreaElement).value;
          prBodyEdited = true;
        }}
      ></textarea>
      <label class="ut-ship-check">
        <input
          type="checkbox"
          data-testid="ship-pr-draft"
          .checked=${prDraft}
          @change=${(e: Event) => {
            prDraft = (e.target as HTMLInputElement).checked;
          }}
        />
        ${t('ship.prDraft')}
      </label>
      <div class="ut-ship-actions">
        <button
          class="ut-ship-primary"
          data-testid="ship-review"
          ?disabled=${!prTitle.trim() || !prBase}
          @pointerdown=${toConfirm}
          @pointerup=${toConfirm}
          @click=${toConfirm}
        >
          ${t('ship.reviewPr')}
        </button>
      </div>
    `;
  };

  const renderConfirm = (s: ShipStatus) => {
    let what: unknown;
    let blocked = false;
    if (mode === 'commit') {
      const files = chosenFiles();
      what = html`
        <p>${t('ship.confirmCommit', { n: files.length })}</p>
        <ul class="ut-ship-list" dir="ltr" data-testid="ship-confirm-files">
          ${files.map((f) => html`<li>${f.path}</li>`)}
        </ul>
        <pre class="ut-ship-out" dir="auto" data-testid="ship-confirm-message">${message}</pre>
      `;
    } else if (mode === 'push') {
      const target = pushTarget();
      const mainNeeded = needsMainConfirm();
      blocked = mainNeeded && !confirmMain;
      what = html`
        <p>${t('ship.confirmPush', { n: s.ahead, branch: target?.branch ?? '' })}</p>
        <pre class="ut-ship-out" dir="ltr" data-testid="ship-confirm-command">${target?.command ?? ''}</pre>
        <p class="ut-ship-dim">${t('ship.neverForce')}</p>
        ${
          mainNeeded
            ? html`<label class="ut-ship-check ut-ship-danger">
                <input
                  type="checkbox"
                  data-testid="ship-confirm-main"
                  .checked=${confirmMain}
                  @change=${(e: Event) => {
                    confirmMain = (e.target as HTMLInputElement).checked;
                    draw();
                  }}
                />
                ${t('ship.confirmMain', { branch: target?.branch ?? 'main' })}
              </label>`
            : nothing
        }
      `;
    } else {
      what = html`
        <p>${t(prDraft ? 'ship.confirmPrDraft' : 'ship.confirmPr', { head: s.branch ?? '', base: prBase })}</p>
        <pre class="ut-ship-out" dir="auto" data-testid="ship-confirm-pr">${prTitle}${prBody ? `\n\n${prBody}` : ''}</pre>
      `;
    }
    const label =
      mode === 'commit' ? t('ship.doCommit') : mode === 'push' ? t('ship.doPush') : t('ship.doPr');
    return html`
      <div class="ut-ship-confirm" data-testid="ship-confirm">${what}</div>
      <div class="ut-ship-actions">
        <button data-testid="ship-cancel" @pointerdown=${backToForm} @pointerup=${backToForm} @click=${backToForm}>
          ${t('ship.back')}
        </button>
        <button
          class="ut-ship-primary"
          data-testid="ship-confirm-button"
          ?disabled=${blocked}
          @pointerdown=${confirm}
          @pointerup=${confirm}
          @click=${confirm}
        >
          ${label}
        </button>
      </div>
    `;
  };

  const renderDone = () => {
    if (!result) return nothing;
    const okText =
      mode === 'commit'
        ? t('ship.commitDone')
        : mode === 'push'
          ? t('ship.pushDone')
          : t('ship.prDone');
    const safeUrl = result.url?.startsWith('https://') ? result.url : '';
    return html`
      <div class=${result.ok ? 'ut-ship-ok' : 'ut-ship-err'} data-testid="ship-result" role="status">
        ${result.ok ? okText : result.message}
      </div>
      ${
        safeUrl
          ? html`<a
              class="ut-ship-link"
              data-testid="ship-pr-link"
              href=${safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              >${t('ship.openPr')} · ${safeUrl}</a
            >`
          : nothing
      }
      ${renderOutput(result.output)}
      <div class="ut-ship-actions">
        ${
          result.ok
            ? nothing
            : html`<button data-testid="ship-retry" @pointerdown=${backToForm} @pointerup=${backToForm} @click=${backToForm}>
                ${t('ship.back')}
              </button>`
        }
        ${
          // A commit done and somewhere to push it: the next step, one tap away. The push sheet
          // reloads the repo and keeps its own confirmation (protected branches included).
          mode === 'commit' && result.ok && pushTarget()
            ? html`<button data-testid="ship-push-next" @pointerdown=${pushNext} @pointerup=${pushNext} @click=${pushNext}>
                ${t('ship.push')}
              </button>`
            : nothing
        }
        <button class="ut-ship-primary" data-testid="ship-done" @pointerdown=${close} @pointerup=${close} @click=${close}>
          ${t('ship.close')}
        </button>
      </div>
    `;
  };

  const body = () => {
    if (view === 'loading') return html`<div class="ut-ship-note">${t('changes.loading')}</div>`;
    if (view === 'error')
      return html`<div class="ut-ship-err">${loadError || t('ship.failed')}</div>`;
    if (view === 'running')
      return html`<div class="ut-ship-note" data-testid="ship-running">${t('ship.running')}</div>`;
    if (view === 'done') return renderDone();
    if (!status) return nothing;
    if (view === 'confirm') return renderConfirm(status);
    return mode === 'commit'
      ? renderCommitForm(status)
      : mode === 'push'
        ? renderPushForm(status)
        : renderPrForm(status);
  };

  const title =
    mode === 'commit' ? t('ship.commit') : mode === 'push' ? t('ship.push') : t('ship.pr');

  const draw = () => {
    if (openHost !== host) return;
    render(
      html`
        <style>
          .ut-ship {
            position: fixed;
            inset: 0;
            display: flex;
            flex-direction: column;
            background: var(--color-bg);
            color: var(--color-text);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
          }
          .ut-ship-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
          }
          .ut-ship-title { flex: 1; font-weight: var(--ut-fw-semibold); font-size: 15px; }
          .ut-ship button {
            min-height: 44px;
            padding: 0 14px;
            border-radius: var(--ut-r-8);
            font-size: 15px;
            border: 1px solid var(--color-border);
            color: var(--color-text);
            background: var(--color-bg-tertiary);
            touch-action: manipulation;
          }
          .ut-ship button:disabled { opacity: 0.45; }
          .ut-ship button.ut-ship-primary {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: var(--color-bg);
            font-weight: var(--ut-fw-semibold);
          }
          .ut-ship-body {
            flex: 1;
            overflow: auto;
            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;
            padding: 12px 12px calc(20px + env(safe-area-inset-bottom));
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .ut-ship-kv { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
          .ut-ship-kv span { color: var(--color-text-muted); }
          .ut-ship-kv code { overflow-wrap: anywhere; text-align: right; }
          .ut-ship-files, .ut-ship-list { list-style: none; margin: 0; padding: 0; }
          .ut-ship-list li {
            font-family: var(--ut-font-mono-system);
            font-size: 13px;
            padding: 2px 0;
            overflow-wrap: anywhere;
          }
          .ut-ship-file {
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 44px;
            border-bottom: 1px solid var(--color-border);
          }
          .ut-ship-file input, .ut-ship-check input { width: 22px; height: 22px; flex: 0 0 auto; }
          .ut-ship-status {
            width: 18px;
            font-family: var(--ut-font-mono-system);
            font-weight: var(--ut-fw-bold);
            color: var(--color-text-muted);
          }
          .ut-ship-path {
            flex: 1;
            min-width: 0;
            font-family: var(--ut-font-mono-system);
            font-size: 13px;
            overflow-wrap: anywhere;
          }
          .ut-ship-label { font-size: 13px; color: var(--color-text-muted); }
          .ut-ship textarea, .ut-ship input:not([type]), .ut-ship select {
            width: 100%;
            font-size: 16px;
            padding: 10px;
            border-radius: var(--ut-r-8);
            border: 1px solid var(--color-border);
            background: var(--color-bg-secondary);
            color: var(--color-text);
          }
          .ut-ship-check { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15px; }
          .ut-ship-danger { color: var(--color-status-error); font-weight: var(--ut-fw-semibold); }
          .ut-ship-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
          .ut-ship-note, .ut-ship-dim { color: var(--color-text-dim); font-size: 14px; }
          .ut-ship-note { text-align: center; padding: 16px 4px; }
          .ut-ship-warn { color: var(--color-status-warning-text, var(--color-status-warning)); font-size: 14px; }
          .ut-ship-ok { color: var(--color-status-success); font-weight: var(--ut-fw-semibold); }
          .ut-ship-err { color: var(--color-status-error); font-weight: var(--ut-fw-semibold); overflow-wrap: anywhere; }
          .ut-ship-out {
            margin: 0;
            padding: 10px;
            border-radius: var(--ut-r-8);
            background: var(--color-bg-secondary);
            border: 1px solid var(--color-border);
            font-family: var(--ut-font-mono-system);
            font-size: 12px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 45vh;
            overflow: auto;
            user-select: text;
            -webkit-user-select: text;
          }
          .ut-ship-confirm p { margin: 0 0 8px; font-size: 15px; }
          .ut-ship-link {
            display: block;
            padding: 12px;
            border-radius: var(--ut-r-8);
            border: 1px solid var(--color-primary);
            color: var(--color-primary);
            text-decoration: none;
            overflow-wrap: anywhere;
            font-weight: var(--ut-fw-semibold);
          }
        </style>
        <div
          class="ut-ship"
          role="dialog"
          aria-modal="true"
          aria-label=${title}
          data-view=${view}
          style="z-index: ${Z_INDEX.MODAL + 1};"
        >
          <div class="ut-ship-bar">
            <div class="ut-ship-title">${title}</div>
            <button data-testid="ship-close" @pointerdown=${close} @pointerup=${close} @click=${close}>
              ${t('ship.close')}
            </button>
          </div>
          <div class="ut-ship-body">${body()}</div>
        </div>
      `,
      host
    );
  };

  draw();
  const sheet = host.querySelector<HTMLElement>('.ut-ship');
  releaseFocus = holdSheetFocus(sheet, () =>
    view === 'confirm' ? setView('form') : closeShipSheet()
  );
  // Its confirm buttons end the form: above the keyboard while the message is typed.
  if (sheet) stopKeyboard = followKeyboard(sheet);
  void load();
}
