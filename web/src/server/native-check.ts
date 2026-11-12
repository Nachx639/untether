/**
 * `untether check-native`: the server opens its own native modules and says whether each
 * loads, with the Node it runs on (in the Mac app, the Node embedded in the executable).
 *
 * 2026-11-12: nothing checked a built app's modules against the Node it embeds; one built for
 * another Node (authenticate-pam is one build per Node ABI) was found out at the first login.
 * mac/scripts/build-web-frontend.sh and the release script (before anything is signed) run this.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface NativeCheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 800);

export function checkNativeModules(deps: {
  /** The folder of a bundled server (next to the executable); undefined in development. */
  bundleDir?: string;
  pam: () => { loaded: boolean; error?: string };
  /** Opens node-pty's addon; throws when it does not load. */
  openPty: () => void;
  executable?: (file: string) => boolean;
}): NativeCheckLine[] {
  const executable =
    deps.executable ??
    ((file: string) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const lines: NativeCheckLine[] = [];
  try {
    deps.openPty();
    lines.push({ name: 'pty.node', ok: true, detail: 'loads' });
  } catch (error) {
    lines.push({
      name: 'pty.node',
      ok: false,
      detail: oneLine(error instanceof Error ? error.message : String(error)),
    });
  }
  const pam = deps.pam();
  lines.push({
    name: 'authenticate_pam.node',
    ok: pam.loaded,
    detail: pam.loaded ? 'loads' : oneLine(pam.error ?? 'did not load'),
  });
  if (deps.bundleDir && process.platform === 'darwin') {
    const helper = path.join(deps.bundleDir, 'spawn-helper');
    const ok = executable(helper);
    lines.push({ name: 'spawn-helper', ok, detail: ok ? 'executable' : `${helper} is missing` });
  }
  return lines;
}

/** Prints one line per module and exits 0 only when all of them are good. */
export function checkNativeMain(lines: NativeCheckLine[]): never {
  for (const line of lines) {
    console.log(`${line.ok ? 'ok' : 'FAILED'} ${line.name}: ${line.detail}`);
  }
  console.log(`node ${process.version} (modules ${process.versions.modules})`);
  process.exit(lines.every((line) => line.ok) ? 0 : 1);
}
