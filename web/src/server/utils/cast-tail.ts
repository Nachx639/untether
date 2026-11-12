/**
 * Bounded reads of asciinema cast files (a session's `stdout`).
 *
 * 2026-10-04: a long Claude Code session (fullscreen TUI, constant repaints) grew its cast to
 * 1 GB. The server read whole casts into one string, which V8 caps at 0x1fffffe8 characters:
 * "Cannot create a string longer than 0x1fffffe8 characters" when its terminal was built, then
 * "Invalid string length" in the fallback snapshot, so /text, previews, the Claude menu reader
 * and pushes had no screen for that session. The client replay streamed the file but kept every
 * event since the last clear (430 MB there) in memory and queued it all on the WebSocket.
 *
 * A screen is rebuilt from the end of the recording: a full-screen app's last repaints draw
 * all of it. These helpers read only the last few MB, starting on a line (one JSON event)
 * boundary, plus the header line read on its own, and stream them with backpressure.
 */
import * as fs from 'fs';

/** Bytes of a cast replayed at most to rebuild a screen (server terminal, live catch-up). */
export const CAST_REPLAY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Bytes of history replayed at most to a client opening a session. User report 2026-10-14:
 * «Cargando historial» took 0.5-1.6 s on a phone for Mac-window sessions. The client keeps the
 * screen blank until the whole replay is written, and its ghostty keeps only a few hundred to
 * two thousand rows of 16 MB of a TUI's repaints. The last 4 MB rebuild the same screen, all of
 * a Claude session's rows after its last clear, and 35-85% of a Mac window's (the oldest go),
 * written in about a third of the time.
 */
export const CAST_CLIENT_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

/** How far back from a cut replay to look for the terminal size in effect there. */
export const RESIZE_LOOKBACK_MAX_BYTES = 128 * 1024 * 1024;

const SCAN_CHUNK_BYTES = 64 * 1024;
const RESIZE_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
// `[1.5,"r","80x24"]`: inside an event's data every quote is escaped, so this only matches
// the type field of a resize event.
const RESIZE_MARKER = Buffer.from(',"r","');

/**
 * Offset of the start of the line containing `offset` (0 if none found). A hole of a compacted
 * cast (see forEachCastLine) stops the search at its end: the rest of the line there is junk
 * the line readers drop, and a search back through a GB of NULs would block the server.
 */
export function findLineStart(filePath: string, offset: number): number {
  if (offset <= 0) return 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let end = offset;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const bytesRead = fs.readSync(fd, chunk, 0, end - start, start);
      const view = chunk.subarray(0, bytesRead);
      const stop = Math.max(view.lastIndexOf(NEWLINE), view.lastIndexOf(0));
      if (stop !== -1) return start + stop + 1;
      end = start;
    }
    return 0;
  } catch {
    return offset;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The first offset at or after `offset` that starts a line, or `limit` if none is before it. */
export async function findNextLineStart(
  filePath: string,
  offset: number,
  limit: number
): Promise<number> {
  if (offset <= 0) return 0;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    // From the byte before: when it is a newline, `offset` itself starts a line.
    let position = offset - 1;
    while (position < limit) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, limit - position),
        position
      );
      if (bytesRead === 0) break;
      const newline = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
      if (newline !== -1) return Math.min(position + newline + 1, limit);
      position += bytesRead;
    }
    return limit;
  } finally {
    await handle.close();
  }
}

