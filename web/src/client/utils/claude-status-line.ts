/**
 * Claude Code's status line, as the terminal shows it: the lines under the prompt box. Whatever
 * produces them (Claude Code's own mode line, a `statusLine` command such as a usage meter) is
 * read off the screen, so the chat shows exactly what the terminal does.
 *
 *   ─────────────────────────────
 *   ❯ <what is being typed>
 *   ─────────────────────────────
 *     Opus · 5h 5% · week 16% …      ← status line
 *     ⏵⏵ bypass permissions on · …   ← mode line
 */

/** A horizontal rule of the prompt box (top rules may carry a title in the middle). */
const RULE = /^\s*[─━]{8,}/;
/** The prompt line inside the box. */
const PROMPT = /^\s*[❯>]/;
/** At most this many lines under the box are taken (more is not a status line). */
const MAX_LINES = 4;

export const CHAT_STATUS_LINE_KEY = 'ut-chat-status-line';
export const CHAT_STATUS_LINE_CHANGED_EVENT = 'ut-chat-status-line-changed';

/** How the screen's rows were laid out, aligned with the text's last rows (see ScreenLayout). */
export interface StatusLineLayout {
  cols?: number;
  /** Per row of the screen (counted from its end): it goes on from the row above. */
  wrappedRows?: boolean[];
}

/** A row that is only the pieces of a box (a border the terminal wrapped onto its own row). */
const BOX_ONLY = /^[\s─━│┃┄┅┆┇┈┉┊┋═║╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬]+$/;

/**
 * The screen's rows as Claude printed them: rows the terminal soft-wrapped are joined back
 * (2026-10-12, a 40-column phone: "5h 7% (rese" + "ts 22:30)" showed as two chips and an orphan
 * ")"). With the terminal's own wrap flags that is exact; a row that filled the width goes on
 * mid-word, a shorter one lost a trailing space to trimming. Without them only the rows under
 * the prompt box are joined, by their look (see joinStatusRows).
 */
function printedRows(rows: string[], layout?: StatusLineLayout): { text: string; raw: string }[] {
  const flags = layout?.wrappedRows;
  const offset = flags ? flags.length - rows.length : 0;
  const out: { text: string; raw: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const wrapped = flags !== undefined && flags[i + offset] === true && out.length > 0;
    if (!wrapped) {
      out.push({ text: rows[i], raw: rows[i] });
      continue;
    }
    const last = out[out.length - 1];
    const previousRow = rows[i - 1] ?? '';
    const full = layout?.cols === undefined || previousRow.length >= layout.cols;
    last.text += `${full ? '' : ' '}${rows[i]}`;
  }
  return out;
}

/**
 * Status rows without the terminal's wrap flags: Claude indents its own rows, so when the first
 * one is indented a row starting at the left edge goes on from the one above; so does one
 * starting with ")" (the end of a "(resets …)" cut by the wrap). "(" starts a new word, anything
 * else goes on mid-word.
 */
function joinStatusRows(rows: string[]): string[] {
  const out: string[] = [];
  const first = rows.find((row) => row.trim() && !BOX_ONLY.test(row.trim()));
  const indented = first !== undefined && /^\s/.test(first);
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed || BOX_ONLY.test(trimmed)) continue;
    const continues = out.length > 0 && ((indented && /^\S/.test(row)) || trimmed.startsWith(')'));
    if (!continues) {
      out.push(trimmed);
      continue;
    }
    const gap = /^[(·•|]/.test(trimmed) || /[\s·•|]$/.test(out[out.length - 1]) ? ' ' : '';
    out[out.length - 1] = `${out[out.length - 1]}${gap}${trimmed}`.replace(/\s{2,}/g, ' ');
  }
  return out;
}

