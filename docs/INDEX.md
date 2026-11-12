# Untether Documentation

## Quick Navigation

### Getting Started
- [Quickstart](../README.md) - Installation, first terminal
- [Technical Specification](spec.md) - Parts, sessions, state, HTTP routes
- [Native Forwarder](forwarder.md) - PTY, session artifact, and IPC contracts
- [WebSocket protocol](websocket.md) and [IPC socket protocol](../web/docs/socket-protocol.md) - Transport

### Development
- [Contributing Guide](CONTRIBUTING.md) and [Build System](build-system.md) - Setup, workflow, builds
- [Testing Guide](testing.md) - Unit, E2E; [external devices](TESTING_EXTERNAL_DEVICES.md)
- [Deployment Guide](deployment.md) - Production setup

### Platform Guides
- [macOS App](../mac/README.md) - Native app development
- [Web Frontend](../web/README.md) - TypeScript/Lit development

### Features
- [Security](security.md) - Sign-in modes, tokens, local bypass, limits
- [Push Notifications](push-notification.md) - Remote alerts
- [Terminal Features](cjk-ime-input.md) - CJK input; [keyboard shortcuts](keyboard-shortcuts.md)
- [Model Providers](model-providers.md) - Run tasks/sessions against an external Anthropic-compatible provider

### Reference
- [Release Process](RELEASE.md) - Publishing updates

## API Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | POST | Create terminal session |
| `/api/sessions` | GET | List active sessions |
| `/api/sessions/:id` | GET | Session details |
| `/api/sessions/:id` | DELETE | Kill session |
| `/api/sessions/:id/input` | POST | Send text or a key |
| `/api/sessions/:id/resize` | POST | Resize terminal |
| `/ws` | WS | Terminal transport (v3 framing; multiplexed) |
| `/api/health` | GET | Server health check |

More routes: [spec.md](spec.md#http-api).

## CLI Commands

| Task | Command | Description |
|------|---------|-------------|
| Run in a session | `ut <command>` | Run a command inside an Untether session (`ut --shell` for a shell) |
| View logs | `./scripts/utlog.sh -n 100` | Last 100 log lines |
| Error logs | `./scripts/utlog.sh -e` | Errors only |
| Run tests | `cd web && pnpm test` | Web test suite (Vitest) |
| Build Mac | `cd mac && ./scripts/build.sh` | Build release |
| Dev server | `cd web && pnpm run dev` | Start dev server |
| Web checks | `cd web && pnpm run check` | Format, lint and type checks |

## WebSocket Protocol

WebSocket v3 uses binary frames (`"VT"` magic, version `3`) and multiplexes sessions on a single `/ws` connection.

Details: `docs/websocket.md`.

## Project Structure

```
untether/
├── mac/           # macOS native app (Swift/SwiftUI)
├── ios/           # iOS companion app (Swift/SwiftUI)
├── web/           # Server & frontend (TypeScript)
│   ├── src/
│   │   ├── server/   # Node.js/Bun server
│   │   ├── client/   # Web UI (Lit/TypeScript)
│   │   └── shared/   # Types and protocol code for both
│   └── dist/      # Built artifacts
├── native/ut-fwd/ # untether-fwd, the Rust forwarder behind `ut`
├── scripts/       # Build & utility scripts
└── docs/          # Documentation
```

## Key Files

| File | Purpose |
|------|---------|
| `mac/Untether/Core/Services/ServerManager.swift` | Server lifecycle |
| `web/src/cli.ts` | `untether` command entry point |
| `web/src/server/server-app.ts` | Builds the HTTP/WebSocket server (`createApp`) |
| `web/src/server/server-config.ts` | Command-line options |
| `web/src/server/pty/pty-manager.ts` | Terminal management |
| `web/src/client/app.ts` | Web UI entry point |
| `ios/Untether/App/UntetherApp.swift` | iOS app entry |

## Common Tasks

### Add New Feature
1. Check the [Technical Specification](spec.md) for component placement
2. Follow the [Contributing Guide](CONTRIBUTING.md)
3. Add tests per [Testing Guide](testing.md)

### Debug Issue
1. Check the README's troubleshooting notes
2. View logs: `./scripts/utlog.sh -e`
3. Test in dev mode: `cd web && pnpm run dev`
4. See the platform guides ([macOS](../mac/README.md), [web](../web/README.md)) for specific issues

### Release Update
1. Follow [Release Process](RELEASE.md)
2. Test on all platforms
3. Update changelog
4. Create GitHub release

## Security Model

- **Authentication**: the computer's user and password (or SSH keys); the browser keeps a signed token
- **Transport**: the server speaks plain HTTP; HTTPS comes from Tailscale, a tunnel or a reverse proxy
- **Isolation**: Per-session PTY processes

Details: [security.md](security.md).

## Quick Links

- [GitHub Repository](https://github.com/Nachx639/untether)
- [Technical Specification](spec.md)
- [Contributing Guide](CONTRIBUTING.md)
- [License](../LICENSE)
