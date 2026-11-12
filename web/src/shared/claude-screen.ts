/**
 * Reading Claude Code's terminal screen, shared by the chat view (client) and the session
 * list's quick answers (server).
 */

/** A prompt Claude Code shows on screen, answerable from the phone. */
export interface ScreenChoices {
  question: string;
  options: string[];
  /**
   * What to type for each option when it is not its number: a "(y/n)" question takes the
   * letter. Numbered menus select on the digit alone.
   */
  keys?: string[];
  /** Which option the menu's cursor (❯) is on, when the screen shows one. */
  cursor?: number;
  /** The options are numbered on screen ("❯ 1. Yes"), so typing a number can pick one. */
  numbered?: boolean;
  /**
   * What the menu is about, as its dialog shows it above the question: "Bash command",
   * "rm -rf dist/ && pnpm build". Shown with the options.
   */
  detail?: string[];
  /**
   * The menu and the lines above it up to its dialog's top (at most 40), compared loosely
   * (looseText): tells apart prompts with the same question and options (consecutive
   * permissions, plans), whatever wrapped where on the phone or the server (see menuKey).
   */
  key?: string;
  /**
   * A selection menu (cursor and key hints): typing may select nothing there, or select without
   * confirming, and Enter confirms the option under the cursor, so it is answered by moving the
   * cursor with the arrow keys, then Enter.
   */
  navigate?: boolean;
}

/** The side borders of Claude Code's boxed dialogs ("│ ❯ 1. Yes      │"), kept as spaces. */
function unbox(line: string): string {
  return line.replace(/^(\s*)│/, '$1 ').replace(/\s*│\s*$/, '');
}

/** "shift+tab to approve with this feedback": key hints under an option, not part of it. */
const KEY_HINT = /\b(?:shift\+tab|ctrl\+\w+|tab|esc|enter)\s+to\b/i;

/**
 * The question on line `index`, whole: a narrow terminal wraps "…ready to execute. Would you
 * like to" / "proceed?", so a line starting in lowercase is joined to the rows above it, and
 * the sentence ending in the question mark is kept ("Would you like to proceed?").
 */
function wholeQuestion(lines: string[], index: number): string {
  let text = lines[index].trim();
  for (let k = index - 1; k >= 0 && k >= index - 3 && /^\p{Ll}/u.test(text); k--) {
    const previous = lines[k].trim();
    if (!previous) break;
    text = `${previous} ${text}`;
  }
  const starts = [...text.matchAll(/[.!]\s+(?=\p{Lu})/gu)];
  const last = starts[starts.length - 1];
  return last?.index !== undefined ? text.slice(last.index + last[0].length) : text;
}

/** "Overwrite the file? (y/n)", "Continue? [Y/n]": a yes/no question near the bottom. */
const YES_NO = /^.*\?\s*[([](?:y\/n|yes\/no)[)\]]\s*:?$/i;

/**
 * A menu Claude Code or Codex shows on screen, waiting for an answer: permission prompts, plan
 * approval, AskUserQuestion ("❯ 1. Yes", "2. …", wrapped labels indented), the trust-folder
 * dialog, Codex's update and trust prompts. Boxed dialogs (older Claude Code) are read through
 * their borders. Without a menu, a "(y/n)" question near the bottom is a yes/no choice.
 *
 * A menu has its cursor (❯ or ›) on one option and is the last thing on screen. A numbered
 * list without a cursor is text in an answer ("Which one do you prefer? 1. … 2. …"), not a
 * menu: taken for one, the phone typed a bare "2" there and the server never typed a reply
 * while it stayed on screen (review of 2026-10-03).
 */
/** How a screen's text was laid out (see parseScreenChoices). */
export interface ScreenLayout {
  cols?: number;
  /** Per line: it goes on from the line above, which the terminal soft-wrapped into it. */
  wrappedRows?: boolean[];
  visibleRows?: number;
  /**
   * The width the app drew for: the PTY's, when the text is a client's copy of the screen at
   * a width of its own. Wider than that copy, its rows lost their tails (see
   * parseScreenChoices); narrower, the app's rows fit and are read at this width.
   */
  ptyCols?: number;
}

