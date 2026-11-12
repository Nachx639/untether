import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  decide,
  type GuardContext,
  type GuardPolicy,
  ownProcess,
  type ProcessEntry,
  readCommands,
  shellCommandOf,
} from './task-guard.js';

const HOME = '/Users/alex';
const ROOT = '/Users/alex/Projects/.untether-worktrees/app/task-a';
const MAIN = '/Users/alex/Projects/app';

const policy: GuardPolicy = {
  taskId: 't1',
  root: ROOT,
  baseBranch: 'main',
  branch: 'ut/task-a',
  home: HOME,
};

/** The agent (pid 100) runs a shell (200) running the hook (300); 400 is its dev server. */
const table: ProcessEntry[] = [
  { pid: 1, ppid: 0, command: 'launchd' },
  { pid: 50, ppid: 1, command: 'tmux new-session' },
  { pid: 100, ppid: 50, command: '/Users/alex/.local/bin/claude --settings x' },
  { pid: 200, ppid: 100, command: '/bin/sh -c guard' },
  { pid: 300, ppid: 200, command: 'node task-guard-hook.ts' },
  { pid: 400, ppid: 100, command: 'node vite' },
  { pid: 410, ppid: 400, command: 'esbuild --service' },
  { pid: 900, ppid: 1, command: 'node /Users/alex/Projects/app/web/dev-server' },
];

const context: GuardContext = {
  processes: () => table,
  selfPid: 300,
  exists: (file) => file === `${ROOT}/src/app.ts`,
  tmpdir: '/var/folders/xy/T',
};

function bash(command: string, extra: Partial<GuardPolicy> = {}, cwd = ROOT) {
  return decide(
    { tool_name: 'Bash', tool_input: { command }, cwd },
    { ...policy, ...extra },
    context
  );
}

/** A rule and its pairs: [blocked, similar allowed]. */
function pairs(rule: string, cases: Array<[string, string]>) {
  describe(rule, () => {
    for (const [blocked, allowed] of cases) {
      it(`blocks: ${blocked}`, () => {
        expect(bash(blocked)?.rule).toBe(rule);
      });
      it(`allows: ${allowed}`, () => {
        expect(bash(allowed)).toBeNull();
      });
    }
  });
}

pairs('delete-outside', [
  ['rm -rf ~/Documents', 'rm -rf build'],
  ['rm -rf ../task-b', 'rm -rf ./dist'],
  ['rm -rf /', 'rm -rf node_modules/.cache'],
  [`rm -rf ${MAIN}/src`, `rm -rf ${ROOT}/src/generated`],
  ['cd .. && rm -rf task-b', 'cd src && rm -rf old'],
  ['rm -rf .', 'rm -rf ./*.log'],
  ['rm -rf .git', 'rm -f .gitignore.bak'],
  ['rm -rf ../*', 'rm -rf *'],
  ['find ~ -name "*.log" -delete', 'find . -name "*.log" -delete'],
  ['find /Users/alex/Projects -exec rm {} \\;', 'find . -name x -exec rm {} \\;'],
  ['rm -rf ~/old', 'rm -rf /tmp/untether-test'],
  ['mv ~/notes.txt ./notes.txt', 'mv ./a.txt ./b.txt'],
  ['rmdir ../empty', 'rmdir ./empty'],
  ['unlink ~/.zshrc', 'unlink ./link'],
  ['bash -c "rm -rf ~/x"', 'bash -c "rm -rf ./x"'],
  ['echo $(rm -rf ~/x)', 'echo $(rm -rf ./x)'],
  ['xargs -0 rm -rf ~/x', 'xargs -0 rm -rf ./x'],
  ['true && { rm -rf ~/y; }', 'true && { rm -rf ./y; }'],
  ['rm -rf ~/x/*', 'rm -rf "$TMPDIR/x"'],
  ['T=/Users/alex; rm -rf $T', 'T=$(mktemp -d); rm -rf "$T"'],
]);

