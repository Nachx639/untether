/**
 * What the doctor's checks share.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

export const execFileAsync = promisify(execFile);

export const MINUTE = 60 * 1000;

export const HOUR = 60 * MINUTE;

export const shortId = (id: string) => id.slice(0, 8);

export const minutes = (ms: number) => Math.round(ms / MINUTE);

export function readTail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
