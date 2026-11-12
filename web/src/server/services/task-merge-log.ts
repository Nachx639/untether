/**
 * The merge pipeline's log of a run and the git calls written to it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { type RunResult, run } from '../utils/exec-file.js';
import { GIT_TIMEOUT_MS } from './task-merge-types.js';

/** A check's whole log (the tail may miss the failure list); null when it can't be read. */
export function readLog(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const output = (r: RunResult) => `${r.stdout}\n${r.stderr}`.trim();

export const lastLines = (text: string, count = 20) =>
  text.split('\n').filter(Boolean).slice(-count);

/** The reflog action of Untether's fast-forward of a checked-out base (scripts/server-watch.js). */
export const MERGE_REFLOG_ACTION = 'untether-merge';

export class MergeLog {
  constructor(private readonly file: string) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // A log that can't be written never stops the merge.
    }
  }

  write(text: string): void {
    try {
      fs.appendFileSync(this.file, text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // Same.
    }
  }

  async git(
    cwd: string,
    args: string[],
    timeout = GIT_TIMEOUT_MS,
    env: Record<string, string> = {}
  ): Promise<RunResult> {
    const r = await run('git', args, cwd, timeout, env);
    const out = output(r);
    this.write(`$ git ${args.join(' ')}  (in ${cwd}) → ${r.code}${out ? `\n${out}` : ''}`);
    return r;
  }

  async gitOut(cwd: string, args: string[]): Promise<string | null> {
    const r = await this.git(cwd, args);
    return r.code === 0 ? r.stdout.trim() : null;
  }
}

export async function isAncestor(log: MergeLog, cwd: string, older: string, newer: string) {
  return (await log.git(cwd, ['merge-base', '--is-ancestor', older, newer])).code === 0;
}
