import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { watchAssets } = require('../../../scripts/assets-watch.js');
const webRoot = path.resolve(__dirname, '../../..');

class CopyProcess extends EventEmitter {
  kill = vi.fn();
}

const stops: Array<() => Promise<unknown>> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
  const watch = vi.fn(() => watcher);
  const children: CopyProcess[] = [];
  const spawn = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
    const child = new CopyProcess();
    children.push(child);
    return child;
  });
  const log = vi.fn();
  const assets = watchAssets({ watch, spawn, debounceMs: 100, log });
  stops.push(async () => {
    const closing = assets.close();
    for (const child of children) child.emit('close', 0);
    await closing;
  });
  return { watcher, watch, children, spawn, log, assets };
}

describe('asset watcher', () => {
  it('watches the directory recursively without repeating the initial copy', () => {
    const { watch, spawn } = setup();
    expect(watch).toHaveBeenCalledWith(
      [path.join(webRoot, 'src/client/assets'), path.join(webRoot, 'src/client/styles/looks')],
      {
        ignoreInitial: true,
      }
    );
    vi.advanceTimersByTime(1000);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('debounces additions, changes and removals, running only the fixed script without a shell', () => {
    vi.stubEnv('UNTETHER_SEA', '1');
    vi.stubEnv('UNTETHER_LOCAL_AUTH_TOKEN', 'test-only');
    const { watcher, spawn } = setup();
    watcher.emit('all', 'add', 'nested/a.svg');
    vi.advanceTimersByTime(90);
    watcher.emit('all', 'change', 'nested/$(touch unwanted).svg');
    vi.advanceTimersByTime(90);
    watcher.emit('all', 'unlink', 'nested/b.svg');
    vi.advanceTimersByTime(99);
    expect(spawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([path.join(webRoot, 'scripts/copy-assets.js')]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(webRoot);
    expect(options.stdio).toBe('inherit');
    const env = options.env as NodeJS.ProcessEnv;
    expect(env.UNTETHER_SEA).toBeUndefined();
    expect(env.UNTETHER_LOCAL_AUTH_TOKEN).toBeUndefined();
    expect(process.env.UNTETHER_SEA).toBe('1');
    expect(process.env.UNTETHER_LOCAL_AUTH_TOKEN).toBe('test-only');
  });

  it('queues one more copy for changes during a copy, waiting for stdio to close', () => {
    const { watcher, spawn, children } = setup();
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    for (let i = 0; i < 3; i++) {
      watcher.emit('all', 'change', 'b.svg');
      vi.advanceTimersByTime(100);
    }
    children[0].emit('exit', 0);
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].emit('close', 0);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].emit('close', 0);
    vi.advanceTimersByTime(1000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('still waits for the debounce when an active copy finishes before the latest event settles', () => {
    const { watcher, spawn, children } = setup();
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    watcher.emit('all', 'change', 'b.svg');
    vi.advanceTimersByTime(100);
    watcher.emit('all', 'change', 'c.svg');
    children[0].emit('close', 0);
    vi.advanceTimersByTime(99);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reports spawn errors and nonzero exits and accepts later changes', () => {
    const { watcher, spawn, children, log } = setup();
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    children[0].emit('error', new Error('spawn failed'));
    children[0].emit('close', -2);
    expect(log).toHaveBeenCalledWith('assets-watch: copy failed: spawn failed');
    watcher.emit('all', 'change', 'b.svg');
    vi.advanceTimersByTime(100);
    children[1].emit('close', 1);
    expect(log).toHaveBeenCalledWith('assets-watch: copy exited with 1');
    watcher.emit('all', 'change', 'c.svg');
    vi.advanceTimersByTime(100);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('recovers from a synchronous spawn failure and reports watcher errors', () => {
    const { watcher, spawn, log } = setup();
    spawn.mockImplementationOnce(() => {
      throw new Error('cannot spawn');
    });
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    expect(log).toHaveBeenCalledWith('assets-watch: copy failed: cannot spawn');
    watcher.emit('error', new Error('cannot watch'));
    expect(log).toHaveBeenCalledWith('assets-watch: watcher failed: cannot watch');
    watcher.emit('all', 'change', 'b.svg');
    vi.advanceTimersByTime(100);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('closes once, cancels the debounce and ignores events after shutdown', async () => {
    const { watcher, spawn, assets } = setup();
    watcher.emit('all', 'change', 'a.svg');
    const closing = assets.close();
    expect(assets.close()).toBe(closing);
    await closing;
    watcher.emit('all', 'change', 'b.svg');
    vi.advanceTimersByTime(1000);
    expect(spawn).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it('stops an active copy and discards queued changes on shutdown', async () => {
    const { watcher, spawn, children, assets } = setup();
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    watcher.emit('all', 'change', 'b.svg');
    vi.advanceTimersByTime(100);
    const closing = assets.close();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('close', null, 'SIGTERM');
    await closing;
    vi.advanceTimersByTime(1000);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('kills a copy that ignores SIGTERM before the dev shutdown deadline', async () => {
    const { watcher, children, assets } = setup();
    watcher.emit('all', 'change', 'a.svg');
    vi.advanceTimersByTime(100);
    const closing = assets.close();
    vi.advanceTimersByTime(1000);
    expect(children[0].kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    children[0].emit('close', null, 'SIGKILL');
    await closing;
  });
});

describe('dev asset watcher integration', () => {
  it('does not declare or lock the redundant CLI dependency', () => {
    const manifest = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
    expect(manifest.devDependencies).not.toHaveProperty('chokidar-cli');
    expect(manifest.dependencies).not.toHaveProperty('chokidar-cli');
    expect(readFileSync(path.join(webRoot, 'pnpm-lock.yaml'), 'utf8')).not.toContain(
      'chokidar-cli'
    );
  });

  it.each([true, false])(
    'preserves initial copy and shutdown (client-only: %s)',
    async (clientOnly) => {
      const execSync = vi.fn();
      const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => ({
        exitCode: 0,
        signalCode: null,
        on: vi.fn(),
        kill: vi.fn(),
      }));
      const assets = { close: vi.fn(async () => {}) };
      const watchAssets = vi.fn(() => {
        expect(
          execSync.mock.calls.filter(([cmd]) => cmd === 'node scripts/copy-assets.js')
        ).toHaveLength(1);
        return assets;
      });
      const context = { rebuild: vi.fn(), watch: vi.fn(), dispose: vi.fn() };
      const args = clientOnly ? ['--client-only'] : ['--no-auth'];
      const handlers = new Map<string, () => Promise<void>>();
      const modules: Record<string, unknown> = {
        child_process: { execSync, spawn },
        esbuild: { context: async () => context },
        './esbuild-config.js': { devOptions: {}, clientAppBuild: {}, cleanClientChunks: vi.fn() },
        './assets-watch.js': { watchAssets },
        './css-watch.js': { watchStyles: () => ({ ready: Promise.resolve(), close: vi.fn() }) },
        '../postcss.config.js': { plugins: [] },
        './dev-auth-args.js': require('../../../scripts/dev-auth-args.js'),
        util: {
          parseArgs: (options: object) => require('node:util').parseArgs({ ...options, args }),
        },
      };
      await runInNewContext(readFileSync(path.join(webRoot, 'scripts/dev.js'), 'utf8'), {
        require: (name: string) => modules[name] ?? require(name),
        __dirname: path.join(webRoot, 'scripts'),
        console: { log: vi.fn(), error: vi.fn() },
        process: {
          argv: ['node', 'scripts/dev.js', ...args],
          env: {},
          platform: process.platform,
          on: (signal: string, handler: () => Promise<void>) => handlers.set(signal, handler),
          exit: vi.fn(),
        },
        setInterval,
        clearInterval,
        setTimeout,
      });
      expect(watchAssets).toHaveBeenCalledTimes(1);
      if (clientOnly) {
        expect(spawn).not.toHaveBeenCalled();
      } else {
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0].slice(0, 2)).toEqual([
          'node',
          ['scripts/server-watch.js', '--no-auth'],
        ]);
      }
      expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
      await handlers.get('SIGTERM')?.();
      expect(assets.close).toHaveBeenCalledTimes(1);
    }
  );
});
