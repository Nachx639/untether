# Untether Keyboard Shortcuts

The shortcuts the web interface implements, and where each one is defined. Pressing `?` in the
session list (outside a text field) shows the same list in the app.

## App shortcuts

Defined in `web/src/client/utils/browser-shortcuts.ts` (`matchAppShortcut`) and handled in
`web/src/client/app.ts` (`handleAppShortcut`). They use Command only (a Mac, or an iPad with a
keyboard).

| Shortcut | Action | Where |
|----------|--------|-------|
| ⌘K | Open or close the command palette | Anywhere after sign-in |
| ⇧⌘N | New session | Anywhere, unless a dialog is open |
| ⌘, | Settings | Anywhere, unless a dialog is open |
| ⌘O | Browse files | Session list and session view |
| ⌘B | Show or hide the sidebar | Session view |
| ⌘1 … ⌘9 | Go to session 1–9, in the order the sidebar numbers them | Session list and session view |
| ? | Show the shortcut list | Session list, outside text fields |

While ⌘ is held, the sidebar shows the session numbers.

Without Command:

| Shortcut | Action | Where |
|----------|--------|-------|
| Ctrl+O | Browse files | Session list and session view |
| Ctrl+B | Show or hide the sidebar | Not on a Mac |
| Escape | Back to the session list | File browser; session view of an exited session |

In the command palette, ↑ and ↓ move the selection, Enter activates it and Escape closes it.

## Keyboard capture

In a session, keys go to the terminal. Capture decides what happens to the browser's own
shortcuts (`web/src/client/components/session-view/input-manager.ts`, `isKeyboardShortcut`):

- **Capture on** (default): everything not listed under "Always left to the browser" goes to the
  terminal.
- **Capture off**: ⌘ (Mac) or Ctrl (elsewhere) with `A`, `F`, `R`, `L`, `P`, `S` or `D` also
  stays with the browser.

Press Escape twice within 500 ms to switch capture on or off (both Escapes still reach the
terminal), or click the keyboard indicator in the session header.

### Always left to the browser

From `isBrowserShortcut` in `browser-shortcuts.ts` and `isKeyboardShortcut`:

| macOS | Windows/Linux | |
|-------|---------------|---|
| ⌘T, ⌘N, ⌘W, ⌘Q, ⌘H, ⌘M | Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+H | Tabs and windows |
| ⇧⌘T, ⇧⌘N, ⇧⌘A, ⇧⌘Z, ⇧⌘[, ⇧⌘], ⇧⌘J, ⇧⌘C | Ctrl+Shift+T, Ctrl+Shift+N, Ctrl+Shift+J, Ctrl+Shift+C | |
| ⌥⌘W | Alt+F4 | |
| ⌘C, ⌘V, ⌘X | Ctrl+C, Ctrl+V | Copy, paste (Ctrl+X goes to the terminal) |
| ⌘0 | Ctrl+0 … Ctrl+9 | Browser tab switching (⌘1–9 switch sessions on a Mac) |
| F12, ⌥⌘I | F12, Ctrl+Shift+I | Developer tools |
| ⌘Tab, ⌥⌘←, ⌥⌘→ | Alt+Tab | |

On iPhone and iPad every Command chord that is not an app shortcut is left to the system.

## Keys sent to the terminal

Handled in `input-manager.ts`:

| Key | Terminal receives |
|-----|-------------------|
| Ctrl + a letter | The control character (Ctrl+A is `0x01`, …), except the combinations left to the browser above |
| Alt+← / Alt+→ | Previous / next word (`ESC b` / `ESC f`) |
| Alt+Backspace | Delete the previous word (`Ctrl+W`) |
| Enter, Ctrl+Enter, Shift+Enter | Three distinct keys |
| Tab, Shift+Tab | Tab, back-tab |
| Arrows, Escape, Backspace, Delete | The key itself |

Nothing is sent to a session that has exited.

## Selecting and copying

| Shortcut | Action |
|----------|--------|
| ⌘C / Ctrl+C | Copy the terminal selection |
| Shift + drag | Select text where the program in the terminal uses the mouse |
| ⌥ / Alt + drag | Select a block of columns |

## Mobile quick keys

On phones and tablets the terminal has a bar of quick keys
(`web/src/client/components/terminal-quick-keys.ts`). The available keys are listed in
`web/src/client/utils/quick-keys-layout.ts`: Esc, Ctrl, Tab, Shift+Tab, Enter, arrows, PgUp,
PgDn, Home, End, Del, Paste, ⌥, ⌘, `^C`, `^Z`, `^X^S`, F1–F12 and symbols.

**Settings → Mobile Quick Keys → Customize** reorders or hides them. There are three presets
(Default, Compact, Claude (phone)); the layout is stored in the browser, and the Done button,
which dismisses the keyboard, stays fixed.

## Mac app

The menu bar icon's context menu (`mac/Untether/Presentation/Components/StatusBarMenuManager.swift`)
has two key equivalents: ⌘, for Settings… and ⌘Q for Quit Untether.
