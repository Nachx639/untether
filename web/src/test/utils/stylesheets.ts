/**
 * Reads the app's stylesheets for the tests, as the build joins them. styles.css and
 * styles/list.css only list their parts (one file per piece, 2026-11-11): a test asks for a
 * whole sheet here and never names the file a rule happens to live in, so moving a rule from
 * one piece to another breaks no test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CLIENT = resolve(__dirname, '../../client');
const IMPORT = /^@import "(\.[^"]+)";$/gm;

function inlined(path: string, follow: (file: string) => boolean): string {
  return readFileSync(path, 'utf8').replace(IMPORT, (line: string, target: string) => {
    const file = join(dirname(path), target);
    return follow(file) ? inlined(file, follow) : line;
  });
}

/** A stylesheet (path from src/client) with every file it imports in its place, in order. */
export function readStylesheet(file: string): string {
  return inlined(join(CLIENT, file), () => true);
}

/**
 * styles.css without the tokens and the areas (list, session, dialogs, layout), whose imports
 * stay as lines: the foundation's own rules and the material ones after the areas.
 */
export function readFoundation(): string {
  const own = [join(CLIENT, 'styles/foundation/'), join(CLIENT, 'styles/material.css')];
  return inlined(join(CLIENT, 'styles.css'), (file) => own.some((path) => file.startsWith(path)));
}
