# Claude Development Notes (web/)

Root `CLAUDE.md` rules apply too (code reference format, package installation policy, refactoring, no backwards compatibility).

## Build process
- **Never run build commands** (`pnpm run build` or similar): the user has `pnpm run dev` running (directly or via
  the Mac app), which watches and compiles TypeScript changes automatically.
- Never manually run the server. The user does that. Exception: the twin (`scripts/gemelo.sh`, `web/scripts/ui-shots.mjs`), and
  the client build ui-shots.mjs runs by itself when `web/public` is missing or older than the code.

## Development workflow
- Make changes to source files in `src/`.
- **ALWAYS run `pnpm run check` before committing**: format, lint and typecheck in parallel; the ONLY check command you need.
- To fix issues: `pnpm run check:fix` (auto-fixes formatting and linting, sequentially to avoid conflicts).
- Individual commands (rarely needed): `pnpm run format` / `format:check`, `pnpm run lint` / `lint:fix`, `pnpm run typecheck`.
- Always fix all linting and type checking errors, including in unrelated code.
- Never run the tests (`pnpm run test`) unless explicitly asked to.
- Tests never make the Mac beep: no Cmd+C/Cmd+X without a selection or editing keys without a focused field in
  WebKit/Chrome; a beep fails the run (`docs/agent-reference.md`, "Tests never beep").

## Refactoring
- We do not care about deprecation or backwards compatibility: everything ships together; the web UI and server
  are always deployed as a unit, so there are no "older UI versions" to support. Remove old code completely.

## Best practices
- ALWAYS use the `Z_INDEX` constants in `src/client/utils/constants.ts`, never primitive / magic z-index numbers.
- Add ids to web elements to make testing simpler (descriptive, e.g. `session-kill-button`, `show-exited-button`,
  `file-picker-choose-button`); prefer `#element-id` selectors over text/DOM-traversal queries; always consider an
  id when adding interactive elements (buttons, inputs).

## CRITICAL: ut command in package.json
**Never add `"ut": "./bin/ut"` to the `bin` section of `package.json` or `package.npm.json`.** `ut` conflicts with
many other tools, so it must not be a global binary; the postinstall script installs it conditionally, creating the
symlink only if `ut` does not already exist.

## CRITICAL: Playwright tests and UI changes
When tests fail looking for UI elements, investigate the actual UI structure:
1. Use semantic ids and `data-testid` attributes; they are more stable than CSS selectors.
2. Understand the UI structure; don't just increase timeouts, find out why elements aren't found.
3. Check for collapsible/expandable sections; many elements are hidden by default.
4. After expanding sections, wait briefly for animations to complete.
5. Wait for 'visible', not just 'attached', for interactive elements.
