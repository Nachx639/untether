import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeTestMarker } from '../server/services/stray-tmux';
import { ensureForwarder } from './helpers/fresh-forwarder';
import { RM_TEST_DIR } from './helpers/rm-test-dir.js';
import {
  reapRunTmuxServers,
  reapRunTmuxServersNow,
  startRunWatchdog,
  sweepDeadTestRuns,
} from './helpers/run-teardown';
import {
  describeSounds,
  MARKS_ENV,
  markAt,
  readMarks,
  watchSystemSounds,
} from './helpers/system-sound-guard.js';

/** Signals that end a run without its teardown (Ctrl-C, a check's timeout, a closed terminal). */
const ENDING_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export default async function globalSetup(): Promise<() => Promise<void>> {
  // One temporary directory per run for the fake tailscale and the workers' HOMEs (setup.ts),
  // removed when the run ends. 2026-10-04: one directory per run and per worker, never
  // removed, had piled up by the thousand in $TMPDIR.
  // 2026-10-18: under macOS's long $TMPDIR (/var/folders/…) a session's socket in the test
  // HOME came to 149 characters, past the 104 a Unix socket path may have, and the session
  // tests failed with "Socket path too long". /tmp keeps it short.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const runDir = mkdtempSync(join(base, 'ut-test-'));
  process.env.UNTETHER_TEST_RUN_DIR = runDir;
  // 2026-11-01: four shield tmux servers of tests or QA had run 18-20 days. The run dir's marker
  // (its vitest's pid and the time) is what lets a later run and the doctor remove it, and only
  // it: nothing unmarked is ever removed or closed (stray-tmux.ts);
  // workers hand UNTETHER_TEST_RUN_DIR to every tmux server they start, wherever its socket is,
  // and the teardown finds them by it.
  writeTestMarker(runDir, runDir);
  // 2026-11-10: a run killed with -9 cleaned up nothing, and one ended by a signal only what
  // was there at the signal. A process outside this one closes what the run leaves once this
  // vitest is gone, however it went.
  startRunWatchdog(runDir);
  const forwarder = ensureForwarder(
    join(__dirname, '..', '..', '..', 'native', 'ut-fwd'),
    join(__dirname, '..', '..')
  );
  if (forwarder) console.warn(`global setup: ${forwarder}`);
  // Runs killed before their teardown (SIGKILL, a crash): their servers and dirs go now.
  const swept = sweepDeadTestRuns(base, runDir);
  if (swept.length > 0) {
    console.warn(`global setup: cleaned ${swept.length} test run dir(s) left by dead runs`);
  }
  // 2026-10-24: tests made their temporary dirs in the real $TMPDIR and some never removed
  // them ($TMPDIR/ut held over 700 control dirs, 124 with a live shield tmux server). Workers
  // inherit this: every os.tmpdir() of the run is inside runDir, removed (and its tmux servers
  // killed) when the run ends.
  process.env.TMPDIR = runDir;

  // 2026-10-02: a unit test left the Serve service marked running and its afterEach stop() ran
  // a real `tailscale serve reset`, wiping the developer's Tailscale Serve routes on every server
  // test run. Workers inherit this env, so every test talks to a fake binary unless live
  // Tailscale tests are requested.
  if (!process.env.ENABLE_TAILSCALE_TESTS) {
    const fake = join(runDir, 'tailscale');
    writeFileSync(fake, '#!/bin/sh\necho "$@" >> "$0.calls"\nexit 0\n', { mode: 0o755 });
    process.env.UNTETHER_TAILSCALE_BIN = fake;
  }

  // 2026-10-04: a test's `tmux kill-server` without -S/-L goes to the server in $TMUX. Run from
  // inside a shielded Untether session, it killed that server and every shielded session with
  // it (03:30:44: the developer's three Claudes restarted). Workers inherit this env: no test
  // ever sees the developer's tmux.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  // 2026-10-18: run from inside an Untether session (a developer's Claude, a task's check), the
  // `ut` tests saw its UNTETHER_SESSION_ID and acted as that session; they failed unless run
  // with `env -u UNTETHER_SESSION_ID`. A test that needs one sets its own.
  delete process.env.UNTETHER_SESSION_ID;
  // 2026-10-20: inherited UNTETHER_SHIELD_LAUNCHD=1 made the shield tests start their tmux
  // servers as launchd jobs that stayed loaded after the run. The launchd test opts in itself.
  delete process.env.UNTETHER_SHIELD_LAUNCHD;

  // Tests never make the Mac play a sound (2026-11-03: WebKit's beep on Cmd+C with nothing
  // selected woke the user at night, every task check). Every process this run starts is
  // watched; workers write which test they run (setup.ts) and a sound fails the run naming it.
  const marksFile = join(runDir, 'sound-marks.tsv');
  process.env[MARKS_ENV] = marksFile;
  const sounds = await watchSystemSounds();

  // 2026-10-03: no port sweep here. It SIGKILLed every listener on TCP 3000-3005 to clear test
  // servers left by a crashed run, but tests only listen on port 0 now, so it only ever hit other
  // apps: a local messaging bridge on 3000 died with every test run (1,760 times on 2-3 Oct).
  // Tests stop only the processes they started; a port clash fails the test that hit it.

  // A run that ends on a signal or process.exit never reaches the teardown below: clean up
  // synchronously then. The signal is raised again so the run still ends the way it was asked.
  let cleaned = false;
  const cleanNow = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      reapRunTmuxServersNow(runDir);
    } catch {
      // Best effort: the next run's sweep and the doctor catch what is left.
    }
    rmSync(runDir, RM_TEST_DIR);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    cleanNow();
    for (const each of ENDING_SIGNALS) process.removeListener(each, onSignal);
    process.kill(process.pid, signal);
  };
  for (const each of ENDING_SIGNALS) process.once(each, onSignal);
  process.once('exit', cleanNow);

  return async () => {
    const beeps = await sounds.stop();
    if (beeps.length > 0) {
      const marks = readMarks(marksFile);
      console.error(
        `\nFAIL: tests made the Mac play the system alert sound; tests never may (in WebKit: an editing command with nothing to act on, such as Cmd+C with nothing selected or a shortcut with no editable element focused; see docs/agent-reference.md, "Tests never beep"):\n${describeSounds(
          beeps,
          (sound) => markAt(sound, marks) ?? 'no test known (between files)'
        )}\n`
      );
      process.exitCode = 1;
    }
    // Only this run's tmux servers: other runs at the same time keep theirs.
    const reaped = await reapRunTmuxServers(runDir);
    if (reaped.length > 0) {
      console.warn(`global teardown: killed ${reaped.length} tmux server(s) left by tests`);
    }
    rmSync(runDir, RM_TEST_DIR);
    cleaned = true;
  };
}
