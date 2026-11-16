/** A review from Qoder: no tools, MCP servers, project settings or saved conversation. */
import { spawn } from 'node:child_process';
import { terminalSessionEnv } from '../utils/session-env.js';

export interface QoderOnceOptions {
  cwd: string;
  timeoutMs: number;
  model?: string;
  bin?: string;
}
export type QoderOnce = (prompt: string, options: QoderOnceOptions) => Promise<string | null>;

export const askQoderOnce: QoderOnce = (prompt, options) =>
  new Promise((resolve) => {
    const child = spawn(
      options.bin ?? 'qodercli',
      [
        '--print',
        '--output-format',
        'text',
        '--permission-mode',
        'dont_ask',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--no-session-persistence',
        '--model',
        options.model ?? 'auto',
        '--',
        prompt,
      ],
      {
        cwd: options.cwd,
        env: terminalSessionEnv(process.env, {}),
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    let output = '';
    let settled = false;
    const finish = (reply: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
    };
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(null);
    }, options.timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 1024 * 1024) {
        kill();
        finish(null);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && output.trim() ? output.trim() : null));
  });
