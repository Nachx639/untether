/**
 * Share with phone: is the Mac's screen locked? While it is, every Apple Event to Terminal,
 * iTerm2 or System Events hangs with no reply and no error, so nothing is scripted then: the
 * share is refused before closing anything, and after the close it waits for the unlock.
 *
 * One `ioreg -a -n Root -d1` (about 10 ms, killed at 2 s) gives the IORegistry root as a plist:
 * - `IOConsoleLocked`: the console is locked;
 * - `IOConsoleUsers`: one entry per GUI session, with `kCGSSessionUserIDKey`,
 *   `CGSSessionScreenIsLocked` and `kCGSSessionOnConsoleKey`.
 * It counts as locked when the console is, when our user's session is, or when our session is
 * not on the console (fast user switching, or no session of ours at all). When ioreg fails or
 * its answer can't be read, the state is unknown: the caller goes ahead, and the osascript
 * runner's hard timeout still protects it.
 */
import { execFile } from 'child_process';
import { assertRealScanAllowed } from './process-tree.js';

export const IOREG_PATH = '/usr/sbin/ioreg';
export const IOREG_ARGS = ['-a', '-n', 'Root', '-d1'] as const;
export const SCREEN_LOCK_TIMEOUT_MS = 2000;

export interface ScreenLockState {
  /** False when ioreg failed or answered something unreadable: `locked` is then false. */
  known: boolean;
  locked: boolean;
  why?: 'console-locked' | 'session-locked' | 'off-console';
}

const UNKNOWN: ScreenLockState = { known: false, locked: false };

export interface ScreenLockDeps {
  /** Runs ioreg and gives its stdout; tests pass their own. */
  run?: (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  uid?: number;
  platform?: NodeJS.Platform;
  /** Tests that mean to run the real ioreg say so. */
  allowRealInTests?: boolean;
}

function runIoreg(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

export async function screenLock(deps: ScreenLockDeps = {}): Promise<ScreenLockState> {
  if ((deps.platform ?? process.platform) !== 'darwin') return UNKNOWN;
  if (!deps.run && !deps.allowRealInTests) assertRealScanAllowed('ioreg');
  const uid = deps.uid ?? process.getuid?.();
  if (uid === undefined) return UNKNOWN;
  let xml: string;
  try {
    xml = await (deps.run ?? runIoreg)(IOREG_PATH, IOREG_ARGS, SCREEN_LOCK_TIMEOUT_MS);
  } catch {
    return UNKNOWN;
  }
  return screenLockFromPlist(xml, uid);
}

/** The lock state in ioreg's plist for the user `uid`. */
export function screenLockFromPlist(xml: string, uid: number): ScreenLockState {
  let root: unknown;
  try {
    root = parsePlist(xml);
  } catch {
    return UNKNOWN;
  }
  if (Array.isArray(root)) root = root[0];
  if (!isDict(root)) return UNKNOWN;
  const consoleLocked = root.IOConsoleLocked;
  const users = root.IOConsoleUsers;
  if (typeof consoleLocked !== 'boolean' && !Array.isArray(users)) return UNKNOWN;
  if (consoleLocked === true) return { known: true, locked: true, why: 'console-locked' };
  const ours = Array.isArray(users)
    ? users.filter(isDict).find((user) => user.kCGSSessionUserIDKey === uid)
    : undefined;
  if (!ours) return { known: true, locked: true, why: 'off-console' };
  if (ours.CGSSessionScreenIsLocked === true) {
    return { known: true, locked: true, why: 'session-locked' };
  }
  if (ours.kCGSSessionOnConsoleKey === false) {
    return { known: true, locked: true, why: 'off-console' };
  }
  return { known: true, locked: false };
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Token = { kind: 'open' | 'close' | 'empty'; name: string } | { kind: 'text'; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity];
  });
}

function tokenize(xml: string): Token[] {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<![\s\S]*?>/g, '');
  const tokens: Token[] = [];
  const re = /<(\/?)([A-Za-z]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  for (let match = re.exec(body); match; match = re.exec(body)) {
    if (match[4] !== undefined) {
      tokens.push({ kind: 'text', text: decodeText(match[4]) });
    } else if (match[1]) {
      tokens.push({ kind: 'close', name: match[2] });
    } else {
      tokens.push({ kind: match[3] ? 'empty' : 'open', name: match[2] });
    }
  }
  return tokens;
}

/**
 * A small reader for XML property lists: dict, array, key, string, integer, real, true,
 * false, date and data (left as text). Throws on anything else or malformed input.
 */
export function parsePlist(xml: string): unknown {
  const tokens = tokenize(xml);
  let at = 0;
  const skipSpace = () => {
    while (at < tokens.length) {
      const token = tokens[at];
      if (token.kind !== 'text' || token.text.trim() !== '') break;
      at++;
    }
  };
  const next = (): Token => {
    skipSpace();
    const token = tokens[at++];
    if (!token) throw new Error('plist: unexpected end');
    return token;
  };
  const expectClose = (name: string) => {
    const token = next();
    if (token.kind !== 'close' || token.name !== name)
      throw new Error(`plist: </${name}> expected`);
  };
  const textUntilClose = (name: string): string => {
    const token = tokens[at];
    let text = '';
    if (token?.kind === 'text') {
      text = token.text;
      at++;
    }
    const close = tokens[at++];
    if (close?.kind !== 'close' || close.name !== name) throw new Error(`plist: </${name}>`);
    return text;
  };
  const value = (): unknown => {
    const token = next();
    if (token.kind === 'empty') {
      if (token.name === 'true') return true;
      if (token.name === 'false') return false;
      if (token.name === 'string' || token.name === 'data' || token.name === 'date') return '';
      if (token.name === 'dict') return {};
      if (token.name === 'array') return [];
      throw new Error(`plist: <${token.name}/>`);
    }
    if (token.kind !== 'open') throw new Error('plist: value expected');
    switch (token.name) {
      case 'plist': {
        const inner = value();
        expectClose('plist');
        return inner;
      }
      case 'dict': {
        const dict: Dict = {};
        for (;;) {
          const keyToken = next();
          if (keyToken.kind === 'close' && keyToken.name === 'dict') return dict;
          if (keyToken.kind !== 'open' || keyToken.name !== 'key') throw new Error('plist: key');
          const key = textUntilClose('key');
          dict[key] = value();
        }
      }
      case 'array': {
        const list: unknown[] = [];
        for (;;) {
          skipSpace();
          const peek = tokens[at];
          if (peek?.kind === 'close' && peek.name === 'array') {
            at++;
            return list;
          }
          list.push(value());
        }
      }
      case 'string':
      case 'data':
      case 'date':
        return textUntilClose(token.name);
      case 'integer':
      case 'real': {
        const number = Number(textUntilClose(token.name).trim());
        if (Number.isNaN(number)) throw new Error('plist: number');
        return number;
      }
      default:
        throw new Error(`plist: <${token.name}>`);
    }
  };
  const result = value();
  skipSpace();
  if (at !== tokens.length) throw new Error('plist: trailing content');
  return result;
}
