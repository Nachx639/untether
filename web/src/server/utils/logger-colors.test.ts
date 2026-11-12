import { WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colors } from './colors.js';
import { createLogger, getVerbosityLevel, setVerbosityLevel, VerbosityLevel } from './logger.js';

const outputs = [process.stdout, process.stderr].map((stream) => ({
  stream,
  properties: {
    isTTY: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
    getColorDepth: Object.getOwnPropertyDescriptor(stream, 'getColorDepth'),
  },
}));

describe('logger destination colors', () => {
  let verbosity: VerbosityLevel;

  beforeEach(() => {
    verbosity = getVerbosityLevel();
    setVerbosityLevel(VerbosityLevel.DEBUG);
    for (const name of ['NO_COLOR', 'NODE_DISABLE_COLORS', 'FORCE_COLOR', 'CI']) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('TERM', 'xterm-256color');
    for (const { stream } of outputs) {
      Object.defineProperties(stream, {
        isTTY: { configurable: true, value: true },
        getColorDepth: { configurable: true, value: WriteStream.prototype.getColorDepth },
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setVerbosityLevel(verbosity);
    for (const { stream, properties } of outputs) {
      for (const key of ['isTTY', 'getColorDepth'] as const) {
        const descriptor = properties[key];
        if (descriptor) Object.defineProperty(stream, key, descriptor);
        else Reflect.deleteProperty(stream, key);
      }
    }
  });

  it.each(['error', 'warn'] as const)(
    'colors %s on a TTY stderr with redirected stdout',
    (level) => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false });
      const output = vi.spyOn(console, level).mockImplementation(() => {});

      createLogger('color-test')[level]('message');

      expect(output).toHaveBeenCalledOnce();
      expect(output.mock.calls[0][0]).toContain('\u001b[36m[[SRV] color-test]\u001b[39m');
      const code = level === 'error' ? 31 : 33;
      expect(output.mock.calls[0][0]).toContain(`\u001b[${code}mmessage\u001b[39m`);
    }
  );

  it.each(['error', 'warn'] as const)(
    'keeps redirected %s plain even with colored arguments',
    (level) => {
      Object.defineProperty(process.stderr, 'isTTY', { value: false });
      const output = vi.spyOn(console, level).mockImplementation(() => {});
      const message = colors.blue('message');
      expect(message).toContain('\u001b[34m');

      createLogger('color-test')[level](message);

      expect(output).toHaveBeenCalledOnce();
      const text = String(output.mock.calls[0][0]);
      expect(text).toContain('message');
      expect(text).toBe(stripVTControlCharacters(text));
    }
  );

  it.each([true, false])('uses stdout TTY=%s for info regardless of stderr', (isTTY) => {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY });
    Object.defineProperty(process.stderr, 'isTTY', { value: !isTTY });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    createLogger('color-test').info(colors.green('message'));

    expect(output).toHaveBeenCalledOnce();
    const text = String(output.mock.calls[0][0]);
    expect(text).toContain('message');
    expect(text.includes('\u001b[')).toBe(isTTY);
  });

  it.each([
    ['NO_COLOR', '1', true, false],
    ['FORCE_COLOR', '0', true, false],
    ['FORCE_COLOR', '1', false, true],
  ] as const)('honors %s=%s on stderr', (name, value, isTTY, colored) => {
    vi.stubEnv(name, value);
    Object.defineProperty(process.stdout, 'isTTY', { value: !isTTY });
    Object.defineProperty(process.stderr, 'isTTY', { value: isTTY });
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});

    createLogger('color-test').error(colors.blue('message'));

    expect(output).toHaveBeenCalledOnce();
    const text = String(output.mock.calls[0][0]);
    expect(text).toContain('message');
    expect(text.includes('\u001b[')).toBe(colored);
  });
});
