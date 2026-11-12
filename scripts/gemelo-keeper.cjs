// The rich twin's keeper (scripts/gemelo-rich-seed.mjs): owns its fake session processes and
// answers on the active preview's port.
//
// 2026-11-09: the fake sessions are /bin/sleep, and macOS's `ps -E` shows no environment for a
// platform binary, so gemelo.sh stop never saw them as the twin's: 281 sleeps were left behind by
// a morning of screenshots. This one is node, so stop finds it by HOME=<twin>. It ends them all
// when it is signalled, when the twin's HOME goes away (stop, the doctor) and when the run that
// marked that HOME has ended.
//
// Usage: node scripts/gemelo-keeper.cjs <twin HOME> <preview port> [<page title> <page heading>]
// (the page's two texts, for a twin in another language: UTT_GEMELO_LOCALE)
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const [home, port, title = 'Faro · reservas', heading = 'Vista previa ficticia'] = process.argv.slice(2);
const escapeHtml = (text) => text.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`);
const FAKE_COMMAND = '/bin/sleep 21600';
const pidsFile = path.join(home, '.gemelo/fake-pids');
const markerFile = path.join(home, '.untether-test-run');

function fakePids() {
  try {
    return fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The file's list goes with its HOME, so what it names is read once, here at start. */
const owned = fakePids();

function endAll() {
  for (const pid of owned) {
    try {
      // A pid that ended and was reused by something else is left alone.
      const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
      if (command === FAKE_COMMAND) process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, endAll);

setInterval(() => {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {
    endAll(); // its HOME, or the mark, is gone
    return;
  }
  if (!pidAlive(marker.pid)) endAll();
}, 1000);

http
  .createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${escapeHtml(title)}</title><h1>${escapeHtml(heading)}</h1>`);
  })
  // Losing the port (taken since the seed chose it) only shows the preview as paused: this
  // process must live on, it is what ends the fake sessions.
  .on('error', () => {})
  .listen(Number(port), '127.0.0.1');
