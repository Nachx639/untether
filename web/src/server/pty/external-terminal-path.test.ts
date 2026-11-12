import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-11-11: the server still carried the code of the Node forwarder it once was (`ut fwd`
// ran this same PtyManager and wrote the session to its own stdout): output copied to
// process.stdout, titles injected into it, a session.json watcher, fish completions, prompt
// detection, a `sh -c "ps …"` per finished command for an exit code that was always 0, and
// Windows branches of a package that only installs on macOS and Linux. ~1,500 lines with no
// caller: the forwarder is native/ut-fwd. A tripwire so none of it comes back by a merge.
const SERVER = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function offenders(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${relative(SERVER, file)}:${index + 1}: ${line.trim()}`] : []
      )
  );
}

describe('the external-terminal path stays out of the server', () => {
  const all = sources(SERVER);
  const pty = all.filter((file) => file.startsWith(join(SERVER, 'pty')));

  it('no session output or title goes to the server process own terminal', () => {
    expect(
      offenders(
        all,
        /forwardToStdout|stdoutQueue|isExternalTerminal|pendingTitleToInject|titleInjection|setupSessionWatcher|sessionJsonWatcher/
      )
    ).toEqual([]);
    expect(offenders(pty, /process\.(stdout|stdin)\b/)).toEqual([]);
  });

  it('no fish completions, prompt detection or title generation modules', () => {
    expect(
      offenders(
        all,
        /fish-handler|FishHandler|prompt-patterns|PromptDetector|utils\/terminal-title/
      )
    ).toEqual([]);
  });

  it('PtyManager runs no shell: programs with their arguments only (execFile)', () => {
    expect(
      offenders(
        pty.filter((file) => file.includes('pty-manager')),
        /\b(?:exec|execSync|execAsync)\(|promisify\(exec\)/
      )
    ).toEqual([]);
  });

  it('no Windows branches (the package installs on macOS and Linux only)', () => {
    expect(
      offenders(
        all,
        /win32|windowsHide|\.exe\b|tasklist|taskkill|WindowsPowerShell|\bpwsh\b|\bwmic\b/
      )
    ).toEqual([]);
    const { os } = JSON.parse(readFileSync(join(SERVER, '..', '..', 'package.json'), 'utf8'));
    expect(os).toEqual(['darwin', 'linux']);
  });
});
