import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { stopTestShieldServer } from '../../test/helpers/shield-teardown.js';
import { stableTmuxCheck } from './doctor-checks.js';
import {
  findInstalledTmux,
  findTmuxBinary,
  ShieldTmux,
  setStableTmuxBinary,
  shieldServerPids,
} from './shielded-tmux.js';
import {
  type Exec,
  isValidSigningIdentity,
  oldTmuxPermissionPush,
  parseSigningIdentities,
  STABLE_TMUX_IDENTIFIER,
  StableTmux,
  type StableTmuxStatus,
} from './stable-tmux.js';

const IDENTITY = 'A'.repeat(40);
const homebrewTmux = '/opt/homebrew/bin/tmux';
const OTHER_IDENTITY = 'B'.repeat(40);

/**
 * codesign and `tmux -V`, simulated: a "tmux" is a text file whose first line is its version;
 * signatures are kept per inode (a rename keeps them, a new file has none).
 */
function fakeSystem() {
  const signatures = new Map<number, { identity: string; identifier: string }>();
  const calls: string[][] = [];
  const state = { failSign: false as false | string };
  const ino = (file: string) => fs.statSync(file).ino;
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'codesign') {
      const target = args[args.length - 1];
      if (args.includes('--sign')) {
        if (state.failSign) {
          throw Object.assign(new Error('codesign failed'), { stderr: state.failSign });
        }
        signatures.set(ino(target), {
          identity: args[args.indexOf('--sign') + 1],
          identifier: args[args.indexOf('--identifier') + 1],
        });
        return { stdout: '', stderr: '' };
      }
      const signature = signatures.get(ino(target));
      if (args.includes('--verify')) {
        const requirement = args.find((arg) => arg.startsWith('-R='))?.slice(3);
        if (!signature || requirement !== requirementOf(signature)) {
          throw Object.assign(new Error('invalid signature'), { stderr: 'invalid signature' });
        }
        return { stdout: '', stderr: '' };
      }
      if (args.includes('-r-')) {
        if (!signature) return { stdout: '', stderr: '' };
        return { stdout: `designated => ${requirementOf(signature)}\n`, stderr: '' };
      }
      // -d --verbose=2 (printed on stderr, as codesign does)
      const stderr = signature
        ? `Identifier=${signature.identifier}\nTeamIdentifier=TEAM${signature.identity.slice(0, 4)}\n`
        : 'Identifier=tmux-55554944\nSignature=adhoc\nTeamIdentifier=not set\n';
      return { stdout: '', stderr };
    }
    // `<tmux> -V`
    const version = fs.readFileSync(file, 'utf8').split('\n')[0];
    return { stdout: `tmux ${version}\n`, stderr: '' };
  };
  const requirementOf = (signature: { identity: string; identifier: string }) =>
    `identifier "${signature.identifier}" and certificate leaf = H"${signature.identity}"`;
  const signs = () => calls.filter((call) => call.includes('--sign')).length;
  return { exec, calls, state, signatures, signs, ino };
}

