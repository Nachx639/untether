/**
 * The mark of a session or task that runs on an external model provider instead of Anthropic's
 * models, as configured for that provider (UntetherConfig.modelProviders). Two places:
 * providerLogo() draws its `icon` in the avatar (agent-avatar.ts); ut-provider-badge is the small mark
 * for a provider with no usable `icon` (a discreet plug) and for views without a tile. The rows
 * hold only the provider id, so the list of providers comes from the server config, shared by
 * every mark (model-provider-list.ts). The same logo draws UntetherConfig.avatarIcons when the
 * row has no provider.
 */
import { html, LitElement, nothing } from 'lit';
import { AsyncDirective, directive } from 'lit/async-directive.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { AvatarIconKey } from '../../shared/model-providers.js';
import { t } from '../i18n/index.js';
import {
  avatarMark,
  knownProviders,
  markIconFileBroken,
  providerMark,
  type ResolvedProviderIcon,
  watchAvatarIcons,
  watchProviders,
} from '../services/model-provider-list.js';
import { ICON_NAMES, type IconName, icon } from './icons.js';

const BADGE_ICON_SIZE = 12;

/** The provider a row runs on: its id and, when known, the model. */
export interface ProviderRef {
  id: string;
  model?: string;
}

type DrawableIcon = Exclude<ResolvedProviderIcon, { kind: 'generic' }>;

/** A provider's `icon` when the app can draw it: a name outside its set counts as no icon. */
function drawableIcon(mark: ResolvedProviderIcon): DrawableIcon | undefined {
  if (mark.kind === 'generic') return undefined;
  if (mark.kind !== 'named') return mark;
  return (ICON_NAMES as string[]).includes(mark.name) ? mark : undefined;
}

/** An image is a blob already in memory (model-provider-list.ts): drawn at once, never lazily. */
function drawIcon(mark: DrawableIcon, size: number) {
  if (mark.kind === 'emoji') return html`<span class="ut-provider-emoji">${mark.emoji}</span>`;
  if (mark.kind === 'named') return icon(mark.name as IconName, size);
  return html`<img
    class="ut-provider-img"
    data-testid="provider-img"
    src=${mark.url}
    alt=""
    width=${size}
    height=${size}
    @error=${() => markIconFileBroken(mark.file)}
  />`;
}

function markLabel(name: string, model: string | undefined): string {
  const provider = t('board.providerBadge', { name });
  return model ? `${provider} · ${model}` : provider;
}

/** An image or emoji is the whole avatar, no tile behind it (styles.css); a line icon needs one. */
const fillsTile = (mark: DrawableIcon) => (mark.kind === 'named' ? '' : 'ut-logo-full');

interface LogoOptions {
  /** The badge on a project's logo instead of the logo itself. */
  corner?: boolean;
  /** With no provider: the avatarIcons entry that replaces `logo`. */
  avatar?: AvatarIconKey;
  /** The logo's side where no tile sets it. */
  size?: number;
}

/**
 * Renders the provider's `icon` where `logo` (the agent's) would go, and `logo` itself with no
 * provider or no usable `icon`; with no provider at all, the `avatar` entry of avatarIcons goes
 * there first. In `corner` mode it is the badge on a project's logo instead, and nothing without
 * an icon. A directive, not an element: what it draws stays a direct child of the tile, where
 * list.css tints the glyph and places the corner marks.
 */
class ProviderLogoDirective extends AsyncDirective {
  private provider?: ProviderRef;
  private logo: unknown;
  private options: LogoOptions = {};
  private stopWatching?: () => void;

  render(provider: ProviderRef | undefined, logo: unknown, options: LogoOptions = {}) {
    this.provider = provider;
    this.logo = logo;
    this.options = options;
    if (provider || options.avatar) this.watch();
    else this.unwatch();
    return this.draw(knownProviders());
  }

  private drawAvatar() {
    const { avatar, size } = this.options;
    const mark = avatar && avatarMark(avatar);
    const drawable = mark && drawableIcon(mark);
    if (!drawable) return this.logo;
    return html`<span
      class="ut-agent-glyph ut-provider-logo ${fillsTile(drawable)}"
      data-testid="avatar-logo"
      data-avatar=${avatar}
      style=${size ? `--ut-provider-logo-size:${size}px` : nothing}
      aria-hidden="true"
      >${drawIcon(drawable, size ?? BADGE_ICON_SIZE)}</span
    >`;
  }

  private draw(providers: ReturnType<typeof knownProviders>) {
    if (!this.provider) return this.drawAvatar();
    const { icon: mark, name } = providerMark(providers, this.provider.id);
    const drawable = drawableIcon(mark);
    if (!drawable) return this.logo;
    const label = markLabel(name, this.provider.model);
    const { corner } = this.options;
    return html`<span
      class="ut-agent-glyph ut-provider-logo ${corner ? 'ut-provider-corner' : fillsTile(drawable)}"
      data-testid=${corner ? 'provider-corner' : 'provider-logo'}
      role="img"
      aria-label=${label}
      title=${label}
      >${drawIcon(drawable, BADGE_ICON_SIZE)}</span
    >`;
  }

  private watch() {
    if (this.stopWatching || !this.isConnected) return;
    const follow = this.provider ? watchProviders : watchAvatarIcons;
    this.stopWatching = follow((providers) => this.setValue(this.draw(providers)));
  }

  private unwatch() {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  protected disconnected() {
    this.unwatch();
  }

  protected reconnected() {
    if (this.provider || this.options.avatar) this.watch();
    this.setValue(this.draw(knownProviders()));
  }
}

export const providerLogo = directive(ProviderLogoDirective);

/** The provider's icon as a badge on a project's logo; that logo stays as it is. */
export const providerCorner = (provider: ProviderRef | undefined): unknown =>
  providerLogo(provider, nothing, { corner: true });

@customElement('ut-provider-badge')
export class ProviderBadge extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) providerId?: string;
  @property({ attribute: false }) model?: string;
  /** It sits by a tile (agent-avatar.ts) that already shows an `icon`: not here too. */
  @property({ attribute: false }) besideLogo = false;
  @state() private providers = knownProviders();
  private stopWatching?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.stopWatching = watchProviders((providers) => {
      this.providers = providers;
      // Same list when an image has loaded or failed, which changes what is drawn.
      this.requestUpdate();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  render() {
    if (!this.providerId) return nothing;
    const { icon: mark, name } = providerMark(this.providers, this.providerId);
    const drawable = drawableIcon(mark);
    if (drawable && this.besideLogo) return nothing;
    const label = markLabel(name, this.model);
    return html`<span role="img" aria-label=${label} title=${label}
      >${drawable ? drawIcon(drawable, BADGE_ICON_SIZE) : icon('plug', BADGE_ICON_SIZE)}</span
    >`;
  }
}