/**
 * The screen's copy is narrower than the PTY the app drew for: its longer rows lost their
 * tails, so no menu is read off it (see parseScreenChoices).
 */
export function narrowerThanPty(layout: ScreenLayout | undefined): boolean {
  return layout?.ptyCols !== undefined && layout.cols !== undefined && layout.ptyCols > layout.cols;
}

export function parseScreenChoices(
  screenText: string,
  /**
   * Terminal width (a line that fills it is taken as hard-wrapped), or the width plus which
   * rows go on from the one above (the terminal soft-wrapped it), which is exact; and how many
   * of the text's last lines are the visible screen (the rest is scrollback).
   */
  layout?: number | ScreenLayout
): ScreenChoices | null {
  const ptyCols = typeof layout === 'object' ? layout.ptyCols : undefined;
  const localCols = typeof layout === 'number' ? layout : layout?.cols;
  // A copy narrower than the PTY cannot be read (2026-10-04, QA): the phone's terminal stayed
  // at 45 columns after another client resized the PTY to 53, so each of Claude's longer rows
  // spilled its tail onto the next row, which Claude's next row then overwrote. "…access to
  // /Users/alexandr" + "apublicdemouser/…/qa-git from this" read as "/Users/apublicdemouser/…
  // qa-git fproject", its key no longer the server's, and every tap was refused as a changed
  // question. No menu then, until the client's width is the PTY's again.
  if (typeof layout === 'object' && narrowerThanPty(layout)) return null;
  const cols = ptyCols ?? localCols;
  const wrappedRows = typeof layout === 'object' ? layout.wrappedRows : undefined;
  const visibleRows = typeof layout === 'object' ? layout.visibleRows : undefined;
  const raw = screenText.split('\n');
  const lines = raw.map(unbox);
  // A menu drawn inside a box (Gemini, older plans): only then is a box's top its dialog's.
  const boxed = (line: number) => /^\s*│/.test(raw[line] ?? '');
  const options: string[] = [];
  let firstOptionLine = -1;
  let cursor = -1;
  let cursorLine = -1;
  let lastListLine = -1;
  let inHint = false;
  for (let i = 0; i < lines.length; i++) {
    // The cursor: ❯ Claude Code, › Codex, ● Gemini CLI ("● 1. Allow once").
    const match = lines[i].match(/^\s*([❯›●]\s*)?(\d+)\.\s+(.*\S)\s*$/);
    if (
      match &&
      wrappedRows?.[i] !== true &&
      (Number(match[2]) === options.length + 1 || Number(match[2]) === 1)
    ) {
      // A new numbered list further down replaces an earlier one.
      if (Number(match[2]) === 1) {
        options.length = 0;
        firstOptionLine = i;
        cursor = -1;
      }
      if (match[1]) {
        cursor = options.length;
        cursorLine = i;
      }
      options.push(match[3]);
      lastListLine = i;
      inHint = false;
    } else if (
      options.length > 0 &&
      (/^\s{4,}\S/.test(lines[i]) || (wrappedRows?.[i] === true && lines[i].trim() !== ''))
    ) {
      // A row the terminal soft-wrapped starts at column 0 (the PTY narrower than the menu
      // Claude drew, until it redraws): it goes on the option all the same. It was dropped,
      // and "…for pnpm build commands in /Users/…" read "…for pnpm build /Users/…"
      // (2026-10-12 QA, iPhone SE).
      lastListLine = i;
      // Key hints under an option (and the rows they wrap onto) are not part of its label.
      if (inHint || KEY_HINT.test(lines[i])) {
        inHint = true;
        continue;
      }
      const midWord = continuesMidWord(lines, i, cols, wrappedRows);
      options[options.length - 1] += `${midWord ? '' : ' '}${lines[i].trim()}`;
    }
  }
  if (
    options.length >= 2 &&
    cursor >= 0 &&
    !screenGoesOn(lines, cursorLine) &&
    !isInputDraft(lines, firstOptionLine, cursorLine, lastListLine)
  ) {
    let question = '';
    for (let k = firstOptionLine - 1; k >= Math.max(0, firstOptionLine - 3) && !question; k--) {
      if (lines[k].trim().endsWith('?')) question = wholeQuestion(lines, k);
    }
    // Answered with the cursor too: what a digit does differs between such screens (Codex's
    // update prompt confirms on it, its trust prompt only selects, 2026-10-03).
    const labels = options.map(withoutGluedHint);
    const top = dialogTop(lines, firstOptionLine, boxed(firstOptionLine));
    return withDetail(
      {
        question: question || menuQuestion(lines, firstOptionLine),
        options: labels,
        cursor,
        navigate: true,
        numbered: true,
        key: menuKey(lines, firstOptionLine, labels, top, visibleRows),
      },
      lines,
      firstOptionLine,
      top
    );
  }
  return parseCursorMenu(lines, { cols, wrappedRows, visibleRows }, boxed) ?? parseYesNo(lines);
}

