/**
 * `untether check-native`: the server opens its own native modules and says whether each
 * loads, with the Node it runs on (in the Mac app, the Node embedded in the executable).
 *
 * 2026-11-12: nothing checked a built app's modules against the Node it embeds; one built for
 * another Node (authenticate-pam is one build per Node ABI) was found out at the first login.
 * mac/scripts/build-web-frontend.sh and the release script (before anything is signed) run this.
 *
 * 2026-11-14: in a source checkout the Node that asks is not always the Node that loads. A
 * task's `ut` ran this checkout's source with its session's Node 24 while the server ran from
 * it on Node 26, and modules built (rightly) for 26 were reported as broken, with Node's advice
 * to rebuild them: under the running server. A checkout's modules are now opened with the Node
 * of the server running from that checkout (`nodeThatLoads`, from the server's status), in a
 * child of it; only with nobody running from it, with the Node that asks, and said so. Node's
 * "Please try re-compiling" is never repeated: the doctor of the server that loads a module
 * rebuilds it, with its own Node (installed-app.ts nativeModulesLoadCheck).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildInfo } from './build-info.js';
import { withoutRebuildAdvice } from './services/authenticate-pam-loader.js';

/** A Node: its executable, version (v26.1.0) and module ABI (process.versions.modules). */
export interface NodeIdentity {
  execPath: string;
  version: string;
  modules: string;
}

export const ownNode = (): NodeIdentity => ({
  execPath: process.execPath,
  version: process.version,
  modules: process.versions.modules,
});

/**
 * The Node a source checkout's native modules are judged with: the one of the server running
 * from that very checkout (same `untether-dev`), whoever asks; the asking Node only when no
 * server runs from it (`server: false`).
 */
export function nodeThatLoads(deps: {
  own: NodeIdentity;
  /** The build of the CLI that asks, and what the running server says of itself. */
  cli: BuildInfo;
  server?: { build?: BuildInfo; node?: NodeIdentity };
}): { node: NodeIdentity; server: boolean } {
  const { cli, server } = deps;
  const sameCheckout =
    cli.dev && server?.build?.dev && Boolean(cli.cli) && server.build.cli === cli.cli;
  if (sameCheckout && server?.node?.execPath) return { node: server.node, server: true };
  return { node: deps.own, server: false };
}

/** Opens a native addon in a child of `node`; throws with what that Node said. */
export function openWithNode(node: string, file: string): void {
  try {
    execFileSync(node, ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 20_000,
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    const lines = stderr.split('\n');
    const from = lines.findIndex((line) => /Error/.test(line));
    const rest = from < 0 ? [] : lines.slice(from);
    const stack = rest.findIndex((line) => /^\s+at /.test(line));
    const said = rest.slice(0, stack < 0 ? 6 : stack).join(' ');
    throw new Error(said.trim() || (error instanceof Error ? error.message : String(error)));
  }
}

export interface NativeCheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

const oneLine = (text: string) => withoutRebuildAdvice(text).slice(0, 800);

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

/**
 * What `check-native` prints: one line per module, the Node they were opened with and, in a
 * source checkout, whose Node that is. Never a word about rebuilding.
 */
export function checkNativeReport(
  lines: NativeCheckLine[],
  loader: { node: NodeIdentity; server: boolean } = { node: ownNode(), server: false },
  options: { own?: NodeIdentity; checkout?: boolean } = {}
): string[] {
  const out = lines.map((line) => `${line.ok ? 'ok' : 'FAILED'} ${line.name}: ${line.detail}`);
  const { node } = loader;
  const own = options.own ?? ownNode();
  if (loader.server) {
    out.push(
      `node ${node.version} (modules ${node.modules}): ${node.execPath}, the Node of the server running from this checkout` +
        (node.execPath === own.execPath
          ? ''
          : ` (this command runs on ${own.version}, which does not load them and does not need to)`)
    );
  } else {
    out.push(`node ${node.version} (modules ${node.modules})`);
    if (options.checkout && lines.some((line) => !line.ok)) {
      out.push(
        'No server runs from this checkout: the modules were opened with the Node of this command, which may not be the Node they were built for. Nothing here needs rebuilding for a command to work; a server that runs from this checkout checks and repairs its own modules.'
      );
    }
  }
  return out;
}

/** Prints the report and exits 0 only when every module is good. */
export function checkNativeMain(
  lines: NativeCheckLine[],
  loader?: { node: NodeIdentity; server: boolean },
  options?: { own?: NodeIdentity; checkout?: boolean }
): never {
  for (const line of checkNativeReport(lines, loader, options)) console.log(line);
  process.exit(lines.every((line) => line.ok) ? 0 : 1);
}
