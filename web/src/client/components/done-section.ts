/**
 * "Hechas (n)" on the home (2026-10-18): the last merged and discarded tasks (newest first, at
 * most 20, utils/project-groups.ts), collapsed until tapped; the choice is remembered on this
 * device. A row still opens its session while the list has it.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { icon } from './icons.js';
import { renderSectionHead } from './section-head.js';
import './task-row.js';

const OPEN_KEY = 'ut-done-tasks-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Blocked storage: it stays as chosen until the page reloads.
  }
}

@customElement('done-section')
export class DoneSection extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) tasks: TaskRecord[] = [];
  @property({ attribute: false }) sessionsById: ReadonlyMap<string, Session> = new Map();
  /** 'row' on the phone, 'card' in the desktop grid. */
  @property({ type: String }) layout: 'row' | 'card' = 'row';
  @state() private open = readOpen();

  /** Open it (a task push for one of its rows), remembered like a tap. */
  expand() {
    if (this.open) return;
    this.open = true;
    writeOpen(true);
  }

  private toggle = () => {
    this.open = !this.open;
    writeOpen(this.open);
  };

  render() {
    if (!this.tasks.length) return nothing;
    const listId = 'done-tasks-rows';
    const label = t('board.done', { n: this.tasks.length });
    // The desktop grid's sections share one folding header (section-head.ts); the phone's is
    // its eyebrow with the chevron after it.
    const head =
      this.layout === 'card'
        ? renderSectionHead({
            label,
            open: this.open,
            toggle: this.toggle,
            testid: 'done-toggle',
            controls: listId,
          })
        : html`<div class="ut-phone-section">
            <button
              type="button"
              class="ut-phone-disclosure"
              data-testid="done-toggle"
              aria-expanded=${this.open ? 'true' : 'false'}
              aria-controls=${listId}
              @click=${this.toggle}
            >
              <span class="ut-phone-eyebrow">${label}</span>
              ${icon('chevronRight', 14)}
            </button>
          </div>`;
    return html`<section
      class=${this.layout === 'card' ? 'ut-section' : 'prj prj-done'}
      data-testid="done-section"
    >
      ${head}
      ${
        this.open
          ? html`<div
              class=${this.layout === 'card' ? 'tsk-grid' : 'psr-list'}
              id=${listId}
              data-testid="done-list"
            >
              ${repeat(
                this.tasks,
                (task) => task.id,
                (task) => html`<task-row
                  data-task=${task.id}
                  .task=${task}
                  .session=${task.sessionId ? this.sessionsById.get(task.sessionId) : undefined}
                  .variant=${'done'}
                ></task-row>`
              )}
            </div>`
          : html`<div id=${listId} hidden></div>`
      }
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'done-section': DoneSection;
  }
}
