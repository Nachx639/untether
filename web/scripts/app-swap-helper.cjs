// Replaces an installed Mac app by a newer build of it, and puts the old one back when the
// server does not answer afterwards (the server's installed-app-updater.ts starts it).
//
// 2026-11-11: the installed app stayed on its build of 2026-11-02 for nine days while the
// development server it runs moved with every merge (a `ut` that took new options for text, a
// config.json about to be reset). The swap closes the app, and the app takes its server down
// with it: whoever swaps cannot be a child that dies with them. This is a process of its own
// (started detached, in a session of its own, like the twin's keeper), it outlives both, and
// it leaves what happened in a file the next server reads to tell the phone.
//
// It knows nothing of Untether or /Applications: every path and command comes in its plan, so
// the tests run it against a folder that plays /Applications with doubles for the app,
// codesign, quit and open.
//
// Usage: node scripts/app-swap-helper.cjs <plan.json>
// Exit: 0 updated · 1 nothing changed (refused) · 2 old app put back · 3 neither answers
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const {
  appPath,
  newAppPath,
  backupPath,
  resultPath,
  logPath,
  commit,
  previousCommit,
  serverGroup,
  quit,
  open,
  healthUrl,
  codesign = '/usr/bin/codesign',
} = plan;
const timeouts = {
  quitMs: 30_000,
  orphanMs: 10_000,
  healthMs: 180_000,
  pollMs: 5_000,
  ...plan.timeouts,
};

const appsDir = path.dirname(appPath);
const name = path.basename(appPath);
const staged = path.join(appsDir, `.${name}.staged`);
const old = path.join(appsDir, `.${name}.old`);
const failedAside = path.join(appsDir, `.${name}.failed`);

function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // The log is a courtesy: the swap goes on without it.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(code, outcome, reason, detail) {
  const result = {
    outcome,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
    commit,
    ...(previousCommit ? { previousCommit } : {}),
    at: new Date().toISOString(),
  };
  log(`${outcome}${reason ? ` (${reason})` : ''}${detail ? `: ${result.detail}` : ''}`);
  const temp = `${resultPath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(result)}\n`);
  fs.renameSync(temp, resultPath);
  process.exit(code);
}

/** A copy that keeps what a signed bundle needs (symlinks, extended attributes). */
function copyBundle(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync('/usr/bin/ditto')) execFileSync('/usr/bin/ditto', [from, to]);
  else execFileSync('cp', ['-a', from, to]);
}

function run(argv) {
  const out = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
  return {
    ok: out.status === 0,
    text: `${out.stdout || ''}${out.stderr || ''}${out.error ? out.error.message : ''}`.trim(),
  };
}

const signatureOf = (bundle) => run([codesign, '--verify', '--deep', '--strict', bundle]);

/** Who signed it, as macOS's privacy permissions see it (the designated requirement). */
function signerOf(bundle) {
  const { text } = run([codesign, '-d', '-r-', bundle]);
  const line = text.split('\n').find((candidate) => candidate.startsWith('designated =>'));
  return line ? line.slice('designated =>'.length).trim() : undefined;
}

/** macOS said no to a file operation: a permission of the system, not a bug. */
const denied = (error) => ['EPERM', 'EACCES'].includes(error && error.code);

/** The processes running from the bundle (its Contents/MacOS). */
function appPids() {
  const marker = `${appPath}/Contents/MacOS/`;
  let table = '';
  try {
    table = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of table.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match && match[2].includes(marker) && Number(match[1]) !== process.pid) {
      pids.push(Number(match[1]));
    }
  }
  return pids;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function signal(pid, name_) {
  try {
    process.kill(pid, name_);
  } catch {
    // Already gone.
  }
}

async function waitUntil(condition, ms, every = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(every, Math.max(1, deadline - Date.now())));
  }
}

/** Asks the app to quit, then insists; true once nothing runs from the bundle. */
async function closeApp() {
  if (!appPids().length) return true;
  const asked = run(quit);
  if (!asked.ok) log(`asking the app to quit failed: ${asked.text}`);
  if (await waitUntil(() => !appPids().length, timeouts.quitMs)) return true;
  log('the app is still running: SIGTERM');
  for (const pid of appPids()) signal(pid, 'SIGTERM');
  return waitUntil(() => !appPids().length, Math.min(10_000, timeouts.quitMs));
}

const groupAlive = (pgid) => alive(-pgid);

