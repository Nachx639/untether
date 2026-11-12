function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Code, bold, italics and strikethrough, in text already escaped (no links). */
function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

const anchor = (url: string, label: string) =>
  `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/**
 * Links, inline code, bold, italics and strikethrough, in text already escaped. Links are
 * found in ONE scan and parked behind placeholders until the other rules have run: a second
 * URL rule going over the markup of the first nested an <a> inside an href, and the rest of
 * the URL became attributes, onclick included (XSS found in review, 2026-10-03). Only
 * http(s) links; the placeholder characters are removed from the input first.
 */
function renderInline(escaped: string): string {
  const links: string[] = [];
  const park = (html: string) => `${links.push(html) - 1}`;
  const parked = escaped
    .replace(/[]/g, '')
    .replace(
      /\[([^[\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,!?;:'"])/g,
      (_m, label?: string, url?: string, before?: string, bare?: string) =>
        label !== undefined && url !== undefined
          ? park(anchor(url, renderEmphasis(label)))
          : `${before ?? ''}${park(anchor(bare ?? '', bare ?? ''))}`
    );
  return renderEmphasis(parked).replace(
    /(\d+)/g,
    (_m, index: string) => links[Number(index)] ?? ''
  );
}

/** A heading or a --- / *** / ___ rule: block elements with their own spacing. */
const BLOCK_LINE = /^(?:#{1,6} |(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/;

/**
 * Blank lines right before or after a heading or a rule only add empty lines to its own
 * spacing. Line by line: the regex version backtracked quadratically over long runs of
 * blank lines (40 000 took 1.6 s, review 2026-10-03).
 */
function dropBlankLinesAroundBlocks(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      kept.push(lines[i]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].trim() === '') end++;
    const before = kept[kept.length - 1];
    const after = lines[end];
    const nextToBlock =
      (before !== undefined && BLOCK_LINE.test(before)) ||
      (after !== undefined && BLOCK_LINE.test(after));
    if (!nextToBlock) kept.push(...lines.slice(i, end));
    i = end - 1;
  }
  return kept.join('\n');
}

/**
 * A run of prose in its own element, so the desktop's wide column can hold running text to a
 * comfortable line while code and tables next to it take the whole bubble (2026-11-11).
 */
function renderProse(text: string): string {
  const prose = renderProseLines(text);
  return prose ? `<span class="prose">${prose}</span>` : '';
}

/** Prose: inline formatting, headings, lists and line breaks. */
function renderProseLines(text: string): string {
  // A heading or a rule has its own spacing: blank lines around it only add empty lines.
  const compact = dropBlankLinesAroundBlocks(text);
  return (
    renderInline(escapeHtml(compact))
      // Headings: a bit larger and set apart, so a long answer can be skimmed.
      .replace(
        /^(#{1,6}) (.+)$/gm,
        (_m, hashes: string, title: string) =>
          `<span class="h h${Math.min(hashes.length, 3)}">${title}</span>`
      )
      // A line of ---, *** or ___ separates sections; "> " lines are a quote.
      .replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<span class="hr"></span>')
      .replace(/^&gt; ?(.*)$/gm, '<span class="quote">$1</span>')
      // List items as blocks with a hanging indent, so a wrapped item lines up under its
      // text instead of under the bullet.
      .replace(
        /^( *)[-*] (.*)$/gm,
        (_m, indent: string, item: string) =>
          `<span class="li" style="margin-inline-start:${indent.length * 0.5}em">• ${item}</span>`
      )
      .replace(
        /^( *)(\d{1,3})[.)] (.*)$/gm,
        (_m, indent: string, n: string, item: string) =>
          `<span class="li" style="margin-inline-start:${indent.length * 0.5}em">${n}. ${item}</span>`
      )
      .replace(/<\/span>\n/g, '</span>')
      .replace(/\n(?=<span class="(?:li|quote|hr|h)\b)/g, '')
      .replace(/\n/g, '<br>')
  );
}

/** The cells of a table row; `\|` is a pipe inside a cell. */
function tableCells(line: string): string[] {
  let row = line.trim().replace(/\\\|/g, '\uE000');
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim().split('\uE000').join('|'));
}

const TABLE_DELIMITER_CELL = /^:?-{3,}:?$/;

/** A header line and the delimiter row under it (one `---` per header cell) start a table. */
function startsTable(lines: string[], i: number): boolean {
  if (!lines[i].includes('|') || i + 1 >= lines.length || !lines[i + 1].includes('-')) return false;
  const delimiter = tableCells(lines[i + 1]);
  return (
    delimiter.length === tableCells(lines[i]).length &&
    delimiter.every((cell) => TABLE_DELIMITER_CELL.test(cell))
  );
}

/** A markdown table; wider than the bubble, it scrolls sideways. */
function renderTable(lines: string[]): string {
  const header = tableCells(lines[0]);
  const aligns = tableCells(lines[1]).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''
  );
  const cell = (tag: 'th' | 'td', text: string, column: number) =>
    `<${tag}${aligns[column] ? ` style="text-align:${aligns[column]}"` : ''}>${renderInline(escapeHtml(text))}</${tag}>`;
  const rows = lines.slice(2).map((line) => {
    const cells = tableCells(line);
    return `<tr>${header.map((_, column) => cell('td', cells[column] ?? '', column)).join('')}</tr>`;
  });
  return `<div class="table-wrap"><table><thead><tr>${header
    .map((text, column) => cell('th', text, column))
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** Text outside code blocks: tables (2026-10-03: they showed as raw pipes) and prose. */
function renderText(part: string): string {
  const lines = part.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!startsTable(lines, i)) {
      prose.push(lines[i]);
      continue;
    }
    // The table is a block: blank lines around it would add empty lines too.
    while (prose.length > 0 && prose[prose.length - 1].trim() === '') prose.pop();
    if (prose.length > 0) out.push(renderProse(prose.join('\n')));
    prose = [];
    let end = i + 2;
    while (end < lines.length && lines[end].includes('|') && lines[end].trim() !== '') end++;
    out.push(renderTable(lines.slice(i, end)));
    i = end - 1;
    if (lines[end]?.trim() === '') i++;
  }
  if (prose.length > 0) out.push(renderProse(prose.join('\n')));
  return out.join('');
}

