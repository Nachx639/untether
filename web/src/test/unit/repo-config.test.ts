import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const WEB = path.join(ROOT, 'web');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const tracked = (...patterns: string[]) =>
  execFileSync('git', ['ls-files', ...patterns], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const packageJson = JSON.parse(read('web/package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};
const workflows = tracked('.github/workflows/*.yml');

/**
 * 2026-11-11 (decisions after the scripts/docs audit). What the repository's configuration says
 * has to be true of the repository: scripts that point at files, workflows that call scripts,
 * build tools told where their output goes. Each of these was false somewhere.
 */
describe('package.json scripts', () => {
  // test:e2e:perf pointed at a Playwright configuration that did not exist; test:e2e:fast at one
  // that listed specs deleted long before.
  it('name only files that exist', () => {
    const missing: string[] = [];
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      for (const match of command.matchAll(
        /(?:^|[\s=])((?:\.\/)?(?:scripts|src|bin)\/[\w./-]+|[\w.-]+\.config\.[\w.]+)/g
      )) {
        if (!fs.existsSync(path.join(WEB, match[1]))) missing.push(`${name}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // node.yml ran `pnpm run lint:biome`, an alias; docs named scripts that were gone.
  it('are the ones workflows, shell scripts and documents run', () => {
    const files = [
      ...workflows,
      ...tracked('web/scripts/*.sh', 'scripts/*.sh', 'mac/scripts/*.sh', '*.md', '*.mdx'),
    ].filter(
      (file) =>
        !file.startsWith('web/node-pty/') &&
        // The record of what was run for each interface style, not instructions.
        !file.startsWith('docs/verification/') &&
        file !== 'CHANGELOG.md'
    );
    // Scripts of web/node-pty's own package.json, run from that folder.
    const elsewhere = new Set(['install']);
    const unknown: string[] = [];
    for (const file of files) {
      for (const match of read(file).matchAll(/\bpnpm run ([a-z][\w:-]*)/g)) {
        const name = match[1];
        // `pnpm run test:*` in a list of allowed commands: a pattern, not a script.
        if (name.endsWith(':')) continue;
        if (!(name in packageJson.scripts) && !elsewhere.has(name))
          unknown.push(`${file}: ${name}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  // Husky and lint-staged were dependencies with a `prepare` script and a .husky/pre-commit, but
  // the hook was never installed in any checkout: a check everybody believed ran and never did.
  it('carry no git hook manager', () => {
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(Object.keys(packageJson.devDependencies)).not.toContain('husky');
    expect(Object.keys(packageJson.devDependencies)).not.toContain('lint-staged');
    expect(tracked('.husky')).toEqual([]);
  });
});

describe('poltergeist.config.json', () => {
  // The build commands had no -derivedDataPath (and the iOS one no -sdk), so Xcode built into
  // ~/Library/Developer/Xcode/DerivedData and outputPath named an app that was never there.
  it('builds each target where its outputPath says', () => {
    const { targets } = JSON.parse(read('poltergeist.config.json')) as {
      targets: Array<{ name: string; buildCommand: string; outputPath: string }>;
    };
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const command = target.buildCommand;
      const cd = command.match(/^cd (\S+) &&/)?.[1] ?? '.';
      const derived = command.match(/-derivedDataPath (\S+)/)?.[1];
      const configuration = command.match(/-configuration (\S+)/)?.[1];
      const sdk = command.match(/-sdk (\S+)/)?.[1];
      expect(derived, `${target.name}: -derivedDataPath`).toBeDefined();
      expect(configuration, `${target.name}: -configuration`).toBeDefined();
      const products = path.join(
        cd,
        derived as string,
        'Build',
        'Products',
        sdk ? `${configuration}-${sdk}` : (configuration as string)
      );
      expect(path.normalize(path.dirname(target.outputPath)), target.name).toBe(
        path.normalize(products)
      );
    }
    // The iOS app is built for the simulator: without -sdk its products folder has another name.
    const ios = targets.find((target) => target.name === 'untether-ios');
    expect(ios?.buildCommand).toContain('-sdk iphonesimulator');
  });
});

// The public copy (scripts/public-export.sh) carries no workflow at all: nothing to check there.
describe.skipIf(workflows.length === 0)('GitHub workflows', () => {
  it('use one Xcode version', () => {
    const versions = new Map<string, string[]>();
    const macJobsWithoutVersion: string[] = [];
    for (const file of workflows) {
      const text = read(file);
      const found = [...text.matchAll(/xcode-version:\s*'?([\d.]+)'?/g)].map((match) => match[1]);
      for (const version of found) versions.set(version, [...(versions.get(version) ?? []), file]);
      if (/runs-on:\s*macos/.test(text) && /xcodebuild/.test(text) && found.length === 0) {
        macJobsWithoutVersion.push(file);
      }
    }
    expect([...versions.keys()], JSON.stringify([...versions])).toHaveLength(1);
    // nightly.yml built with whatever Xcode the runner had selected.
    expect(macJobsWithoutVersion).toEqual([]);
  });

  // web-ci.yml ran lint, typecheck, build and both test modes a second time, next to node.yml.
  it('check the web in node.yml only; web-ci.yml keeps the forwarder and the npm build', () => {
    const webCi = read('.github/workflows/web-ci.yml');
    expect(webCi).not.toMatch(/\bpnpm (run|install|exec)\b/);
    expect(webCi).toContain('cargo test');
    expect(webCi).toContain('npm run build');

    const node = read('.github/workflows/node.yml');
    for (const script of [
      'format:check',
      'lint',
      'typecheck',
      'build:ci',
      'test:client:coverage',
      'test:server:coverage',
    ]) {
      expect(node, script).toMatch(new RegExp(`pnpm run ${script}(?![\\w:-])`));
    }
    const others = workflows.filter(
      (file) => !/\/(node|claude|claude-code-review)\.yml$/.test(file)
    );
    for (const file of others) {
      expect(read(file), file).not.toMatch(
        /pnpm run (lint|typecheck|format:check|test:(client|server))/
      );
    }
  });

  // ios.yml ran both tools with continue-on-error and nothing looked at the result; it also
  // used other configuration files than ios/scripts/lint.sh.
  it('fail the iOS job on SwiftFormat or SwiftLint, with the configuration of lint.sh', () => {
    const ios = read('.github/workflows/ios.yml');
    expect(ios).toContain('swiftformat . --lint --config ../apple/.swiftformat');
    expect(ios).toContain('swiftlint --config ../apple/.swiftlint.yml');
    const enforce = ios.slice(ios.indexOf('Enforce Swift lint/format success'));
    expect(enforce).toContain('steps.swiftformat.outputs.result');
    expect(enforce).toContain('steps.swiftlint.outputs.result');
    expect(enforce).toContain('exit 1');
  });

  it('run the whole Playwright suite with the one configuration', () => {
    expect(tracked('web/playwright.config*')).toEqual(['web/playwright.config.ts']);
    expect(read('.github/workflows/playwright.yml')).toMatch(/pnpm run test:e2e\s/);
  });
});

// 2026-11-11: the public repository's name was still to be decided, and its address is written in
// documents, package files, both apps and the release scripts. One value (web/package.json's
// "homepage"), changed everywhere at once by scripts/repo-url.sh.
describe("the public repository's address", () => {
  const { homepage } = packageJson as unknown as { homepage: string };
  const [, owner, name] = /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+)$/.exec(homepage) ?? [];

  it('is the one of web/package.json wherever something reads it', () => {
    expect(owner && name, homepage).toBeTruthy();
    for (const file of [
      'README.md',
      'docs.json',
      'web/package.npm.json',
      'web/Dockerfile.standalone',
      'web/src/server/utils/vapid-manager.ts',
      'mac/Untether/version.xcconfig',
      'ios/Untether/version.xcconfig',
      'mac/Untether/Presentation/Views/AboutView.swift',
      'mac/Untether/Presentation/Components/StatusBarMenuManager.swift',
      'ios/Untether/Views/Settings/SettingsView.swift',
      'mac/scripts/release.sh',
    ]) {
      expect(read(file), file).toContain(`github.com/${owner}/${name}`);
    }
  });

  it('is written the same in every tracked file', () => {
    // Any other owner of a repository of this name, or this owner with a name that only
    // starts the same: an address the script did not write.
    const others: string[] = [];
    const mention = new RegExp(
      `github\\.com[/:](?:[\\w-]+/${name}|${owner}/untether[\\w-]*)(?![\\w-])`,
      'gi'
    );
    const files = execFileSync('git', ['grep', '-l', '-I', '-i', 'github\\.com', '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (file) => file && file !== 'web/pnpm-lock.yaml' && fs.existsSync(path.join(ROOT, file))
      );
    for (const file of files) {
      for (const match of read(file).matchAll(mention)) {
        const found = match[0].replace(/^github\.com[/:]/i, '').replace(/\.git$/, '');
        if (found !== `${owner}/${name}`) others.push(`${file}: ${match[0]}`);
      }
    }
    expect(others).toEqual([]);
  });

  it('is what scripts/repo-url.sh reports, with the files that hold it', () => {
    const lines = execFileSync('bash', [path.join(ROOT, 'scripts/repo-url.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(lines[0]).toBe(homepage);
    expect(lines.slice(1).map((line) => line.trim())).toContain('web/package.json');
    expect(lines.length).toBeGreaterThan(15);
  });
});

describe('Playwright configuration', () => {
  // Port 4022 for every run and reuseExistingServer: two checkouts running the suite at once
  // shared one server.
  it('gives each run its own server', () => {
    const config = read('web/playwright.config.ts');
    expect(config).toContain('reuseExistingServer: false');
    expect(config).not.toMatch(/\b40\d\d\b/);
    expect(read('web/src/test/playwright/test-config.ts')).not.toMatch(/port:\s*\d/);
    expect(read('web/scripts/test-server.js')).not.toMatch(/port\s*=\s*\d/);
  });
});

describe('web/scripts/build-npm.js', () => {
  const script = read('web/scripts/build-npm.js');

  // `npx prebuild` downloaded and ran whatever the registry served when it was not installed.
  it('never fetches a tool with npx', () => {
    expect(script).not.toMatch(/\bnpx\s+(?!is\b)\w/);
    expect(script).toContain('resolvePrebuild(');
  });

  // The Linux container installed with --no-frozen-lockfile and an unpinned pnpm.
  it('installs what the lockfile says, with the pinned pnpm', () => {
    expect(script).not.toContain('--no-frozen-lockfile');
    expect(script).toMatch(/pnpm install --force --frozen-lockfile/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the script's own text
    expect(script).toContain('npm install -g pnpm@${PNPM_VERSION}');
  });

  // node_modules/.pnpm/authenticate-pam@1.0.5/… does not exist in an install with the patch
  // (pnpm adds a hash to the folder), so its prebuilds were never built nor copied.
  it('finds authenticate-pam where it is installed', () => {
    expect(script).not.toMatch(/authenticate-pam@\d/);
    expect(script).not.toMatch(/authenticate-pam-v\d/);
    expect(script).toContain("packageDir('authenticate-pam')");
  });
});

describe('.mcp.json', () => {
  // `npx -y @playwright/mcp@latest` ran whatever was published last on every start.
  it('pins every server it starts with npx to a version', () => {
    const { mcpServers } = JSON.parse(read('.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    for (const [name, server] of Object.entries(mcpServers)) {
      if (server.command !== 'npx') continue;
      const pkg = server.args.find((arg) => !arg.startsWith('-'));
      expect(pkg, name).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });
});

describe('documentation', () => {
  // docs/verification and docs/ui-clay-* held 97 MB of screenshots that ui-shots.mjs makes again.
  it('keeps no generated captures in the repository', () => {
    // The public copy (scripts/public-export.sh) leaves docs/verification out: none is fine too.
    const files = tracked('docs/verification', 'docs/ui-clay-*');
    expect(files.filter((file) => !file.endsWith('/README.md'))).toEqual([]);
  });

  it('stays small', () => {
    const bytes = tracked('docs', 'web/docs')
      .filter((file) => fs.existsSync(path.join(ROOT, file)))
      .reduce((sum, file) => sum + fs.statSync(path.join(ROOT, file)).size, 0);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  });

  // The external-device section started the development server on the network with the real
  // HOME, against the rule of never touching ~/.untether.
  it('tests external devices on the twin, not on a server with the real HOME', () => {
    const reference = read('docs/agent-reference.md');
    expect(reference).not.toMatch(/pnpm run dev[^\n]*--bind 0\.0\.0\.0/);
    expect(read('docs/TESTING_EXTERNAL_DEVICES.md')).not.toMatch(
      /pnpm run dev[^\n]*--bind 0\.0\.0\.0/
    );
    expect(reference).toContain('gemelo.sh');
    expect(packageJson.scripts['dev:mobile']).toBeUndefined();
  });
});
