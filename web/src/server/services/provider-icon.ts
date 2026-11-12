/**
 * The image a model provider uses as its mark (ModelProvider.icon = a file name): only bare file
 * names of ~/.untether/icons, never anything a symlink or a path can reach outside that folder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseProviderIcon } from '../../shared/model-providers.js';
import { PROJECT_ICON_TYPES } from './project-icon.js';

export const PROVIDER_ICON_MAX_BYTES = 2 * 1024 * 1024;

/** ~/.untether/icons, or that folder in the twin's control directory. */
export function providerIconsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether'), 'icons');
}

/** The image's file, or why it can't be served. */
export function resolveProviderIcon(
  name: string,
  dir = providerIconsDir()
): { file: string; type: string } | { error: string } {
  const icon = parseProviderIcon(name);
  if (icon?.kind !== 'file') return { error: 'not an icon file name' };
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(dir);
    file = fs.realpathSync(path.join(root, icon.file));
  } catch {
    return { error: `icon not found: ${icon.file}` };
  }
  if (!file.startsWith(`${root}${path.sep}`)) return { error: 'icon is outside the icons folder' };
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { error: `icon is not a file: ${icon.file}` };
  if (stat.size > PROVIDER_ICON_MAX_BYTES) {
    return { error: `icon is larger than ${PROVIDER_ICON_MAX_BYTES / 1024} KB` };
  }
  return { file, type: PROJECT_ICON_TYPES[path.extname(icon.file).toLowerCase()] };
}