describe('StableTmux', () => {
  let root: string;
  let cellar: string;
  let link: string;
  let dir: string;
  let identity: string | undefined;
  let active: string | null | undefined;
  let answers: ((bin: string) => Promise<boolean | null>) | undefined;
  let system: ReturnType<typeof fakeSystem>;

  /** `brew install` / `brew upgrade`: a new Cellar folder and the link moved to it. */
  const install = (version: string) => {
    const bin = path.join(cellar, version, 'bin', 'tmux');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `${version}\nbinary of tmux ${version}\n`, { mode: 0o755 });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(bin, link);
  };

  const make = () =>
    new StableTmux({
      dir,
      identity: () => identity,
      source: () => (fs.existsSync(link) ? link : null),
      activate: (bin) => {
        active = bin;
      },
      serverAnswers: (bin) => (answers ? answers(bin) : Promise.resolve(null)),
      exec: system.exec,
      now: () => Date.parse('2026-10-31T10:00:00Z'),
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-tmux-'));
    cellar = path.join(root, 'Cellar', 'tmux');
    link = path.join(root, 'bin', 'tmux');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    dir = path.join(root, 'untether', 'bin');
    identity = IDENTITY;
    active = undefined;
    answers = undefined;
    system = fakeSystem();
    install('3.7c');
  });

  afterEach(() => {
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('is off without an identity: the installed tmux, nothing signed', async () => {
    identity = undefined;
    const status = await make().refresh();
    expect(status).toEqual({ state: 'off' });
    expect(active).toBeNull();
    expect(system.calls).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'tmux'))).toBe(false);
  });

  it('makes the copy signed with the identity and the fixed identifier, and uses it', async () => {
    const stable = make();
    const status = await stable.refresh();
    expect(status).toMatchObject({ state: 'renewed', version: '3.7c', bin: stable.bin });
    expect(active).toBe(stable.bin);
    expect(fs.readFileSync(stable.bin, 'utf8')).toContain('binary of tmux 3.7c');
    expect(fs.statSync(stable.bin).mode & 0o777).toBe(0o755);
    const sign = system.calls.find((call) => call.includes('--sign'));
    expect(sign).toEqual([
      'codesign',
      '--force',
      '--sign',
      IDENTITY,
      '--identifier',
      STABLE_TMUX_IDENTIFIER,
      '--timestamp=none',
      expect.stringContaining('.tmux.new-'),
    ]);
    // No temporary file left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(['tmux', 'tmux.json']);

    // Nothing changed: checked, not signed again.
    expect(await stable.refresh()).toMatchObject({ state: 'current', version: '3.7c' });
    expect(system.signs()).toBe(1);
  });

  it('renews the copy after a tmux upgrade with the same signature, never writing over the one in use', async () => {
    const stable = make();
    await stable.refresh();
    const requirementBefore = JSON.parse(fs.readFileSync(path.join(dir, 'tmux.json'), 'utf8')).copy
      .requirement;
    // A running tmux server keeps the file it loaded open.
    const inUse = fs.openSync(stable.bin, 'r');
    const inodeBefore = system.ino(stable.bin);

    install('3.8');
    const status = await stable.refresh();
    expect(status).toMatchObject({
      state: 'renewed',
      version: '3.8',
      from: '3.7c',
      reason: 'the installed tmux changed',
    });
    expect(system.signs()).toBe(2);
    expect(system.ino(stable.bin)).not.toBe(inodeBefore);
    // The old file is untouched: what the running server has is still 3.7c.
    const buffer = Buffer.alloc(64);
    const read = fs.readSync(inUse, buffer, 0, 64, 0);
    fs.closeSync(inUse);
    expect(buffer.subarray(0, read).toString()).toContain('binary of tmux 3.7c');
    expect(fs.readFileSync(stable.bin, 'utf8')).toContain('binary of tmux 3.8');
    // Same designated requirement: macOS keeps the permission.
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'tmux.json'), 'utf8'));
    expect(record.copy.requirement).toBe(requirementBefore);
    expect(record.copy.version).toBe('3.8');
  });

  it('re-signs a copy that lost its signature', async () => {
    const stable = make();
    await stable.refresh();
    system.signatures.clear();
    expect(await stable.refresh()).toMatchObject({
      state: 'renewed',
      reason: 'the copy lost its signature or no longer runs',
    });
    expect(system.signs()).toBe(2);
  });

  it('a failed signing is not retried until tmux, the identity or the setting changes', async () => {
    system.state.failSign = 'errSecInternalComponent';
    const stable = make();
    const first = await stable.refresh();
    expect(first).toMatchObject({ state: 'failed', bin: null, identity: IDENTITY });
    expect((first as { error: string }).error).toContain('errSecInternalComponent');
    expect(active).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(['tmux.json']);

    // The doctor's next rounds: no new signing, so no keychain prompt in a loop.
    await stable.refresh();
    await stable.refresh();
    expect(system.signs()).toBe(1);

    // Saving the setting again tries once more.
    system.state.failSign = false;
    stable.clearFailure();
    expect(await stable.refresh()).toMatchObject({ state: 'renewed' });
    expect(system.signs()).toBe(2);

    // After an upgrade that fails to sign, the old copy keeps being used.
    system.state.failSign = 'User canceled';
    install('3.8');
    expect(await stable.refresh()).toMatchObject({ state: 'failed', bin: stable.bin });
    expect(active).toBe(stable.bin);
    expect(fs.readFileSync(stable.bin, 'utf8')).toContain('3.7c');
    // A new identity is tried at once.
    identity = OTHER_IDENTITY;
    system.state.failSign = false;
    expect(await stable.refresh()).toMatchObject({
      state: 'renewed',
      reason: 'the signing identity changed',
    });
  });

  it("waits for a tmux the running shield server can't talk to", async () => {
    const stable = make();
    await stable.refresh();
    install('4.0');
    const newSource = fs.realpathSync(link);
    // The new client gets "protocol version mismatch"; the copy (old) still answers.
    answers = async (bin) => bin !== newSource;
    const status = await stable.refresh();
    expect(status).toMatchObject({ state: 'deferred', version: '4.0', running: '3.7c' });
    expect(active).toBe(stable.bin);
    expect(fs.readFileSync(stable.bin, 'utf8')).toContain('3.7c');
    expect(system.signs()).toBe(1);

    // The server ended: the copy moves on.
    answers = async () => null;
    expect(await stable.refresh()).toMatchObject({ state: 'renewed', version: '4.0' });
  });

  it('moves to a new tmux whose client still talks to the running server', async () => {
    const stable = make();
    await stable.refresh();
    install('3.8');
    answers = async () => true;
    expect(await stable.refresh()).toMatchObject({ state: 'renewed', version: '3.8' });
  });

  it('without the installed tmux the copy is not used', async () => {
    const stable = make();
    await stable.refresh();
    fs.rmSync(link);
    expect(await stable.refresh()).toEqual({ state: 'no-source' });
    expect(active).toBeNull();
  });

  it('activateIfReady uses the copy only when it was signed for the identity set', async () => {
    const stable = make();
    stable.activateIfReady();
    expect(active).toBeNull();
    await stable.refresh();
    active = undefined;
    stable.activateIfReady();
    expect(active).toBe(stable.bin);
    identity = OTHER_IDENTITY;
    stable.activateIfReady();
    expect(active).toBeNull();
  });

  // 2026-10-31, the user: no rubbish left from moving to the copy.
  it('remembers the installed tmux the first copy replaced, until the user is told, never again', async () => {
    const stable = make();
    expect(stable.oldTmuxToTell()).toBeNull();
    await stable.refresh();
    // The first copy replaces the installed tmux, which may hold Full Disk Access.
    expect(stable.oldTmuxToTell()).toBe(link);
    // A server seen on another binary names that one instead.
    stable.noteOldTmux('/opt/homebrew/bin/tmux');
    expect(stable.oldTmuxToTell()).toBe('/opt/homebrew/bin/tmux');
    // Renewals keep it.
    install('3.8');
    await stable.refresh();
    expect(stable.oldTmuxToTell()).toBe('/opt/homebrew/bin/tmux');

    stable.markOldTmuxTold();
    expect(stable.oldTmuxToTell()).toBeNull();
    // Told once: an old server seen again, a renewal or a new identity never bring it back.
    stable.noteOldTmux('/opt/homebrew/Cellar/tmux/3.7c/bin/tmux');
    install('3.9');
    await stable.refresh();
    identity = OTHER_IDENTITY;
    await stable.refresh();
    expect(stable.oldTmuxToTell()).toBeNull();
    expect(make().oldTmuxToTell()).toBeNull();
  });

  it('leaves only tmux and tmux.json, and tmux.json does not grow', async () => {
    const stable = make();
    const recordPath = path.join(dir, 'tmux.json');
    await stable.refresh();
    const sizes: number[] = [];
    for (const version of ['3.8', '3.9', '4.0', '4.1', '4.2']) {
      install(version);
      await stable.refresh();
      await stable.refresh();
      // A failed signing, then the setting saved again.
      install(`${version}a`);
      system.state.failSign = 'x'.repeat(5000);
      await stable.refresh();
      system.state.failSign = false;
      stable.clearFailure();
      await stable.refresh();
      stable.noteOldTmux('/opt/homebrew/bin/tmux');
      sizes.push(fs.statSync(recordPath).size);
      expect(fs.readdirSync(dir).sort()).toEqual(['tmux', 'tmux.json']);
    }
    expect(new Set(sizes).size).toBe(1);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(Object.keys(record).sort()).toEqual(['copy', 'leftover']);
  });

  it('removes the temporary files a server that died mid-renewal left', async () => {
    const stable = make();
    await stable.refresh();
    // A dead process's renewal and record, this process's own (a refresh that never ended),
    // and a live process's that is too old: all left over.
    const dead = 2 ** 22 + 12345;
    const leftovers = [
      `.tmux.new-${dead}-0a1b2c3d`,
      `tmux.json.${dead}.tmp`,
      `.tmux.new-${process.pid}-deadbeef`,
      `.tmux.new-${process.ppid}-00ff00ff`,
    ];
    for (const name of leftovers) fs.writeFileSync(path.join(dir, name), 'partial');
    const old = new Date(Date.parse('2026-10-31T10:00:00Z') - 11 * 60 * 1000);
    fs.utimesSync(path.join(dir, leftovers[3]), old, old);
    // Another live server's renewal in progress, and a file that isn't Untether's.
    const inProgress = `.tmux.new-${process.ppid}-12345678`;
    fs.writeFileSync(path.join(dir, inProgress), 'signing');
    fs.utimesSync(
      path.join(dir, inProgress),
      new Date('2026-10-31T09:59:00Z'),
      new Date('2026-10-31T09:59:00Z')
    );
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');

    expect(await stable.refresh()).toMatchObject({ state: 'current' });
    expect(fs.readdirSync(dir).sort()).toEqual(
      [inProgress, 'notes.txt', 'tmux', 'tmux.json'].sort()
    );
  });
});