export function parseClaudeStatusLine(screen: string, layout?: StatusLineLayout): string[] {
  const rawRows = screen.split('\n').map((line) => line.replace(/\s+$/, ''));
  const printed = printedRows(rawRows, layout);
  const exact = layout?.wrappedRows !== undefined;
  const lines = printed.map((row) => row.text);
  // The box's bottom rule: the last rule with a prompt line a few lines above it.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!RULE.test(lines[i])) continue;
    let prompt = false;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      if (RULE.test(lines[j])) break;
      if (PROMPT.test(lines[j])) {
        prompt = true;
        break;
      }
    }
    if (!prompt) return [];
    const rows = lines.slice(i + 1).filter((line) => !RULE.test(line));
    const below = exact
      ? rows.map((line) => line.trim()).filter((line) => line && !BOX_ONLY.test(line))
      : joinStatusRows(rows);
    return below.slice(0, MAX_LINES);
  }
  return [];
}

/** "Show Claude's status line in chat" (Settings); off unless turned on on this device. */
export function readChatStatusLinePref(): boolean {
  try {
    return localStorage.getItem(CHAT_STATUS_LINE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeChatStatusLinePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(CHAT_STATUS_LINE_KEY, 'on');
    else localStorage.removeItem(CHAT_STATUS_LINE_KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHAT_STATUS_LINE_CHANGED_EVENT, { detail: on }));
}

/** One piece of the status line, ready for a compact chip. */
export interface StatusSegment {
  /** Plain text ("Opus 5.5", "1 shell"), or the label before a percentage ("5h"). */
  text: string;
  /** A usage percentage ("5h 7%"), drawn as a small bar. */
  percent?: number;
  /** When that usage resets ("22:30" from "(reinicia 22:30)" or "(resets 22:30)"). */
  reset?: string;
}

/** Mode-line pieces that the chat already shows (its mode chip) or that only make sense typing. */
const MODE_PIECE = /(?:⏵⏵|⏵|⏸|►►|▶▶)|\b(?:mode|permissions) on\b/i;
const HINT_PIECE = /(?:shift\+tab|for shortcuts|to cycle|← for agents|esc to|ctrl\+)/i;
const RESET = /\((?:reinicia|reinicio|resets?|renews?|se reinicia)\s+([^)]*)\)/i;

/**
 * The status lines as compact pieces: split on "·", the permission mode and key hints dropped
 * (the chat has its mode chip), a piece the terminal cut off ("cont…") dropped, and a cut-off
 * "(resets …" left out.
 */
export function compactStatusSegments(lines: string[]): StatusSegment[] {
  const out: StatusSegment[] = [];
  for (const line of lines) {
    for (const raw of line.split(/\s+·\s+|\s+•\s+|\s+\|\s+/)) {
      let piece = raw.trim();
      if (!piece || MODE_PIECE.test(piece) || HINT_PIECE.test(piece)) continue;
      // A border or a lone bracket left by a wrap is no chip ("————", ")").
      if (BOX_ONLY.test(piece) || /^[\p{P}\p{S}\s]+$/u.test(piece)) continue;
      const cut = piece.endsWith('…');
      let reset: string | undefined;
      const resetMatch = RESET.exec(piece);
      if (resetMatch) {
        reset = resetMatch[1].trim() || undefined;
        piece = piece.replace(RESET, '').trim();
      } else if (piece.includes('(') && !piece.includes(')')) {
        piece = piece.slice(0, piece.indexOf('(')).trim();
      } else if (piece.includes(')') && !piece.includes('(')) {
        // The tail of a "(resets …)" whose start went elsewhere: nothing to read in it.
        piece = piece.slice(piece.indexOf(')') + 1).trim();
      } else if (cut) {
        // A piece the terminal cut short says nothing useful ("cont…").
        if (!/\d+%/.test(piece)) continue;
        piece = piece.replace(/…$/, '').trim();
      }
      const pct = /^(.*?)\s*(\d{1,3})%$/.exec(piece);
      if (pct) {
        out.push({ text: pct[1].trim(), percent: Math.min(100, Number(pct[2])), reset });
      } else if (piece) {
        out.push({ text: piece, reset });
      }
    }
  }
  return out;
}
