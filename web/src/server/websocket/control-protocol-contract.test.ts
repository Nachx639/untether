import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 2026-11-11: the server sent `system:notification` (Follow Mode, Main Repository Synced),
 * `notification:show` and `git:repository-changed` to the Mac app, which has no handler for
 * any of them: they were dropped (or answered with an error) and shown nowhere. This guard
 * reads both sides: every control message the server builds must be one the app handles.
 */
const serverDir = path.resolve(__dirname, '..');
const macServices = path.resolve(__dirname, '../../../../mac/Untether/Core/Services');

/** Sent to the browser's control WebSocket, never to the Mac app. */
const BROWSER_ONLY = new Set(['system:error']);

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return serverSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function messagesBuiltByServer(): Map<string, string> {
  const built = new Map<string, string>();
  const call = /createControl(?:Event|Message)\(\s*'([a-z-]+)',\s*'([a-z-]+)'/g;
  const literal = /category:\s*'([a-z-]+)',\s*action:\s*'([a-z-]+)'/g;
  for (const file of serverSources(serverDir)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('control-protocol') && !file.endsWith('control-protocol.ts')) continue;
    for (const pattern of [call, literal]) {
      for (const match of source.matchAll(pattern)) {
        built.set(`${match[1]}:${match[2]}`, path.relative(serverDir, file));
      }
    }
  }
  return built;
}

function handledByMacApp(): Set<string> {
  const handled = new Set<string>();
  const categories = fs
    .readFileSync(path.join(macServices, 'ControlProtocol.swift'), 'utf8')
    .match(/enum Category: String, Codable \{([^}]*)\}/)?.[1]
    .matchAll(/case (\w+)/g);
  for (const [, category] of categories ?? []) {
    const handler = path.join(
      macServices,
      `${category[0].toUpperCase()}${category.slice(1)}ControlHandler.swift`
    );
    // A category without a handler file handles nothing: the test below names it.
    if (!fs.existsSync(handler)) continue;
    for (const [, action] of fs.readFileSync(handler, 'utf8').matchAll(/case "([a-z-]+)":/g)) {
      handled.add(`${category}:${action}`);
    }
  }
  return handled;
}

describe('control protocol: server and Mac app agree', () => {
  it('the server builds only control messages the Mac app handles', () => {
    const handled = handledByMacApp();
    expect([...handled].sort()).toEqual(['system:ping', 'system:ready', 'terminal:spawn']);
    const unhandled = [...messagesBuiltByServer()]
      .filter(([message]) => !handled.has(message) && !BROWSER_ONLY.has(message))
      .map(([message, file]) => `${message} (${file})`);
    expect(unhandled).toEqual([]);
  });

  it('the server names the same categories as the Mac app', () => {
    const tsCategories = fs
      .readFileSync(path.join(serverDir, 'websocket/control-protocol.ts'), 'utf8')
      .match(/export type ControlCategory = ([^;]+);/)?.[1]
      .match(/'(\w+)'/g)
      ?.map((quoted) => quoted.slice(1, -1));
    const swiftCategories = [
      ...(fs
        .readFileSync(path.join(macServices, 'ControlProtocol.swift'), 'utf8')
        .match(/enum Category: String, Codable \{([^}]*)\}/)?.[1]
        .matchAll(/case (\w+)/g) ?? []),
    ].map((match) => match[1]);
    expect(tsCategories?.sort()).toEqual(swiftCategories.sort());
    expect(swiftCategories.sort()).toEqual(['system', 'terminal']);
  });
});