describe('findTmuxBinary with the stable copy', () => {
  const savedEnv = process.env.UNTETHER_TMUX_BIN;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-tmux-find-'));
    delete process.env.UNTETHER_TMUX_BIN;
  });

  afterEach(() => {
    setStableTmuxBinary(null);
    if (savedEnv === undefined) delete process.env.UNTETHER_TMUX_BIN;
    else process.env.UNTETHER_TMUX_BIN = savedEnv;
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('runs the copy when it is on, UNTETHER_TMUX_BIN still wins', () => {
    const copy = path.join(root, 'tmux');
    fs.writeFileSync(copy, '#!/bin/sh\n', { mode: 0o755 });
    setStableTmuxBinary(copy);
    expect(findTmuxBinary()).toBe(copy);
    const fromEnv = path.join(root, 'tmux-env');
    fs.writeFileSync(fromEnv, '#!/bin/sh\n', { mode: 0o755 });
    process.env.UNTETHER_TMUX_BIN = fromEnv;
    expect(findTmuxBinary()).toBe(fromEnv);
    delete process.env.UNTETHER_TMUX_BIN;
    setStableTmuxBinary(null);
    expect(findTmuxBinary()).not.toBe(copy);
  });

  it('a copy that disappeared falls back to the installed tmux', () => {
    setStableTmuxBinary(path.join(root, 'missing'));
    expect(findTmuxBinary()).not.toBe(path.join(root, 'missing'));
  });
});

