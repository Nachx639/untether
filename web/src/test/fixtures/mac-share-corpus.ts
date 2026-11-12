/**
 * Share with phone: values that reach a shell or osascript's argv, typed into a terminal tab
 * (folder names, option values). Every one must come back byte for byte. Shared by the
 * osascript argv round trip and the shell quoting round trips.
 */

/** Pieces that must survive quoting and argv unchanged. None starts with `-`. */
export const MAC_SHARE_CORPUS: readonly string[] = [
  'plain',
  'a b',
  ' leading space',
  'trailing space ',
  "it's",
  "'",
  "''",
  "a''b",
  'a"b',
  '"',
  '\\',
  "\\'",
  'a\\nb',
  '$HOME',
  // `${HOME}` without biome taking it for a template string.
  '\u0024{HOME}',
  '$(id)',
  '`id`',
  '!',
  '!!',
  '!$',
  'a!b',
  '^old^new',
  '*',
  '?',
  '[ab]',
  '{a,b}',
  '~',
  '~x',
  '~root',
  '=x',
  '=ls',
  '#x',
  'a#b',
  '%self',
  'a;b',
  'a&&b',
  'a|b',
  'a>b',
  'a<b',
  '(x)',
  'a=b',
  'x[1m]',
  'claude-opus-5-5[1m]',
  'café',
  'café',
  '😀',
  'عربى',
  '‮txt',
  'a‍b',
  '​',
  'é/ü/ñ',
  `/${'d'.repeat(255)}`,
  `/${'long/'.repeat(200)}x`,
];

/** Values that must be refused before anything is typed. */
export const MAC_SHARE_REJECTED: readonly string[] = [
  'a\tb',
  'a\nb',
  'a\rb',
  'a\0b',
  'a\u001bb',
  'a\u007fb',
  'a\u0085b',
  'a b',
  'a b',
  'a\uD800b',
  'a\uDC00b',
];