/**
 * Whether row i continues row i - 1 in the middle of a word. The terminal marks the rows it
 * soft-wrapped into (ghostty's isRowWrapped is true on the row that goes on, checked
 * 2026-10-03). A row Claude ended itself is a word boundary even when it fills the width
 * (2026-10-02: "/tmp/vtqa-perm" + "from" was joined as "vtqa-permfrom"), unless Claude cut
 * there a word too long for its box (2026-10-03, 45 columns:
 * "/Users/alexandrapublicdemouser/.untethe" + "r-qa/qa-git" read as two words): a word that
 * fit would have gone to the next row whole, so the two pieces together outgrow the box, and
 * what goes on is no plain word ("/Users/…/Projects" + "from" when the path just fit). Widths
 * in columns: a wide character takes two. Without the terminal's information, a full row is
 * taken as soft-wrapped.
 */
function continuesMidWord(
  lines: string[],
  i: number,
  cols: number | undefined,
  wrappedRows: boolean[] | undefined
): boolean {
  if (wrappedRows?.[i] === true) return true;
  const row = lines[i - 1].trimEnd();
  const full = cols !== undefined && columns(row) >= cols - 1;
  if (!wrappedRows) return full;
  if (!full || cols === undefined) return false;
  const tail = row.match(/\S+$/)?.[0] ?? '';
  const head = lines[i].trim().match(/^\S+/)?.[0] ?? '';
  if (/^\p{L}+[,.;:!?)]*$/u.test(head)) return false;
  return columns(tail) + columns(head) > cols - indentOf(lines[i]);
}

/** East Asian wide characters and emoji, which take two columns in the terminal. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** How many columns a line of the screen's text takes (each cell read as one character). */
function columns(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

const SHIFT_TAB_HINT = '(shift+tab)';

/**
 * Claude Code 2.1 at a phone's width (45 columns) leaves the tail of an option's "(shift+tab)"
 * hint glued to the next option when it redraws: "3. Nohift+tab)" (2026-10-03, its own output,
 * not the terminal's). A label ending in part of that hint stuck to a letter loses it; a whole
 * "(shift+tab)" after a space is a real hint and stays.
 */
function withoutGluedHint(label: string): string {
  if (label.endsWith(SHIFT_TAB_HINT)) return label;
  for (let k = 1; k < SHIFT_TAB_HINT.length - 3; k++) {
    const tail = SHIFT_TAB_HINT.slice(k);
    if (label.endsWith(tail) && /\p{L}$/u.test(label.slice(0, -tail.length))) {
      return label.slice(0, -tail.length);
    }
  }
  return label;
}

/**
 * Text compared loosely: the same on the phone and the server whatever wrapped where (rows of
 * a different width, labels joined with or without a space). Both read a cell's first code
 * point only. Decomposed, without marks, and only letters, digits and ASCII signs: letters of
 * any script, since without them two questions in Chinese, or "rm -rf ./测试" and
 * "rm -rf ./文档", read as the same (fourth review of 2026-10-03); never rules, boxes or
 * symbols, whose length follows the terminal's width.
 */
export function looseText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\x21-\x7e]/gu, '');
}

/**
 * Claude Code 2.1's warning in its dialog: "⚠ Claude Code will automatically block this request
 * in 1:59, to avoid holding up an unattended session". Its clock ticks every second, so a key
 * holding it was another menu at every read and every answer from the phone was refused as "the
 * prompt changed" (2026-11-09, Spain Assist). Only this line, by its glyph and its outdented
 * start: a command's rows are indented or boxed, and a clock in a command must stay in the key,
 * or an old tap would approve "rm /tmp/in1:21" for "rm /tmp/in1:20" (review of 2026-11-09).
 */
