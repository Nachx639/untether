/**
 * The connector as a remote MCP server (streamable HTTP, JSON answers): the same five
 * operations as the HTTP API, a thin layer over ConnectorService with the same bearer token.
 * No sessions, no server-initiated messages: every POST is one JSON-RPC request (or a batch)
 * answered with application/json, which the streamable HTTP transport allows.
 */
import {
  CONNECTOR_API_VERSION,
  ConnectorError,
  type ConnectorService,
  IMAGE_MIME_TYPES,
  MESSAGE_IMAGES_MAX,
  MESSAGE_TEXT_MAX,
  SENDER_FIELD_MAX,
} from './connector-service.js';
import type { ConnectorChannelInfo } from './connector-tokens.js';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SENDER_SCHEMA = {
  type: 'object',
  description: 'Who sends it, as the app knows it (shown to the orchestrator as unverified)',
  properties: {
    agent: { type: 'string', maxLength: SENDER_FIELD_MAX },
    onBehalfOf: { type: 'string', maxLength: SENDER_FIELD_MAX },
    room: { type: 'string', maxLength: SENDER_FIELD_MAX },
  },
  additionalProperties: false,
};

export const MCP_TOOLS = [
  {
    name: 'connector_info',
    description: "This connector's project, channel, permissions and limits.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description:
      "Send a request (text and up to a few small images) to the project's orchestrator. It is told it comes from this app, never from the user. Returns a messageId to read its reply with.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: MESSAGE_TEXT_MAX },
        images: {
          type: 'array',
          maxItems: MESSAGE_IMAGES_MAX,
          items: {
            type: 'object',
            properties: {
              mimeType: { type: 'string', enum: IMAGE_MIME_TYPES },
              data: { type: 'string', description: 'base64' },
            },
            required: ['mimeType', 'data'],
          },
        },
        from: SENDER_SCHEMA,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_message',
    description:
      "A message's state (queued, delivered, answered), whether the orchestrator's turn for it is over (done), and its replies.",
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string' } },
      required: ['messageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_replies',
    description:
      "The orchestrator's replies to this channel's messages after a cursor (0 = from the start). Pass back the returned cursor next time.",
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_tasks',
    description:
      "The project's tasks, read-only: id, title, state, timings, branch, last note and who it waits on. all=true adds the newest finished ones.",
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
] as const;

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

async function callTool(
  service: ConnectorService,
  channel: ConnectorChannelInfo,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'connector_info':
      return service.info(channel);
    case 'send_message':
      return service.send(channel, { text: args.text, images: args.images, from: args.from });
    case 'get_message':
      if (typeof args.messageId !== 'string') {
        throw new ConnectorError('bad-request', 'messageId is required');
      }
      return service.message(channel, args.messageId);
    case 'read_replies': {
      const after = Number(args.after ?? 0);
      const limit = Number(args.limit ?? 50);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
        throw new ConnectorError('bad-request', 'after and limit must be whole numbers');
      }
      return service.replies(channel, after, limit);
    }
    case 'list_tasks':
      return { tasks: service.tasks(channel, args.all === true) };
    default:
      throw new ConnectorError('not-found', `No tool ${name}`);
  }
}

async function handleOne(
  service: ConnectorService,
  channel: ConnectorChannelInfo,
  request: JsonRpcRequest
): Promise<unknown | null> {
  if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0') {
    return rpcError(request?.id, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = request;
  // A notification gets no answer.
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'untether-connector', version: String(CONNECTOR_API_VERSION) },
          instructions:
            "Talk to one project's orchestrator on the owner's Untether: send_message, then get_message or read_replies for its answer; list_tasks shows its tasks. Nothing else is reachable.",
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await callTool(service, channel, name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          },
        };
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        const detail = {
          error: error.code,
          message: error.message,
          ...(error.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}),
        };
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(detail) }], isError: true },
        };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** One POST /mcp body: the answer, or null when it held only notifications (202). */
export async function handleMcp(
  service: ConnectorService,
  channel: ConnectorChannelInfo,
  body: unknown
): Promise<unknown | null> {
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return rpcError(null, -32600, 'Invalid batch');
    const answers = [];
    for (const request of body) {
      const answer = await handleOne(service, channel, request as JsonRpcRequest);
      if (answer) answers.push(answer);
    }
    return answers.length ? answers : null;
  }
  return handleOne(service, channel, body as JsonRpcRequest);
}