/**
 * Small, safe markdown subset: fenced code, inline code, bold, italics, headings, lists,
 * tables. With `copyLabel`, code blocks get a copy button (handled by delegation in the view).
 */
export function renderChatMarkdown(text: string, copyLabel?: string): string {
  // 2026-11-10: every render re-parsed up to 400 messages. The result depends only on the
  // text and the label, so the last answers are kept (oldest dropped past the limit).
  const key = `${copyLabel ?? ''}\u0000${text}`;
  const cached = markdownCache.get(key);
  if (cached !== undefined) return cached;
  const html = renderChatMarkdownUncached(text, copyLabel);
  if (text.length > MARKDOWN_CACHE_MAX_TEXT) return html;
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    const oldest = markdownCache.keys().next().value;
    if (oldest !== undefined) markdownCache.delete(oldest);
  }
  markdownCache.set(key, html);
  return html;
}

const MARKDOWN_CACHE_MAX = 600;
const MARKDOWN_CACHE_MAX_TEXT = 20_000;
const markdownCache = new Map<string, string>();

function renderChatMarkdownUncached(text: string, copyLabel?: string): string {
  const parts = text.split(/```[^\n]*\n?/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const block = `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
        return copyLabel
          ? `<div class="code-block"><button type="button" class="ut-surface--badge copy-code" data-copy-code>${escapeHtml(copyLabel)}</button>${block}</div>`
          : block;
      }
      // A code block has its own margins: the line breaks around its fences are not empty
      // lines (they left a gap between "Here is the code:" and the block).
      let prose = part;
      if (index > 0) prose = prose.replace(/^\n+/, '');
      if (index < parts.length - 1) prose = prose.replace(/\n+$/, '');
      return renderText(prose);
    })
    .join('');
}
