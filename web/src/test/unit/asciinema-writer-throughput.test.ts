import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// A disk where fsync costs what it costs on macOS APFS (~10 ms, here 25 ms).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const fsync = vi.fn((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => {
    setTimeout(() => actual.fsync(fd, cb), 25);
  });
  return { ...actual, default: { ...actual, fsync }, fsync };
});

const fs = await import('fs');
const { AsciinemaWriter } = await import('../../server/pty/asciinema-writer');

describe('AsciinemaWriter throughput', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, RM_TEST_DIR);
  });

  it('keeps up with an output burst instead of paying an fsync per chunk', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asciinema-burst-'));
    const file = path.join(tempDir, 'burst.cast');
    const writer = AsciinemaWriter.create(file, 80, 24);

    // `yes | head` arrives as hundreds of small PTY chunks.
    const chunks = 200;
    const started = Date.now();
    for (let i = 0; i < chunks; i++) writer.writeOutput(Buffer.from(`line ${i}\r\n`));
    await writer.close();
    const elapsed = Date.now() - started;

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(chunks + 1);
    // 200 serial fsyncs would take ≥ 5 s.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reports backpressure so the PTY can pause instead of queueing without bound', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asciinema-burst-'));
    const writer = AsciinemaWriter.create(path.join(tempDir, 'yes.cast'), 80, 24);
    expect(writer.isBackedUp()).toBe(false);

    // `yes` delivers far faster than the queue writes: 8 MB arrives at once.
    const chunk = Buffer.from('y\r\n'.repeat(16 * 1024));
    for (let i = 0; i < 128; i++) writer.writeOutput(chunk);
    expect(writer.isBackedUp()).toBe(true);

    const drained = new Promise<void>((resolve) => writer.onceDrained(resolve));
    await drained;
    expect(writer.isBackedUp()).toBe(false);
    await writer.close();
  });
});
