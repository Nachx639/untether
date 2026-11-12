import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsciinemaWriter } from '../../server/pty/asciinema-writer';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('AsciinemaWriter integrity under load', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, RM_TEST_DIR);
    tempDir = undefined;
  });

  it('keeps its byte positions exact while output keeps arriving during validation', async () => {
    // 2026-10-04: the 1 MB position check ran outside the write queue. Writes went on while it
    // stat()ed, so it saw a "mismatch", and its "recovery" moved the tracked position by the
    // bytes in flight (16 times in a day on a live server): offsets such as lastClearOffset
    // drifted from the file.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asciinema-integrity-'));
    const file = path.join(tempDir, 'load.cast');
    // A busy machine: stat's answer comes back 20 ms after it was read, long enough for more
    // writes to land in between.
    const realStat = fs.promises.stat;
    const stat = vi
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async (...args: Parameters<typeof realStat>) => {
        const stats = await realStat(...args);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return stats;
      });
    const writer = AsciinemaWriter.create(file, 80, 24);
    try {
      // A PTY delivering 8 KB chunks as fast as the loop turns (~24 MB, 3 position checks).
      const chunk = Buffer.from('x'.repeat(8 * 1024));
      for (let i = 0; i < 3000; i++) {
        writer.writeOutput(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await writer.close();
      expect(stat).toHaveBeenCalled();
    } finally {
      stat.mockRestore();
    }

    expect(writer.getPosition().written).toBe(fs.statSync(file).size);
    expect((writer as unknown as { validationErrors: number }).validationErrors).toBe(0);
  });

  it('lets the PTY resume when the cast stream is destroyed while it waits to drain', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asciinema-integrity-'));
    const writer = AsciinemaWriter.create(path.join(tempDir, 'gone.cast'), 80, 24);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stream = (writer as unknown as { writeStream: fs.WriteStream }).writeStream;
    // A disk that stops taking writes (they never complete), then the stream is destroyed
    // without an 'error'.
    (stream as unknown as { _write: () => void })._write = () => {};
    const chunk = Buffer.from('y\r\n'.repeat(16 * 1024));
    for (let i = 0; i < 128; i++) writer.writeOutput(chunk);
    expect(writer.isBackedUp()).toBe(true);
    const resumed = new Promise<string>((resolve) => writer.onceDrained(() => resolve('resumed')));
    stream.destroy();

    const outcome = await Promise.race([
      resumed,
      new Promise<string>((resolve) => setTimeout(() => resolve('still paused'), 2000)),
    ]);
    expect(outcome).toBe('resumed');
  });
});
