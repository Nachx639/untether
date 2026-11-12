#!/bin/bash
set -euo pipefail

pnpm exec oxlint --config ./.oxlintrc.json --deny-warnings src

# No server method is taken off its object (2026-11-11: `const waiting = messages.waiting;
# waiting(id)` lost its `this` in a timer and stopped the server eight times). The client is
# left out: Lit binds `@click=${this.handler}` to its element itself.
node scripts/lint-unbound-methods.mjs tsconfig.server.json

# The three tsc projects are checked by `pnpm run typecheck`, which check-all.sh runs next to this
# (2026-11-10: they ran here too, so every check type-checked the project twice).
