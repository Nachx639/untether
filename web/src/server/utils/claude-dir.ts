/**
 * Where Claude Code keeps its data: sessions/<pid>.json for each running claude and
 * projects/<cwd slug>/<sessionId>.jsonl for each conversation. CLAUDE_CONFIG_DIR moves all of
 * it; without it, ~/.claude.
 */
import * as os from 'os';
import * as path from 'path';

export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}
