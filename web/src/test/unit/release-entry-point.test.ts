import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const ENTRY = 'mac/scripts/release.sh';
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Tracked text files that match, documents (*.md) left out: prose runs nothing. */
const filesWith = (pattern: string): string[] => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', '-I', '-i', '-E', pattern, '--', '.', ':!*.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    // git grep exits 1 when nothing matches
  }
  return out
    .split('\n')
    .filter((file) => file && fs.existsSync(path.join(ROOT, file)))
    .sort();
};
const linesWith = (file: string, pattern: RegExp) =>
  read(file)
    .split('\n')
    .filter((line) => pattern.test(line));

/**
 * 2026-11-12, the owner's decision: a version is published only when he orders it. There is one
 * way to publish, mac/scripts/release.sh, run by hand with the tag written out (`--confirm`);
 * no other script, git hook, workflow, scheduled job, package script or server code runs it or
 * creates a GitHub release on its own. What the script itself refuses (no --confirm, a CI job, a
 * git hook, an Untether task) is tested with doubles in mac/scripts/test-release-scripts.sh, and
 * what a task's agent is stopped from running in task-guard.test.ts.
 */
describe('publishing a release', () => {
  const says = /^\s*(#|\/\/|\*|echo |print_\w+ )/;
  // Every file that names the script, and what its lines may be: anything else is a caller.
  const MENTIONS: Record<string, (line: string) => boolean> = {
    [ENTRY]: () => true,
    // Runs a copy in a toy checkout, where `git push`, `gh` and Apple's notary are stand-ins;
    // the checkout's own script it only reads.
    'mac/scripts/test-release-scripts.sh': (line) =>
      line.includes('"$TOY/mac/scripts/release.sh" "$@"') ||
      /\bgrep\b/.test(line) ||
      /^\s*(#|check ")/.test(line),
    // They tell the person what to run.
    'mac/scripts/preflight-check.sh': (line) => says.test(line),
    'mac/scripts/release-checklist.sh': (line) => says.test(line),
    'mac/scripts/version.sh': (line) => says.test(line),
    'mac/scripts/release-lib.sh': (line) => says.test(line),
    'mac/scripts/create-pkg.sh': (line) => says.test(line),
    'scripts/public-repo-rules.sh': (line) => says.test(line),
    // The task guard's rule against running it, and tests that hold its name as text.
    'web/src/server/services/task-guard.ts': (line) => !/exec|spawn/.test(line),
    'web/src/server/services/task-guard.test.ts': (line) => !/exec|spawn/.test(line),
    'web/src/server/services/security-sweep.test.ts': (line) => !/exec|spawn/.test(line),
    'web/src/server/services/task-risk.test.ts': (line) => !/exec|spawn/.test(line),
    'web/src/test/unit/publish-guard.test.ts': (line) => !/exec|spawn/.test(line),
    'web/src/test/unit/repo-config.test.ts': (line) => !/exec|spawn/.test(line),
    'web/src/test/unit/release-entry-point.test.ts': () => true,
  };

  it('has one entry point, and nothing else runs it', () => {
    const callers: string[] = [];
    for (const file of filesWith('release\\.sh')) {
      const allowed = MENTIONS[file];
      for (const line of linesWith(file, /release\.sh/)) {
        if (!allowed?.(line)) callers.push(`${file}: ${line.trim()}`);
      }
    }
    expect(callers).toEqual([]);
    // The list above names files that exist and still mention it.
    expect(
      Object.keys(MENTIONS).filter((file) => !filesWith('release\\.sh').includes(file))
    ).toEqual([]);
  });

  it('is the only place a GitHub release is created, changed or deleted', () => {
    const publishers = filesWith(
      'gh release (create|upload|edit|delete)|action-gh-release|actions/create-release|upload-release-asset|/releases"? .*-X ?POST|releases/assets'
    );
    expect(publishers).toEqual(
      [
        ENTRY,
        'mac/scripts/test-release-scripts.sh',
        'web/src/server/services/task-guard.test.ts',
        'web/src/test/unit/release-entry-point.test.ts',
      ].sort()
    );
  });

  it('is not what any workflow, git hook or package script does', () => {
    const automation = [
      ...filesWith('.').filter(
        (file) => file.startsWith('.github/') || file.startsWith('scripts/git-hooks/')
      ),
      'web/package.json',
      'poltergeist.config.json',
    ].filter((file) => fs.existsSync(path.join(ROOT, file)));
    expect(automation.length).toBeGreaterThan(2);
    const publishing = /release\.sh|create-pkg\.sh|notarize-pkg\.sh|gh release|public-export\.sh/;
    expect(
      automation.flatMap((file) =>
        linesWith(file, publishing)
          .filter((line) => !says.test(line))
          .map((line) => `${file}: ${line.trim()}`)
      )
    ).toEqual([]);
  });

  it('asks for the tag in words and refuses jobs, hooks and tasks before doing anything', () => {
    const script = read(ENTRY);
    const refusals = script.indexOf('untether_release_automation');
    const confirm = script.indexOf('"$CONFIRM_TAG" != "$TAG_NAME"');
    const firstEffect = Math.min(
      ...['build.sh"', 'public-export.sh"', ' push ', 'gh release create'].map((effect) =>
        script.indexOf(effect, confirm)
      )
    );
    expect(refusals).toBeGreaterThan(0);
    expect(confirm).toBeGreaterThan(refusals);
    expect(firstEffect).toBeGreaterThan(confirm);
    // A dry run is the one that skips them, and a dry run ends before the first push.
    const publish = script.indexOf('git -C "$COPY" push origin main');
    const dryRunEnds = script.lastIndexOf('exit 0', publish);
    expect(script.slice(dryRunEnds - 4000, dryRunEnds)).toContain(
      'if [[ "$DRY_RUN" == true ]]; then'
    );
    expect(script.slice(dryRunEnds, publish)).not.toMatch(/\bgh release|\bpush\b|\btag\b/);
  });

  it('publishes in the public repository, from the clean copy, never from the working history', () => {
    const script = read(ENTRY);
    // Every push and tag is made in the copy the exporter wrote.
    for (const line of script.split('\n').filter((l) => /^\s*git .*\b(push|tag)\b/.test(l))) {
      expect(line.trim()).toMatch(/^git -C "\$COPY" /);
    }
    expect(script).toMatch(
      /gh release create "\$TAG_NAME" \\\n\s+--repo "\$PUBLIC_REPO" \\\n\s+--verify-tag/
    );
    expect(script).not.toMatch(/git (commit|add)\b/);
  });
});

/**
 * The app people install does not update itself and does not look for new versions: a new
 * version is a new .pkg they download. (`autoUpdateInstalledApp` is another thing: the owner's
 * own Mac rebuilding the app from its checkout; it reads no release.)
 */
describe('the installed app', () => {
  it('has no updater and asks no server for a newer version', () => {
    const updaters = filesWith(
      'sparkle-project|SUFeedURL|SUPublicEDKey|appcast|SPUUpdater|SUUpdater|releases/latest|api\\.github\\.com/repos/[^"]*/releases'
    ).filter((file) => /^(mac|ios|web\/src|apple|native)\//.test(file));
    // cloudflared's own download page, opened in the browser when the person asks to install it.
    expect(updaters.filter((file) => !file.endsWith('.test.ts'))).toEqual([
      'mac/Untether/Core/Services/CloudflareService.swift',
    ]);
    expect(
      linesWith('mac/Untether/Core/Services/CloudflareService.swift', /releases\/latest/).every(
        (line) => line.includes('github.com/cloudflare/cloudflared/releases/latest')
      )
    ).toBe(true);
  });
});

describe('the README', () => {
  const readme = read('README.md');

  it('promises a download only where a release exists, and says nothing updates itself', () => {
    const download = readme
      .slice(readme.indexOf('## Download'), readme.indexOf('## Build from source'))
      .replace(/\s+/g, ' ');
    expect(download).toContain('/releases');
    expect(download).toContain('.pkg');
    expect(download).toMatch(/does not update itself/);
    expect(download).toMatch(/If (that|the) page (lists|has|shows) no release/);
    expect(readme).not.toMatch(/\.dmg\b/);
  });
});
