// WebSocket upgrades (terminal transport, voice copilot) and their authentication.
import type { Response as ExpressResponse } from 'express';
import type * as http from 'http';
import { COPILOT_PATH } from '../shared/copilot-protocol.js';
import type { AuthenticatedRequest } from './middleware/auth.js';
import { TOKEN_INVALID_ERROR } from './middleware/auth.js';
import { guardUpgradeSocket, rejectUnauthenticatedUpgrade } from './middleware/ws-auth-reject.js';
import type { AppContext } from './server-context.js';
import { foreignApiRequestReason } from './services/preview-server.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

// Extended WebSocket request with authentication and routing info
export interface WebSocketRequest extends http.IncomingMessage {
  pathname?: string;
  searchParams?: URLSearchParams;
  userId?: string;
  authMethod?: string;
}

export function setupWebSockets(ctx: AppContext) {
  const { authMiddleware, copilotService, copilotWss, previewPublicOrigin, server, wsV3Hub, wss } =
    ctx;
  /**
   * Runs the normal auth middleware on a raw request (WebSocket upgrades, preview proxy):
   * the same Tailscale identity, no-auth, local bypass, bearer or ?token= rules as /api.
   */
  type RawAuthResult = {
    authenticated: boolean;
    userId?: string;
    authMethod?: string;
    /** A token was sent and refused (expired, invalid): the client must log in again. */
    tokenInvalid?: boolean;
  };
  const authenticateRawRequest = (request: http.IncomingMessage): Promise<RawAuthResult> => {
    const parsedUrl = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    return new Promise<RawAuthResult>((resolve) => {
      // Track if promise has been resolved to prevent multiple resolutions
      let resolved = false;
      const safeResolve = (value: RawAuthResult) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      // Convert URLSearchParams to plain object for query parameters
      const query: Record<string, string> = {};
      parsedUrl.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      // Create a mock Express request/response to use auth middleware
      const req = {
        ...request,
        url: request.url,
        path: parsedUrl.pathname,
        userId: undefined as string | undefined,
        authMethod: undefined as string | undefined,
        query, // Include parsed query parameters for token-based auth
        headers: request.headers,
        ip: (request.socket as unknown as { remoteAddress?: string }).remoteAddress || '',
        socket: request.socket,
        hostname: request.headers.host?.split(':')[0] || 'localhost',
        // Add minimal Express-like methods needed by auth middleware
        get: (header: string) => request.headers[header.toLowerCase()],
        header: (header: string) => request.headers[header.toLowerCase()],
        accepts: () => false,
        acceptsCharsets: () => false,
        acceptsEncodings: () => false,
        acceptsLanguages: () => false,
      } as unknown as AuthenticatedRequest;

      let authFailed = false;
      const res = {
        status: (code: number) => {
          // Only consider it a failure if it's an error status code. The body (sent right
          // after) says whether a token was refused; without one, a failure all the same.
          if (code >= 400) {
            authFailed = true;
            queueMicrotask(() => safeResolve({ authenticated: false }));
          }
          return {
            json: (body?: { error?: unknown }) => {
              if (code >= 400) {
                safeResolve({
                  authenticated: false,
                  tokenInvalid: body?.error === TOKEN_INVALID_ERROR,
                });
              }
            },
            send: () => {},
            end: () => {},
          };
        },
        setHeader: () => {},
        send: () => {},
        json: () => {},
        end: () => {},
      } as unknown as ExpressResponse;

      const next = (error?: unknown) => {
        // Authentication succeeds if next() is called without error and no auth failure was recorded
        const authenticated = !error && !authFailed;
        safeResolve({
          authenticated,
          userId: req.userId,
          authMethod: req.authMethod,
        });
      };

      // Add a timeout to prevent indefinite hanging
      const timeoutId = setTimeout(() => {
        logger.error('WebSocket auth timeout - auth middleware did not complete in time');
        safeResolve({ authenticated: false });
      }, 5000); // 5 second timeout

      // Call authMiddleware and handle potential async errors
      Promise.resolve(authMiddleware(req, res, next))
        .then(() => {
          clearTimeout(timeoutId);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          logger.error('Auth middleware error:', error);
          safeResolve({ authenticated: false });
        });
    });
  };
  // Handle WebSocket upgrade with authentication
  server.on('upgrade', async (request, socket, head) => {
    guardUpgradeSocket(socket);
    try {
      if (foreignApiRequestReason(request.headers, ctx.previewListenPort, previewPublicOrigin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      let parsedUrl: URL;
      try {
        // Validate Host separately; it must not control request-target resolution.
        new URL(`http://${request.headers.host || 'localhost'}`);
        parsedUrl = new URL(request.url || '', 'http://localhost');
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Handle WebSocket paths
      if (parsedUrl.pathname === COPILOT_PATH && copilotService) {
        const copilotAuth = await authenticateRawRequest(request);
        if (!copilotAuth.authenticated) {
          rejectUnauthenticatedUpgrade(copilotWss, request, socket, head, copilotAuth);
          return;
        }
        copilotWss.handleUpgrade(request, socket, head, (ws) => copilotService.attach(ws));
        return;
      }
      if (parsedUrl.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check authentication and capture user info
      const authResult = await authenticateRawRequest(request);

      if (!authResult.authenticated) {
        logger.debug(
          `WebSocket connection rejected: ${authResult.tokenInvalid ? 'token invalid (4401)' : 'unauthorized'}`
        );
        rejectUnauthenticatedUpgrade(wss, request, socket, head, authResult);
        return;
      }

      // Handle the upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Add path and auth information to the request for routing
        const wsRequest = request as WebSocketRequest;
        wsRequest.pathname = parsedUrl.pathname;
        wsRequest.searchParams = parsedUrl.searchParams;
        wsRequest.userId = authResult.userId;
        wsRequest.authMethod = authResult.authMethod;
        wss.emit('connection', ws, wsRequest);
      });
    } catch {
      // EventEmitter does not consume async listeners' rejected promises.
      logger.error('WebSocket upgrade failed');
      socket.destroy();
    }
  });

  wss.on('close', () => wsV3Hub.dispose());

  // WebSocket connection router
  wss.on('connection', (ws, req) => {
    const wsReq = req as WebSocketRequest;
    const pathname = wsReq.pathname;

    logger.log(`🔌 WebSocket connection to path: ${pathname}`);
    logger.log(`👤 User ID: ${wsReq.userId || 'unknown'}`);
    logger.log(`🔐 Auth method: ${wsReq.authMethod || 'unknown'}`);

    if (pathname === '/ws') {
      logger.log('🧩 Handling v3 WebSocket connection');
      wsV3Hub.handleClientConnection(ws, wsReq);
    } else {
      logger.error(`❌ Unknown WebSocket path: ${pathname}`);
      ws.close();
    }
  });
}
