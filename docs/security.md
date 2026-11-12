# Untether Server Security

Whoever signs in to Untether gets a shell on the computer as the account the server runs as.
This page lists the sign-in modes, the flags that select them and the limits around them. The
code is in `web/src/server/server-config.ts` (flags), `middleware/auth.ts` (every request),
`routes/auth.ts` (sign-in routes) and `services/auth-service.ts` (tokens, passwords, SSH keys).

## Sign-in modes

| Flags | Sign-in |
|-------|---------|
| none | Password of the account the server runs as |
| `--enable-ssh-keys` | Password or SSH key |
| `--disallow-user-password` | SSH key only (turns `--enable-ssh-keys` on) |
| `--no-auth` | None; every request is the owner. Loopback only (see below) |
| `--enable-tailscale-serve` | Adds the Tailscale identity of the Mac's owner |
| `--allow-local-bypass` | Adds the local token for requests from this computer |

### Password

- Checked with PAM, and only for the account the server runs as: another account's password is
  refused. The sign-in form sends no user name; the server derives it.
- With both `UNTETHER_USERNAME` and `UNTETHER_PASSWORD` set, that pair is used instead of the
  system account. There are no command-line options for them: arguments are visible to every
  user of the computer.
- The password travels to the server over the current connection: use HTTPS (Tailscale, a
  tunnel or a reverse proxy) from outside the computer. The server has no TLS of its own.

### SSH keys

- `POST /api/auth/challenge` returns a random challenge (valid 5 minutes, at most 100 pending);
  `POST /api/auth/ssh-key` takes the signature.
- Ed25519 keys. The public key must be in `~/.ssh/authorized_keys` of the account the server
  runs as.
- The browser generates or imports keys in the SSH key manager and keeps them in `localStorage`.

### Tokens

- A successful sign-in returns a JWT. It lasts 24 hours, or 30 days when the sign-in asked to be
  remembered. Requests send it as `Authorization: Bearer <token>`.
- Only a WebSocket upgrade may carry the token as `?token=`; in any other URL it is ignored.
- The signing key is `JWT_SECRET` if set, otherwise `~/.untether/jwt-secret` (created on first
  start, mode 0600), so tokens survive a restart.
- `POST /api/auth/logout` revokes the token; with `{"everywhere": true}` it ends every token of
  that user. Revocations are kept in `~/.untether/revoked-tokens.json` until the tokens expire.
- A refused token answers 401 `token_invalid` (WebSocket close code 4401): the client signs in again.

### No authentication

- `--no-auth` without `--bind` listens on `127.0.0.1`.
- On any other address, or together with `--ngrok`, `--cloudflare`, `--enable-tailscale-serve`
  or `--enable-tailscale-funnel`, the server refuses to start unless
  `--unsafe-no-auth-on-network` is given (`unsafeNoAuthReason`).
- It also refuses to start when a Tailscale Serve or Funnel route left by an earlier server
  still forwards to its port (`leftoverServeRoutesRefusal`).
- Requests are refused when their `Host` header is not an IP address, `localhost`, one of this
  computer's names, a `*.ts.net` name or a name in `UNTETHER_ALLOWED_HOSTS` (DNS rebinding), and
  when they were relayed by Tailscale Serve or Funnel.
- A `--no-auth` server shuts down when the process that started it goes away.

### Tailscale Serve

- With `--enable-tailscale-serve` the server listens on loopback only, whatever `--bind` says,
  and accepts the identity headers Tailscale's proxy adds.
- The headers count only when the connection comes from loopback, carries the proxy's
  `X-Forwarded-*` headers and its peer process is verified to be Tailscale's own
  (`verifyTailscalePeer`).
- Only the Mac's own Tailscale user may sign in this way, or the logins listed in
  `UNTETHER_TAILSCALE_LOGINS` (comma-separated). When neither is known, nobody does.
- `POST /api/auth/tailscale-token` gives such a user a 24-hour token for the WebSocket.
- A refused Tailscale identity does not block a request that also carries a valid token.

### Local bypass

`--allow-local-bypass` lets a request from this computer skip the sign-in when it carries the
local token in the `X-Untether-Local` header. The Mac app uses it for its own requests.

```bash
UNTETHER_LOCAL_AUTH_TOKEN="$(openssl rand -hex 32)" untether --allow-local-bypass
```

- The token is read from the `UNTETHER_LOCAL_AUTH_TOKEN` environment variable only, and the
  server removes it from its own environment at startup, so nothing it starts inherits it.
  Never pass it as an argument: arguments are visible to every user (`ps`).
- Without a configured token no request bypasses the sign-in: the flag alone opens nothing.
- The request must also come from this computer's own address, name this computer as its host
  and carry no `X-Forwarded-For`, `X-Real-IP` or `X-Forwarded-Host` header, so a request relayed
  by a proxy or a tunnel never counts as local.
- Command-line clients (`ut`) do not need the token: they use `~/.untether/api.sock`, readable
  by its owner only.

### HQ mode

A remote registered with an HQ also accepts the bearer token that HQ must use to reach it; see
[hq.md](hq.md).

## Routes that answer without a sign-in

An explicit list in `middleware/auth.ts`: `/api/auth/challenge`, `/auth/ssh-key`,
`/auth/password`, `/auth/verify`, `/auth/config`, `/auth/tailscale-token`, `/auth/logout`,
`/api/sessions/tailscale/status` and `/api/health`. Health shows version, build and process
details only to a signed-in caller.

## Sign-in limits

Failed sign-ins are slowed down in memory (`LoginThrottle`), per client and for all clients
together; a limited request answers 429 with `Retry-After`.

- Password and SSH key sign-in: 5 free failures per client, then a wait that doubles from 1 s
  up to 15 minutes; failures are forgotten after 15 minutes without new ones.
- All clients together: 20 free failures, then up to 60 s. A client with no failures of its own
  waits at most 2 s because of it, and loopback and tailnet addresses are left out of it.
- SSH challenges: 30 free per client, 300 overall, wait up to 60 s.
- A success clears the client's count.

## Network

- Default bind address: `0.0.0.0`. `--bind 127.0.0.1` keeps the server to this computer.
- The server is announced over mDNS unless `--no-mdns` is given or it listens on loopback only.
- Security headers come from `helmet`; dev-server previews are served from a separate origin
  (the preview port), and the main origin refuses requests coming from it.

## Testing security

Security and robustness tests run against the twin, never against the real install
(`~/.untether`, the Mac app's server, the user's sessions): `scripts/gemelo.sh` starts a
throwaway server on `127.0.0.1:4100` with a temporary HOME, its own `jwt-secret` and sessions,
and removes everything on `stop`.

```bash
scripts/gemelo.sh run -- sh -c 'curl "$GEMELO_URL/api/health"'
```