const COUNTDOWN_WARNING = /^\s{0,2}⚠\s*Claude Code will automatically\b/;
const COUNTDOWN_TIME =
  /\bin\s+(?:\d{1,3}:[0-5]\d|\d{1,4}\s*(?:seconds?|secs?|s|minutes?|mins?|m))\b/;
/** Rows a narrow terminal can wrap that warning onto. */
const COUNTDOWN_MAX_ROWS = 4;

/** The dialog's rows above its options, the warning's clock taken out (it may wrap). */
function withoutCountdown(rows: string[]): string[] {
  let at = rows.length - 1;
  while (at >= 0 && !COUNTDOWN_WARNING.test(rows[at])) at--;
  if (at < 0) return rows;
  let end = at + 1;
  while (
    end < rows.length &&
    end < at + COUNTDOWN_MAX_ROWS &&
    rows[end].trim() &&
    !rows[end].trim().endsWith('?')
  ) {
    end++;
  }
  const warning = rows.slice(at, end).join(' ').replace(COUNTDOWN_TIME, 'in');
  return [...rows.slice(0, at), warning, ...rows.slice(end)];
}

/** How far above its options a menu's key and detail look for its dialog's top. */
const KEY_LINES = 40;

/**
 * The nearest top of the menu's dialog above it (see menuKey), or -1. Not a rule that closes a
 * preview opened by a dashed line above it: Claude Code 2.1's plan draws its text between
 * "╌╌╌" and "───", then the question, and a key from that rule was the same for every plan
 * (fifth review of 2026-10-03). Not a box's top unless the menu itself is boxed: a closed box
 * above an unboxed menu is something else, Codex's header with its version and model.
 */
function dialogTop(lines: string[], firstOptionLine: number, boxed: boolean): number {
  for (let i = firstOptionLine - 1; i >= Math.max(0, firstOptionLine - KEY_LINES); i--) {
    if (!DIALOG_TOP.test(lines[i])) continue;
    if (/^\s*[╭┌]/.test(lines[i]) && !boxed) continue;
    if (closesPreview(lines, i)) continue;
    return i;
  }
  return -1;
}

/** The first rule above line `i` is a dashed one: `i` closes the preview it opened. */
function closesPreview(lines: string[], i: number): boolean {
  for (let k = i - 1; k >= Math.max(0, i - KEY_LINES); k--) {
    const line = lines[k].trim();
    if (/^[╌┄]{3,}$/.test(line)) return true;
    if (DIALOG_TOP.test(lines[k]) || /^[─━]{3,}/.test(line)) return false;
  }
  return false;
}

/**
 * A menu's key: its options and the lines above them from its dialog's top, loosely (see
 * ScreenChoices.key). From the top even where it scrolled out of sight: on a short screen
 * (the SE with its keyboard up) the command was above the visible rows, and a key without it
 * took another command's prompt for the same one (fourth review of 2026-10-03). Never above
 * the top: the scrollback there holds what each side kept of older output, reflowed apart by
 * resizes, and keys reading it differed for the same menu (16:46, a reply refused on every
 * try). Without a top in sight (Codex, a dialog taller than 40 lines), the visible rows. A
 * countdown the dialog runs on itself is no part of it (see COUNTDOWN_WARNING).
 */
function menuKey(
  lines: string[],
  firstOptionLine: number,
  options: string[],
  top: number,
  visibleRows?: number
): string {
  const screenTop = visibleRows !== undefined ? lines.length - visibleRows : 0;
  const from = top >= 0 ? top : Math.max(0, firstOptionLine - KEY_LINES, screenTop);
  return looseText([...withoutCountdown(lines.slice(from, firstOptionLine)), ...options].join(''));
}

/**
 * Whether two reads of a menu are of the same one: one key ends the other, since a shorter
 * read (fewer rows, the scrollback cut) sees the end of the same lines. Without both, nothing
 * tells them apart.
 */
export function sameMenuKey(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return true;
  return a.endsWith(b) || b.endsWith(a);
}

