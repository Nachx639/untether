/**
 * `ut diag input`: what the devices with input diagnostics on have measured (keyboard, key
 * latency, scrolling, opening sessions, reconnections), summed up by agent, by network and by
 * interface style. Read through the API socket (services/input-diagnostics.ts).
 */
import type { TaskResponse } from './pty/socket-protocol.js';
import { type DiagSummary, formatDiagSummary, parseSince } from './services/input-diagnostics.js';
import { SocketApiClient } from './socket-api-client.js';
import { exitAfterFlush } from './utils/exit-after-flush.js';
import { closeLogger } from './utils/logger.js';

export const DIAG_CLI_HELP = `Usage:
  ut diag input [--since 24h] [--json]

What the devices with input diagnostics on have measured, summed up by agent (Claude, Codex,
shell), by network and by interface style: key latency (ms from a key leaving to the first frame
after its echo arrived), scroll frames in the terminal and in the list, the time to open a
session, WebSocket reconnections and the soft keyboard's measures. Never what was typed.
  --since T   how far back: 30m, 24h (default), 7d
  --json      the summary as JSON
Turn it on in the device: Settings → Advanced → Input diagnostics, or add ?kbdebug=1 to the
address (that one shows the keyboard's numbers on screen and ends with the next reload).
Every measure is also a line of the server log: ./scripts/utlog.sh -s "input-diag"`;

export interface DiagCliDeps {
  task: (op: string, args: Record<string, unknown>) => Promise<TaskResponse>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function runDiagCli(argv: string[], deps: DiagCliDeps): Promise<number> {
  if (!argv.length || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    deps.out(DIAG_CLI_HELP);
    return 0;
  }
  if (argv[0] !== 'input') {
    deps.err(`ut diag: unknown ${argv[0]}\n${DIAG_CLI_HELP}`);
    return 2;
  }
  let since = '24h';
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--since' && argv[i + 1]) since = argv[++i];
    else if (arg.startsWith('--since=')) since = arg.slice('--since='.length);
    else {
      deps.err(`ut diag input: unexpected ${arg}\n${DIAG_CLI_HELP}`);
      return 2;
    }
  }
  if (parseSince(since) === null) {
    deps.err(`ut diag input: --since takes 30m, 24h, 7d… (got ${since})`);
    return 2;
  }
  const response = await deps.task('diag-input', { since });
  if (!response.ok) {
    deps.err(`Error: ${response.message ?? response.code ?? 'no answer'}`);
    return 1;
  }
  const summary = response.data as unknown as DiagSummary;
  deps.out(json ? JSON.stringify(summary, null, 2) : formatDiagSummary(summary));
  return 0;
}

/** `untether diag …` from the command line: runs it through the API socket and exits. */
export async function handleDiagCommand(argv: string[] = process.argv.slice(3)): Promise<void> {
  let code = 1;
  try {
    const client = new SocketApiClient();
    code = await runDiagCli(argv, {
      task: (op, args) => client.task(op, args),
      out: (text) => console.log(text),
      err: (text) => console.error(text),
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  closeLogger();
  await exitAfterFlush(code);
}
