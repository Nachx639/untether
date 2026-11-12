import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { SessionInput } from '../../shared/types.js';
import { createScreenMenu } from './screen-menu.js';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'claude-waiting', name), 'utf8');

/** A screen that shows `screens[i]` once `i` arrow keys arrived. */
function fakeScreen(screens: string[]) {
  const sent: SessionInput[] = [];
  let clock = 0;
  const menu = createScreenMenu({
    recentText: async () => {
      const arrows = sent.filter((input) => 'key' in input && input.key !== 'enter').length;
      return { text: screens[Math.min(arrows, screens.length - 1)], cols: 80, rows: 40 };
    },
    sendInput: (_id, input) => sent.push(input),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { menu, sent };
}

describe('screen menu', () => {
  it('reads the trust dialog with its cursor on "No, exit"', async () => {
    const { menu } = fakeScreen([fixture('trust-folder.txt')]);
    expect(await menu.read('s')).toMatchObject({
      options: ['No, exit', 'Yes, I trust this folder'],
      cursor: 0,
      navigate: true,
    });
  });

  it('moves the cursor one arrow at a time and reports it once the screen shows it', async () => {
    const { menu, sent } = fakeScreen([
      fixture('trust-folder.txt'),
      fixture('trust-folder-yes.txt'),
    ]);
    const shown = await menu.read('s');
    if (!shown) throw new Error('no menu');
    expect(await menu.moveCursor('s', shown, 1)).toBe(true);
    expect(sent).toEqual([{ key: 'arrow_down' }]);
  });

  it('a screen that never shows the cursor moved answers false, and sends no Enter', async () => {
    const { menu, sent } = fakeScreen([fixture('trust-folder.txt')]);
    const shown = await menu.read('s');
    if (!shown) throw new Error('no menu');
    expect(await menu.moveCursor('s', shown, 1)).toBe(false);
    expect(sent).toEqual([{ key: 'arrow_down' }]);
  });
});