/**
 * Two reads of the same menu as shown: the same options and keys. A cut-off read of it stays
 * the same menu (sameMenuKey); a menu with other lines above it (the next command) does not.
 */
export function sameShownMenu(
  a: ScreenChoices | null | undefined,
  b: ScreenChoices | null | undefined
): boolean {
  return (
    !!a &&
    !!b &&
    JSON.stringify(a.options) === JSON.stringify(b.options) &&
    sameMenuKey(a.key, b.key)
  );
}

/** The rule Claude Code draws on top of a dialog, or the top border of a boxed one. */
const DIALOG_TOP = /^\s*[╭┌]?─{3,}/;
/** Rules inside a dialog: the dashed ones around a file's preview. */
const INNER_RULE = /^[─╌┄━]{3,}$/;

/**
 * Codex's approval has no rule on top (codex-cli 0.164, 2026-11-10): what it asks to run comes
 * under its question as "$ command" (a long one goes on in the rows below it), with a
 * "Reason: …" line when the model gave one. That command is its detail, so the phone shows
 * what a "Yes, proceed" approves; nothing else of the screen ever is (its header box, the
 * conversation above). Other menus without a top (trust, update) have none.
 */
function withCommandDetail(choices: ScreenChoices, lines: string[], firstOptionLine: number) {
  const from = Math.max(0, firstOptionLine - KEY_LINES);
  let question = -1;
  for (let i = firstOptionLine - 1; i >= from && question < 0; i--) {
    if (lines[i].trim().endsWith('?')) question = i;
  }
  if (question < 0) return choices;
  const rows = lines.slice(question + 1, firstOptionLine).map((row) => row.trim());
  const at = rows.findIndex((row) => /^\$ \S/.test(row));
  if (at < 0) return choices;
  let command = rows[at].slice(2);
  for (let k = at + 1; k < rows.length && rows[k] !== ''; k++) command += ` ${rows[k]}`;
  const reason = rows.find((row) => /^Reason:\s*\S/.test(row))?.replace(/^Reason:\s*/, '');
  return { ...choices, detail: [command, ...(reason ? [reason] : [])] };
}

/**
 * Adds what a menu is about: the lines its dialog shows between its top rule and the question
 * ("Bash command", "rm -rf dist/ && pnpm build", "Remove the stale build output"), at most
 * three. Consecutive permission prompts ask the same question with the same options; without
 * this a late tap approved the next command, which no phone surface showed (review of
 * 2026-10-03). Without its dialog's top in the text (Codex), only the command of an approval
 * (withCommandDetail): lines the key covers.
 */
function withDetail(choices: ScreenChoices, lines: string[], firstOptionLine: number, top: number) {
  if (top < 0) return withCommandDetail(choices, lines, firstOptionLine);
  const rows: string[] = [];
  let inTip = false;
  for (const row of lines.slice(top + 1, firstOptionLine)) {
    // An inner box's borders and a leading status icon (Gemini's "?  Shell rm -rf build").
    const line = row
      .trim()
      .replace(/^│\s*|\s*│$/g, '')
      .replace(/^[?!•●⏺✓✗⚠]\s+/u, '');
    // The question ends the detail; a "?" inside a line ("trust? (Like your own") does not,
    // nor a title asking one (Claude Code 2.1's plan: "Ready to code?", then the plan).
    if (line.endsWith('?') && rows.length > 0) break;
    // Claude Code 2.1's "Tip: auto mode handles these prompts for / you — choose …" and its
    // "Claude Code will automatically block this request in 1:59, …": not what the prompt is
    // about, and they pushed the command out of the three lines.
    if (/^(tip:|claude code will automatically)/i.test(line) || (inTip && /^\p{Ll}/u.test(line))) {
      inTip = true;
      continue;
    }
    inTip = false;
    rows.push(line);
  }
  // Its title, then the line above the dashed block and the block's first line: "Bash
  // command · Create empty file nuevo.txt · touch nuevo.txt", "Edit file · diez.txt · 6 +seis".
  const block = rows.findIndex((line) => INNER_RULE.test(line));
  const words = rows.filter((line) => line && !INNER_RULE.test(line));
  const detail =
    block > 0
      ? [
          words[0],
          rows.slice(0, block).filter(Boolean).pop(),
          // In a diff, the first changed line ("6 +seis"), not the context above it ("3  FIN").
          rows.slice(block + 1).find((line) => /^\d+ ?[+-]/.test(line)) ??
            rows.slice(block + 1).find((line) => line && !INNER_RULE.test(line)),
        ].filter((line, index, all): line is string => !!line && all.indexOf(line) === index)
      : words.slice(0, 3);
  return detail.length > 0 ? { ...choices, detail } : choices;
}