pairs('git-push', [
  ['git push', 'git fetch origin'],
  ['git push --force origin ut/task-a', 'git log origin/main..HEAD'],
  ['git -C . push -f', 'git -C . status'],
  ['cd src && git push origin HEAD:main', 'cd src && git pull --no-rebase origin main'],
  ['gh repo sync', 'gh pr view 12'],
  ['gh release create v1.0.0 --repo owner/name Untether-1.0.0.pkg', 'gh release view v1.0.0'],
  ['gh release upload v1.0.0 Untether-1.0.0.pkg', 'gh release list --repo owner/name'],
  ['gh release delete v1.0.0 --yes', 'gh release download v1.0.0'],
  ['mac/scripts/release.sh stable --confirm v1.0.0', 'mac/scripts/release.sh --dry-run stable'],
  ['cd mac && ./scripts/release.sh beta 3', 'cd mac && ./scripts/release.sh --help'],
  ['bash mac/scripts/release.sh stable', 'bash mac/scripts/release-checklist.sh'],
  ['cd mac/scripts && ./release.sh rc 1 --confirm v1.0.0-rc.1', 'cd web/scripts && ./release.sh'],
]);

pairs('git-base', [
  ['git checkout main', 'git checkout -- src/app.ts'],
  ['git checkout -b other', 'git checkout src/app.ts'],
  ['git switch main', 'git status'],
  ['git switch -c feature', 'git branch --show-current'],
  ['git reset --hard main', 'git reset --hard HEAD~1'],
  ['git reset --hard origin/main', 'git reset --soft HEAD~1'],
  ['git branch -f main HEAD', 'git branch -f ut/task-a-tmp HEAD'],
  ['git branch -D main', 'git branch -D scratch'],
  ['git update-ref refs/heads/main HEAD', 'git update-ref refs/heads/scratch HEAD'],
  [`git -C ${MAIN} commit -am x`, `git -C ${MAIN} log --oneline -5`],
  [`cd ${MAIN} && git reset --hard`, `cd ${MAIN} && git status`],
  [`cd ${MAIN} && git merge ut/task-a`, 'git merge main'],
  ['git worktree remove ../task-b', 'git worktree list'],
  ['git symbolic-ref HEAD refs/heads/main', 'git symbolic-ref --short HEAD'],
]);

pairs('git-rebase-skip', [
  ['git rebase --skip', 'git rebase --continue'],
  ['GIT_EDITOR=true git rebase --skip', 'git rebase --abort'],
]);

pairs('private-paths', [
  ['echo "{}" > ~/.claude/settings.json', 'cat ~/.claude/settings.json'],
  ['rm -rf ~/.untether/logs', 'ls ~/.untether'],
  ['cp ./hook.sh ~/.untether/bin/hook.sh', 'cp ~/.untether/config.json ./config.copy.json'],
  ['sed -i "" s/a/b/ ~/.claude/CLAUDE.md', 'sed s/a/b/ ~/.claude/CLAUDE.md'],
  ['cat ~/.ssh/id_ed25519', 'cat ./docs/ssh.md'],
  ['cd ~/.ssh && cat id_rsa', 'cd docs && cat id_rsa.md'],
  ['cat ~/.aws/credentials', 'cat ./aws/credentials.example'],
  ['security find-generic-password -s github -w', 'security find-certificate -a -p'],
  ['security dump-keychain', 'security list-keychains'],
  ['gh auth token', 'gh auth status'],
  ['git credential fill', 'git config --get user.name'],
  ['tee -a ~/.codex/config.toml < x', 'tee -a ./notes.txt < x'],
  ['cat ~/.netrc', 'cat ./netrc.sample'],
  ['base64 < ~/Library/Keychains/login.keychain-db', 'base64 < ./logo.png'],
]);

pairs('kill-foreign', [
  ['kill 900', 'kill 400'],
  ['kill -9 900', 'kill -9 410'],
  ['kill -TERM 900', 'kill -TERM 400'],
  ['kill 900 400', 'kill $!'],
  ['kill -- -400', 'kill %1'],
  ['kill 100', 'kill -0 900'],
  ['pkill -f vite', 'pgrep -f vite'],
  ['killall node', 'ps aux'],
  ['launchctl kill TERM gui/501/com.untether', 'launchctl list'],
]);

