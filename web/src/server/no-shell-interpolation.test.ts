import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-10-02: /api/fs/diff ran `git diff HEAD -- "${path}"` through a shell, so a file named
// `a$(cmd).txt` ran `cmd` when its diff was opened. Commands that take paths or user input go
// through execFile/spawn with an argument array. Interpolating plain numbers (a pid) is fine.
// Reviewed exceptions: numeric pids, a constant service name, the local account name, and
// the program of a session the user starts themselves (it can already run anything).
// A tripwire, not a proof: it reads template literals passed straight to exec*, so a command
// built in a variable first (process-tree-analyzer, pty-manager: pid-only today) escapes it.
const ALLOWED = [
  /^[^$]*\$\{(?:pid|pgid|currentPid|rootPid)\}[^$]*$/,
  /^systemctl --user [\w-]+ \$\{SERVICE_NAME\}$/,
  /^loginctl enable-linger \$\{username\}$/,
  /^(?:which|command -v) "\$\{baseCommand\}" 2>\/dev\/null$/,
];

/**
 * exec/execAsync/execSync called with a template literal holding `${…}`. Not a regex literal's
 * own .exec (2026-10-31: /designated => …/m.exec(`${a}\n${b}`) in stable-tmux.ts read as a
 * shell command).
 */
const TRIPWIRE = /(?<!\/[dgimsuyv]*\.)\b(?:exec|execAsync|execSync)\(\s*`([^`]*\$\{[^`]*)`/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('server shell commands', () => {
  it('never interpolate values into a shell command string', () => {
    const offenders = sources(__dirname).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(TRIPWIRE)]
        .map((m) => m[1])
        .filter((cmd) => !ALLOWED.some((ok) => ok.test(cmd)))
        .map((cmd) => `${file}: ${cmd}`)
    );
    expect(offenders).toEqual([]);
  });

  it('the tripwire still catches exec with a template, but not a regex literal matching one', () => {
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: samples of source code
    const found = (code: string) => [...code.matchAll(TRIPWIRE)].map((m) => m[1]);
    expect(found('await execAsync(`git diff -- "${file}"`)')).toEqual(['git diff -- "${file}"']);
    expect(found('child.exec(`ls ${dir}`)')).toEqual(['ls ${dir}']);
    expect(found('/designated => (.+)$/m.exec(`${a}\\n${b}`)')).toEqual([]);
    expect(found('/x/.exec(`${a}`)')).toEqual([]);
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: samples of source code
  });

  it('never splice values into a `-c` script or run with shell: true', () => {
    const offenders = sources(__dirname).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [
        ...[...text.matchAll(/'-(?:l?i?c)'\s*,\s*`([^`]*\$\{[^`]*)`/g)]
          .map((m) => m[1])
          // process-utils checks commandName against /^[A-Za-z0-9_@%+,./:-]+$/ first and
          // passes the arguments separately ("$@" / $argv).
          .filter((script) => !/^\$\{commandName\} (?:"\$@"|\$argv)$/.test(script)),
        ...[...text.matchAll(/shell:\s*true/g)].map(() => 'shell: true'),
      ].map((hit) => `${file}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });
});
