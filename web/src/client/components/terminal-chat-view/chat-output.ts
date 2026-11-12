import { html, nothing } from 'lit';
import { getLocale, t } from '../../i18n/index.js';
import { icon } from '../icons.js';
import { TerminalChatViewBase } from './base.js';
import { GLYPHS_ONLY, isPaintedNoise, isSpinnerStatus, PAINTED } from './chat-text.js';
import { loadRecentCommands } from './composer-storage.js';
import { type ChatMessage, type InteractiveOption, logger, MAX_MESSAGE_LENGTH } from './shared.js';

/** The chat view: terminal output turned into messages, and the input line kept in sync. */
export abstract class TerminalChatOutput extends TerminalChatViewBase {
  protected subscribeToTerminalOutput(): void {
    this.unsubscribeFromTerminalOutput();
    // The view stays mounted (hidden) outside chat mode. Listening then appended every
    // byte of output to one ever-growing message; with redraw-heavy apps (Claude Code)
    // the string got so large that rendering it crashed Safari's web process.
    if (!this.active || this.composerOnly || !this.subscribeToOutput || !this.isConnected) return;

    this.outputUnsubscribe = this.subscribeToOutput((data: string) => {
      this.processTerminalOutput(data);
    });
  }

  protected unsubscribeFromTerminalOutput(): void {
    this.outputUnsubscribe?.();
    this.outputUnsubscribe = undefined;
    // The pending tail survives a resubscribe (the source is re-handed on re-renders); the
    // next chunk restarts its flush timer.
    if (this.pendingOutputTimer) clearTimeout(this.pendingOutputTimer);
    this.pendingOutputTimer = undefined;
  }

  /**
   * Start periodic sync from terminal to keep lastSentValue in sync
   * This prevents drift between chat input and terminal state
   */
  protected startTerminalSync(): void {
    if (this.syncInterval) return; // Already running

    const SYNC_INTERVAL_MS = 300;
    const SYNC_DELAY_AFTER_INPUT_MS = 500; // Wait after user stops typing

    this.syncInterval = setInterval(() => {
      // Only sync if user hasn't typed recently
      const timeSinceLastInput = Date.now() - this.lastInputTime;
      if (timeSinceLastInput < SYNC_DELAY_AFTER_INPUT_MS) {
        return;
      }

      this.syncLastSentValueFromTerminal();
    }, SYNC_INTERVAL_MS);

    logger.debug('Terminal sync started');
  }

