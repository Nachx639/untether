# Testing Untether on External Devices

How to try a change on a phone, a tablet or another computer on the same network, without touching the real
install (`~/.untether`, the Mac app's server, your sessions).

## The twin on the network

The twin (`scripts/gemelo.sh`) is a throwaway server run from this checkout's code, with a temporary HOME and
fictitious data. By default it only listens on 127.0.0.1; `UTT_GEMELO_BIND=0.0.0.0` makes it listen on the network:

```bash
UTT_GEMELO_BIND=0.0.0.0 bash scripts/gemelo.sh start   # port 4100 (UTT_GEMELO_PORT changes it)
ipconfig getifaddr en0                                 # this Mac's address on the Wi-Fi (en1 for Ethernet)
```

On the device, open `http://<mac-address>:4100` and log in with this Mac's user and password. The session
`zz-gemelo` and its fictitious project are there to work with.

```bash
bash scripts/gemelo.sh status
UTT_GEMELO_BIND=0.0.0.0 bash scripts/gemelo.sh reset   # stop, start and seed again (loads changed server code)
bash scripts/gemelo.sh stop                            # no process, file or session left
```

- The twin serves the client in `web/public`. After changing client code: `node web/scripts/build-client.js`,
  then reload the page on the device. There is no hot reload.
- `--rich` (the twin full of made-up projects and tasks) has no login, so it is refused on the network. Its
  screens can be seen on this Mac with `node web/scripts/ui-shots.mjs`, which emulates phone sizes in WebKit and
  Chromium.
- Stop the twin when you are done: while it runs, anyone on the network who knows this Mac's user and password
  can log in to it.

Never start a development server on the network for this (`pnpm run dev --bind …`): it runs with the real
HOME and writes into `~/.untether`.

## The installed app

To try the app as installed (the real server, your real sessions): in the Mac app's settings set the server's
access mode to "Network", then open `http://<mac-address>:4020` on the device. That is ordinary use, not a test: do not run
login, rate-limit or robustness tests against it (`docs/agent-reference.md`, "Security and robustness tests").

## When the device cannot connect

- Both on the same Wi-Fi; the address is the one `ipconfig getifaddr en0` prints.
- macOS may ask whether Node may accept incoming connections: allow it (System Settings → Network → Firewall).
- `bash scripts/gemelo.sh status` says whether the twin runs and answers; `lsof -nP -iTCP:4100 -sTCP:LISTEN`
  shows the address it listens on (`*:4100` on the network).

## Inspecting the page on the device

- Safari on iOS/iPadOS: Settings → Safari → Advanced → Web Inspector on the device, connect it by USB, then
  Safari on the Mac → Develop → the device.
- Chrome on Android: enable Developer options and USB debugging, connect by USB, open `chrome://inspect` on the
  desktop Chrome.

## Related

- [agent-reference.md](agent-reference.md): the twin's commands and rules
- [security.md](security.md): sign-in modes and network exposure
