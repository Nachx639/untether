/**
 * The one avatar of a session or task, in every list (an agent-avatar test fails on any tile
 * drawn outside this file). What an external model provider's icon does depends on the tile:
 * - an agent's logo: the icon replaces it (providerLogo);
 * - a project's logo or an orchestrator's mark: that stays, the icon is a badge in the top-left
 *   corner, and the small mark usually there moves to the top-right (list.css, :has).
 * The state dot keeps its corner in every case. With no provider, UntetherConfig.avatarIcons
 * replaces the app's mark in all of them; an image or emoji is then the whole avatar, no tile.
 */
import { html, nothing, type TemplateResult } from 'lit';
import type { AvatarIconKey } from '../../shared/model-providers.js';
import { type AgentKind, agentGlyph, CLAUDE_MARK, CODEX_MARK, GEMINI_MARK, icon } from './icons.js';
import { type ProviderRef, providerCorner, providerLogo } from './provider-badge.js';

export type AvatarKind = AgentKind | 'gemini' | 'terminal';

interface AvatarBase {
  kind: AvatarKind;
  provider?: ProviderRef;
  /** The project's logo, when this row shows one. */
  projectIcon?: string | null;
  iconTestId?: string;
  /** The logo failed to load: the host redraws without it. */
  onIconError?: () => void;
}

type AvatarOptions =
  | (AvatarBase & { variant: 'row'; state: string })
  | (AvatarBase & { variant: 'side'; status: string; title?: string; orchestrator?: boolean })
  | (AvatarBase & { variant: 'card' })
  | (AvatarBase & { variant: 'inline' });

/** A page preview's tile: not a session's, so no agent. Paused = its server is down. */
interface PreviewAvatarOptions {
  variant: 'preview';
  paused: boolean;
  compact: boolean;
}

function glyphKind(kind: AvatarKind): AgentKind {
  return kind === 'claude' || kind === 'codex' ? kind : 'shell';
}

/** Gemini has a mark of its own but no entry in avatarIcons; it must not wear the shell's. */
function avatarIconKey(kind: AvatarKind): AvatarIconKey | undefined {
  if (kind === 'claude' || kind === 'codex') return kind;
  return kind === 'gemini' ? undefined : 'shell';
}

/** Only the logo, for lists with no tile: the provider's icon or the agent's. */
export function agentLogo(
  kind: AvatarKind,
  provider: ProviderRef | undefined,
  size?: number
): unknown {
  return providerLogo(provider, agentGlyph(glyphKind(kind), size ?? 16), {
    avatar: avatarIconKey(kind),
    size,
  });
}

/** The small mark on a project's logo: the provider has the badge there, this stays the agent's. */
function projectTileMark(kind: AvatarKind, provider: ProviderRef | undefined, glyph: unknown) {
  return provider ? glyph : providerLogo(undefined, glyph, { avatar: avatarIconKey(kind) });
}

function rowMark(kind: AvatarKind) {
  if (kind === 'claude') return CLAUDE_MARK;
  if (kind === 'codex') return CODEX_MARK;
  if (kind === 'gemini') return GEMINI_MARK;
  return icon('terminal', 20);
}

/**
 * A row's 40 px tile, one 12 px state dot. Live reads in colour, finished in grey (2026-10-12):
 * list.css colours the tile from its data-state and the dot from its class. An orchestrator's
 * row shows its project's icon, the agent's mark small in a corner (2026-10-20); an icon that
 * can't load leaves the plain avatar.
 */
function rowTile(options: Extract<AvatarOptions, { variant: 'row' }>): TemplateResult {
  const { kind, state, provider, projectIcon } = options;
  const mark = rowMark(kind);
  const hidden = provider ? nothing : 'true';
  if (projectIcon) {
    const broken = (e: Event) => {
      (e.target as HTMLElement).closest('.psr-avatar')?.removeAttribute('data-icon');
    };
    return html`<div
      class="psr-avatar psr-avatar-${kind}"
      data-state=${state}
      data-icon="project"
      aria-hidden=${hidden}
    >
      <img class="psr-avatar-icon" src=${projectIcon} alt="" @error=${broken} />
      <span class="psr-avatar-glyph">${projectTileMark(kind, provider, mark)}</span>
      ${providerCorner(provider)}
      <span class="psr-dot psr-dot-${state}"></span>
    </div>`;
  }
  return html`<div class="psr-avatar psr-avatar-${kind}" data-state=${state} aria-hidden=${hidden}>
    ${providerLogo(provider, mark, { avatar: avatarIconKey(kind) })}<span class="psr-dot psr-dot-${state}"></span>
  </div>`;
}

export function agentAvatar(options: AvatarOptions | PreviewAvatarOptions): TemplateResult {
  if (options.variant === 'preview') {
    const size = options.compact ? 16 : 20;
    const avatar = options.paused ? 'previewPaused' : 'preview';
    return html`<div class="psr-avatar pvr-avatar" aria-hidden="true">
      ${providerLogo(undefined, icon('eye', size), { avatar, size })}
    </div>`;
  }
  if (options.variant === 'row') return rowTile(options);
  const { kind, provider, projectIcon, iconTestId, onIconError } = options;
  const logoImage = (className: string) => html`<img
    class=${className}
    data-testid=${iconTestId ?? nothing}
    src=${projectIcon}
    alt=""
    @error=${() => onIconError?.()}
  />`;

  if (options.variant === 'inline') {
    return projectIcon
      ? html`<span class="ut-card-glyph ut-inline-project"
          >${logoImage('ut-repo-icon')}${providerCorner(provider)}</span
        >`
      : html`<span class="ut-card-glyph">${agentLogo(kind, provider)}</span>`;
  }

  const tileIcon = projectIcon ? logoImage('ut-tile-icon') : nothing;
  const data = projectIcon ? 'project' : nothing;
  const smallSize = projectIcon ? 10 : 16;

  if (options.variant === 'card') {
    return html`<span class="ut-card-avatar" data-icon=${data} aria-hidden=${provider ? nothing : 'true'}
      >${tileIcon}${
        projectIcon
          ? html`${projectTileMark(kind, provider, agentGlyph(glyphKind(kind), smallSize))}${providerCorner(provider)}`
          : agentLogo(kind, provider)
      }<span class="ut-card-dot"></span
    ></span>`;
  }

  const { status, title, orchestrator } = options;
  // The sidebar's orchestrators wear their sparkles instead of the agent's logo.
  const keepsLogo = projectIcon || orchestrator;
  const mark = orchestrator
    ? icon('sparkles', smallSize)
    : projectTileMark(kind, provider, agentGlyph(glyphKind(kind), smallSize));
  return html`<span
    class="ut-side-avatar ${orchestrator ? 'is-orchestrator' : ''}"
    data-status=${status}
    data-icon=${data}
    title=${title ?? nothing}
    >${tileIcon}${keepsLogo ? html`${mark}${providerCorner(provider)}` : agentLogo(kind, provider)}<span
      class="ut-dot ut-side-dot"
      data-status=${status}
    ></span
  ></span>`;
}
