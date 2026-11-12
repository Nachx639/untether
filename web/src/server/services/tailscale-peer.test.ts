import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyTailscalePeer } from '../middleware/auth.js';
import { isProtectedTailscaleExecutable, isTrustedTailscaleProcess } from './tailscale-peer.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => ({ debug: vi.fn() }) }));

describe('Tailscale process identity', () => {
  let owner: number;
  let executable: string;
  let command: string;
  let signed: boolean;
  const protectedStat = (uid = 0, mode = 0o755) =>
    ({ uid, mode, isSymbolicLink: () => false, isFile: () => true }) as ReturnType<
      typeof lstatSync
    >;

  beforeEach(() => {
    vi.resetAllMocks();
    owner = 0;
    executable = '/usr/sbin/tailscaled';
    command = 'tailscaled';
    signed = false;
    vi.mocked(platform).mockReturnValue('linux');
    vi.mocked(realpathSync).mockImplementation((file) => String(file));
    vi.mocked(lstatSync).mockReturnValue(protectedStat());
    vi.mocked(execFile).mockImplementation(((_file, args, _options, callback) => {
      if (_file === '/bin/ps') {
        callback(null, ` ${owner}\n`, '');
        return;
      }
      if (_file === '/usr/bin/codesign') {
        callback(signed ? null : new Error('code requirement not satisfied'), '', '');
        return;
      }
      const output = args.includes('txt')
        ? `p800\nu${owner}\nftxt\nn${executable}\n`
        : `p${process.pid}\ncnode\nn127.0.0.1:4020->127.0.0.1:61000\np800\nc${command}\nn127.0.0.1:61000->127.0.0.1:4020\n`;
      callback(null, output, '');
    }) as typeof execFile);
  });

  afterEach(() => vi.restoreAllMocks());

  const request = () =>
    ({ socket: { localPort: 4020, remotePort: 61000, remoteAddress: '127.0.0.1' } }) as Request;

  it('accepts a visible root-owned peer with a protected known executable', async () => {
    await expect(verifyTailscalePeer(request())).resolves.toBe(true);
  });

  it.each(['tailscaled', 'IPNExtension', 'fake-tailscale-client'])(
    'rejects an unprivileged socket owner named %s',
    async (name) => {
      command = name;
      owner = 501;
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
    }
  );

  it('rejects a renamed executable even when the process runs as root', async () => {
    executable = '/tmp/tailscaled';
    await expect(verifyTailscalePeer(request())).resolves.toBe(false);
  });

  it.each(['/usr/sbin/tailscaled', '/usr/sbin', '/usr', '/'])(
    'rejects a writable executable or ancestor: %s',
    async (writable) => {
      vi.mocked(lstatSync).mockImplementation((file) =>
        protectedStat(0, String(file) === writable ? 0o777 : 0o755)
      );
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
    }
  );

  it('rejects user-owned paths and symlinks resolving into writable locations', () => {
    vi.mocked(lstatSync).mockReturnValue(protectedStat(501));
    expect(isProtectedTailscaleExecutable(executable)).toBe(false);
    vi.mocked(realpathSync).mockReturnValue('/tmp/tailscaled');
    vi.mocked(lstatSync).mockImplementation((file) =>
      protectedStat(0, String(file) === '/tmp' ? 0o1777 : 0o755)
    );
    expect(isProtectedTailscaleExecutable(executable)).toBe(false);
  });

  it('fails closed if the executable cannot be inspected', async () => {
    vi.mocked(lstatSync).mockImplementation(() => {
      throw new Error('permission denied');
    });
    await expect(isTrustedTailscaleProcess(800)).resolves.toBe(false);
  });

  it('fails closed if lsof fails or reports a different process', async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('lsof failed'), '', '');
    }) as typeof execFile);
    await expect(isTrustedTailscaleProcess(800)).resolves.toBe(false);
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(null, `p801\nu0\nftxt\nn${executable}\n`, '');
    }) as typeof execFile);
    await expect(isTrustedTailscaleProcess(800)).resolves.toBe(false);
  });

  describe('macOS signatures and Homebrew', () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue('darwin');
      vi.spyOn(process, 'geteuid').mockReturnValue(1000);
    });

    it.each([
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension',
      '/Library/SystemExtensions/test/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension',
    ])(
      'validates the running Tailscale code despite standard app directory permissions: %s',
      async (file) => {
        executable = file;
        signed = true;
        vi.mocked(lstatSync).mockImplementation((file) =>
          protectedStat(0, String(file) === '/Applications' ? 0o775 : 0o755)
        );
        await expect(verifyTailscalePeer(request())).resolves.toBe(true);
        const call = vi.mocked(execFile).mock.calls.find(([file]) => file === '/usr/bin/codesign');
        expect(call?.[1]).toEqual([
          '--verify',
          '--strict',
          '-R',
          expect.stringContaining('anchor apple generic'),
          '800',
        ]);
        const requirement = (call?.[1] as string[] | undefined)?.[3];
        expect(requirement).toContain('certificate leaf[subject.OU] = "W5364U7YZB"');
        for (const id of [
          'macsys',
          'macos',
          'macsys.network-extension',
          'macos.network-extension',
        ]) {
          expect(requirement).toContain(`identifier "io.tailscale.ipn.${id}"`);
        }
        // Inspection is of the PID, never a replaceable file or a display-name match.
        expect(lstatSync).not.toHaveBeenCalled();
      }
    );

    it('accepts a signed App Store extension running as the server account', async () => {
      owner = 1000;
      command = 'IPNExtension';
      signed = true;
      await expect(verifyTailscalePeer(request())).resolves.toBe(true);
    });

    it('rejects another account even when its Tailscale signature is valid', async () => {
      owner = 501;
      signed = true;
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
      expect(vi.mocked(execFile).mock.calls.some(([file]) => file === '/usr/bin/codesign')).toBe(
        false
      );
    });

    it('does not let a user-owned signed proxy authenticate to a root server', async () => {
      vi.mocked(process.geteuid).mockReturnValue(0);
      owner = 1000;
      signed = true;
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
    });

    it.each(['Tailscale', 'IPNExtension'])(
      'rejects a replacement or wrongly signed %s executable',
      async (name) => {
        command = name;
        executable = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
        // Even a root-owned path is not a substitute for the vendor signature on macOS apps.
        await expect(verifyTailscalePeer(request())).resolves.toBe(false);
      }
    );

    it('fails closed when the process owner cannot be inspected', async () => {
      signed = true;
      vi.mocked(execFile).mockImplementationOnce(((_file, _args, _options, callback) => {
        callback(null, '', '');
      }) as typeof execFile);
      await expect(isTrustedTailscaleProcess(800)).resolves.toBe(false);
    });

    it.each(['/usr/local', '/opt/homebrew'])(
      'accepts an unsigned daemon mapped from the server-owned %s Cellar',
      async (prefix) => {
        executable = `${prefix}/Cellar/tailscale/1.98.0/bin/tailscaled`;
        vi.mocked(realpathSync).mockImplementation((file) =>
          String(file) === `${prefix}/bin/tailscaled` ? executable : String(file)
        );
        vi.mocked(lstatSync).mockImplementation((file) =>
          protectedStat(
            String(file).startsWith(prefix) ? 1000 : 0,
            String(file) === `${prefix}/bin` ? 0o775 : 0o755
          )
        );
        for (const uid of [0, 1000]) {
          owner = uid;
          await expect(verifyTailscalePeer(request())).resolves.toBe(true);
        }
        expect(lstatSync).not.toHaveBeenCalledWith(`${prefix}/bin`);
        // The mapped executable itself and every parent still must be protected.
        vi.mocked(lstatSync).mockReturnValue(protectedStat(1000, 0o775));
        await expect(verifyTailscalePeer(request())).resolves.toBe(false);
      }
    );

    it('rejects a Homebrew executable owned by another account or trusted by a root server', async () => {
      executable = '/usr/local/bin/tailscaled';
      vi.mocked(lstatSync).mockReturnValue(protectedStat(501));
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
      vi.mocked(process.geteuid).mockReturnValue(0);
      vi.mocked(lstatSync).mockReturnValue(protectedStat(1000));
      await expect(verifyTailscalePeer(request())).resolves.toBe(false);
    });
  });
});
