/**
 * A project's quick actions (shared/quick-actions.ts): read from and saved to
 * `.untether/quick-actions.json` at the root of a session's repository or worktree (the
 * session's own folder outside git).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DEFAULT_QUICK_ACTIONS,
  parseQuickActions,
  QUICK_ACTIONS_FILE,
  QUICK_ACTIONS_VERSION,
  type QuickAction,
  type QuickActionsResponse,
} from '../../shared/quick-actions.js';
import { run } from '../utils/exec-file.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('quick-actions');

/** Files larger than this are not read (a quick-actions list is a few KB). */
const MAX_FILE_BYTES = 256 * 1024;

/** The worktree's root for a folder in git (`--show-toplevel`), else the folder itself. */
export async function quickActionsRoot(dir: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], dir, 5000);
  const top = result.code === 0 ? result.stdout.trim() : '';
  return top || dir;
}

export async function loadQuickActions(root: string): Promise<QuickActionsResponse> {
  const file = path.join(root, QUICK_ACTIONS_FILE);
  const defaults = (warnings: string[] = []): QuickActionsResponse => ({
    source: 'default',
    path: file,
    actions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })),
    warnings,
  });
  let content: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return defaults([`${QUICK_ACTIONS_FILE} is not a file`]);
    if (stat.size > MAX_FILE_BYTES) return defaults([`${QUICK_ACTIONS_FILE} is too large`]);
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    logger.warn(`could not read ${file}: ${(error as Error).message}`);
    return defaults([`could not read ${QUICK_ACTIONS_FILE}`]);
  }
  const { config, warnings } = parseQuickActions(content);
  for (const warning of warnings) logger.warn(`${file}: ${warning}, ignored`);
  if (!config) return defaults(warnings);
  return { source: 'file', path: file, actions: config.actions, warnings };
}

/** Writes the list (already validated) atomically, creating `.untether/` if needed. */
export async function saveQuickActions(
  root: string,
  actions: QuickAction[]
): Promise<QuickActionsResponse> {
  const file = path.join(root, QUICK_ACTIONS_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    tmp,
    `${JSON.stringify({ version: QUICK_ACTIONS_VERSION, actions }, null, 2)}\n`,
    'utf8'
  );
  await fs.rename(tmp, file);
  logger.log(`saved ${actions.length} quick actions to ${file}`);
  return { source: 'file', path: file, actions, warnings: [] };
}