describe('stableTmuxCheck', () => {
  const copy = '/Users/u/.untether/bin/tmux';
  const check = (
    status: StableTmuxStatus,
    server: string | null = copy,
    access: 'granted' | 'denied' | 'no-server' | 'unknown' = 'granted'
  ) =>
    stableTmuxCheck({
      refresh: async () => status,
      serverBinaries: async () => (server ? [server] : []),
      fullDiskAccess: async () => access,
      oldTmux: { note: () => {}, toTell: () => null, told: () => {} },
      tellOldTmux: async () => true,
    }).run();

  it('says nothing when off or all is well', async () => {
    expect(await check({ state: 'off' })).toEqual([]);
    expect(await check({ state: 'current', bin: copy, version: '3.7c' })).toEqual([]);
    expect(await check({ state: 'current', bin: copy, version: '3.7c' }, null)).toEqual([]);
  });

  it('warns once about a failed signing', async () => {
    const findings = await check({
      state: 'failed',
      bin: null,
      error: 'errSecInternalComponent',
      identity: IDENTITY,
    });
    expect(findings).toEqual([
      expect.objectContaining({
        key: 'stable-tmux:sign-failed',
        severity: 'warning',
        problem: expect.stringContaining('errSecInternalComponent'),
      }),
    ]);
  });

  it('warns when the copy the server runs has no Full Disk Access', async () => {
    const findings = await check({ state: 'current', bin: copy, version: '3.7c' }, copy, 'denied');
    expect(findings).toEqual([
      expect.objectContaining({ key: 'stable-tmux:no-full-disk-access', severity: 'warning' }),
    ]);
    // unknown (not started by launchd) says nothing.
    expect(await check({ state: 'current', bin: copy, version: '3.7c' }, copy, 'unknown')).toEqual(
      []
    );
  });

  it('notes a server still on another tmux and a renewal, without telling anyone', async () => {
    const findings = await check(
      { state: 'renewed', bin: copy, version: '3.8', from: '3.7c', reason: 'x' },
      '/opt/homebrew/Cellar/tmux/3.7c/bin/tmux'
    );
    expect(findings.map((finding) => [finding.key, finding.severity])).toEqual([
      ['stable-tmux:renewed:3.8', 'info'],
      ['stable-tmux:server-not-copy', 'info'],
    ]);
    expect(await check({ state: 'deferred', bin: copy, version: '4.0', running: '3.7c' })).toEqual([
      expect.objectContaining({ key: 'stable-tmux:deferred:4.0', severity: 'info' }),
    ]);
  });

  describe('the old tmux left in Full Disk Access (2026-10-31)', () => {
    const homebrew = '/opt/homebrew/bin/tmux';
    const current: StableTmuxStatus = { state: 'current', bin: copy, version: '3.8' };
    let servers: string[] | null;
    let access: 'granted' | 'denied' | 'no-server' | 'unknown';
    let leftover: { binary: string; told: boolean } | null;
    let reaches: boolean;
    let told: string[];
    const doctor = () =>
      stableTmuxCheck({
        refresh: async () => current,
        serverBinaries: async () => servers,
        fullDiskAccess: async () => access,
        oldTmux: {
          note: (binary) => {
            if (!leftover?.told) leftover = { binary, told: false };
          },
          toTell: () => (leftover && !leftover.told ? leftover.binary : null),
          told: () => {
            if (leftover) leftover.told = true;
          },
        },
        tellOldTmux: async (binary) => {
          told.push(binary);
          return reaches;
        },
      });

    beforeEach(() => {
      servers = [homebrew, copy, homebrew];
      access = 'granted';
      leftover = null;
      reaches = true;
      told = [];
    });

    it('says nothing while any Untether tmux server runs the old binary, then tells once', async () => {
      const check = doctor();
      // Copy on, servers started before it still on Homebrew's tmux: no word to the user.
      for (let round = 0; round < 3; round++) {
        expect((await check.run()).map((finding) => finding.key)).toEqual([
          'stable-tmux:server-not-copy',
        ]);
      }
      expect(told).toEqual([]);
      expect(leftover).toEqual({ binary: homebrew, told: false });
      // One old server left.
      servers = [copy, homebrew];
      await check.run();
      expect(told).toEqual([]);

      // All on the copy: told once...
      servers = [copy, copy];
      expect(await check.run()).toEqual([
        expect.objectContaining({ key: 'stable-tmux:old-tmux-permission', severity: 'info' }),
      ]);
      expect(told).toEqual([homebrew]);
      // ...and never again, not even after an old server comes and goes.
      expect(await check.run()).toEqual([]);
      servers = [homebrew];
      await check.run();
      servers = [copy];
      expect(await check.run()).toEqual([]);
      expect(told).toEqual([homebrew]);
    });

    it('waits while nothing runs the copy, ps is unreadable or the copy lacks the permission', async () => {
      leftover = { binary: homebrew, told: false };
      const check = doctor();
      servers = [];
      await check.run();
      servers = null;
      await check.run();
      servers = [copy];
      access = 'denied';
      expect((await check.run()).map((finding) => finding.key)).toEqual([
        'stable-tmux:no-full-disk-access',
      ]);
      expect(told).toEqual([]);
      access = 'unknown';
      await check.run();
      expect(told).toEqual([homebrew]);
    });

    it('tries again when the push reached nobody, still only once in the end', async () => {
      leftover = { binary: homebrew, told: false };
      servers = [copy];
      reaches = false;
      const check = doctor();
      expect(await check.run()).toEqual([]);
      expect(await check.run()).toEqual([]);
      expect(leftover.told).toBe(false);
      reaches = true;
      await check.run();
      await check.run();
      expect(told).toEqual([homebrew, homebrew, homebrew]);
      expect(leftover.told).toBe(true);
    });

    it('a server whose binary is the copy by another spelling counts as the copy', async () => {
      leftover = { binary: homebrew, told: false };
      servers = ['/Users/u/.untether/bin/../bin/tmux'];
      await doctor().run();
      expect(told).toEqual([homebrew]);
    });
  });

  it('the push: English with the old binary, the phone rewords it (tmux-old-permission)', () => {
    const push = oldTmuxPermissionPush(homebrewTmux);
    expect(push).toMatchObject({
      type: 'tmux-old-permission',
      tag: 'untether-tmux-old-permission',
      data: { type: 'tmux-old-permission', where: 'tmux', detail: homebrewTmux },
    });
    expect(push.body).toContain(homebrewTmux);
    expect(push.body).toContain('Full Disk Access');
  });
});

