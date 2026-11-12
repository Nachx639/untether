/**
 * Share with phone: quoting for the line typed into a terminal tab. Every value that comes
 * from the Mac (a folder, an option value, a path) is quoted for the tab's shell; only words
 * from the server's own tables are typed bare.
 *
 * - POSIX shells (zsh, bash): `'` + value with each `'` as `'\''` + `'`. No `''` ever appears
 *   inside a quoted span, so zsh's RC_QUOTES changes nothing; history expansion (`!`), globs,
 *   `=cmd`, `~` and `$` are all inert inside single quotes.
 * - fish: `'` + value with `\` and `'` backslash-escaped + `'`.
 *
 * Refused (the value can't be typed safely, whatever the quoting): C0 controls (NUL, tab,
 * newline, CR, ESC…), DEL, NEL (U+0085), the Unicode line and paragraph separators, and lone
 * surrogates. A newline or CR would submit the line early; ESC could start a key sequence.
 */
import * as path from 'path';
import type { MacShareShell } from '../../../shared/mac-share.js';

/** C0 controls, DEL, NEL and the Unicode line and paragraph separators. */
function isRefusedCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/** Why `value` can't be typed into a shell, or undefined when it can. */
export function unsafeReason(value: string): 'control' | 'surrogate' | undefined {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isRefusedCode(code)) return 'control';
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return 'surrogate';
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return 'surrogate';
    }
  }
  return undefined;
}

export class UnsafeValueError extends Error {
  constructor(readonly why: 'control' | 'surrogate') {
    super(`unsafe value for a shell (${why})`);
  }
}

function assertSafe(value: string): void {
  const why = unsafeReason(value);
  if (why) throw new UnsafeValueError(why);
}

export function quotePosix(value: string): string {
  assertSafe(value);
  return `'${value.split("'").join("'\\''")}'`;
}

export function quoteFish(value: string): string {
  assertSafe(value);
  return `'${value.replace(/[\\']/g, '\\$&')}'`;
}

export function quoteFor(shell: MacShareShell, value: string): string {
  return shell === 'fish' ? quoteFish(value) : quotePosix(value);
}

const SHELLS: readonly MacShareShell[] = ['zsh', 'bash', 'fish'];

/**
 * The tab's shell from its process's args[0] (`-zsh`, `/bin/zsh`, `/opt/homebrew/bin/fish`).
 * `name` is safe to show ("Its tab runs {shell}"): letters, digits, `.`, `_` and `-` only.
 */
export function shellFromArg0(
  arg0: string
): { shell: MacShareShell; name: string } | { shell?: undefined; name: string } {
  const word = arg0.trim().split(' ')[0] ?? '';
  const name = path
    .basename(word)
    .replace(/^-/, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 32);
  const shell = SHELLS.find((candidate) => candidate === name);
  return shell ? { shell, name } : { name };
}