/**
 * A numbered list typed into the agent's own input box, not a menu (review of 2026-10-03:
 * read as one, its lines became buttons and "1" pressed Enter on the unfinished draft).
 * Claude Code draws a rule right above its input; a menu has its question or title there.
 * Codex's composer starts with › like its menus, which always say "Press enter to …" under
 * their options.
 */
function isInputDraft(
  lines: string[],
  firstOptionLine: number,
  cursorLine: number,
  lastListLine: number
): boolean {
  if (/^\s*─{3,}/.test(lines[firstOptionLine - 1] ?? '')) return true;
  if (!lines[cursorLine].trimStart().startsWith('›')) return false;
  const below = lines
    .slice(lastListLine + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return !below.some((line) => MENU_HINT.test(line));
}

/**
 * Whether the screen goes on below a menu's cursor line the way it never does under a menu
 * that waits for an answer: another cursor or prompt line, or Claude's output. Claude Code
 * 2.1 shows the user's past messages as "❯ text" (a numbered one as "❯ 1. …") above its own
 * "❯" input line, and its answers start with ⏺; Codex's composer starts with ›.
 */
function screenGoesOn(lines: string[], cursorLine: number): boolean {
  return lines.slice(cursorLine + 1).some((line) => /^\s*[❯›⏺]/.test(line));
}

/**
 * "Enter to confirm · Esc to cancel", "Press enter to continue": the key hints under a
 * selection menu, the key named right before "to" ("Enter a name to continue" is not one).
 * Codex 0.163 writes them without "to", a key and its action between dots ("enter continue ·
 * esc back"): its trust dialog read as a draft in its composer, was never answered, and two
 * tasks' briefs waited 30 min for it (2026-10-23).
 */
const MENU_HINT = /\b(?:enter|esc)\s+to\b|^\s*(?:enter|esc)\s+\p{L}+\s*·/iu;
/** The rule Claude Code draws above and below its own prompt. */
const RULE = /^\s*─{3,}\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * A selection menu with its cursor on one option, read when the numbered reading finds
 * nothing (no question mark next to it, or no numbers): Claude Code's trust-folder dialog,
 * "❯ No, exit" over "  Yes, I trust this folder" (v2.1.288). Typing does nothing there and
 * Enter confirms the highlighted option: answering it with "Sí" from the phone exited Claude
 * (2026-10-03). Only taken as a menu with its key hints under it, since Claude's own prompt
 * starts with ❯ too and a draft of several lines is indented like options.
 */
function parseCursorMenu(
  lines: string[],
  layout: ScreenLayout,
  boxed: (line: number) => boolean
): ScreenChoices | null {
  let cursorLine = -1;
  for (let i = lines.length - 1; i >= 0 && cursorLine < 0; i--) {
    if (/^\s*[❯›]\s+\S/.test(lines[i])) cursorLine = i;
  }
  const marker = cursorLine >= 0 ? lines[cursorLine].match(/^\s*[❯›]\s+/) : null;
  if (!marker || screenGoesOn(lines, cursorLine)) return null;
  // Options start where the cursor line's label does; deeper lines continue a wrapped label.
  const column = marker[0].length;
  // A row the terminal soft-wrapped into goes on the one above, whatever its indent.
  const inMenu = (i: number) => {
    const line = lines[i];
    if (line === undefined || line.trim() === '') return false;
    return indentOf(line) >= column || layout.wrappedRows?.[i] === true;
  };
  let first = cursorLine;
  while (inMenu(first - 1)) first--;
  while (first < cursorLine && indentOf(lines[first]) !== column) first++;
  let last = cursorLine;
  while (inMenu(last + 1)) last++;
  if (RULE.test(lines[last + 1] ?? '') && RULE.test(lines[first - 1] ?? '')) return null;
  const hints = lines
    .slice(last + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!hints.some((line) => MENU_HINT.test(line))) return null;
  const options: string[] = [];
  let cursor = -1;
  for (let i = first; i <= last; i++) {
    const line = i === cursorLine ? lines[i].replace(/[❯›]/, ' ') : lines[i];
    if (indentOf(line) === column && layout.wrappedRows?.[i] !== true) {
      if (i === cursorLine) cursor = options.length;
      options.push(line.trim());
    } else if (options.length > 0) {
      const midWord = continuesMidWord(lines, i, layout.cols, layout.wrappedRows);
      options[options.length - 1] += `${midWord ? '' : ' '}${line.trim()}`;
    }
  }
  if (options.length < 2 || cursor < 0) return null;
  const top = dialogTop(lines, first, boxed(first));
  return withDetail(
    {
      question: menuQuestion(lines, first),
      options,
      cursor,
      navigate: true,
      key: menuKey(lines, first, options, top, layout.visibleRows),
    },
    lines,
    first,
    top
  );
}

/**
 * What a menu asks: the sentence up to the first question mark in the nearest paragraph above
 * it that has one ("Quick safety check: Is this a project you created or one you trust?").
 * Without one, a dialog drawn from the top of the screen, or below blank rows (as the phone's
 * copy of the screen has it), has its title on its first line ("✨ Update available! 0.155.1
 * -> 0.160.0", Codex); otherwise the line just above the menu. Looks at most 16 lines up.
 */
function menuQuestion(lines: string[], first: number): string {
  const start = Math.max(0, first - 16);
  const above = lines.slice(start, first).map((line) => line.trim());
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...above, '']) {
    if (line) {
      current.push(line);
    } else if (current.length > 0) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  for (const paragraph of paragraphs.reverse()) {
    const end = paragraph.indexOf('?');
    if (end >= 0) return paragraph.slice(0, end + 1);
  }
  const isWorded = (line: string) => /\p{L}/u.test(line);
  const firstWorded = above.findIndex(isWorded);
  if (firstWorded < 0) return '';
  if (start === 0 || firstWorded > 0) return above[firstWorded];
  return above.filter(isWorded).pop() ?? '';
}

