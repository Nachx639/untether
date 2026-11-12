/**
 * Tests that change the environment save it with snapshotEnv() and put it back with the
 * function it returns, in place: keys added since are removed, changed ones restored.
 *
 * 2026-11-03: tts.test.ts restored with `process.env = { ...env }` and failed 10 of 28 under
 * Node 26, whose child processes no longer inherit a replaced process.env object but the real
 * environment: the FAKE_* and UNTETHER_* the test set never reached its fake engines. Never
 * replace process.env; setup.ts makes such an assignment throw.
 */
export function snapshotEnv(): () => void {
  const saved = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else if (process.env[key] !== value) process.env[key] = value;
    }
  };
}
