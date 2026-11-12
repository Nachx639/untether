import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** `ps -o pid=,tpgid=` output as pid → foreground process group of its terminal. */
export function parseForegroundPgids(stdout: string): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(-?\d+)\s*$/);
    if (!match) continue;
    const tpgid = Number(match[2]);
    // 0 / -1: no controlling terminal (or it is gone).
    if (tpgid > 0) result.set(Number(match[1]), tpgid);
  }
  return result;
}

/**
 * Foreground process group of the terminal of each pid, in one `ps` run for all of them.
 * Pids that are gone or have no terminal are missing from the result.
 */
export async function readForegroundPgids(pids: number[]): Promise<Map<number, number>> {
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (valid.length === 0) return new Map();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'pid=,tpgid=', '-p', valid.join(',')], {
      timeout: 2000,
    }));
  } catch (error) {
    // ps exits 1 when some of the pids are gone but still prints the others.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
  }
  return parseForegroundPgids(stdout);
}
