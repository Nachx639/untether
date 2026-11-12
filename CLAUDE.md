# CLAUDE.md

Guidance for Claude Code in this repository. Never say you're absolutely right; be critical when you disagree with me and discuss it first.

Untether is a macOS app that gives access to terminal sessions from any web browser: native macOS app
(Swift/SwiftUI) in `mac/`, iOS companion app in `ios/`, web frontend (TypeScript/LitElement) and Node.js/Bun
server in `web/` (its own rules: `web/CLAUDE.md`).

## Where the reference material lives (read on demand)

- `docs/agent-reference.md`: web/test commands, logs (`./scripts/utlog.sh`, never `-f`), dev vs production mode,
  architecture diagram and flows, critical/key files, `ut title` / `ut open` usage, external device testing (the twin on the network)
- `.claude/rules/apple-builds.md` (auto-loaded for `mac/**`, `ios/**`): Poltergeist, xcodebuild builds/tests, SwiftFormat lint, `/fixmac`
- `.claude/rules/tailscale.md` (auto-loaded for Tailscale files): current `tailscale serve` / `funnel` syntax
- Release: when the user says "release" or asks for one, ALWAYS read and follow `docs/RELEASE.md`

## ABSOLUTE CARDINAL RULES (violation means immediate failure)

- Never start the real server or the Mac app yourself, and never touch `~/.untether`. The one exception is the
  twin: `scripts/gemelo.sh` (a throwaway server on 127.0.0.1:4100 with a temporary HOME) may be started and looked at
  with Playwright (`web/scripts/ui-shots.mjs`, see rule 9). Verify Mac changes with `xcodebuild` only (never `swift test`).
1. **Never create a branch without explicit user permission.** On a branch (not main), stay on it, even for
   unrelated changes; the user says "create/switch to a new branch". Exception (approved 2026-10-20): the `ut/*`
   branches `ut task` creates for its worktrees; Untether reviews, merges and deletes them. Any other branch
   (`git branch`, `git checkout -b`, `git switch -c` by hand) still needs permission.
2. **Never commit and/or push before the user has tested your changes**; wait for their confirmation.
3. **Never use `git rebase --skip`** (data loss); on rebase conflicts, ask the user.
4. **Never create duplicate files with version numbers or suffixes** (`file_v2.ts`, `file_new.ts`); edit the existing file.
5. **Web changes and modes**: in production mode the Mac app embeds a pre-built server (restart serves a stale
   build; clean → build → run); in development mode ("Use Development Server", Settings → Debug) it runs
   `pnpm run dev` with hot reload; restart the Untether server to pick up web changes. Details in `docs/agent-reference.md`.
6. **Never kill all sessions**: you run inside one; it would kill your own process.
7. **Never rename `docs.json` to `mint.json`**; the Mintlify config stays `docs.json` (reference: https://mintlify.com/docs/llms.txt).
8. **Tests kill only their own sessions**: track them with `TestSessionTracker`, clean up only names starting with
   `test-`, never sessions tests didn't create.
9. **Security and robustness tests run against the twin (`scripts/gemelo.sh`), never against the real install**
   (`~/.untether`, the Mac app's server, the user's sessions). To SEE the interface, use the twin too:
   `node web/scripts/ui-shots.mjs` starts it with fictitious data and saves screenshots (WebKit and Chromium, kept up
   to date and free of known CVEs). Usage in `docs/agent-reference.md`.

## Git workflow

- Workflow: start from main → create branch → PR → merge → return to main. PRs may hold several features.
- Check the current branch with `git branch` before changing anything; if unsure about branching, ASK FIRST.
- **"Adopt" a PR means REVIEW** (switch to its branch and review), never merge without explicit permission.
- **"Rebase main" means rebase the CURRENT branch on main**: `git pull --rebase origin main`, never switch to main.
- Before committing web changes, `cd web && pnpm run check` must pass (`pnpm run check:fix` auto-fixes).
- When creating a PR, set the terminal title with `ut title "Brief summary - github.com/owner/repo/pull/123"`; ignore it if `ut` fails.
- "Commit and push" / "commit + push" / `/cp` / "c+p": one command, `git add -A && git commit -m "…" && git push`.

## Code and packages

- **Code references** (of utter importance): always clickable `path/to/file.ts:123` or `path/to/file.ts:123-456`,
  relative to the project root (e.g. `web/src/client/app.ts:15`); never any other format.
- **Never install packages without explicit user approval**: no `pnpm add`/`npm install`, no edits to
  `package.json`/`pnpm-lock.yaml` unless asked; ask before suggesting dependencies; work with the existing
  (often custom) implementations first.
- **Refactoring**: no deprecation, clean refactors over gradual migration, delete unused functions and code paths immediately.
- After a visual change to a web app whose dev server runs in this session, show it with `ut open <port|url>` (details in `docs/agent-reference.md`).

## Web interface styling

- The web interface is styled ONLY with `--ut-*` tokens and shared `.ut-*` pieces (`docs/ui-tokens.md`); never hand-write
  colors, radii, shadows or fonts (`web/src/client/ui-tokens-guard.test.ts` and `theme-contrast.test.ts` fail otherwise).
- A new interface style is one file in `web/src/client/styles/looks/` plus its entry in `web/src/shared/looks.ts`.
- To see an interface change, use the twin: `node web/scripts/ui-shots.mjs --look <id>`, and
  `web/scripts/ui-shots-diff.mjs` to compare before and after.

## NO BACKWARDS COMPATIBILITY, EVER

The Mac app and web server always ship together; different versions never talk to each other. When fixing bugs
or changing APIs, change both sides, delete old code completely; no compatibility layers, no "old format" vs
"new format" checks, no fallbacks for older versions. Suggesting backwards compatibility in any form is a failure.

## Instruction reminders

Do what has been asked; nothing more, nothing less. Never create files unless absolutely necessary; prefer editing
an existing file. Never proactively create documentation files (*.md) or READMEs unless the user asks.
