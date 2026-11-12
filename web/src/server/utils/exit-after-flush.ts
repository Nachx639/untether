/**
 * Exit once stdout and stderr have written everything (2026-10-23: `ut task list --all --json`
 * stopped at exactly 128 KiB into a pipe, a cut JSON, because console.log to a pipe is
 * asynchronous and process.exit dropped the rest; scripts read that as "no task busy").
 * Never resolves: nothing after it runs.
 */
export function exitAfterFlush(
  code: number,
  streams: NodeJS.WritableStream[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (value) => process.exit(value)
): Promise<never> {
  let pending = streams.length;
  const done = () => {
    pending--;
    if (pending === 0) exit(code);
  };
  if (!pending) exit(code);
  for (const stream of streams) {
    // A write's callback runs once it and everything written before it are flushed.
    stream.write('', () => done());
  }
  return new Promise<never>(() => {});
}
