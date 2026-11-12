import { describe, expect, it, vi } from 'vitest';
import {
  IOREG_ARGS,
  IOREG_PATH,
  parsePlist,
  SCREEN_LOCK_TIMEOUT_MS,
  screenLock,
  screenLockFromPlist,
} from './screen-lock.js';

const UID = 501;

interface User {
  uid: number;
  locked?: boolean;
  onConsole?: boolean;
}

/** The shape of `ioreg -a -n Root -d1` on macOS 27, user names and UUIDs removed. */
function ioreg(consoleLocked: boolean | undefined, users: User[] | undefined): string {
  const user = (u: User) => `
		<dict>
${u.locked === undefined ? '' : `			<key>CGSSessionScreenIsLocked</key>\n			<${u.locked}/>\n`}			<key>CGSSessionScreenLockedTime</key>
			<integer>1791066518</integer>
			<key>CGSSessionUniqueSessionUUID</key>
			<string>00000000-0000-0000-0000-000000000000</string>
			<key>kCGSSessionLoginwindowSafeLogin</key>
			<false/>
${u.onConsole === undefined ? '' : `			<key>kCGSSessionOnConsoleKey</key>\n			<${u.onConsole}/>\n`}			<key>kCGSSessionUserIDKey</key>
			<integer>${u.uid}</integer>
			<key>kCGSSessionUserNameKey</key>
			<string>someone &amp; co</string>
		</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${consoleLocked === undefined ? '' : `	<key>IOConsoleLocked</key>\n	<${consoleLocked}/>\n`}${users === undefined ? '' : `	<key>IOConsoleUsers</key>\n	<array>${users.map(user).join('')}\n	</array>\n`}	<key>IOKitBuildVersion</key>
	<string>Darwin Kernel Version 27.0.0</string>
	<key>IOKitDiagnostics</key>
	<dict>
		<key>Classes</key>
		<dict>
			<key>ACMKernelService</key>
			<integer>7</integer>
		</dict>
		<key>Empty</key>
		<array/>
		<key>Ratio</key>
		<real>0.5</real>
	</dict>
	<key>IORegistryEntryName</key>
	<string>Root</string>
</dict>
</plist>
`;
}

describe('screen lock', () => {
  it('unlocked: the console is not locked and our session is on it, unlocked', () => {
    expect(
      screenLockFromPlist(ioreg(false, [{ uid: UID, locked: false, onConsole: true }]), UID)
    ).toEqual({ known: true, locked: false });
  });

  it('locked when the console is locked, whatever the sessions say', () => {
    expect(
      screenLockFromPlist(ioreg(true, [{ uid: UID, locked: false, onConsole: true }]), UID)
    ).toEqual({ known: true, locked: true, why: 'console-locked' });
  });

  it('locked when only our session says its screen is locked', () => {
    expect(
      screenLockFromPlist(ioreg(false, [{ uid: UID, locked: true, onConsole: true }]), UID)
    ).toEqual({ known: true, locked: true, why: 'session-locked' });
  });

  it('locked when another user has the console (fast user switching)', () => {
    const users = [
      { uid: 502, locked: false, onConsole: true },
      { uid: UID, locked: false, onConsole: false },
    ];
    expect(screenLockFromPlist(ioreg(false, users), UID)).toEqual({
      known: true,
      locked: true,
      why: 'off-console',
    });
    // Only another user's session, none of ours: nothing of ours can be scripted either.
    expect(screenLockFromPlist(ioreg(false, [users[0]]), UID).why).toBe('off-console');
  });

  it('another user locked does not lock ours', () => {
    const users = [
      { uid: 502, locked: true, onConsole: false },
      { uid: UID, locked: false, onConsole: true },
    ];
    expect(screenLockFromPlist(ioreg(false, users), UID).locked).toBe(false);
  });

  it('missing per-session keys count as unlocked; no lock keys at all is unknown', () => {
    expect(screenLockFromPlist(ioreg(false, [{ uid: UID }]), UID)).toEqual({
      known: true,
      locked: false,
    });
    expect(screenLockFromPlist(ioreg(undefined, undefined), UID)).toEqual({
      known: false,
      locked: false,
    });
  });

  it('garbage, an empty answer or a truncated plist is unknown', () => {
    const whole = ioreg(true, [{ uid: UID, locked: true, onConsole: true }]);
    for (const xml of ['', 'IOConsoleLocked = Yes', '<plist><dict><key>x', whole.slice(0, 300)]) {
      expect(screenLockFromPlist(xml, UID), xml).toEqual({ known: false, locked: false });
    }
  });

  it('reads one ioreg, killed at 2 s, and a failing ioreg is unknown', async () => {
    const run = vi.fn(async () => ioreg(true, [{ uid: UID, locked: true, onConsole: true }]));
    expect(await screenLock({ run, uid: UID, platform: 'darwin' })).toMatchObject({
      known: true,
      locked: true,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(IOREG_PATH, IOREG_ARGS, SCREEN_LOCK_TIMEOUT_MS);
    expect(IOREG_ARGS).toEqual(['-a', '-n', 'Root', '-d1']);
    expect(SCREEN_LOCK_TIMEOUT_MS).toBe(2000);

    const failing = vi.fn(async () => {
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
    });
    expect(await screenLock({ run: failing, uid: UID, platform: 'darwin' })).toEqual({
      known: false,
      locked: false,
    });
  });

  it('is unknown off macOS without running anything, and never runs the real ioreg in tests unasked', async () => {
    const run = vi.fn(async () => '');
    expect(await screenLock({ run, platform: 'linux' })).toEqual({ known: false, locked: false });
    expect(run).not.toHaveBeenCalled();
    await expect(screenLock({ platform: 'darwin' })).rejects.toThrow(/vitest/);
  });

  it.skipIf(process.platform !== 'darwin')(
    "reads this Mac's real ioreg within the timeout (no Apple Event involved)",
    async () => {
      const started = Date.now();
      const state = await screenLock({ allowRealInTests: true });
      expect(state.known).toBe(true);
      expect(Date.now() - started).toBeLessThan(SCREEN_LOCK_TIMEOUT_MS);
    }
  );
});

describe('plist reader', () => {
  it('reads nested dicts and arrays, numbers, booleans, empty elements and entities', () => {
    expect(
      parsePlist(`<?xml version="1.0"?><plist version="1.0"><dict>
        <key>a</key><array><integer>-3</integer><real>1.5</real><true/><false/></array>
        <key>b &amp; c</key><dict><key>s</key><string> x &lt;y&gt; &#x263A; &#65;</string></dict>
        <key>e</key><string></string><key>f</key><string/><key>g</key><array/><key>h</key><dict/>
      </dict></plist>`)
    ).toEqual({
      a: [-3, 1.5, true, false],
      'b & c': { s: ' x <y> ☺ A' },
      e: '',
      f: '',
      g: [],
      h: {},
    });
  });

  it('refuses malformed input', () => {
    for (const xml of [
      '<plist><dict><key>a</key></dict></plist>',
      '<plist><dict><string>a</string></dict></plist>',
      '<plist><integer>x</integer></plist>',
      '<plist><dict></plist>',
      '<plist><unknown/></plist>',
      '<plist><true/></plist><plist/>',
    ]) {
      expect(() => parsePlist(xml), xml).toThrow();
    }
  });
});
