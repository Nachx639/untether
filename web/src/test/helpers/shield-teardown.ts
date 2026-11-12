import { execFileSync } from 'child_process';
import { shieldLaunchdLabel, shieldSocketArgs } from '../../server/services/shielded-tmux.js';

type Runner = (file: string, args: string[]) => void;

const defaultRunner: Runner = (file, args) => {
  execFileSync(file, args, { stdio: 'ignore', timeout: 10_000 });
};

/**
 * Stops the shield tmux server a test started in its own throwaway control dir.
 *
 * 2026-10-20: teardown only ran `tmux kill-server`. When the server had been started as a
 * launchd job (UNTETHER_SHIELD_LAUNCHD=1 inherited into a test run), the job stayed loaded in
 * the user's GUI domain after every run, one per temp dir. The job is unloaded too, and only
 * the one whose label derives from this test's control dir: never any other job on the Mac.
 */
export function stopTestShieldServer(
  tmuxBin: string,
  controlPath: string,
  run: Runner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()
): void {
  try {
    run(tmuxBin, [...shieldSocketArgs(controlPath), 'kill-server']);
  } catch {
    // No server left.
  }
  if (platform !== 'darwin' || uid === undefined) return;
  try {
    run('launchctl', ['bootout', `gui/${uid}/${shieldLaunchdLabel(controlPath)}`]);
  } catch {
    // Not loaded (the usual case: tests don't use launchd).
  }
}
