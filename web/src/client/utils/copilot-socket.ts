/**
 * The page's end of the copilot socket (`/copilot`, protocol in shared/copilot-protocol.ts):
 * reconnects on its own and says `hello` again on every (re)connection, so the server puts the
 * page back in its conversation.
 */
import {
  COPILOT_PATH,
  type CopilotClientMessage,
  type CopilotServerMessage,
} from '../../shared/copilot-protocol.js';
import { createLogger } from './logger.js';

const logger = createLogger('copilot-socket');

export interface CopilotSocketHandlers {
  hello: () => CopilotClientMessage;
  onMessage: (msg: CopilotServerMessage) => void;
  onAudio: (frame: ArrayBuffer) => void;
  onOpenChange: (open: boolean) => void;
}

export function copilotUrl(token: string | undefined, loc: Location = window.location): string {
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${loc.host}${COPILOT_PATH}${query}`;
}

export class CopilotSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: () => string,
    private readonly handlers: CopilotSocketHandlers
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retryMs = 500;
      ws.send(JSON.stringify(this.handlers.hello()));
      this.handlers.onOpenChange(true);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof e.data !== 'string') {
        this.handlers.onAudio(e.data as ArrayBuffer);
        return;
      }
      let msg: CopilotServerMessage;
      try {
        msg = JSON.parse(e.data) as CopilotServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onOpenChange(false);
      if (this.closed) return;
      logger.debug(`copilot socket closed, again in ${this.retryMs} ms`);
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  /** False when the socket is not open: nothing was sent, the caller keeps what it had. */
  send(msg: CopilotClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendAudio(wav: ArrayBuffer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(wav);
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}
