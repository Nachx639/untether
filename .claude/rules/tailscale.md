---
paths:
  - "**/*ailscale*"
  - "docs/tailscale_ios.md"
---

# Tailscale CLI syntax (as of August 2025)

The Tailscale CLI has changed its syntax.

Tailscale Serve (HTTPS proxy to local services):
```bash
# OLD syntax (deprecated):
tailscale serve https / http://localhost:4020
# NEW syntax:
tailscale serve --bg http://localhost:4020
```
The `--bg` flag runs the serve configuration in background mode; the process exits immediately after configuration.

Tailscale Funnel (public internet access):
```bash
tailscale funnel --bg --https=443 http://localhost:4020   # what the server runs (tailscale-serve-service.ts)
```

NEVER run `tailscale serve reset` or `tailscale funnel reset` by hand on this Mac: they wipe every Serve/Funnel
route of the machine, not only Untether's, and cut the user's remote access (2026-10-05 incident, see the header of
`web/src/server/services/tailscale-serve-service.ts`). The server issues the Tailscale commands itself; tests use a
fake binary through `UNTETHER_TAILSCALE_BIN`.

Notes:
- `tailscale serve --bg` exits immediately with code 0 on success
- There's no long-running process to monitor after using `--bg`
- HTTPS is automatically configured on port 443
