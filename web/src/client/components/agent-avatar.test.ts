import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '../../shared/agents.js';
import { agentAvatar, agentLogo } from './agent-avatar.js';
import { QODER_MARK } from './icons.js';

/**
 * Every agent or preview avatar goes through agent-avatar.ts, or a provider's icon and
 * avatarIcons go missing from it. A new tile or logo elsewhere fails here: draw it with
 * agentAvatar() or agentLogo(), and only list it below if it is not an avatar.
 */
const AVATAR_DRAWING =
  /\bagentGlyph\(|\b(?:CLAUDE|CODEX|GEMINI|QODER)_MARK\b|\bicon\('eye'|class="[^"]*\b(?:psr-avatar|ut-side-avatar|ut-card-avatar|ut-agent-glyph)\b/g;

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

  /** A lit template as the text it renders (attribute and child values in place). */
  const text = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(text).join('');
    // providerLogo(provider, mark, …): with no provider and no avatarIcons it draws the mark.
    const directive = value as { _$litDirective$?: unknown; values?: unknown[] } | null;
    if (directive?._$litDirective$) return text(directive.values?.[1]);
    const template = value as { strings?: readonly string[]; values?: unknown[] } | null;
    if (!template?.strings) return typeof value === 'string' ? value : '';
    return template.strings.map((part, i) => part + text(template.values?.[i])).join('');
  };

  it("Qoder's mark is a small drawn duckling tinted by the look, never an image", () => {
    const mark = text(QODER_MARK);
    expect(mark).toContain('viewBox="0 0 24 24"');
    expect(mark).toContain('stroke="currentColor"');
    // No colour of its own, no bitmap, nothing loaded: the tile's token colours it.
    expect(mark).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|<image|<img|href=/i);
    expect(mark.length).toBeLessThan(700);
  });

  it('every agent of the registry has its own mark in every tile, not the shell prompt', () => {
    const shell = text(agentLogo('shell', undefined));
    const seen = new Set<string>();
    for (const kind of AGENT_IDS) {
      const logo = text(agentLogo(kind, undefined));
      expect(logo, kind).not.toBe(shell);
      seen.add(logo);
      const row = text(agentAvatar({ variant: 'row', kind, state: 'working' }));
      expect(row, kind).toContain(`psr-avatar-${kind}`);
      expect(row, kind).toContain('<svg');
      const side = text(agentAvatar({ variant: 'side', kind, status: 'working' }));
      expect(side, kind).toContain('ut-agent-glyph');
    }
    expect(seen.size).toBe(AGENT_IDS.length);
    const duck = text(QODER_MARK);
    expect(text(agentAvatar({ variant: 'row', kind: 'qoder', state: 'working' }))).toContain(duck);
    expect(text(agentAvatar({ variant: 'card', kind: 'qoder' }))).toContain(duck);
    expect(text(agentLogo('qoder', undefined, 16))).toContain(duck);
  });
});
