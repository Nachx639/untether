import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every agent or preview avatar goes through agent-avatar.ts, or a provider's icon and
 * avatarIcons go missing from it. A new tile or logo elsewhere fails here: draw it with
 * agentAvatar() or agentLogo(), and only list it below if it is not an avatar.
 */
const AVATAR_DRAWING =
  /\bagentGlyph\(|\b(?:CLAUDE|CODEX|GEMINI)_MARK\b|\bicon\('eye'|class="[^"]*\b(?:psr-avatar|ut-side-avatar|ut-card-avatar|ut-agent-glyph)\b/g;

/** The owners (-1: any number), then what is not an avatar: a menu's eye, a loading placeholder. */
const NOT_AN_AVATAR: Record<string, number> = {
  'agent-avatar.ts': -1,
  'icons.ts': -1,
  'provider-badge.ts': -1,
  'copilot-sheet.ts': 1,
  'session-view/compact-menu.ts': 1,
  'session-list/list-phone.ts': 1,
};

function sources(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return sources(path.join(dir, entry.name), `${relative}/`);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [relative] : [];
  });
}

describe('agent and preview avatars', () => {
  const root = path.join(__dirname);

  it('are all drawn by the shared component', () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const count =
        fs.readFileSync(path.join(root, file), 'utf8').match(AVATAR_DRAWING)?.length ?? 0;
      const allowed = NOT_AN_AVATAR[file] ?? 0;
      if (allowed !== -1 && count !== allowed)
        offenders.push(`${file}: ${count}, expected ${allowed}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the check itself recognises a hand-drawn tile', () => {
    expect('<span class="ut-side-avatar" data-status=${s}>'.match(AVATAR_DRAWING)).toHaveLength(1);
    expect('return agentGlyph(kind, 16);'.match(AVATAR_DRAWING)).toHaveLength(1);
    expect('html`${CODEX_MARK}`'.match(AVATAR_DRAWING)).toHaveLength(1);
    expect("${icon('eye', 20)}".match(AVATAR_DRAWING)).toHaveLength(1);
  });
});