  protected stopTerminalSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      logger.debug('Terminal sync stopped');
    }
  }

  /**
   * Sync lastSentValue with what's actually in the terminal
   * This corrects any drift between our tracking and terminal state
   */
  protected syncLastSentValueFromTerminal(): void {
    if (!this.getTerminalInputLine) return;

    const terminalInput = this.getTerminalInputLine();
    if (terminalInput === null || terminalInput === undefined) return;

    // Clean up terminal input (remove TUI artifacts)
    // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
    const controlCharPattern = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
    const cleanedInput = terminalInput
      .replace(controlCharPattern, '')
      .replace(/[│┃┆┇┊┋|]/g, ' ')
      .replace(/[─━┄┅┈┉═]/g, '')
      .replace(/[╭╮╰╯┌┐└┘]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Update lastSentValue if different - this fixes drift
    if (this.lastSentValue !== cleanedInput) {
      logger.debug(`Syncing lastSentValue: "${this.lastSentValue}" -> "${cleanedInput}"`);
      this.lastSentValue = cleanedInput;
    }
  }

  /**
   * Sync input from terminal with retry - gives time for buffer to fully load
   */
  protected syncFromTerminalWithRetry(attempt = 0): void {
    if (!this.active || !this.isConnected || !this.getTerminalInputLine) return;

    let terminalInput = this.getTerminalInputLine();

    if (terminalInput) {
      // Aggressively clean up TUI artifacts and special characters
      // biome-ignore lint/complexity/useRegexLiterals: Avoiding control character lint errors
      const ctrlPattern = new RegExp('[\\x00-\\x1F\\x7F]', 'g');
      terminalInput = terminalInput
        .replace(ctrlPattern, '') // Remove control characters
        .replace(/[│┃┆┇┊┋|]/g, ' ') // Replace box-drawing pipes with space
        .replace(/[─━┄┅┈┉═]/g, '') // Remove horizontal lines
        .replace(/[╭╮╰╯┌┐└┘]/g, '') // Remove corners
        .replace(/\s+/g, ' ') // Collapse multiple spaces to one
        .trim();

      if (terminalInput) {
        // Set input value directly on DOM element (not via reactive binding)
        if (this.inputElement) {
          this.inputElement.value = terminalInput;
          this.composerEmpty = !terminalInput.trim();
        }
        return;
      }
    }

    if (attempt < 3) {
      // Retry after a short delay (buffer might still be loading)
      this.scheduleDelayedTask(() => this.syncFromTerminalWithRetry(attempt + 1), 150);
    }
  }

  /**
   * PTY output arrives in arbitrary chunks (a shell echo can come one keystroke at a time).
   * Treating each chunk as a line rendered `echo hola` as a column of fragments and could
   * drop letters (2026-10-12). Complete lines are processed as they arrive; the unterminated
   * tail waits here and is shown after a short idle (prompts, progress) without being
   * cleared, so when its line completes it replaces the partial via the redraw rule.
   */
  protected pendingOutputLine = '';

  /** The unterminated tail as it was shown after its idle, until its line ends. */
  protected shownPartialLine = '';

  protected pendingOutputTimer?: ReturnType<typeof setTimeout>;

  protected static readonly PARTIAL_LINE_FLUSH_MS = 150;

  protected processTerminalOutput(data: string) {
    // Plain text, with where the cursor jumped to another row marked (see toChatText).
    const cleanData = TerminalChatOutput.toChatText(data);

    // A lone space is part of the line being echoed: it joins the pending tail too.
    if (!cleanData) return;

    const parts = `${this.pendingOutputLine}${cleanData}`.split(/\r?\n/);
    this.pendingOutputLine = TerminalChatOutput.applyLineEdits(parts.pop() ?? '');
    const lines = parts.map((part) => TerminalChatOutput.applyLineEdits(part));
    // The tail already shown after its idle, now ended as it was: shown once, not twice
    // (a TUI's text painted at a position is ended by the next move, 2026-10-12).
    if (lines.length > 0) {
      if (this.shownPartialLine && lines[0] === this.shownPartialLine) lines.shift();
      this.shownPartialLine = '';
    }

    if (this.pendingOutputTimer) clearTimeout(this.pendingOutputTimer);
    this.pendingOutputTimer = undefined;
    if (this.pendingOutputLine.trim()) {
      this.pendingOutputTimer = setTimeout(() => {
        this.pendingOutputTimer = undefined;
        this.shownPartialLine = this.pendingOutputLine;
        this.processOutputLines([this.pendingOutputLine], true);
      }, TerminalChatOutput.PARTIAL_LINE_FLUSH_MS);
    }

    this.processOutputLines(lines, false);
  }

  /**
   * PTY output as chat text. A full-screen TUI (Claude Code's differential renderer, Ink's
   * redraws) paints cells with cursor moves and no newlines: with the moves just removed, a
   * spinner's frames, its counters and the logo's block glyphs ran together into one bubble
   * ("Musing…5", "29203✽Pondering…", 2026-10-12). A move to another row (absolute position,
   * up/down, next/previous line, a row, a clear) now ends the line, and what follows starts
   * with PAINTED: text painted somewhere on the screen, kept only if it reads as words
   * (isPaintedNoise). Column moves are a carriage return; cursor forward is a space; other
   * escapes and control characters (BEL) go.
   */
  static toChatText(data: string): string {
    return (
      data
        // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control characters
        .replace(/[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, (ch) => (ch === '\x07' ? ch : ''))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC (titles, links) to BEL or ST
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the BEL left after OSC
        .replace(/\x07/g, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: cursor to another row, clear
        .replace(/\x1b\[[\d;?]*[HfABEFdJ]/g, `\n${PAINTED}`)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: cursor to a column
        .replace(/\x1b\[\d*G/g, '\r')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: cursor forward
        .replace(/\x1b\[\d*C/g, ' ')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: any other CSI sequence
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: charset and two-byte escapes
        .replace(/\x1b(?:[()*+][\x20-\x7e]|[\x20-\x7e])?/g, '')
    );
  }

  /** Resolve a lone \r (cursor to column 0, line redrawn) and backspaces within one line. */
  protected static applyLineEdits(line: string): string {
    // Painted somewhere on the screen stays so after a redraw within the line.
    if (line.includes(PAINTED) && line.includes('\r')) {
      return PAINTED + TerminalChatOutput.applyLineEdits(line.split(PAINTED).join(''));
    }
    let text = line;
    const cr = text.lastIndexOf('\r');
    if (cr !== -1) {
      const after = text.slice(cr + 1);
      text = after.trim() ? after : text.slice(0, cr).replace(/\r/g, '');
    }
    if (!text.includes('\b')) return text;
    let out = '';
    for (const ch of text) out = ch === '\b' ? out.slice(0, -1) : out + ch;
    return out;
  }

  protected processOutputLines(lines: string[], partial: boolean) {
    // Get the last command sent to filter out its echo
    // A backwards scan: copying the array for every chunk of output was wasted work.
    let lastCommand = '';
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === 'command') {
        lastCommand = this.messages[i].content;
        break;
      }
    }

    // Get current input value to filter out live echo
    const currentInput = this.inputElement?.value.trim() || '';

    for (const rawLine of lines) {
      const painted = rawLine.includes(PAINTED);
      const line = painted ? rawLine.split(PAINTED).join('') : rawLine;
      let trimmedLine = line.trim();

      // 1. Filter out noise (separators, spinners, system prompts)
      if (!trimmedLine) continue;

      // Filter echo of executed command
      if (lastCommand && (trimmedLine === lastCommand || trimmedLine.endsWith(lastCommand)))
        continue;

      if (partial) {
        // A bare shell prompt ("bash-3.2$", "~/dir %") is chrome, not a message.
        if (/^[\w.@:/-]*[a-zA-Z~][\w.@:/~-]*\s?[$#%>]$/.test(trimmedLine)) continue;
        // The echo of the command being typed or just sent, still arriving from the shell.
        const afterPrompt = trimmedLine.replace(/^.*?[$#%>]\s/, '');
        const echoOf = (text: string) =>
          text.length > 0 && (lastCommand.startsWith(text) || currentInput.startsWith(text));
        if (echoOf(trimmedLine) || echoOf(afterPrompt)) continue;
      }

      // Filter live echo of current typing
      // We strip common prompt chars and box borders to check if the content matches what we are typing
      const cleanContent = trimmedLine
        .replace(/^[\s│]*[>·$#]\s?/, '') // Remove leading prompt/box
        .replace(/[│\s]*$/, ''); // Remove trailing box/space

      if (currentInput && cleanContent && currentInput.startsWith(cleanContent)) {
        continue;
      }

      // Filter TUI noise (boxes, status bars, spinners)
      if (this.isNoiseLine(trimmedLine)) continue;
      if (painted && isPaintedNoise(trimmedLine)) continue;

      // Clean up leading symbols (spinners, prompts)
      // Includes braille patterns for spinners and various bullets
      trimmedLine = trimmedLine.replace(/^[\s]*[·⏵>⏺✻✽✶✳✢✦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s?/, '');

      // If line became empty after cleaning, skip
      if (!trimmedLine.trim()) continue;

      // 2. Append to current message or create new one
      this.appendOutputToChat(trimmedLine.trim());
    }
  }

  protected isNoiseLine(line: string): boolean {
    // Box borders and horizontal lines
    if (line.match(/^[─_━\s╭╮╰╯│]+$/)) return true;
    // Spinner and status frames ("✻ Musing… (5s · esc to interrupt)", "Working…12") and lines
    // of glyphs alone (block elements of a logo, box drawing, spinner marks).
    if (isSpinnerStatus(line) || GLYPHS_ONLY.test(line)) return true;

    // Very short lines that are likely noise (single chars like ~, >, etc)
    const trimmed = line.trim();
    // (A number a command printed, "42", is output.)
    if (trimmed.length <= 2 && !/^[\p{L}\p{N}]{1,2}$/u.test(trimmed)) return true;

    // Thinking/processing indicators (Gemini, Claude CLI)
    if (
      line.includes('Thinking') ||
      line.includes('Thought for') ||
      line.includes('ctrl+o to show') ||
      line.match(/^∴/) || // Gemini thinking symbol
      line.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/) || // Braille spinners
      line.includes('Processing') ||
      line.includes('Generating')
    ) {
      return true;
    }

    // Permission dialogs - keep interactive options visible but filter noise
    if (
      line.includes('current working directory') ||
      line.includes('Shell ') || // Shell command headers
      line.includes('(Cre') || // Truncated "(Create..." etc
      line.includes('(Deleti') || // Truncated "(Deleting..." etc
      line.match(/^[?!]\s+Shell/) || // Permission prompt headers
      line.includes('← │') || // TUI box edges
      line.includes('│ ?') ||
      line.includes('Waiting for user')
    ) {
      return true;
    }

    // Specific Gemini/Claude TUI elements
    if (
      line.includes('Gemini CLI update available') ||
      line.includes('Installed via Homebrew') ||
      line.includes('Using:') || // Gemini "Using: - X GEMINI.md files"
      trimmed === 'Usi' || // Partial "Using:" (streaming)
      trimmed === 'ng:' || // Partial "Using:" continued
      line.includes('GEMINI.md') || // Config file references
      line.includes('CLAUDE.md') || // Config file references
      line.match(/^-\s*\d+\s*(GEMINI|CLAUDE|\.md)/i) || // "- 4 GEMINI.md files" pattern
      line.includes('Type your message or @path') ||
      line.includes('no sandbox') || // Status bar - filter any line with this
      line.includes('Converting coffee into code') ||
      line.includes('Considering the Greeting') ||
      line.includes("I'm Feeling Lucky") ||
      line.includes('esc to cancel') ||
      line.includes('esc to interrupt') ||
      line.includes('bypass permissions on') ||
      line.includes('Marinating') ||
      line.includes('Clauding') ||
      line.includes('Simmering') ||
      line.includes('enable IDE integration') ||
      line.includes('Queued (press') ||
      line.includes('Tip: Open the Command Palette')
    ) {
      return true;
    }

    // Status bar fragments - be more aggressive
    if (line.match(/^~\/.*no sandbox/)) return true;
    if (trimmed === 'auto' || trimmed === 'manual' || trimmed === 'plan') return true;
    if (line.match(/^\s*(auto|manual|plan)\s*$/)) return true;

    // Boxed content (lines starting and ending with │) that looks like noise
    if (line.startsWith('│') && line.endsWith('│')) {
      // Assume it's a TUI box if it's short or matches known patterns
      // (We already caught specific messages above, but this catches generic boxes)
      // To be safe, we only filter if it contains "update" or "Homebrew" which we already did.
      // Let's filter empty box lines
      if (line.replace(/[│\s]/g, '').length === 0) return true;
    }

    return false;
  }

  protected appendOutputToChat(content: string) {
    const lastMsg = this.messages[this.messages.length - 1];

    // If last message is from System (output), append to it
    if (lastMsg && lastMsg.type === 'output') {
      const lastLines = lastMsg.content.split('\n');
      const lastLine = lastLines[lastLines.length - 1].trim();

      // Replace only a progressive redraw of the trailing line. Exact repeated output
      // is meaningful terminal content and must remain visible.
      // e.g., lastLine = "Hello", content = "Hello, how are you?"
      if (content.length > lastLine.length && content.startsWith(lastLine) && lastLine.length > 0) {
        // Replace last line with the longer version
        if (lastLines.length > 1) {
          lastLines[lastLines.length - 1] = content;
          lastMsg.content = lastLines.join('\n');
        } else {
          lastMsg.content = content;
        }
        this.requestUpdate();
        this.scrollToBottom();
        return;
      }

      // Normal case: append new content, keeping only the tail of very long output.
      const appended = `${lastMsg.content ? `${lastMsg.content}\n` : ''}${content}`;
      lastMsg.content =
        appended.length > MAX_MESSAGE_LENGTH ? appended.slice(-MAX_MESSAGE_LENGTH) : appended;
      this.requestUpdate();
      this.scrollToBottom();
    } else {
      // Create new system message
      this.addMessage('output', content);
    }
  }

  protected addMessage(type: ChatMessage['type'], content: string) {
    if (!content.trim()) return;

    // Detect if this is an error message
    const isError = this.detectError(content);
    const messageType = isError ? 'error' : type;

    this.messages = [
      ...this.messages,
      {
        type: messageType,
        content: content.trim(),
        timestamp: new Date(),
        id: `msg-${this.messageIdCounter++}`,
      },
    ];
  }

  protected detectError(str: string): boolean {
    const errorKeywords = [
      'error',
      'failed',
      'cannot',
      'permission denied',
      'not found',
      'fatal',
      'exception',
      'traceback',
    ];
    const lowerStr = str.toLowerCase();
    return errorKeywords.some((keyword) => lowerStr.includes(keyword));
  }

  protected scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesContainer) {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      }
    });
  }

  protected formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  /** detectInteractiveOptions per message, kept until its text or the language changes. */
  private readonly optionsCache = new WeakMap<
    ChatMessage,
    { content: string; locale: string; options: InteractiveOption[] | null }
  >();

  /**
   * 2026-11-10: every render ran up to five regexes over up to 20 000 characters for EVERY
   * message; a message's options only change when its text does.
   */
  protected interactiveOptionsOf(msg: ChatMessage): InteractiveOption[] | null {
    const locale = getLocale();
    const cached = this.optionsCache.get(msg);
    if (cached && cached.content === msg.content && cached.locale === locale) {
      return cached.options;
    }
    const options = this.detectInteractiveOptions(msg.content);
    this.optionsCache.set(msg, { content: msg.content, locale, options });
    return options;
  }

  protected detectInteractiveOptions(content: string): InteractiveOption[] | null {
    // Detect Gemini CLI permission format like:
    // ● 1. Yes, allow once
    //   2. Yes, allow always ...
    //   3. No, suggest changes (esc)
    const geminiPattern = /[●\s]*(\d+)\.\s+(.+?)(?:\s*\.{3}|\s*\(esc\))?$/gm;
    const geminiMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(geminiPattern)) {
      const label = match[2]
        .trim()
        .replace(/\s*\.{3}$/, '')
        .replace(/\s*\(esc\)$/, '');
      geminiMatches.push({ label, response: match[1] });
    }

    if (geminiMatches.length >= 2) {
      return geminiMatches;
    }

    // Detect numbered options like:
    // 1) Option one
    // 2) Option two
    const numberedPattern = /^\s*(\d+)\)\s+(.+)$/gm;
    const matches: InteractiveOption[] = [];

    for (const match of content.matchAll(numberedPattern)) {
      matches.push({ label: match[2].trim(), response: match[1] });
    }

    if (matches.length >= 2) {
      return matches;
    }

    // Detect lettered options like:
    // a) Option one
    // b) Option two
    const letteredPattern = /^\s*([a-z])\)\s+(.+)$/gm;
    const letterMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(letteredPattern)) {
      letterMatches.push({ label: match[2].trim(), response: match[1] });
    }

    if (letterMatches.length >= 2) {
      return letterMatches;
    }

    // Detect bracketed options like:
    // [1] Option one
    // [2] Option two
    const bracketPattern = /^\s*\[(\d+)\]\s+(.+)$/gm;
    const bracketMatches: InteractiveOption[] = [];

    for (const match of content.matchAll(bracketPattern)) {
      bracketMatches.push({ label: match[2].trim(), response: match[1] });
    }

    if (bracketMatches.length >= 2) {
      return bracketMatches;
    }

    // Detect yes/no questions
    if (/\(y\/n\)|\[y\/n\]|yes\/no/i.test(content)) {
      return [
        { label: t('chat.option.yes'), response: 'y' },
        { label: t('chat.option.no'), response: 'n' },
      ];
    }

    // Detect "Allow execution" prompts
    if (/Allow execution of/i.test(content)) {
      return [
        { label: t('chat.option.allowOnce'), response: '1' },
        { label: t('chat.option.allowAlways'), response: '2' },
        { label: t('chat.option.no'), response: '3' },
      ];
    }

    return null;
  }

  protected handleOptionClick(option: InteractiveOption) {
    if (!this.onSend) return;

    // Send the option response + enter to the terminal
    const input = `${option.response}\r`;
    this.onSend(input);

    // Mark the current message as "answered" by changing it to show just the selected option
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.type === 'output') {
      // Replace the message content with just the selected option
      lastMsg.content = t('chat.selected', { option: option.label });
      this.requestUpdate();
    }

    // Force next output to create a new message by adding a placeholder command
    this.addMessage('command', `[Option ${option.response}]`);

    logger.log(`Selected option ${option.response}: ${option.label}`);
  }

  /**
   * Clean up content when showing interactive options
   * Removes shell box content and other noise to show just the question
   */
  protected cleanContentForOptions(content: string): string {
    const lines = content.split('\n');
    const cleanLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip shell box frames
      if (
        trimmed.match(/^[╭╮╰╯│─┌┐└┘├┤┬┴┼]+$/) ||
        trimmed.match(/^[─━═]+$/) ||
        trimmed.startsWith('│') ||
        trimmed.endsWith('│')
      ) {
        continue;
      }

      // Skip checkmark lines (shell execution confirmations)
      if (trimmed.startsWith('✓') || trimmed.startsWith('✔')) {
        continue;
      }

      // Skip lines that look like shell commands
      if (trimmed.match(/^Shell\s+/) || trimmed.match(/^(mkdir|rm|mv|cp|cd|ls|cat|echo)\s/)) {
        continue;
      }

      // Skip empty lines
      if (!trimmed) continue;

      // Skip option lines (they'll be rendered as buttons)
      if (
        trimmed.match(/^[●○•]\s*\d+\./) || // Gemini option format
        trimmed.match(/^\d+[.)]\s/) || // Numbered options
        trimmed.match(/^[a-z][.)]\s/i)
      ) {
        // Lettered options
        continue;
      }

      cleanLines.push(trimmed);
    }

    // If nothing remains, return a default prompt
    if (cleanLines.length === 0) {
      return t('chat.chooseOption');
    }

    return cleanLines.join('\n');
  }

  /**
   * Extract working directory path from the beginning of a message
   * Returns { path, content } where path is the extracted path (or null) and content is the remaining text
   */
  protected extractPathFromContent(content: string): { path: string | null; content: string } {
    // Match paths like ~/Projects, ~/foo/bar, /Users/something at the start of the message
    const pathMatch = content.match(/^(~\/[^\s\n]+|\/[^\s\n]+)\s*/);
    if (pathMatch) {
      const path = pathMatch[1];
      const remainingContent = content.slice(pathMatch[0].length).trim();
      return { path, content: remainingContent };
    }
    return { path: null, content };
  }

  protected renderMessage(msg: ChatMessage) {
    const isCommand = msg.type === 'command';
    const isError = msg.type === 'error';
    const options = !isCommand ? this.interactiveOptionsOf(msg) : null;

    // Extract path from system messages to show in header
    let { path, content: messageContent } = !isCommand
      ? this.extractPathFromContent(msg.content)
      : { path: null, content: msg.content };

    // When showing interactive options, clean up the content to show just the relevant question
    // Remove shell box content and noise
    if (options) {
      messageContent = this.cleanContentForOptions(messageContent);
    }

    return html`
      <div
        class="chat-message ${msg.type}"
        data-message-id="${msg.id}"
      >
        <div class="message-header">
          <span class="message-icon">
            ${icon(isCommand ? 'chat' : isError ? 'alert' : options ? 'info' : 'terminal', 12)}
          </span>
          <span class="message-sender">
            ${isCommand ? t('chat.sender.you') : t('chat.sender.system')}
          </span>
          ${
            path
              ? html`
            <span class="message-separator">•</span>
            <span class="message-path">${path}</span>
          `
              : ''
          }
          <span class="message-separator">•</span>
          <span class="message-time">${this.formatTime(msg.timestamp)}</span>
        </div>
        <div class="message-bubble ${msg.type}">
          <pre class="message-content">${messageContent}</pre>
          ${
            options
              ? html`
            <div class="interactive-options">
              ${options.map(
                (option, index) => html`
                <button
                  class="ut-surface--badge option-button"
                  @click=${() => this.handleOptionClick(option)}
                >
                  <span class="option-number">${index + 1}</span>
                  <span class="option-text">${option.label}</span>
                </button>
              `
              )}
            </div>
          `
              : ''
          }
        </div>
      </div>
    `;
  }

  /**
   * Desktop empty state (2026-10-12): a quiet tile with the chat icon, what chat mode does, and
   * up to three recent commands to start from. No emoji, no mono except the commands.
   */
  protected renderEmptyState() {
    const recent = loadRecentCommands();
    return html`<div class="ut-chat-empty" data-testid="chat-empty-state">
      <div class="ut-chat-empty-tile" aria-hidden="true">${icon('chat')}</div>
      <p class="ut-chat-empty-title">${t('chat.empty.title')}</p>
      <p class="ut-chat-empty-body">${t('chat.empty.body')}</p>
      ${
        recent.length
          ? html`<div class="ut-chat-suggestions" data-testid="chat-suggestions">
              ${recent.map(
                (command) => html`<button
                  type="button"
                  dir="ltr"
                  title=${command}
                  @click=${() => this.useSuggestion(command)}
                >
                  ${command}
                </button>`
              )}
            </div>`
          : nothing
      }
    </div>`;
  }

  /** A suggestion goes into the box (and to the terminal line, as typing does); Enter sends. */
  protected useSuggestion(command: string) {
    const input = this.inputElement;
    if (!input) return;
    input.value = command;
    this.syncComposerEmpty();
    this.sendDeltaToTerminal(command);
    this.onPendingInputChange?.(command);
    input.focus();
  }

  protected handleContainerClick(e: Event) {
    // On iPad, clicking outside the input loses focus and makes it hard to refocus
    // Always refocus the input when clicking anywhere in the chat view
    const target = e.target as HTMLElement;
    // Don't refocus if clicking on a button (send button, option buttons)
    if (target.tagName !== 'BUTTON' && !target.closest('button')) {
      // Use setTimeout to ensure focus happens after any other handlers
      this.scheduleDelayedTask(() => {
        if (this.inputElement && this.active) {
          this.inputElement.focus();
          logger.log('Chat input focused via container click');
        }
      }, 50);
    }
  }
}