pairs('sudo', [
  ['sudo rm -rf ./build', 'rm -rf ./build'],
  ['sudo -u root ls', 'ls'],
  ['doas reboot', 'uptime'],
  ['su - root', 'whoami'],
  [
    'osascript -e \'do shell script "x" with administrator privileges\'',
    'osascript -e \'display notification "done"\'',
  ],
]);

describe('project settings', () => {
  it('turns a rule off for the project', () => {
    expect(bash('git push', { off: ['git-push'] })).toBeNull();
    expect(bash('git push', { off: ['sudo'] })?.rule).toBe('git-push');
  });

  it('blocks what guardDeny names, and nothing similar', () => {
    const deny = ['\\bterraform\\s+apply\\b'];
    expect(bash('terraform apply -auto-approve', { deny })?.rule).toBe('project');
    expect(bash('terraform plan', { deny })).toBeNull();
  });

  it('lets through what guardAllow names, and nothing similar', () => {
    const allow = ['^git push origin ut/task-a$'];
    expect(bash('git push origin ut/task-a', { allow })).toBeNull();
    expect(bash('git push origin main', { allow })?.rule).toBe('git-push');
  });

  it('ignores a pattern that does not compile', () => {
    expect(bash('ls', { deny: ['(['] })).toBeNull();
  });
});

