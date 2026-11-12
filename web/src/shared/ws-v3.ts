/**
 * WebSocket v3 framing for terminal transport.
 *
 * Frame:
 *   u16  magic = 0x5654 ("VT") LE
 *   u8   version = 3
 *   u8   type
 *   u32  sessionIdLen LE
 *   u8[] sessionId UTF-8
 *   u32  payloadLen LE
 *   u8[] payload
 */

export const WS_V3_MAGIC = 0x5654;
export const WS_V3_VERSION = 3;

export enum WsV3MessageType {
  WELCOME = 2,

  SUBSCRIBE = 10,
  UNSUBSCRIBE = 11,

  STDOUT = 20,
  SNAPSHOT_VT = 21,
  EVENT = 22,
  ERROR = 23,

  INPUT_TEXT = 30,
  INPUT_KEY = 31,
  RESIZE = 32,
  KILL = 33,
  RESET_SIZE = 34,

  PING = 40,
  PONG = 41,

  /**
   * Client → server: the session this client is showing on a visible page (frame
   * sessionId), or none (empty sessionId). Pushes about a viewed session are skipped.
   * Re-sent every VIEWING_REFRESH_MS while someone is really looking; the server forgets it
   * VIEWING_STALE_MS after the last one.
   */
  VIEWING = 50,

  /**
   * Client → server: the session shown on this page while the page is visible (frame
   * sessionId), or none (empty: hidden, locked, backgrounded, no session); payload: the page's
   * id (client-id.ts). Unlike VIEWING it ignores focus and idle time, so it says whether the
   * page is there at all; re-sent every VIEWING_REFRESH_MS while it is. The server gives a
   * Mac-window session's size back to its window once the owning page has been away for
   * SIZE_AWAY_GIVE_BACK_MS (server/pty/size-owner.ts). Older servers ignore it.
   */
  PRESENT = 51,

  /**
   * Client → server: what this looked-at page shows that a push may be about, as keys joined
   * by newlines (server/services/agent-attention-policy.ts: `confirm:<id>`, `needs-you:<task>`).
   * Re-sent every VIEWING_REFRESH_MS while it stays on screen. An important push held while
   * someone looks is dropped when its key was seen during the hold.
   */
  SEEN = 52,
}

/** How often a client repeats its VIEWING frame while the page is really being looked at. */
export const VIEWING_REFRESH_MS = 20_000;
/**
 * A VIEWING frame not repeated within this long no longer counts (three refreshes missed):
 * a page left open on a locked Mac must not hold back the phone's pushes for ever
 * (2026-10-03). A client that never repeats it (older pages) expires the same way.
 */
export const VIEWING_STALE_MS = 60_000;

export type WsV3DecodedFrame = {
  type: WsV3MessageType;
  sessionId: string;
  payload: Uint8Array;
};

/**
 * What a VIEWING frame names when the page shows a dev-server preview view (/preview/<id>)
 * instead of a session: "Preview ready" for that preview is then already on screen. It
 * never equals a session id, so the session's own pushes still go.
 */
export function previewViewingKey(previewId: string): string {
  return `preview:${previewId}`;
}

/** SEEN key of a pending confirmation (the attention strip shows it). */
export function confirmSeenKey(confirmId: string): string {
  return `confirm:${confirmId}`;
}

/** SEEN key of a task that needs the user (the attention strip shows it). */
export function needsYouSeenKey(taskId: string): string {
  return `needs-you:${taskId}`;
}

