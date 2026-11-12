/**
 * A session started with `ut <command>` in a terminal window: the forwarder (untether-fwd)
 * runs the program there, in that window, and names the session `fwd_<time>_<pid>`. Untether
 * shows and controls it, but the program belongs to the window: it keeps running when the
 * server restarts, and "shielding" it would close it in the window to reopen it here
 * (2026-10-03: the list offered to shield two of them).
 *
 * A Terminal-window session spawned from the web (spawn_terminal) runs under ut-fwd too, but
 * with the UUID id the server gave it: the forwarder records its pid as `forwarderPid` in
 * session.json (2026-10-20: such a session got a 500 ms kill grace, "Killed: 9" in its window,
 * and was offered Blindar, which closed its program in the window).
 */
export function isForwardedSession(session: { id: string; forwarderPid?: unknown }): boolean {
  return session.id.startsWith('fwd_') || recordedForwarderPid(session) !== null;
}

/** The forwarder pid ut-fwd wrote into session.json, when it is a usable pid. */
export function recordedForwarderPid(session: object): number | null {
  const pid = (session as { forwarderPid?: unknown }).forwarderPid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}
