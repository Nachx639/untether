import * as os from 'os';

/**
 * Convert absolute paths to use ~ for the home directory
 * @param absolutePath The absolute path to prettify
 * @returns The prettified path with ~ for home directory
 */
export function prettifyPath(absolutePath: string): string {
  const homeDir = os.homedir();

  if (absolutePath.startsWith(homeDir)) {
    return `~${absolutePath.slice(homeDir.length)}`;
  }

  return absolutePath;
}
