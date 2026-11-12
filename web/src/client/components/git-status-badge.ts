/**
 * Git Status Badge Component
 *
 * Displays git repository status information in a compact badge format.
 * Shows counts for changed files, line changes, and ahead/behind commits.
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { midCutTitle } from '../utils/card-line.js';
import { icon } from './icons.js';

@customElement('git-status-badge')
export class GitStatusBadge extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) session: Session | null = null;
  @property({ type: Boolean }) detailed = false; // Show detailed breakdown

  render() {
    // Show badge if we have a git repo path (even if branch is not loaded yet)
    if (!this.session?.gitRepoPath) return null;

    // Branch chip, worktree chip, then the counts, inline after the path (design spec 5.2).
    // No box of its own (2026-11-12): each piece is an item of the line that holds the badge
    // (styles/session.css `.ut-session-header-line2`), which decides what gives way.
    return html`
      ${this.renderBranchInfo()}
      ${this.renderWorktreeChip()}
      ${this.renderLocalChanges()}
      ${this.renderLineChanges()}
      ${this.renderRemoteChanges()}
    `;
  }

  /**
   * The branch as a mono chip. No branch name means a detached HEAD (a worktree checked out at
   * a commit, a rebase in progress): it says HEAD with a tooltip, never "[git]" (2026-10-12).
   * A long branch is cut in its middle (`.ut-mid`): task branches differ at their end.
   */
  private renderBranchInfo() {
    const branch = this.session?.gitBranch || '';
    const label = branch || 'HEAD';
    const tooltip = branch || t('git.detached');
    return html`
      <span
        class="ut-chip ut-chip--mono ut-git-branch"
        data-testid="git-branch-chip"
        data-detached=${branch ? 'false' : 'true'}
        title=${tooltip}
        aria-label=${branch ? branch : t('git.detached')}
      >
        ${icon('gitBranch', 12)}
        <span class="ut-mid" dir="ltr">${midCutTitle(label)}</span>
      </span>
    `;
  }

  private renderWorktreeChip() {
    if (!this.session?.gitIsWorktree) return null;
    return html`<span class="ut-chip ut-git-extra" data-testid="git-worktree-chip" title=${t('git.worktree')}
      >${t('git.worktree')}</span
    >`;
  }

  private renderLocalChanges() {
    if (!this.session) return null;

    const addedCount = this.session?.gitAddedCount ?? 0;
    const modifiedCount = this.session?.gitModifiedCount ?? 0;
    const deletedCount = this.session?.gitDeletedCount ?? 0;
    const totalChanges = addedCount + modifiedCount + deletedCount;

    if (totalChanges === 0 && !this.detailed) return null;

    if (this.detailed) {
      // Detailed view shows individual counts
      return html`
        <span class="ut-git-extra flex items-center gap-1">
          ${
            addedCount > 0
              ? html`
            <span class="text-status-success" title=${t('gitBadge.newFiles')}>
              +${addedCount}
            </span>
          `
              : null
          }
          ${
            modifiedCount > 0
              ? html`
            <span class="text-status-warning" title=${t('gitBadge.modifiedFiles')}>
              ~${modifiedCount}
            </span>
          `
              : null
          }
          ${
            deletedCount > 0
              ? html`
            <span class="text-status-error" title=${t('gitBadge.deletedFiles')}>
              -${deletedCount}
            </span>
          `
              : null
          }
        </span>
      `;
    } else {
      // Compact view shows total with an indicator
      return html`
        <span
          class="ut-git-extra ut-data text-text-dim whitespace-nowrap"
          data-testid="git-changed-files"
          title=${t('gitBadge.summary', { added: addedCount, modified: modifiedCount, deleted: deletedCount })}
          >●${totalChanges}</span
        >
      `;
    }
  }

  private renderRemoteChanges() {
    if (!this.session) return null;

    const aheadCount = this.session?.gitAheadCount ?? 0;
    const behindCount = this.session?.gitBehindCount ?? 0;

    if (aheadCount === 0 && behindCount === 0) return null;

    return html`
      <span class="ut-git-extra ut-data inline-flex items-center gap-1 whitespace-nowrap">
        ${
          aheadCount > 0
            ? html`
          <span class="text-status-success" title=${t('gitBadge.ahead')}>
            ↑${aheadCount}
          </span>
        `
            : null
        }
        ${
          behindCount > 0
            ? html`
          <span class="text-status-error" title=${t('gitBadge.behind')}>
            ↓${behindCount}
          </span>
        `
            : null
        }
      </span>
    `;
  }

  private renderLineChanges() {
    if (!this.session) return null;

    const insertionCount = this.session.gitInsertionCount ?? 0;
    const deletionCount = this.session.gitDeletionCount ?? 0;

    if (insertionCount === 0 && deletionCount === 0) return null;

    return html`
      <span class="ut-git-extra ut-data inline-flex items-center gap-1 whitespace-nowrap" data-testid="git-line-changes">
        ${
          insertionCount > 0
            ? html`
          <span class="text-status-success" title=${t('gitBadge.insertions')}>+${insertionCount}</span>
        `
            : null
        }
        ${
          deletionCount > 0
            ? html`
          <span class="text-status-error" title=${t('gitBadge.deletions')}>−${deletionCount}</span>
        `
            : null
        }
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-status-badge': GitStatusBadge;
  }
}
