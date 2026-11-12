/**
 * Test configuration for Playwright tests
 */
import { execFileSync } from 'node:child_process';

const PORT_ENV = 'UNTETHER_PW_PORT';

/**
 * The port of this run's test server: a free one, picked once by the process that loads the
 * configuration and handed to the workers through the environment.
 * 2026-11-11: it was always 4022 and a local run reused whatever answered there, so two
 * checkouts running the suite at once (two tasks, each in its worktree) shared one server:
 * each saw the other's sessions and tested the other's build.
 */
function runPort(): number {
  const given = Number(process.env[PORT_ENV]);
  if (Number.isInteger(given) && given > 0) return given;
  const port = Number(
    execFileSync(
      process.execPath,
      [
        '-e',
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
      ],
      { encoding: 'utf8' }
    )
  );
  if (!Number.isInteger(port) || port <= 0) throw new Error('No free port for the test server');
  process.env[PORT_ENV] = String(port);
  return port;
}

const port = runPort();

export const testConfig = {
  port,
  baseURL: `http://localhost:${port}`,

  // Timeouts - tuned for stability (Playwright fixture applies these as defaults)
  defaultTimeout: 10_000,
  navigationTimeout: 15_000,
  actionTimeout: 5_000,

  // Session defaults
  defaultSessionName: 'Test Session',
  hideExitedSessions: true,
};