describe('shieldServerPids', () => {
  const socket = ['-S', '/Users/u/.untether/control/.shield-tmux'];
  it('finds every server on the socket, old binaries and orphans too, never clients or others', () => {
    const ps = [
      '  101     1 /opt/homebrew/bin/tmux -S /Users/u/.untether/control/.shield-tmux -D',
      '  102     1 /Users/u/.untether/bin/tmux -S /Users/u/.untether/control/.shield-tmux start-server ; set-option -g status off',
      '  103   500 /opt/homebrew/bin/tmux -S /Users/u/.untether/control/.shield-tmux attach-session -t =ut-1',
      '  104     1 /opt/homebrew/bin/tmux -S /tmp/ut/abcd/.shield-tmux -D',
      '  105     1 /opt/homebrew/bin/tmux -S /Users/u/.untether/control/.shield-tmux-other -D',
      '  106     1 /usr/bin/less -S /Users/u/.untether/control/.shield-tmux',
      '  107     1 /Users/u v/.untether/bin/tmux -S /Users/u/.untether/control/.shield-tmux -D',
      '  108     1 /opt/homebrew/bin/tmux -S /Users/u/.untether/control/.shield-tmux',
    ].join('\n');
    expect(shieldServerPids(ps, socket)).toEqual([101, 102, 107, 108]);
    expect(
      shieldServerPids('  9     1 /opt/homebrew/bin/tmux -L untether-abc -D\n', [
        '-L',
        'untether-abc',
      ])
    ).toEqual([9]);
  });
});

