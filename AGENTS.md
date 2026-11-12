# Untether Notes

- Mac app and server ship together; no backwards compatibility needed.
- iOS tasks: use iOS 26 simulator.

- Security and robustness tests run against the twin (`scripts/gemelo.sh`), never against the real install. To see the interface: `node web/scripts/ui-shots.mjs`, which also uses the twin. Never start the real server or the Mac app, nor touch `~/.untether`. Usage: `docs/agent-reference.md`.

## Web interface styling

- The web interface is styled ONLY with `--ut-*` tokens and shared `.ut-*` pieces (`docs/ui-tokens.md`); never hand-write
  colors, radii, shadows or fonts (`web/src/client/ui-tokens-guard.test.ts` and `theme-contrast.test.ts` fail otherwise).
- A new interface style is one file in `web/src/client/styles/looks/` plus its entry in `web/src/shared/looks.ts`.
- To see an interface change, use the twin: `node web/scripts/ui-shots.mjs --look <id>`, and
  `web/scripts/ui-shots-diff.mjs` to compare before and after.