describe('file tools', () => {
  const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
    decide({ tool_name, tool_input, cwd: ROOT }, policy, context);

  it('blocks a write into ~/.claude or ~/.untether, allows one in the worktree', () => {
    expect(tool('Write', { file_path: `${HOME}/.claude/settings.json` })?.rule).toBe(
      'private-paths'
    );
    expect(tool('Edit', { file_path: `${HOME}/.untether/config.json` })?.rule).toBe(
      'private-paths'
    );
    expect(tool('Write', { file_path: `${ROOT}/src/settings.json` })).toBeNull();
  });

  it('lets Claude settings be read, never a credential', () => {
    expect(tool('Read', { file_path: `${HOME}/.claude/settings.json` })).toBeNull();
    expect(tool('Read', { file_path: `${HOME}/.ssh/id_rsa` })?.rule).toBe('private-paths');
    expect(tool('Grep', { pattern: 'x', path: `${HOME}/.aws` })?.rule).toBe('private-paths');
    expect(tool('Grep', { pattern: 'x', path: `${ROOT}/src` })).toBeNull();
  });

  it("reads Codex's apply_patch and shell argv", () => {
    const patch = `*** Begin Patch\n*** Add File: ${HOME}/.untether/x.json\n+{}\n*** End Patch`;
    expect(tool('apply_patch', { input: patch })?.rule).toBe('private-paths');
    expect(
      tool('apply_patch', { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' })
    ).toBeNull();
    expect(tool('shell', { command: ['bash', '-lc', 'git push'] })?.rule).toBe('git-push');
    expect(tool('shell', { command: ['git', 'status'] })).toBeNull();
  });

  it('turning private-paths off lets file tools through', () => {
    expect(
      decide(
        { tool_name: 'Write', tool_input: { file_path: `${HOME}/.claude/x` }, cwd: ROOT },
        { ...policy, off: ['private-paths'] },
        context
      )
    ).toBeNull();
  });
});

describe('reading shell', () => {
  it('follows cd, quotes, heredocs and comments', () => {
    const commands = readCommands(
      "cd src && cat <<'EOF' > out.txt\nrm -rf ~\nEOF\necho 'a; rm -rf ~' # rm -rf ~",
      ROOT,
      HOME
    );
    expect(commands.map((c) => c.words.map((w) => w.text))).toEqual([
      ['cd', 'src'],
      ['cat'],
      ['echo', 'a; rm -rf ~'],
    ]);
    expect(commands[1].cwd).toBe(`${ROOT}/src`);
    expect(commands[1].redirects[0].target.text).toBe('out.txt');
  });

  it('does not take a heredoc body or a quoted string for commands', () => {
    expect(bash("git commit -m 'never git push --force here'")).toBeNull();
    expect(bash('cat > notes.md <<EOF\nrm -rf ~ and git push\nEOF')).toBeNull();
  });

  it('reads the command of a Codex shell argv', () => {
    expect(
      shellCommandOf({ tool_name: 'shell', tool_input: { command: ['zsh', '-lc', 'ls -la'] } })
    ).toBe('ls -la');
  });

  it('a kill target is the agent’s only when it runs under the agent', () => {
    expect(ownProcess(410, context)).toBe(true);
    expect(ownProcess(900, context)).toBe(false);
    expect(ownProcess(100, context)).toBe(false); // the agent itself
    expect(ownProcess(410, { ...context, processes: () => [] })).toBe(false);
  });
});

describe('worktree-less task', () => {
  it('guards its folder the same way without base-branch rules', () => {
    const plain = { taskId: 't2', root: MAIN, home: HOME };
    const run = (command: string) =>
      decide({ tool_name: 'Bash', tool_input: { command }, cwd: MAIN }, plain, context);
    expect(run('rm -rf ../other')?.rule).toBe('delete-outside');
    expect(run('rm -rf ./build')).toBeNull();
    expect(run('git commit -am x')).toBeNull();
    expect(run('git push')?.rule).toBe('git-push');
  });
});

describe('a known variable written with a default is that variable (bakery 3dc243e4, 2026-11-10)', () => {
  it('"${TMPDIR:-/tmp}/rv" is a folder under the temporary one, not /rv', () => {
    // As its subagent wrote it: read as empty, the path became /rv and it was blocked.
    expect(bash('D="${TMPDIR:-/tmp}/rv"; mkdir -p "$D"; rm -rf "$D"/*')).toBeNull();
    expect(bash('rm -rf "${TMPDIR:-/tmp}/rv"')).toBeNull();
    expect(bash('rm -rf "${TMPDIR-/tmp}/rv/"*')).toBeNull();
  });

  it('a default never opens what the variable itself would not', () => {
    expect(bash('rm -rf "${HOME:-/tmp}/Documents"')?.rule).toBe('delete-outside');
    // One nobody knows here stays unknown (let run, marked uncertain), as before.
    expect(bash('rm -rf "${SOMEDIR:-/tmp/x}/y"')).toMatchObject({ uncertain: true });
  });
});

describe('in doubt it lets the call run, marked uncertain (a net against mistakes, not a sandbox)', () => {
  it('a path or pid known only at run time goes through as uncertain', () => {
    expect(bash('rm -rf "$SOMEDIR"')).toMatchObject({ rule: 'delete-outside', uncertain: true });
    expect(bash('rm -rf `echo ~`')).toMatchObject({ uncertain: true });
    expect(bash('kill $(lsof -ti :4020)')).toMatchObject({ rule: 'kill-foreign', uncertain: true });
  });

  it('a real block later in the same line still blocks', () => {
    expect(bash('rm -rf "$X" && git push')).toMatchObject({ rule: 'git-push' });
    expect(bash('rm -rf "$X" && git push')?.uncertain).toBeUndefined();
  });
});

describe('case 1: the folder a command runs in', () => {
  const exec = (cmd: string, workdir?: string) =>
    decide(
      {
        tool_name: 'exec_command',
        tool_input: { cmd, ...(workdir ? { workdir } : {}) },
        cwd: ROOT,
      },
      policy,
      context
    );

  it("uses exec_command's workdir: ./src there is the base checkout's", () => {
    expect(exec('rm -rf ./src', MAIN)?.rule).toBe('delete-outside');
    expect(exec('rm -rf ./src', `${ROOT}/pkg`)).toBeNull();
    expect(exec('rm -rf ./src')).toBeNull();
    expect(exec('rm -rf ./src', '../other-task')?.rule).toBe('delete-outside');
  });

  it("a subshell's cd does not carry over to the commands after it", () => {
    expect(bash('(cd /Users/alex && ls) && rm -rf ./build')).toBeNull();
    expect(bash('(cd src && ls) ; rm -rf ../x')?.rule).toBe('delete-outside');
    expect(bash('cd /Users/alex && rm -rf ./build')?.rule).toBe('delete-outside');
  });

  it('a nested command runs where it was written, not after later cds', () => {
    expect(bash('echo $(rm -rf ./build) && cd /Users/alex')).toBeNull();
    expect(bash('cd /Users/alex && echo $(rm -rf ./build)')?.rule).toBe('delete-outside');
  });
});

describe('case 2: paths judged by where they really lead (realpath)', () => {
  let tmp: string;
  let home: string;
  let root: string;
  let real: (file: string) => string;

  const setup = () => {
    // Outside the temporary folders (deleting there is allowed): next to the tests.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.guard-real-')));
    home = path.join(tmp, 'home');
    root = path.join(home, 'wt');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Documents', 'keep'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'k');
    fs.symlinkSync(path.join(home, 'Documents'), path.join(root, 'docs'));
    fs.symlinkSync(path.join(home, '.claude'), path.join(root, 'cl'));
    fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(root, 'key'));
    real = (file) => fs.realpathSync(file);
  };
  const run = (tool_name: string, tool_input: Record<string, unknown>) =>
    decide(
      { tool_name, tool_input, cwd: root },
      { taskId: 't', root, home, baseBranch: 'main' },
      { realpath: real, tmpdir: path.join(tmp, 'none') }
    );

  it('a symlink in the worktree does not take a delete out of it', () => {
    setup();
    try {
      expect(run('Bash', { command: 'rm -rf docs/keep' })?.rule).toBe('delete-outside');
      // rm of the link itself removes only the link.
      expect(run('Bash', { command: 'rm docs' })).toBeNull();
      expect(run('Bash', { command: 'rm -rf src/old' })).toBeNull();
    } finally {
      fs.rmSync(tmp, RM_TEST_DIR);
    }
  });

  it('nor leads a write to ~/.claude or a read to a credential', () => {
    setup();
    try {
      expect(run('Bash', { command: 'echo x > cl/settings.json' })?.rule).toBe('private-paths');
      expect(run('Write', { file_path: path.join(root, 'cl', 'CLAUDE.md') })?.rule).toBe(
        'private-paths'
      );
      expect(run('Bash', { command: 'cat key' })?.rule).toBe('private-paths');
      expect(run('Read', { file_path: path.join(root, 'key') })?.rule).toBe('private-paths');
      expect(run('Read', { file_path: path.join(root, 'src') })).toBeNull();
      expect(run('Bash', { command: 'cat src/a.ts' })).toBeNull();
    } finally {
      fs.rmSync(tmp, RM_TEST_DIR);
    }
  });
});

describe('case 3: apply_patch outside the task folder follows the rules of rm and Write', () => {
  const patch = (body: string) =>
    decide(
      {
        tool_name: 'apply_patch',
        tool_input: { input: `*** Begin Patch\n${body}\n*** End Patch` },
        cwd: ROOT,
      },
      policy,
      context
    );

  it('Delete File outside the worktree is a delete outside it', () => {
    expect(patch(`*** Delete File: ${MAIN}/src/app.ts`)?.rule).toBe('delete-outside');
    expect(patch('*** Delete File: ../task-b/x.ts')?.rule).toBe('delete-outside');
    expect(patch('*** Delete File: .git/config')?.rule).toBe('delete-outside');
    expect(patch('*** Delete File: src/old.ts')).toBeNull();
  });

  it("Add / Update File follow Write's rules", () => {
    expect(patch(`*** Add File: ${HOME}/.claude/x.md\n+x`)?.rule).toBe('private-paths');
    expect(patch(`*** Update File: ${HOME}/.ssh/config`)?.rule).toBe('private-paths');
    expect(patch('*** Update File: src/app.ts')).toBeNull();
    expect(patch('*** Add File: src/new.ts\n+x')).toBeNull();
  });
});

describe('review 2: writes into the main checkout (git-base)', () => {
  const withBase = { baseRoot: MAIN };
  const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
    decide({ tool_name, tool_input, cwd: ROOT }, { ...policy, ...withBase }, context);

  it('Write / Edit with an absolute path into the main checkout are blocked', () => {
    expect(tool('Write', { file_path: `${MAIN}/src/app.ts` })?.rule).toBe('git-base');
    expect(tool('Edit', { file_path: `${MAIN}/README.md` })?.rule).toBe('git-base');
    expect(tool('Edit', { file_path: `${ROOT}/src/app.ts` })).toBeNull();
    // Reading the main checkout is fine.
    expect(tool('Read', { file_path: `${MAIN}/src/app.ts` })).toBeNull();
  });

  it('apply_patch Add / Update into the main checkout are blocked', () => {
    const patch = (body: string) =>
      tool('apply_patch', { input: `*** Begin Patch\n${body}\n*** End Patch` });
    expect(patch(`*** Update File: ${MAIN}/src/app.ts`)?.rule).toBe('git-base');
    expect(patch(`*** Add File: ${MAIN}/src/new.ts\n+x`)?.rule).toBe('git-base');
    expect(patch('*** Update File: src/app.ts')).toBeNull();
  });

  it('shell writes into the main checkout are blocked, copies out of it are not', () => {
    const sh = (command: string) => bash(command, withBase);
    expect(sh(`echo x > ${MAIN}/src/app.ts`)?.rule).toBe('git-base');
    expect(sh(`cp src/app.ts ${MAIN}/src/app.ts`)?.rule).toBe('git-base');
    expect(sh(`cp ${MAIN}/src/app.ts src/app.ts`)).toBeNull();
    expect(sh(`cat ${MAIN}/src/app.ts > src/copy.ts`)).toBeNull();
  });

  it('without a main checkout (worktree-less task) nothing changes', () => {
    expect(bash(`echo x > ${MAIN}/src/app.ts`)).toBeNull();
  });

  it('a worktree inside the main checkout still writes its own files', () => {
    const nested = `${MAIN}/.worktrees/task-a`;
    expect(
      decide(
        { tool_name: 'Write', tool_input: { file_path: `${nested}/src/a.ts` }, cwd: nested },
        { ...policy, root: nested, baseRoot: MAIN },
        context
      )
    ).toBeNull();
  });

  it('guardOff git-base turns it off', () => {
    expect(bash(`echo x > ${MAIN}/a`, { ...withBase, off: ['git-base'] })).toBeNull();
  });
});

describe('review 2: `..` after a symlink is resolved on disk, not by the text', () => {
  it('Delete File: link/../notes is judged where it really leads', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.guard-real-')));
    try {
      const home = path.join(tmp, 'home');
      const root = path.join(home, 'wt');
      fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(home, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'notes'), 'n');
      fs.symlinkSync(path.join(home, 'docs'), path.join(root, 'link'));
      const run = (tool_name: string, tool_input: Record<string, unknown>) =>
        decide(
          { tool_name, tool_input, cwd: root },
          { taskId: 't', root, home },
          { realpath: (file) => fs.realpathSync(file), tmpdir: path.join(tmp, 'none') }
        );
      const patch = (body: string) =>
        run('apply_patch', { input: `*** Begin Patch\n${body}\n*** End Patch` });
      // link/.. is home (the link's parent on disk), not wt: link/../notes is ~/notes.
      expect(patch('*** Delete File: link/../notes')?.rule).toBe('delete-outside');
      expect(run('Bash', { command: 'rm -rf link/../notes' })?.rule).toBe('delete-outside');
      // Without a symlink in the way, .. stays inside the worktree.
      expect(patch('*** Delete File: notes/../notes/a')).toBeNull();
      expect(run('Bash', { command: 'rm -rf notes/../notes/a' })).toBeNull();
    } finally {
      fs.rmSync(tmp, RM_TEST_DIR);
    }
  });
});

