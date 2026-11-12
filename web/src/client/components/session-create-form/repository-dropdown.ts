/**
 * Repository Dropdown Component
 *
 * Dropdown list of discovered repositories for quick selection.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Repository } from '../autocomplete-manager.js';

@customElement('repository-dropdown')
export class RepositoryDropdown extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @property({ type: Array }) repositories: Repository[] = [];

  private handleRepositoryClick(repoPath: string) {
    this.dispatchEvent(
      new CustomEvent('repository-selected', {
        detail: { path: repoPath },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (!this.visible || this.repositories.length === 0) {
      return nothing;
    }

    return html`
      <div class="absolute left-0 right-0 mt-1 z-50 bg-bg-elevated rounded-card overflow-hidden font-ui" style="box-shadow: var(--shadow-e2)">
        <div class="max-h-60 overflow-y-auto p-1">
          ${this.repositories.map(
            (repo) => html`
              <button
                @click=${() => this.handleRepositoryClick(repo.path)}
                class="w-full text-left px-2 py-1.5 rounded-ctl hover:bg-surface-hover transition-colors"
                type="button"
              >
                <div class="flex items-center justify-between">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="text-text text-ui font-medium truncate">${repo.folderName}</div>
                    </div>
                    <div class="text-text-dim font-mono text-[11px] mt-0.5 truncate" dir="ltr">${repo.relativePath}</div>
                  </div>
                  <div class="text-text-dim text-caption tnum flex-none ml-3">
                    ${new Date(repo.lastModified).toLocaleDateString()}
                  </div>
                </div>
              </button>
            `
          )}
        </div>
      </div>
    `;
  }
}
