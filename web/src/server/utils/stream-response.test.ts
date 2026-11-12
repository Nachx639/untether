import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { endOnReadError } from './stream-response.js';

describe('endOnReadError', () => {
  it('a file that cannot be read is a 500, not an unhandled stream error', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      // A directory opens for stat and fails on read (EISDIR), like an unreadable file.
      const stream = fs.createReadStream(import.meta.dirname);
      endOnReadError(stream, res);
      stream.pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to read file' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('no server file pipes a read stream of a file into a response without it', () => {
    const serverDir = path.resolve(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          const pipesAFile = /createReadStream\(/.test(source) && /\.pipe\(res\)/.test(source);
          if (pipesAFile && !source.includes('endOnReadError(')) {
            offenders.push(path.relative(serverDir, full));
          }
        }
      }
    };
    walk(serverDir);
    expect(offenders).toEqual([]);
  });
});
