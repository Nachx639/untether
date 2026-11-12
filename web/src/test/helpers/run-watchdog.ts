/**
 * The watchdog of one test run, started by global-setup.ts (startRunWatchdog):
 * `run-watchdog.ts <run dir> <vitest pid>`. Ends by itself once the run is gone and cleaned up.
 */
import { watchRun } from './run-teardown.js';

const [runDir, parent] = process.argv.slice(2);
// It outlives the signals that end its run (a closed terminal, a kill of everything in sight).
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGPIPE'] as const) {
  process.on(signal, () => undefined);
}
if (!runDir || !/^\d+$/.test(parent ?? '')) process.exit(2);
void watchRun(runDir, Number(parent)).finally(() => process.exit(0));