/** The cast's first line (its header) and the offset just after it, if it is complete. */
export async function readCastHeaderLine(
  filePath: string
): Promise<{ line: string; end: number } | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    const parts: Buffer[] = [];
    let position = 0;
    while (position < MAX_HEADER_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return null;
      const newline = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
      if (newline !== -1) {
        parts.push(Buffer.from(chunk.subarray(0, newline)));
        return { line: Buffer.concat(parts).toString('utf8'), end: position + newline + 1 };
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Where to start replaying the events in [from, to) so that at most `maxBytes` are read:
 * `from` when they fit; otherwise `preferred` (the line of the last clear) when it is inside
 * the last `maxBytes`, else the first line that starts in them.
 */
export async function castReplayStart(
  filePath: string,
  from: number,
  to: number,
  maxBytes: number,
  preferred?: number
): Promise<{ start: number; truncated: boolean }> {
  if (to - from <= maxBytes) return { start: from, truncated: false };
  const cut = to - maxBytes;
  if (preferred !== undefined && preferred >= cut && preferred < to) {
    return { start: Math.max(from, findLineStart(filePath, preferred)), truncated: true };
  }
  return { start: await findNextLineStart(filePath, cut, to), truncated: true };
}

/**
 * The dimensions ("COLSxROWS") of the last resize event before `offset`, looking back at most
 * `lookback` bytes and never before `stopAt`. Null when there is none in that range.
 */
export async function findLastResizeBefore(
  filePath: string,
  offset: number,
  stopAt = 0,
  lookback = RESIZE_LOOKBACK_MAX_BYTES
): Promise<string | null> {
  const floor = Math.max(stopAt, offset - lookback);
  if (offset <= floor) return null;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(RESIZE_SCAN_CHUNK_BYTES);
    const tail = Buffer.alloc(32);
    let end = offset;
    while (end > floor) {
      const start = Math.max(floor, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const view = chunk.subarray(0, bytesRead);
      for (let at = view.lastIndexOf(RESIZE_MARKER); at !== -1; ) {
        const { bytesRead: tailRead } = await handle.read(
          tail,
          0,
          tail.length,
          start + at + RESIZE_MARKER.length
        );
        const match = tail.toString('latin1', 0, tailRead).match(/^(\d+x\d+)"\]/);
        if (match) return match[1];
        at = at > 0 ? view.lastIndexOf(RESIZE_MARKER, at - 1) : -1;
      }
      if (start <= floor) break;
      // Overlap so a marker across the chunk boundary is still found.
      end = start + RESIZE_MARKER.length - 1;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * The last resize event ("120x67") written in [start, end) of a cast, read backwards in 1 MB
 * chunks, synchronously (pty-manager checks the bytes appended since its last look, before
 * deciding on a resize). Null when there is none.
 */
export function findLastResizeInRangeSync(
  filePath: string,
  start: number,
  end: number
): string | null {
  if (end <= start) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(Math.min(RESIZE_SCAN_CHUNK_BYTES, end - start + 32));
    let to = end;
    while (to > start) {
      const from = Math.max(start, to - chunk.length);
      const bytesRead = fs.readSync(fd, chunk, 0, to - from, from);
      const view = chunk.subarray(0, bytesRead);
      for (let at = view.lastIndexOf(RESIZE_MARKER); at !== -1; ) {
        const match = view
          .toString('latin1', at + RESIZE_MARKER.length, at + RESIZE_MARKER.length + 24)
          .match(/^(\d+x\d+)"\]/);
        if (match) return match[1];
        at = at > 0 ? view.lastIndexOf(RESIZE_MARKER, at - 1) : -1;
      }
      if (from <= start) break;
      // Overlap so an event across the chunk boundary is still found whole.
      to = from + 32;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Stream the complete lines in [start, end) to `onLine`, reading with backpressure (the next
 * chunk is read only after this one's lines were handled). Lines are cut on the newline byte,
 * which never occurs inside a UTF-8 sequence, so a character split across chunks stays whole.
 * Returns the offset after the last complete line: a trailing partial line is left for later.
 *
 * A compacted cast (native/ut-fwd/src/cast_compact.rs) has a hole of NUL bytes where its old
 * middle was, cut on block boundaries, so mid-line on both sides. A cast's JSON never holds a
 * raw NUL: the line a hole starts in, the hole and the rest of the line it ends in are dropped,
 * never gathered into one line hundreds of MB long.
 */
export async function forEachCastLine(
  filePath: string,
  start: number,
  end: number,
  onLine: (line: string, lineEnd: number) => void
): Promise<number> {
  return forEachCastLineBytes(filePath, start, end, (line, lineEnd) =>
    onLine(line.toString('utf8'), lineEnd)
  );
}

/**
 * forEachCastLine with each line's raw bytes, without decoding it. `line` may be a view into
 * the read buffer: it is valid only during the call.
 */
export async function forEachCastLineBytes(
  filePath: string,
  start: number,
  end: number,
  onLine: (line: Buffer, lineEnd: number) => void
): Promise<number> {
  if (end <= start) return start;
  const stream = fs.createReadStream(filePath, {
    start,
    end: end - 1,
    highWaterMark: 256 * 1024,
  });
  let offset = start; // after the last complete line (where `pending` starts)
  let chunkStart = start; // file offset of the chunk's first byte
  let pending: Buffer[] = [];
  let skipping = false; // in a hole, or in the rest of the line it cut
  for await (const data of stream) {
    const chunk = data as Buffer;
    const hasHole = chunk.indexOf(0) !== -1;
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, from);
      if (skipping) {
        if (newline === -1) break;
        skipping = false;
        from = newline + 1;
        offset = chunkStart + from;
        continue;
      }
      const hole = hasHole ? chunk.indexOf(0, from) : -1;
      if (hole !== -1 && (newline === -1 || hole < newline)) {
        pending = [];
        skipping = true;
        from = hole + 1;
        continue;
      }
      if (newline === -1) {
        pending.push(Buffer.from(chunk.subarray(from)));
        break;
      }
      const piece = chunk.subarray(from, newline);
      const lineBytes = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      from = newline + 1;
      offset = chunkStart + from;
      onLine(lineBytes, offset);
    }
    chunkStart += chunk.length;
  }
  return offset;
}

// The sequences looked for, as a cast's JSON writes them (ESC is `\u001b` there). Mode changes
// are found by their first digits: `1` (cursor keys, the mouse modes, alternate screen), `7`
// (autowrap) and 2004 (bracketed paste). Cursor show/hide (`ESC[?25…`) and synchronized output
// (`ESC[?2026…`), which a TUI writes around every frame, are never even matched; a combined set
// that starts with one of them (`ESC[?25;1000h`) is missed, which no TUI writes.
const MARKERS = /\\u001b(?:\[\?(?:1|7|2004)|c|\[!p)/g;
const JSON_ESC_LENGTH = '\\u001b'.length;
const SEQUENCE = /^(?:\[\?[\d;]{1,32}[hl]|c|\[!p)/;
/** Characters an escape and its sequence take at most (`\u001b[?` + 32 digits or `;` + `h`). */
const SEQUENCE_CHARS = 48;
/** Characters of a line read to tell its type: the time is a short number. */
const LINE_TYPE_CHARS = 40;
// `[1.5,"o","`: the type field right after the time.
const OUTPUT_TYPE = ',"o","';

/** Whether the line starting at `start` is an output event; null when too little is there. */
function isOutputLine(text: string, start: number): boolean | null {
  let head = text.slice(start, start + LINE_TYPE_CHARS);
  const newline = head.indexOf('\n');
  if (newline !== -1) head = head.slice(0, newline);
  const comma = head.indexOf(',');
  if (comma !== -1 && head.length - comma >= OUTPUT_TYPE.length) {
    return head.startsWith(OUTPUT_TYPE, comma);
  }
  return newline === -1 && head.length < LINE_TYPE_CHARS ? null : false;
}

/**
 * Feed the DEC private mode changes (`ESC[?…h`/`l`, see MARKERS) and terminal resets (`ESC c`,
 * `ESC[!p`) written in the output events of a cast's [start, end) to `onSequence`, in order, as
 * the terminal received them. Input events are skipped (a typed Alt+C is `ESC c` too), and so is
 * an escaped backslash followed by `u001b` (text, not an ESC). `start` must be a line start.
 *
 * Searched for in the raw text, read as latin1 (one character per byte), in constant memory: no
 * JSON parsing, no lines kept. A Claude session's cast is hundreds of MB of repaints with an ESC
 * every few bytes, lines up to megabytes long, and only a handful of these sequences.
 * Returns the offset after the last complete line read.
 */
export async function scanCastModeSequences(
  filePath: string,
  start: number,
  end: number,
  onSequence: (sequence: string) => void
): Promise<number> {
  if (end <= start) return start;
  const stream = fs.createReadStream(filePath, {
    start,
    end: end - 1,
    highWaterMark: 1024 * 1024,
  });
  let text = '';
  let textOffset = start; // file offset of text[0]
  let scan = 0; // where the next search starts
  let lineStart = 0; // start of the line holding `scan`, or -1 when before text
  let isOutput: boolean | null = null; // that line's type, null until read
  let lastLineEnd = start;

  /** Move lineStart to the line holding `at`, given none starts in (lineStart, from]. */
  const followLines = (from: number, at: number) => {
    const newline = text.lastIndexOf('\n', at - 1);
    if (newline < from) return;
    lineStart = newline + 1;
    lastLineEnd = textOffset + lineStart;
    isOutput = null;
  };
  const escaped = (at: number) => {
    let backslashes = 0;
    const floor = Math.max(lineStart, 0);
    while (at - backslashes - 1 >= floor && text.charCodeAt(at - backslashes - 1) === 0x5c) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  };
  const search = (limit: number) => {
    let checked = scan;
    MARKERS.lastIndex = scan;
    for (let match = MARKERS.exec(text); match && match.index < limit; match = MARKERS.exec(text)) {
      const at = match.index;
      followLines(checked, at);
      checked = at;
      if (isOutput === null && lineStart >= 0) isOutput = isOutputLine(text, lineStart);
      if (isOutput && !escaped(at)) {
        const sequence = text.slice(at + JSON_ESC_LENGTH, at + SEQUENCE_CHARS).match(SEQUENCE);
        if (sequence) onSequence(`\x1b${sequence[0]}`);
      }
    }
    followLines(checked, limit);
    scan = limit;
    if (isOutput === null && lineStart >= 0) isOutput = isOutputLine(text, lineStart);
  };

  for await (const data of stream) {
    text += (data as Buffer).toString('latin1');
    // The last characters wait for the next read: a sequence there may be cut.
    const limit = text.length - SEQUENCE_CHARS;
    if (limit <= scan) continue;
    search(limit);
    // Keep what is still needed: the line's start while its type is unknown, else a few
    // characters before `scan` (an escape's preceding backslashes).
    const keepFrom =
      isOutput === null && lineStart >= 0 ? lineStart : Math.max(0, scan - SEQUENCE_CHARS);
    if (keepFrom > 0) {
      text = text.slice(keepFrom);
      textOffset += keepFrom;
      scan -= keepFrom;
      lineStart = lineStart >= keepFrom ? lineStart - keepFrom : -1;
    }
  }
  if (text.length > scan) search(text.length);
  return lastLineEnd;
}
