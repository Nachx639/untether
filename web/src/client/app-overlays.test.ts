/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '../shared/types.js';
import { UntetherApp } from './app.js';

type AppInternals = {
  showQuickSwitcher: boolean;
  showShortcutSheet: boolean;
  hasActiveOverlay: boolean;
  sessions: Session[];
  willUpdate(changed: Map<string, unknown>): void;
  handleOpenPalette(): void;
  numberedSessions(): Session[];
};

describe('app overlays and shortcuts', () => {
  // QA 2026-10-12: with the ⌘K palette open in a session, typing went to the terminal because
  // the session view's keyboard handler only backs off while hasActiveOverlay is true.
  it.each(['showQuickSwitcher', 'showShortcutSheet'] as const)(
    '%s counts as an overlay, so the terminal stops taking keys',
    (prop) => {
      const app = new UntetherApp() as unknown as AppInternals;
      app[prop] = true;
      app.willUpdate(new Map([[prop, false]]));
      expect(app.hasActiveOverlay).toBe(true);
      app[prop] = false;
      app.willUpdate(new Map([[prop, true]]));
      expect(app.hasActiveOverlay).toBe(false);
    }
  );

  it('the header search trigger opens the palette and closes the shortcut sheet', () => {
    const app = new UntetherApp() as unknown as AppInternals;
    app.showShortcutSheet = true;
    app.handleOpenPalette();
    expect(app.showQuickSwitcher).toBe(true);
    expect(app.showShortcutSheet).toBe(false);
  });

  // QA 2026-10-12: ⌘2 opened the API's second session, not the sidebar's "2".
  it('⌘N follows the numbers the sidebar shows, not API order', () => {
    const app = new UntetherApp() as unknown as AppInternals & HTMLElement;
    const make = (id: string) => ({ id, status: 'running' }) as Session;
    app.sessions = [make('x'), make('y'), make('z')];
    expect(app.numberedSessions().map((s) => s.id)).toEqual(['x', 'y', 'z']);
    const list = document.createElement('session-list');
    for (const [id, n] of [
      ['z', 1],
      ['x', 2],
      ['y', 3],
    ] as const) {
      const card = document.createElement('compact-session-card') as HTMLElement & {
        session?: Session;
        sessionNumber?: number;
      };
      card.session = make(id);
      card.sessionNumber = n;
      list.appendChild(card);
    }
    app.appendChild(list);
    expect(app.numberedSessions().map((s) => s.id)).toEqual(['z', 'x', 'y']);
  });
});