describe('review 2: kill judges every pid, a doubt on one does not let the rest through', () => {
  it('kill "$PID" 900 blocks on 900', () => {
    expect(bash('kill "$PID" 900')).toMatchObject({ rule: 'kill-foreign' });
    expect(bash('kill "$PID" 900')?.uncertain).toBeUndefined();
    expect(bash('kill 900 "$PID"')?.rule).toBe('kill-foreign');
  });

  it('kill "$PID" 400 (its own dev server) stays uncertain, not blocked', () => {
    expect(bash('kill "$PID" 400')).toMatchObject({ rule: 'kill-foreign', uncertain: true });
    expect(bash('kill 400')).toBeNull();
  });
});

describe('2026-11-02 bakery: a task kills what it started, reparented or not', () => {
  // The task's `yes` (700, 701), reparented to launchd when their zsh ended; 702 a platform
  // binary (environment hidden) left in the worktree; 703 the same elsewhere; 704 another task's;
  // 705 one with no marker; 706 a hidden child of 707's group, 707 the task's group leader.
  const orphans: ProcessEntry[] = [
    ...table,
    { pid: 700, ppid: 1, pgid: 690, command: 'yes' },
    { pid: 701, ppid: 1, pgid: 690, command: 'yes' },
    { pid: 702, ppid: 1, pgid: 695, command: '/bin/sleep 600' },
    { pid: 703, ppid: 1, pgid: 696, command: '/bin/sleep 600' },
    { pid: 704, ppid: 1, pgid: 704, command: 'node other-task' },
    { pid: 705, ppid: 1, pgid: 705, command: 'node users-own' },
    { pid: 706, ppid: 1, pgid: 707, command: '/bin/sleep 600' },
    { pid: 707, ppid: 1, pgid: 707, command: 'node task-runner' },
  ];
  const marks = new Map<number, { marker: string | null | undefined }>([
    [100, { marker: 't1' }],
    [700, { marker: 't1' }],
    [701, { marker: 't1' }],
    [702, { marker: undefined }],
    [703, { marker: undefined }],
    [704, { marker: 't2' }],
    [705, { marker: null }],
    [706, { marker: undefined }],
    [707, { marker: 't1' }],
  ]);
  const asked: number[][] = [];
  const named = new Map<string, number[]>([
    ['yes', [700, 701]],
    ['-f sleep', [702, 703]],
    ['node', [300, 400, 704]],
  ]);
  const withMarks: GuardContext = {
    ...context,
    processes: () => orphans,
    marks: (pids) => {
      asked.push(pids);
      return new Map(pids.filter((pid) => marks.has(pid)).map((pid) => [pid, marks.get(pid)!]));
    },
    matches: (_tool, args) => named.get(args.join(' ')) ?? null,
  };
  const run = (command: string, extra: Partial<GuardPolicy> = {}) =>
    decide(
      { tool_name: 'Bash', tool_input: { command }, cwd: ROOT },
      { ...policy, ...extra },
      withMarks
    );

  it('a reparented child carrying the task marker can be killed', () => {
    expect(run('kill 700 701')).toBeNull();
    expect(run('kill -9 700')).toBeNull();
  });

  it('a pid not the task’s stays blocked: another task’s, none, the user’s dev server', () => {
    expect(run('kill 704')?.rule).toBe('kill-foreign');
    expect(run('kill 705')?.rule).toBe('kill-foreign');
    expect(run('kill 900')?.rule).toBe('kill-foreign');
    expect(run('kill 700 704')?.reason).toContain('704');
  });

  it('the agent and the hook’s ancestors stay blocked though they carry the marker', () => {
    expect(run('kill 100')?.rule).toBe('kill-foreign');
    expect(run('kill 50')?.rule).toBe('kill-foreign');
  });

  it('a hidden environment is never the task’s on a guess, wherever it works (AI review)', () => {
    // 702 works in the task's worktree, 703 elsewhere: neither carries a readable marker.
    expect(run('kill 702')?.rule).toBe('kill-foreign');
    expect(run('kill 703')?.rule).toBe('kill-foreign');
  });

  it('a hidden process in the group of a task process is the task’s', () => {
    expect(run('kill 706')).toBeNull();
  });

  it('a hidden environment in a shell group the task recorded is the task’s (bakery yes)', () => {
    // 720/721: yes of the dead shell 715, which recorded its group; 722 the same of 716, not
    // recorded; 723 of 717, recorded, but pid 717 now leads something started later (reused).
    const rows: ProcessEntry[] = [
      ...orphans,
      { pid: 720, ppid: 1, pgid: 715, start: 1_005_000, command: 'yes' },
      { pid: 721, ppid: 1, pgid: 715, start: 1_005_000, command: 'yes' },
      { pid: 722, ppid: 1, pgid: 716, start: 1_005_000, command: 'yes' },
      { pid: 723, ppid: 1, pgid: 717, start: 1_905_000, command: 'yes' },
      { pid: 717, ppid: 1, pgid: 717, start: 1_900_000, command: 'yes' },
    ];
    const hidden = new Map(
      rows.filter((e) => e.pid >= 715).map((e) => [e.pid, { marker: undefined }])
    );
    const groupContext: GuardContext = {
      ...withMarks,
      processes: () => rows,
      marks: (pids) =>
        new Map(pids.filter((pid) => hidden.has(pid)).map((pid) => [pid, hidden.get(pid)!])),
      shellGroups: () =>
        new Map([
          [715, 1_000_000],
          [717, 1_000_000],
        ]),
    };
    const judge = (command: string) =>
      decide({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT }, policy, groupContext);
    expect(judge('kill 720 721')).toBeNull();
    expect(judge('kill 722')?.rule).toBe('kill-foreign');
    expect(judge('kill 723')?.rule).toBe('kill-foreign');
  });

  it('what still has the agent’s terminal is the task’s', () => {
    const rows: ProcessEntry[] = [
      ...orphans.map((e) => (e.pid === 100 ? { ...e, tty: 'ttys007' } : e)),
      { pid: 730, ppid: 1, pgid: 730, tty: 'ttys007', command: 'yes' },
      { pid: 731, ppid: 1, pgid: 731, tty: 'ttys008', command: 'yes' },
    ];
    const ttyContext: GuardContext = { ...withMarks, processes: () => rows };
    const judge = (command: string) =>
      decide({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT }, policy, ttyContext);
    expect(judge('kill 730')).toBeNull();
    expect(judge('kill 731')?.rule).toBe('kill-foreign');
  });

  it('processes under the agent are judged without reading markers', () => {
    asked.length = 0;
    expect(run('kill 400 410')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('pkill / killall go through when every match is the task’s', () => {
    expect(run('pkill yes')).toBeNull();
    expect(run('pkill -9 yes')).toBeNull();
    expect(run('killall yes')).toBeNull();
  });

  it('pkill / killall that would reach anyone else stay blocked', () => {
    // 702 and 703 hide their environment: neither is proven the task's.
    expect(run('pkill -f sleep')?.reason).toContain('702');
    // 300 is the hook (gone when pkill runs); 704 is another task's.
    expect(run('pkill node')?.reason).toContain('704');
    // What it would match is unknown: blocked as before.
    expect(run('pkill -u root bash')?.rule).toBe('kill-foreign');
    // Words known only when it runs: blocked, never let through unjudged (AI review).
    expect(run('name=node; pkill "$name"')).toMatchObject({ rule: 'kill-foreign' });
    expect(run('name=node; pkill "$name"')?.uncertain).toBeUndefined();
    expect(run('killall $(echo node)')?.uncertain).toBeUndefined();
    expect(run('killall $(echo node)')?.rule).toBe('kill-foreign');
  });
});