/**
 * The option a typed message picks in a numbered menu: its number ("2"), or a yes/no
 * question's letter ("n"). Anything else is not an answer to the menu but a reply.
 */
export function optionForTyped(text: string, choices: ScreenChoices): number | null {
  const typed = text.trim().toLowerCase();
  if (choices.keys) {
    const index = choices.keys.indexOf(typed);
    return index >= 0 ? index + 1 : null;
  }
  if (!choices.numbered || !/^\d$/.test(typed)) return null;
  const option = Number(typed);
  return option >= 1 && option <= choices.options.length ? option : null;
}

/**
 * A menu's detail where room is short (the list row, the composer's menu): without its title
 * when there is more ("Bash command" says less than the command, which got cut off after it).
 */
export function compactDetail(detail: string[]): string {
  return (detail.length > 2 ? detail.slice(1) : detail).join(' · ');
}

/**
 * Whether a written message can answer this menu as Esc and the text: Esc is Claude's "No, and
 * tell Claude what to do differently" (permissions, plan approval, its questions). Not on a
 * menu that offers to exit or quit (trust this folder, the bypass-permissions warning, Codex's
 * trust prompt), where Esc closes the program.
 */
export function takesReply(choices: ScreenChoices): boolean {
  // The whole label: "exit" in a path or a description ("Calls process.exit(1)") is not it.
  return !choices.options.some((option) =>
    /^(?:no,?\s+)?(?:exit|quit)\b\s*(?:\(.*\))?$/i.test(option.trim())
  );
}

function parseYesNo(lines: string[]): ScreenChoices | null {
  const bottom = lines.flatMap((line, index) => (line.trim() ? [index] : [])).slice(-4);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const question = lines[bottom[i]].trim();
    if (YES_NO.test(question) && !screenGoesOn(lines, bottom[i])) {
      return { question, options: ['Yes', 'No'], keys: ['y', 'n'] };
    }
  }
  return null;
}