describe('signing identities', () => {
  it('parses security find-identity', () => {
    const output = [
      `  1) ${IDENTITY} "Apple Development: Someone (ABCDE12345)"`,
      `  2) ${OTHER_IDENTITY.toLowerCase()} "Untether local signing"`,
      '     2 valid identities found',
    ].join('\n');
    expect(parseSigningIdentities(output)).toEqual([
      { hash: IDENTITY, name: 'Apple Development: Someone (ABCDE12345)' },
      { hash: OTHER_IDENTITY, name: 'Untether local signing' },
    ]);
  });

  it('accepts a hash or a name, never an option or control characters', () => {
    expect(isValidSigningIdentity(IDENTITY)).toBe(true);
    expect(isValidSigningIdentity('Apple Development: Someone (X)')).toBe(true);
    expect(isValidSigningIdentity('--force')).toBe(false);
    expect(isValidSigningIdentity('a\nb')).toBe(false);
    expect(isValidSigningIdentity('')).toBe(false);
    expect(isValidSigningIdentity(' x')).toBe(false);
    expect(isValidSigningIdentity(42)).toBe(false);
  });
});

const installedTmux = findInstalledTmux();

describe.skipIf(!installedTmux)(
  'a shield server and a copy of tmux renewed under it (real tmux)',
  () => {
    let root: string;
    let controlPath: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-tmux-real-'));
      controlPath = fs.mkdtempSync('/tmp/ut-st-');
    });

    afterEach(() => {
      stopTestShieldServer(installedTmux as string, controlPath);
      fs.rmSync(controlPath, RM_TEST_DIR);
      fs.rmSync(root, RM_TEST_DIR);
    });

    it('keeps the server running through a rename over its binary; old and new clients both talk to it', async () => {
      // What the stable copy does, without signing: a copy runs the server...
      const copy = path.join(root, 'tmux');
      fs.copyFileSync(fs.realpathSync(installedTmux as string), copy);
      fs.chmodSync(copy, 0o755);
      const shield = new ShieldTmux(controlPath, copy, false);
      await shield.create({
        sessionId: 'stable-copy',
        command: ['sh', '-c', 'exec sleep 60'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() },
      });
      expect(await shield.serverBinary()).toBe(copy);
      expect(await shield.serverBinaries()).toEqual([copy]);
      expect(await shield.answersWith(installedTmux as string)).toBe(true);
      expect(await shield.answersWith('/usr/bin/false')).toBe(false);

      // ...and a renewal writes a new file and renames it onto the copy.
      const next = path.join(root, '.tmux.new-test');
      fs.copyFileSync(fs.realpathSync(installedTmux as string), next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, copy);
      expect(await shield.has('stable-copy')).toBe(true);
      expect(await shield.answersWith(copy)).toBe(true);
      expect(['granted', 'denied', 'unknown']).toContain(await shield.fullDiskAccess());
    }, 20_000);

    it('fullDiskAccess lists a protected folder: granted when it reads, unknown when none exists', async () => {
      const shield = new ShieldTmux(controlPath, installedTmux, false);
      await shield.create({
        sessionId: 'fda-probe',
        command: ['sh', '-c', 'exec sleep 60'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() },
      });
      // A home with none of the folders: nothing to tell (never «denied» by mistake).
      const bare = fs.mkdtempSync(path.join(root, 'home-'));
      expect(await shield.fullDiskAccess(bare)).toBe('unknown');
      // One that exists and reads (a plain folder here): granted. «denied» needs a tmux
      // without the grant, checked by hand on 2026-11-08 (Homebrew tmux under launchd).
      fs.mkdirSync(path.join(bare, 'Library', 'Mail'), { recursive: true });
      expect(await shield.fullDiskAccess(bare)).toBe('granted');
      // A path with a quote in it does not break the probe.
      const odd = fs.mkdtempSync(path.join(root, "it's-"));
      expect(await shield.fullDiskAccess(odd)).toBe('unknown');
    }, 20_000);

    it('answersWith is null when no server runs', async () => {
      const shield = new ShieldTmux(controlPath, installedTmux, false);
      expect(await shield.answersWith(installedTmux as string)).toBeNull();
      expect(await shield.serverBinary()).toBeNull();
      expect(await shield.serverBinaries()).toEqual([]);
      expect(await shield.fullDiskAccess()).toBe('no-server');
    });
  }
);