/**
 * The server the old app ran (its process group), when the app went without stopping it
 * (killed, not quit): the next app could not take its port. TERM, then KILL.
 */
async function endOrphanServer() {
  if (!serverGroup || serverGroup <= 1 || !groupAlive(serverGroup)) return;
  // The app stops its server on the way out; give that a moment before taking over.
  if (await waitUntil(() => !groupAlive(serverGroup), timeouts.orphanMs)) return;
  log(`the old server (process group ${serverGroup}) outlived its app: ending it`);
  signal(-serverGroup, 'SIGTERM');
  if (await waitUntil(() => !groupAlive(serverGroup), 8_000)) return;
  signal(-serverGroup, 'SIGKILL');
}

function healthy() {
  return new Promise((resolve) => {
    const request = http.get(healthUrl, { timeout: 5_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function answers() {
  const deadline = Date.now() + timeouts.healthMs;
  for (;;) {
    if (await healthy()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(timeouts.pollMs);
  }
}

function openApp() {
  const opened = run(open);
  if (!opened.ok) log(`opening the app failed: ${opened.text}`);
  return opened;
}

async function main() {
  log(`start: ${newAppPath} → ${appPath} (${previousCommit || '?'} → ${commit})`);
  if (!fs.existsSync(path.join(newAppPath, 'Contents'))) {
    finish(1, 'refused', 'no-build', `${newAppPath} is not an app bundle`);
  }
  if (!fs.existsSync(path.join(appPath, 'Contents'))) {
    finish(1, 'refused', 'no-app', `${appPath} is not an app bundle`);
  }

  // The signature first: nothing is touched for a build macOS would not run.
  const signature = signatureOf(newAppPath);
  if (!signature.ok) finish(1, 'refused', 'signature', signature.text);
  // Signed by someone else (another certificate, ad hoc): macOS would take it for another
  // app and ask every permission again (Accessibility, Full Disk Access, Automation).
  const installedSigner = signerOf(appPath);
  const newSigner = signerOf(newAppPath);
  if (installedSigner && installedSigner !== newSigner) {
    finish(1, 'refused', 'signer', `installed: ${installedSigner} · new: ${newSigner || 'none'}`);
  }

  try {
    copyBundle(appPath, backupPath);
  } catch (error) {
    finish(1, 'refused', denied(error) ? 'permission' : 'backup', error.message);
  }
  // Next to the app, so putting it in place is one rename; checked again where it landed.
  try {
    copyBundle(newAppPath, staged);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    finish(1, 'refused', denied(error) ? 'permission' : 'copy', error.message);
  }
  const stagedSignature = signatureOf(staged);
  if (!stagedSignature.ok) {
    fs.rmSync(staged, { recursive: true, force: true });
    finish(1, 'refused', 'signature', `after copying: ${stagedSignature.text}`);
  }

  if (!(await closeApp())) {
    fs.rmSync(staged, { recursive: true, force: true });
    finish(1, 'refused', 'app-did-not-quit');
  }
  await endOrphanServer();

  fs.rmSync(old, { recursive: true, force: true });
  try {
    fs.renameSync(appPath, old);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    openApp();
    finish(1, 'refused', denied(error) ? 'permission' : 'replace', error.message);
  }
  try {
    fs.renameSync(staged, appPath);
  } catch (error) {
    fs.renameSync(old, appPath);
    fs.rmSync(staged, { recursive: true, force: true });
    openApp();
    finish(1, 'refused', denied(error) ? 'permission' : 'replace', error.message);
  }

  openApp();
  if (await answers()) {
    fs.rmSync(old, { recursive: true, force: true });
    finish(0, 'updated');
  }

  log('the server does not answer with the new app: putting the old one back');
  await closeApp();
  fs.rmSync(failedAside, { recursive: true, force: true });
  try {
    fs.renameSync(appPath, failedAside);
    if (fs.existsSync(old)) fs.renameSync(old, appPath);
    else copyBundle(backupPath, appPath);
  } catch (error) {
    // The bundle moved aside could not be replaced: the copy kept before the swap is the way.
    try {
      copyBundle(backupPath, appPath);
    } catch (again) {
      finish(3, 'broken', 'restore', `${error.message} · ${again.message}`);
    }
  }
  fs.rmSync(failedAside, { recursive: true, force: true });
  openApp();
  if (await answers()) finish(2, 'rolled-back', 'no-answer');
  finish(3, 'broken', 'no-answer');
}

main().catch((error) => finish(3, 'broken', 'helper', error && error.stack ? error.stack : error));
