/** `ut project connector add | list | revoke`: tokens for external apps to reach a project's orchestrator. */

import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project connector add <name> [--repo DIR] [--json]
                 (a token for an external app, e.g. bakery-app: it may send requests to the
                  project's orchestrator, read its replies and its tasks, nothing else; shown
                  once. From an agent or a script it works only after the user's OK)
  ut project connector list [--repo DIR | --all] [--json]
  ut project connector revoke <id|name> [--repo DIR]`;

interface ConnectorChannelLine {
  id: string;
  name: string;
  repoPath: string;
  active: boolean;
  createdAt: string;
  lastUsedAt?: string;
  uses: number;
}

/** A new connector token: shown once, with where apps reach it. */
function formatConnectorToken(data: Record<string, unknown>): string {
  const channel = data.channel as ConnectorChannelLine;
  const url = typeof data.url === 'string' ? data.url : null;
  const lines = [
    `Connector channel ${channel.name} (${channel.id}) for ${channel.repoPath}${channel.active ? '' : ' — inactive until the user approves it'}`,
  ];
  if (typeof data.token === 'string') {
    lines.push(
      `Token (shown only now; Untether keeps only its hash): ${data.token}`,
      "Give it to the app as 'Authorization: Bearer <token>'."
    );
  }
  lines.push(
    url
      ? `API: ${url}/api/connector/info · MCP: ${url}/mcp (from a Docker container: ${url.replace(/127\.0\.0\.1|localhost/, 'host.docker.internal')})`
      : 'The connector listens once a token is active (127.0.0.1, port 4023 by default).'
  );
  return lines.join('\n');
}

function formatConnectorList(data: Record<string, unknown>): string {
  const channels = (data.channels ?? []) as ConnectorChannelLine[];
  if (!channels.length) return 'No connector channels';
  return channels
    .map(
      (channel) =>
        `${channel.id}  ${channel.name}  ${channel.active ? 'active' : 'waiting for the OK'}  ${channel.repoPath}  used ${channel.uses}×${channel.lastUsedAt ? `, last ${channel.lastUsedAt}` : ''}`
    )
    .join('\n');
}

export const projectConnector: CommandFamily = {
  usage: USAGE,
  commands: {
    'project connector': {
      options: { value: ['repo', 'name'], switches: ['all'] },
      build: ({ flags, positional, json, repo, deps }) => {
        const [action, ...words] = positional;
        if (action === 'add') {
          const name = flags.name === undefined ? words[0] : flags.name;
          if (typeof name !== 'string' || !name.trim()) {
            throw new UsageError('ut project connector add needs a name (e.g. --name bakery-app)');
          }
          return { op: 'connector-add', args: { repo, cwd: deps.cwd, name }, json };
        }
        if (action === 'list') {
          return {
            op: 'connector-list',
            args: { repo, cwd: deps.cwd, ...(flags.all === true ? { all: true } : {}) },
            json,
          };
        }
        if (action === 'revoke') {
          const [refArg] = words;
          if (!refArg)
            throw new UsageError('ut project connector revoke needs a channel id or name');
          return { op: 'connector-revoke', args: { repo, cwd: deps.cwd, ref: refArg }, json };
        }
        throw new UsageError('ut project connector needs add, list or revoke');
      },
    },
  },
  print: {
    'connector-add': ({ data, deps }) => {
      deps.out(formatConnectorToken(data));
      return undefined;
    },
    'connector-list': ({ data, deps }) => {
      deps.out(formatConnectorList(data));
      return undefined;
    },
    'connector-revoke': ({ data, deps }) => {
      const channel = data.channel as { id: string; name: string };
      deps.out(`Revoked ${channel.name} (${channel.id}): its token no longer works`);
      return undefined;
    },
  },
  pending: {
    // The token is shown at once, inactive until the user approves it.
    'connector-add': ({ data, deps }) => {
      if (data) deps.out(formatConnectorToken(data));
    },
  },
};
