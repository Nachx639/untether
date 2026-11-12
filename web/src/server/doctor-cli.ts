/**
 * `ut doctor`: what Untether's doctor found wrong with Untether itself (its last look, or one
 * made now with --run), and what the installed app's own update is doing, always, in one line
 * (2026-11-11: a build stood ready for hours and no command said what it waited on). Read
 * through the API socket.
 */
import type { TaskResponse } from './pty/socket-protocol.js';
import type { DoctorReport } from './services/untether-doctor.js';
import { SocketApiClient } from './socket-api-client.js';
import { exitAfterFlush } from './utils/exit-after-flush.js';
import { closeLogger } from './utils/logger.js';

export const DOCTOR_CLI_HELP = `Usage:
  ut doctor [--run] [--json]

What Untether's doctor found wrong with Untether itself the last time it looked (every few
minutes), and what the installed app's own update is doing: up to date, building, built and
waiting for what, or failed and why.
  --run    look now instead of telling the last look
  --json   the report as JSON`;

export interface DoctorCliDeps {
  task: (op: string, args: Record<string, unknown>) => Promise<TaskResponse>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export function formatDoctor(report: DoctorReport | null, appUpdate: string | null): string {
  const lines = [`App update: ${appUpdate ?? 'not available on this server'}`];
  if (!report) return [...lines, 'Doctor: no look yet (ut doctor --run makes one)'].join('\n');
  const marks = { warning: '!', critical: '!!', info: '-' } as Record<string, string>;
  lines.push(
    `Doctor (${report.at}): ${report.findings.length ? `${report.findings.length} finding(s)` : 'nothing found'}`
  );
  for (const finding of report.findings) {
    lines.push(
      `  ${marks[finding.severity] ?? '-'} [${finding.check}] ${finding.problem}${finding.healed ? ` (healed: ${finding.healed})` : ''}`
    );
  }
  for (const check of report.failedChecks) lines.push(`  !! check ${check} could not run`);
  return lines.join('\n');
}

export async function runDoctorCli(argv: string[], deps: DoctorCliDeps): Promise<number> {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    deps.out(DOCTOR_CLI_HELP);
    return 0;
  }
  const unexpected = argv.find((arg) => arg !== '--run' && arg !== '--json');
  if (unexpected) {
    deps.err(`ut doctor: unexpected ${unexpected}\n${DOCTOR_CLI_HELP}`);
    return 2;
  }
  const response = await deps.task('doctor', { run: argv.includes('--run') });
  if (!response.ok) {
    deps.err(`Error: ${response.message ?? response.code ?? 'no answer'}`);
    return 1;
  }
  const data = response.data as unknown as {
    report: DoctorReport | null;
    appUpdate: string | null;
  };
  deps.out(
    argv.includes('--json')
      ? JSON.stringify(data, null, 2)
      : formatDoctor(data.report, data.appUpdate)
  );
  return 0;
}

/** `untether doctor …` from the command line: runs it through the API socket and exits. */
export async function handleDoctorCommand(argv: string[] = process.argv.slice(3)): Promise<void> {
  let code = 1;
  try {
    const client = new SocketApiClient();
    code = await runDoctorCli(argv, {
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
