import type { ServerResponse } from 'http';
import type { Readable } from 'stream';

/**
 * A file streamed into a response ends that response when the read fails.
 *
 * 2026-11-10: `createReadStream(file).pipe(res)` with no 'error' listener on the stream. A
 * file that can be stat'ed but not read (`/etc/sudoers`, a `chmod 000`, one deleted between
 * the check and the read) emits 'error' with nobody listening: an uncaught exception, which
 * stops the whole server (cli.ts). Call this before `.pipe(res)`; stream-response.test.ts
 * fails on a `createReadStream(…)` piped into a response without it.
 */
export function endOnReadError(stream: Readable, res: ServerResponse): void {
  stream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = 500;
    res.removeHeader('Content-Disposition');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to read file' }));
  });
}
