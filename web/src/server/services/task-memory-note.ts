/**
 * A merged task's memory note (TaskResult.memoryNote) saved in its project's agent memory
 * (2026-11-03): task agents kept writing incident notes into the user's Claude memory folder
 * (~/.claude/projects/<project>/memory), the task guard blocked it (rightly: it is outside the
 * worktree) and every task asked its orchestrator to save it by hand. The agent now puts the
 * note in its result and Untether writes it once the task merges, in the folder the project's
 * memoryDir setting names (opt-in), as <name>.md with frontmatter, plus a one-line pointer in
 * MEMORY.md there. Off, or the folder is missing: the note goes to the orchestrator in the
 * merged event (orchestrator.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MEMORY_DIR_AUTO } from '../../shared/projects.js';
import { TASK_MEMORY_NAME, type TaskMemoryNote } from '../../shared/task-result.js';

/** The index of a memory folder: one line per note. */
export const MEMORY_INDEX = 'MEMORY.md';

/**
 * Claude Code's memory folder of a project: ~/.claude/projects/<the path with every character
 * that is not a letter or digit as "-">/memory.
 */
export function claudeMemoryDir(repoPath: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', repoPath.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

/**
 * The folder the project's notes go to, or why none: memoryDir unset (off), 'auto' and no
 * Claude Code memory folder for the project, or a folder that is not one.
 */
export function resolveMemoryDir(
  setting: string | undefined,
  repoPath: string,
  home = os.homedir()
): { dir: string } | { off: string } {
  if (!setting?.trim()) return { off: 'memoryDir is off for this project' };
  const auto = setting.trim() === MEMORY_DIR_AUTO;
  const dir = auto ? claudeMemoryDir(repoPath, home) : path.resolve(setting.trim());
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = undefined;
  }
  if (!stat) {
    return {
      off: auto
        ? `memoryDir is auto and the project has no Claude Code memory folder (${dir})`
        : `the memoryDir folder does not exist (${dir})`,
    };
  }
  if (!stat.isDirectory()) return { off: `memoryDir is not a folder (${dir})` };
  return { dir };
}

/** A YAML scalar on one line: plain when it reads back as the same string, else quoted. */
function yamlScalar(text: string): string {
  const plain =
    !/[:#'"{}[\]&*!|>%@`,]/.test(text) && !/^[\s?-]/.test(text) && !/\s$/.test(text) && !!text;
  return plain ? text : JSON.stringify(text);
}

/** "flaky-check-under-load" → "Flaky check under load". */
function titleOf(name: string): string {
  const words = name.replace(/-+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The note's file: frontmatter (name, description, metadata.type project), then its body. */
export function memoryNoteFile(note: TaskMemoryNote): string {
  return [
    '---',
    `name: ${yamlScalar(note.name)}`,
    `description: ${yamlScalar(note.description)}`,
    'metadata:',
    '  type: project',
    '---',
    '',
    note.body.trim(),
    '',
  ].join('\n');
}

/** Writes `content` to `file` through a temporary file and a rename; never through a symlink. */
function writeAtomic(file: string, content: string): void {
  let link = false;
  try {
    link = fs.lstatSync(file).isSymbolicLink();
  } catch {
    // Not there yet.
  }
  if (link) throw new Error(`${file} is a symbolic link: not written`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Saves the note as <dir>/<name>.md (replacing a note of the same name) and points to it from
 * <dir>/MEMORY.md: its line is replaced when there is one, else appended. Throws when it can't.
 */
export function saveMemoryNote(
  dir: string,
  note: TaskMemoryNote
): { saved: string; updated: boolean } {
  // Validated with the result already; checked again since it becomes a file name.
  if (!TASK_MEMORY_NAME.test(note.name)) throw new Error(`invalid memory note name: ${note.name}`);
  const fileName = `${note.name}.md`;
  const file = path.join(dir, fileName);
  const updated = fs.existsSync(file);
  writeAtomic(file, memoryNoteFile(note));

  const index = path.join(dir, MEMORY_INDEX);
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(index, 'utf8').split('\n');
  } catch {
    // No index yet: it starts with this note.
  }
  if (lines[lines.length - 1] === '') lines.pop();
  const pointer = `- [${titleOf(note.name)}](${fileName}) — ${note.description}`;
  const target = `](${fileName})`;
  const at = lines.findIndex((line) => line.includes(target));
  if (at >= 0) {
    lines[at] = pointer;
    // One pointer per note: later duplicates go.
    lines = lines.filter((line, i) => i <= at || !line.includes(target));
  } else {
    lines.push(pointer);
  }
  writeAtomic(index, `${lines.join('\n')}\n`);
  return { saved: file, updated };
}
