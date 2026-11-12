/** The options of one command line. */

import { type CommandOptions, type Flags, UsageError } from './types.js';

/** `command`: "ut project tell", for the error; `options`: what it takes (its CliCommand). */
export function parseFlags(
  argv: string[],
  command: string,
  options: CommandOptions
): { flags: Flags; positional: string[] } {
  const value = new Set(options.value ?? []);
  const switches = new Set([...(options.switches ?? []), 'json']);
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (value.has(name)) {
        if (eq > 0) flags[name] = arg.slice(eq + 1);
        else {
          const next = argv[i + 1];
          if (next === undefined) throw new UsageError(`--${name} needs a value`);
          flags[name] = next;
          i++;
        }
      } else if (switches.has(name)) {
        if (eq > 0) throw new UsageError(`--${name} takes no value`);
        flags[name] = true;
      } else {
        const known = [
          ...[...value].map((v) => `--${v} VALUE`),
          ...[...switches].map((v) => `--${v}`),
        ];
        const shown = arg.length > 40 ? `${arg.slice(0, 40)}…` : arg;
        throw new UsageError(
          `unknown option ${shown} for '${command}' (it takes: ${known.join(', ')}). Nothing was done. Text that starts with -- goes after a lone --: ${command} … -- "--text"`
        );
      }
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

/** "a, b" of a flag: its values. */
export const commaList = (raw: string) =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
