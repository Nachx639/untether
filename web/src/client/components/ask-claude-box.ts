/**
 * "Ask Claude…" / "Ask Codex…" on the phone home screen: pick the agent, type a question,
 * pick the folder, send. The session list starts the agent there and the server types the
 * question once the agent is ready.
 *
 * In a git repository a Tarea / Sesión chip says what the text becomes (P6, 2026-10-18): a task
 * (sent to the open task it belongs to, or a new one on its own branch; the default) or a plain
 * session, as before. Outside a repository it is always a session and the chip is not shown.
 *
 * Events: `ask-claude` ({ text, agent, mode }) on send, `ask-pick-folder` when the folder chip
 * is tapped.
 */

import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import { type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { caretTapDiagnostics } from '../utils/caret-tap-diagnostics.js';
import { composerHeightFor } from '../utils/composer-height.js';
import { DictationController, type DictationState, dictationErrorKey } from '../utils/dictation.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { icon } from './icons.js';

export const ASK_DRAFT_KEY = 'ut-ask-claude-draft';
export const ASK_AGENT_KEY = 'ut-ask-agent';
export const ASK_MODE_KEY = 'ut-ask-mode';

export type AskAgent = 'claude' | 'codex';
/** What the text becomes in a repository: a task (routed) or a plain session. */
export type AskMode = 'task' | 'session';

/** The mode picked last (Tarea unless Sesión was picked). */
export function readAskMode(): AskMode {
  try {
    return localStorage.getItem(ASK_MODE_KEY) === 'session' ? 'session' : 'task';
  } catch {
    return 'task';
  }
}

function writeAskMode(mode: AskMode) {
  try {
    localStorage.setItem(ASK_MODE_KEY, mode);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

/** The agent picked last in the ask box (Claude unless Codex was picked). */
export function readAskAgent(): AskAgent {
  try {
    return localStorage.getItem(ASK_AGENT_KEY) === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

function writeAskAgent(agent: AskAgent) {
  try {
    localStorage.setItem(ASK_AGENT_KEY, agent);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

function readDraft(): string {
  try {
    return localStorage.getItem(ASK_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(text: string) {
  try {
    if (text) localStorage.setItem(ASK_DRAFT_KEY, text);
    else localStorage.removeItem(ASK_DRAFT_KEY);
  } catch {
    // Blocked storage: the draft just isn't kept.
  }
}

const logger = createLogger('ask-claude-box');

/**
 * What the folder chip shows: the folder's own name, "~" or "/". The whole path, cut at the
 * end to fit ("~/Proj…"), hid the one part that tells folders apart (2026-10-03).
 */
export function folderName(displayPath: string): string {
  const trimmed = displayPath.replace(/\/+$/, '');
  if (!trimmed) return displayPath ? '/' : '~';
  if (trimmed === '~') return '~';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

@customElement('ask-claude-box')
export class AskClaudeBox extends LitElement {
  createRenderRoot() {
    return this;
  }

  /** Folder Claude starts in (shown on the chip). */
  @property({ type: String }) folder = '~';
  /** True while the session is being created: blocks a double send. */
  @property({ type: Boolean }) busy = false;
  /**
   * Compact phone list (utils/phone-list-layout.ts): "Tareas" as an icon in this row instead
   * of a link on its own line below the box. A tap fires `ask-open-tasks`.
   */
  @property({ type: Boolean }) tasks = false;
  /** The folder is in a git repository: the Tarea / Sesión chip shows. */
  @property({ type: Boolean }) repo = false;

  @state() private text = readDraft();
  @state() private agent: AskAgent = readAskAgent();
  @state() private mode: AskMode = readAskMode();
  @state() private dictation: DictationState = 'idle';
  @state() private dictationNote = '';
  private dictationNoteTimer: ReturnType<typeof setTimeout> | null = null;

  /** iOS: a touch acts on pointerup (a first tap can be eaten as hover); skip its click. */
  private ignoreClickUntil = 0;
  /** Where a tap in the text put the caret, as the phone saw it (caret-tap-diagnostics.ts). */
  private caretTaps = caretTapDiagnostics((line) => logger.log(`ask caret tap: ${line}`));

  private onTap(action: () => void) {
    return {
      pointerup: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        // A scroll of the list that started on a button ends here too: not a tap.
        if (endsADrag(e)) return;
        e.preventDefault();
        this.ignoreClickUntil = Date.now() + 700;
        swallowNextClick();
        action();
      },
      click: () => {
        if (Date.now() < this.ignoreClickUntil) return;
        action();
      },
    };
  }

  private sendTap = this.onTap(() => this.send());
  private claudeTap = this.onTap(() => this.pickAgent('claude'));
  private codexTap = this.onTap(() => this.pickAgent('codex'));

  private pickAgent(agent: AskAgent) {
    if (agent === this.agent) return;
    this.agent = agent;
    writeAskAgent(agent);
  }
  private micTap = this.onTap(() => this.toggleDictation());
  private modeTap = this.onTap(() => {
    this.mode = this.mode === 'task' ? 'session' : 'task';
    writeAskMode(this.mode);
  });

  /** What the text becomes: a task only in a repository. */
  private get effectiveMode(): AskMode {
    return this.repo ? this.mode : 'session';
  }

  /** Dictation (speech to text into the box): see DictationController. */
  private dictationController = new DictationController({
    getText: () => this.text,
    setText: (value) => {
      this.text = value;
      writeDraft(value);
      const input = this.querySelector('textarea');
      if (input) {
        input.value = value;
        this.autoSize(input);
      }
    },
    onState: (state) => {
      this.dictation = state;
      if (state !== 'idle') this.setDictationNote('');
    },
    onError: (error) => this.setDictationNote(t(dictationErrorKey(error) as MessageKey)),
    authHeaders: () => authClient.getAuthHeader(),
  });

  private setDictationNote(note: string) {
    if (this.dictationNoteTimer) clearTimeout(this.dictationNoteTimer);
    this.dictationNote = note;
    if (note) this.dictationNoteTimer = setTimeout(() => (this.dictationNote = ''), 7000);
  }

  private toggleDictation() {
    void this.dictationController.toggle();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.dictationController.cancel();
  }
  private folderTap = this.onTap(() =>
    this.dispatchEvent(new CustomEvent('ask-pick-folder', { bubbles: true }))
  );
  private tasksTap = this.onTap(() =>
    this.dispatchEvent(new CustomEvent('ask-open-tasks', { bubbles: true }))
  );

  send() {
    const text = this.text.trim();
    // Still turning the dictation into text: sending now would throw that text away.
    if (!text || this.busy || this.dictation === 'transcribing') return;
    // abort, not stop: stop() still delivers a final result, which would put the sent
    // question back into the box.
    this.dictationController.cancel();
    this.dispatchEvent(
      new CustomEvent('ask-claude', {
        detail: { text, agent: this.agent, mode: this.effectiveMode },
        bubbles: true,
      })
    );
    this.text = '';
    writeDraft('');
    const input = this.querySelector('textarea');
    if (input) {
      input.value = '';
      this.autoSize(input);
    }
  }

  /** Put text back (the session could not be started) unless something new was typed. */
  restore(text: string) {
    if (this.text.trim()) return;
    this.text = text;
    writeDraft(text);
  }

  private autoSize(input: HTMLTextAreaElement) {
    input.style.height = 'auto';
    // scrollHeight includes the padding: setting it as a content-box height counted the
    // padding twice and showed an extra blank line (2026-10-03, same fix as the chat composer).
    input.style.height = `${Math.min(composerHeightFor(input.scrollHeight, getComputedStyle(input)), 140)}px`;
  }

  private onInput = (e: Event) => {
    const input = e.target as HTMLTextAreaElement;
    // The render that follows compares with the field itself (live()), so a keystroke is never
    // written back into it: the caret stays where a tap put it (2026-10-12).
    this.text = input.value;
    writeDraft(input.value);
    this.autoSize(input);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    // Desktop keyboards: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter
    // for new lines and send with the button.
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) {
      e.preventDefault();
      this.send();
    }
  };

  render() {
    const folder = formatPathForDisplay(this.folder);
    const name = folderName(folder);
    const codex = this.agent === 'codex';
    const asTask = this.effectiveMode === 'task';
    const placeholder = t(
      asTask ? 'ask.placeholderTask' : codex ? 'ask.placeholderCodex' : 'ask.placeholder'
    );
    const sendLabel = t(codex ? 'ask.sendCodex' : 'ask.send');
    // Always the names, even on an SE (2026-10-12): the folder chip gives way instead.
    const agentButton = (
      agent: AskAgent,
      label: string,
      tap: { pointerup: (e: PointerEvent) => void; click: () => void }
    ) =>
      html`<button
        type="button"
        role="radio"
        aria-checked=${this.agent === agent ? 'true' : 'false'}
        aria-label=${label}
        title=${label}
        class="ut-surface--segment ${this.agent === agent ? 'selected' : ''}"
        data-testid=${`ask-agent-${agent}`}
        @pointerup=${tap.pointerup}
        @click=${tap.click}
      ><span class="ask-agent-name">${label}</span></button>`;
    return html`
      <div class="ask-claude ut-surface--material ut-surface--well" data-testid="ask-claude">
        <textarea
          rows="1"
          dir="auto"
          enterkeyhint="enter"
          placeholder=${placeholder}
          aria-label=${placeholder}
          .value=${live(this.text)}
          @input=${this.onInput}
          @keydown=${this.onKeyDown}
          @pointerdown=${this.caretTaps.pointerdown}
          @pointerup=${this.caretTaps.pointerup}
        ></textarea>
        <div class="ask-claude-bar">
          <span class="ask-claude-start">
          <span
            class="ask-claude-agent"
            role="radiogroup"
            aria-label=${t('ask.agent')}
          >
            ${agentButton('claude', 'Claude', this.claudeTap)}${agentButton('codex', 'Codex', this.codexTap)}
          </span>
          ${
            this.repo
              ? html`<button
                  type="button"
                  class="ut-surface--control ask-claude-mode ${asTask ? 'task' : ''}"
                  data-testid="ask-mode"
                  data-mode=${this.mode}
                  aria-label=${t(asTask ? 'ask.modeTaskLabel' : 'ask.modeSessionLabel')}
                  title=${t(asTask ? 'ask.modeTaskLabel' : 'ask.modeSessionLabel')}
                  @pointerup=${this.modeTap.pointerup}
                  @click=${this.modeTap.click}
                >
                  ${icon(asTask ? 'gitBranch' : 'terminal', 14)}
                  <span class="ask-claude-mode-label"
                    >${t(asTask ? 'ask.modeTask' : 'ask.modeSession')}</span
                  >
                </button>`
              : ''
          }
          <button
            class="ut-surface--control ask-claude-folder"
            data-testid="ask-claude-folder"
            aria-label=${t('ask.folder', { folder })}
            title=${folder}
            @pointerup=${this.folderTap.pointerup}
            @click=${this.folderTap.click}
          >
            ${icon('folder', 14)}
            <bdi>${name}</bdi>
          </button>
          </span>
          <span class="ask-claude-actions">
          ${
            this.tasks
              ? html`<button
                  type="button"
                  class="ut-surface--control ut-surface--compact ask-claude-tasks"
                  data-testid="open-tasks"
                  aria-label=${t('tasks.open')}
                  title=${t('tasks.open')}
                  @pointerup=${this.tasksTap.pointerup}
                  @click=${this.tasksTap.click}
                >
                  ${icon('clock', 20)}
                </button>`
              : ''
          }
          ${html`<button
                  class="ut-surface--control ask-claude-mic ${this.dictation === 'listening' || this.dictation === 'recording' || this.dictation === 'starting' ? 'listening' : ''}"
                  data-testid="ask-claude-mic"
                  aria-label=${t(this.dictation === 'idle' ? 'chat.dictate' : 'chat.stopDictation')}
                  aria-pressed=${this.dictation === 'idle' ? 'false' : 'true'}
                  title=${t(this.dictation === 'idle' ? 'chat.dictate' : 'chat.stopDictation')}
                  ?disabled=${this.dictation === 'transcribing'}
                  @pointerup=${this.micTap.pointerup}
                  @click=${this.micTap.click}
                >
                  ${
                    this.dictation === 'idle'
                      ? icon('mic', 18)
                      : this.dictation === 'transcribing'
                        ? html`<span class="ask-claude-spinner" aria-hidden="true"></span>`
                        : html`<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>`
                  }
                </button>`}
          <button
            class="ask-claude-send ut-surface--material ut-surface--action ut-surface--primary"
            data-testid="ask-claude-send"
            aria-label=${sendLabel}
            title=${sendLabel}
            ?disabled=${!this.text.trim() || this.busy || this.dictation === 'transcribing'}
            @pointerup=${this.sendTap.pointerup}
            @click=${this.sendTap.click}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </button>
          </span>
        </div>
        ${
          this.dictation !== 'idle' || this.dictationNote
            ? html`<div
                class="ask-claude-note ${this.dictation !== 'idle' ? 'active' : ''}"
                role=${this.dictation !== 'idle' ? 'status' : 'alert'}
                data-testid="ask-claude-note"
              >
                ${
                  this.dictation === 'starting'
                    ? t('dictation.starting')
                    : this.dictation === 'listening'
                      ? t('dictation.listening')
                      : this.dictation === 'recording'
                        ? t('dictation.recording')
                        : this.dictation === 'transcribing'
                          ? t('dictation.transcribing')
                          : this.dictationNote
                }
              </div>`
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ask-claude-box': AskClaudeBox;
  }
}
