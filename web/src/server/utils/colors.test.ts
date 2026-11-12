import { WriteStream } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colors } from './colors.js';

const codes = { blue: 34, cyan: 36, gray: 90, green: 32, magenta: 35, red: 31, yellow: 33 };
const stdoutProperties = {
  isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
  getColorDepth: Object.getOwnPropertyDescriptor(process.stdout, 'getColorDepth'),
};

describe('terminal colors', () => {
  beforeEach(() => {
    for (const name of ['NO_COLOR', 'NODE_DISABLE_COLORS', 'FORCE_COLOR', 'CI']) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('TERM', 'xterm-256color');
    Object.defineProperties(process.stdout, {
      isTTY: { configurable: true, value: true },
      getColorDepth: { configurable: true, value: WriteStream.prototype.getColorDepth },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of ['isTTY', 'getColorDepth'] as const) {
      const descriptor = stdoutProperties[key];
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else Reflect.deleteProperty(process.stdout, key);
    }
  });

  it.each(Object.keys(codes) as (keyof typeof codes)[])('renders %s on a TTY', (name) => {
    expect(colors[name]('message')).toBe(`\u001b[${codes[name]}mmessage\u001b[39m`);
  });

  it('leaves redirected output uncolored', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false });
    for (const render of Object.values(colors)) expect(render('message')).toBe('message');
  });

  it.each(['NO_COLOR', 'NODE_DISABLE_COLORS'])('honors %s on a TTY', (name) => {
    vi.stubEnv(name, '1');
    expect(colors.red('message')).toBe('message');
  });

  it.each(['', '1', '2', '3', 'true'])('honors FORCE_COLOR=%s for redirected output', (value) => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false });
    vi.stubEnv('FORCE_COLOR', value);
    expect(colors.green('message')).toBe('\u001b[32mmessage\u001b[39m');
  });

  it.each(['0', 'false'])('disables colors with FORCE_COLOR=%s on a TTY', (value) => {
    vi.stubEnv('FORCE_COLOR', value);
    expect(colors.green('message')).toBe('message');
  });

  it('gives FORCE_COLOR precedence over NO_COLOR', () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '1');
    expect(colors.yellow('message')).toBe('\u001b[33mmessage\u001b[39m');
  });

  it('leaves empty strings empty', () => {
    expect(colors.red('')).toBe('');
  });

  it('restores the outer color after a nested message', () => {
    expect(colors.red(`before ${colors.cyan('inner')} after`)).toBe(
      '\u001b[31mbefore \u001b[36minner\u001b[31m after\u001b[39m'
    );
  });

  it('closes and reopens colors around LF and CRLF', () => {
    expect(colors.blue('first\nsecond\r\nthird')).toBe(
      '\u001b[34mfirst\u001b[39m\n\u001b[34msecond\u001b[39m\r\n\u001b[34mthird\u001b[39m'
    );
  });
});
