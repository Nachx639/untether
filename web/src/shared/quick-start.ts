/**
 * The program a quick start runs: the first word of its command line, split the way the web
 * client's parseCommand splits it for POST /api/sessions (on spaces, quoted parts kept
 * together, quotes dropped). The server's quick-start availability answer is keyed by it.
 */
export function quickStartProgram(command: string): string {
  let word = '';
  let quote = '';
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ' ') {
      if (word) break;
    } else {
      word += char;
    }
  }
  return word;
}
