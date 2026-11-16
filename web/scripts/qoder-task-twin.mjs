// Run with scripts/gemelo.sh run --rich -- node web/scripts/qoder-task-twin.mjs.
// A real spawned qodercli double, the spawn rewriter's hooks and the server's scheduler.
// Two regressions in one run:
//   1. A project MCP server (playwright's `npx -y @playwright/mcp`) must not stop the task at its
//      approval dialog: the double blocks there unless Untether locked MCP out of the session.
//   2. An intermediate Stop is not the task's end: the double stops, then works again 22 s later;
//      the task must stay working — no check, review, merge or session close.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.GEMELO_HOME;
const url = process.env.GEMELO_URL;
assert(home && /^\/(?:private\/)?tmp\/utt-gemelo[^/]*$/.test(home));
assert(url && /^http:\/\/127\.0\.0\.1:\d+$/.test(url));
const repo = path.join(home, 'qoder-contract');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Twin');
git('config', 'user.email', 'twin@example.invalid');
fs.writeFileSync(path.join(repo, 'file.txt'), 'before\n');
// A project MCP server that downloads code: the double reads it, never runs it. Committed so the
// task's worktree carries it, exactly like the project that stopped the real Qoder task.
fs.writeFileSync(
  path.join(repo, '.mcp.json'),
  JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.85'] } } })
);
git('add', '.');
git('commit', '-qm', 'Initial');
const base = git('rev-parse', 'HEAD').toString();
const stage = path.join(home, 'qoder-stage');
const argvFile = path.join(home, 'qoder-argv.json');
const double = path.join(home, 'fake-bin/qodercli');
fs.writeFileSync(double, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
// --strict-mcp-config keeps the project's .mcp.json out: no server to approve, no dialog.
const strict = argv.includes('--strict-mcp-config');
let projectServers = {};
try { projectServers = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mcp.json'), 'utf8')).mcpServers ?? {}; } catch {}
if (!strict && Object.keys(projectServers).length > 0) {
  // The approval dialog nobody answers: the session stops here, before any work.
  fs.writeFileSync(${JSON.stringify(stage)}, 'mcp-dialog');
  process.stdin.resume();
} else {
  const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
  const hook = (event, extra = {}) => {
    const command = settings.hooks[event][0].hooks[0].command;
    const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event, session_id: 'twin-qoder', ...extra }), env: process.env });
    if (r.status !== 0) throw new Error('hook failed');
  };
  hook('SessionStart');
  let submitted = false;
  process.stdin.on('data', (data) => {
    if (submitted || !/[\\r\\n]/.test(data.toString())) return;
    submitted = true;
    hook('UserPromptSubmit');
    fs.writeFileSync('file.txt', 'intermediate work\\n');
    execSync('git add file.txt && git commit -qm "Intermediate commit"');
    hook('Stop', { last_assistant_message: 'Intermediate turn; more work remains.' });
    fs.writeFileSync(${JSON.stringify(stage)}, 'stopped');
    setTimeout(() => {
      hook('UserPromptSubmit');
      hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'long', tool_input: { command: 'sleep 120' } });
      fs.writeFileSync(${JSON.stringify(stage)}, 'working');
      process.stdout.write('Still working after intermediate Stop\\n');
    }, 22000);
  });
  process.stdin.resume();
}
`, { mode: 0o755 });

const api = async (route, body) => {
  const response = await fetch(`${url}/api/${route}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
};
const created = await api('tasks', {
  name: 'Qoder MCP dialog + intermediate Stop regression', prompt: 'Exercise the twin contract.',
  workingDir: repo, command: [double], agent: 'qoder', isolation: 'worktree',
  mergePolicy: 'auto', model: 'default', shielded: true, notify: false,
});
const task = created.task ?? created.tasks?.[0];
assert(task?.id, JSON.stringify(created));
// The session was launched with MCP locked out: an empty --mcp-config under --strict-mcp-config.
const argvUntil = Date.now() + 15000;
while (!fs.existsSync(argvFile) && Date.now() < argvUntil) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(fs.existsSync(argvFile), 'The double never started');
const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
assert(argv.includes('--strict-mcp-config'), `No --strict-mcp-config: ${JSON.stringify(argv)}`);
const mcpConfig = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
assert.deepEqual(mcpConfig, { mcpServers: {} }, `MCP config not empty: ${JSON.stringify(mcpConfig)}`);
let sawStop = false;
let sawResume = false;
const until = Date.now() + 60000;
while (Date.now() < until) {
  const current = (await api(`tasks/${task.id}`)).task;
  assert(current, 'Task status missing');
  const value = fs.existsSync(stage) ? fs.readFileSync(stage, 'utf8') : '';
  assert(value !== 'mcp-dialog', 'The Qoder task stopped at the project MCP approval dialog');
  assert(!current.verify && !current.review && !current.mergedSha, JSON.stringify(current));
  assert(!['verifying', 'merging', 'merged', 'done', 'failed'].includes(current.state), JSON.stringify(current));
  sawStop ||= value === 'stopped';
  if (value === 'working') {
    assert.equal(current.state, 'working');
    sawResume = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(sawStop && sawResume, 'Double never completed the Stop → working sequence');
assert.equal(git('rev-parse', 'HEAD').toString(), base);
console.log('PASS: the qodercli double never stopped at the project MCP dialog (MCP locked empty), and stayed working through a 22-second intermediate Stop; no check, review, merge or session close.');