export function encodeWsV3Frame(params: {
  type: WsV3MessageType;
  sessionId?: string;
  payload?: Uint8Array;
}): Uint8Array {
  const sessionId = params.sessionId ?? '';
  const encoder = new TextEncoder();
  const sessionIdBytes = encoder.encode(sessionId);
  const payload = params.payload ?? new Uint8Array();

  const headerLen = 2 + 1 + 1 + 4 + sessionIdBytes.length + 4;
  const out = new Uint8Array(headerLen + payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  let offset = 0;
  view.setUint16(offset, WS_V3_MAGIC, true);
  offset += 2;
  view.setUint8(offset, WS_V3_VERSION);
  offset += 1;
  view.setUint8(offset, params.type);
  offset += 1;

  view.setUint32(offset, sessionIdBytes.length, true);
  offset += 4;
  out.set(sessionIdBytes, offset);
  offset += sessionIdBytes.length;

  view.setUint32(offset, payload.length, true);
  offset += 4;
  out.set(payload, offset);

  return out;
}

export function decodeWsV3Frame(data: Uint8Array): WsV3DecodedFrame | null {
  if (data.byteLength < 2 + 1 + 1 + 4 + 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const magic = view.getUint16(offset, true);
  offset += 2;
  if (magic !== WS_V3_MAGIC) return null;

  const version = view.getUint8(offset);
  offset += 1;
  if (version !== WS_V3_VERSION) return null;

  const type = view.getUint8(offset) as WsV3MessageType;
  offset += 1;

  const sessionIdLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + sessionIdLen + 4 > data.byteLength) return null;
  const sessionIdBytes = data.subarray(offset, offset + sessionIdLen);
  const sessionId = new TextDecoder().decode(sessionIdBytes);
  offset += sessionIdLen;

  const payloadLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + payloadLen > data.byteLength) return null;

  const payload = data.subarray(offset, offset + payloadLen);
  return { type, sessionId, payload };
}

export enum WsV3SubscribeFlags {
  Stdout = 1 << 0,
  Snapshots = 1 << 1,
  Events = 1 << 2,
}

export function encodeWsV3SubscribePayload(params: {
  flags: number;
  snapshotMinIntervalMs?: number;
  snapshotMaxIntervalMs?: number;
}): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, params.flags >>> 0, true);
  view.setUint32(4, (params.snapshotMinIntervalMs ?? 0) >>> 0, true);
  view.setUint32(8, (params.snapshotMaxIntervalMs ?? 0) >>> 0, true);
  return out;
}

export function decodeWsV3SubscribePayload(payload: Uint8Array): {
  flags: number;
  snapshotMinIntervalMs: number;
  snapshotMaxIntervalMs: number;
} | null {
  if (payload.byteLength < 12) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    flags: view.getUint32(0, true),
    snapshotMinIntervalMs: view.getUint32(4, true),
    snapshotMaxIntervalMs: view.getUint32(8, true),
  };
}

/** RESIZE flag: the user used this page (a key, a tap, opening the session), it takes the size. */
export const WS_V3_RESIZE_CLAIM = 1;

/**
 * RESIZE payload: cols u32, rows u32, flags u32 (WS_V3_RESIZE_CLAIM), then the page's id
 * (client-id.ts) as UTF-8. The server keeps one owner of each Mac-window session's size and
 * applies a resize only from it, or from a page that claims it (pty-manager sizeRequestDecision).
 */
export function encodeWsV3ResizePayload(
  cols: number,
  rows: number,
  options: { claim?: boolean; clientId?: string } = {}
): Uint8Array {
  const id = new TextEncoder().encode(options.clientId ?? '');
  const out = new Uint8Array(12 + id.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, cols >>> 0, true);
  view.setUint32(4, rows >>> 0, true);
  view.setUint32(8, options.claim ? WS_V3_RESIZE_CLAIM : 0, true);
  out.set(id, 12);
  return out;
}

export function decodeWsV3ResizePayload(
  payload: Uint8Array
): { cols: number; rows: number; claim: boolean; clientId: string | null } | null {
  // The whole header or nothing: there is no RESIZE without its flags (2026-11-11).
  if (payload.byteLength < 12) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint32(8, true);
  const id = payload.byteLength > 12 ? new TextDecoder().decode(payload.subarray(12)) : '';
  return {
    cols: view.getUint32(0, true),
    rows: view.getUint32(4, true),
    claim: (flags & WS_V3_RESIZE_CLAIM) !== 0,
    clientId: id || null,
  };
}
