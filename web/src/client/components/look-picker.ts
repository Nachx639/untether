/**
 * The interface styles in Settings → Appearance: a grid of cards with a live miniature of each
 * style, drawn with the style's own tokens (no images): each miniature is a `.ut-look-scope`, a
 * small root that takes the style's data-look and mode. Applied at once; docs/ui-tokens.md.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { LOOKS, type Look, ORIGINAL_LOOK_ID } from '../../shared/looks.js';
import { type MessageKey, t } from '../i18n/index.js';
import { getAccent } from '../utils/accent-themes.js';
import { effectiveThemeMode } from '../utils/theme-mode.js';

const lookText = (look: Look, part: 'name' | 'desc') => t(`look.${look.id}.${part}` as MessageKey);

function renderMiniature(look: Look): TemplateResult {
  const mode = look.modes === 'both' ? effectiveThemeMode() : look.modes;
  return html`<span
    class="ut-look-thumb ut-look-scope"
    data-look=${look.id === ORIGINAL_LOOK_ID ? nothing : look.id}
    data-theme=${mode}
    data-accent=${getAccent()}
    aria-hidden="true"
  >
    <span class="ut-look-thumb-row">
      <span class="ut-look-thumb-dot"></span>
      <span class="ut-look-thumb-lines">
        <span class="ut-look-thumb-line"></span>
        <span class="ut-look-thumb-line ut-look-thumb-line--short"></span>
      </span>
    </span>
    <span class="ut-look-thumb-btn">Aa</span>
  </span>`;
}

export function renderLookPicker(options: {
  active: string;
  deviceChoice: string | null;
  serverLook: Look | undefined;
  onSelect: (id: string) => void;
  onFollowServer: () => void;
  ready: boolean;
}): TemplateResult {
  const { serverLook, deviceChoice } = options;
  return html`
    <h3 class="ut-section-label ut-look-title" id="settings-look-title">${t('settings.look')}</h3>
    <p class="ut-look-note">${t('settings.look.description')}</p>
    <div class="ut-look-grid" role="group" aria-labelledby="settings-look-title" data-testid="settings-look-grid">
      ${LOOKS.map(
        (look) => html`
          <button
            type="button"
            class="ut-look-card ut-surface--panel ut-surface--material"
            aria-pressed=${options.active === look.id ? 'true' : 'false'}
            data-testid="settings-look-${look.id}"
            data-ready=${options.ready ? 'true' : nothing}
            @click=${() => options.onSelect(look.id)}
          >
            ${renderMiniature(look)}
            <span class="ut-look-name">${lookText(look, 'name')}</span>
            <span class="ut-look-desc">${lookText(look, 'desc')}</span>
          </button>
        `
      )}
    </div>
    ${
      serverLook
        ? html`<p class="ut-look-note" data-testid="settings-look-server">
            ${t('look.serverDefault', { name: lookText(serverLook, 'name') })}
            ${
              deviceChoice
                ? html`<button
                    type="button"
                    class="ut-btn ut-btn--ghost ut-btn--sm"
                    data-testid="settings-look-follow-server"
                    @click=${options.onFollowServer}
                  >
                    ${t('look.useServerDefault')}
                  </button>`
                : nothing
            }
          </p>`
        : nothing
    }
  `;
}
