/**
 * The interface styles ("looks", docs/ui-tokens.md). One entry here plus one file of token values
 * (client/styles/looks/<id>.css), and it exists: the picker in Settings, the server's `look`
 * setting (config.json) and the tests all read this list. Names and descriptions are in the
 * locales (`look.<id>.name`, `look.<id>.desc`).
 *
 * Mode rule: a style with `modes: 'dark'` or `'light'` forces that mode while it is active (the
 * saved light/dark/system choice is kept and comes back with another style). A style with
 * `fixedAccent` sets its own accent colors; the user's accent is kept and comes back the same way.
 */
export type LookModes = 'both' | 'light' | 'dark';
/** How much a style asks of the engine: base = none, easy = tokens only, effects = plus a layer. */
export type LookGroup = 'base' | 'easy' | 'effects';

export interface Look {
  id: string;
  modes: LookModes;
  group: LookGroup;
  /** Background, surface and accent of the style, for lists that show no live miniature. */
  swatches: readonly [string, string, string];
  /** The style's file sets the accent tokens: the user's accent has no effect while it is on. */
  fixedAccent: boolean;
  /** It also has styles/looks/<id>.effects.css, a layer over the shared pieces only. */
  effects: boolean;
  /**
   * The style's --ut-bg-app per mode (none: the app's own), painted before any file loads and
   * sent to the browser chrome. A test checks they match the file.
   */
  backgrounds: { light?: string; dark?: string };
}

export const ORIGINAL_LOOK_ID = 'original';

export const LOOKS: readonly Look[] = [
  {
    id: ORIGINAL_LOOK_ID,
    modes: 'both',
    group: 'base',
    swatches: ['#131211', '#232120', '#FF6A00'],
    fixedAccent: false,
    effects: false,
    backgrounds: {},
  },
  {
    id: 'minimal-light',
    modes: 'light',
    group: 'easy',
    swatches: ['#FFFFFF', '#F4F4F4', '#FF7900'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#FFFFFF' },
  },
  {
    id: 'cyber-hacker',
    modes: 'dark',
    group: 'effects',
    swatches: ['#020704', '#061109', '#51FF79'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#020704' },
  },
  {
    id: 'monochrome-elegant',
    modes: 'dark',
    group: 'effects',
    swatches: ['#090909', '#202020', '#EEEEEE'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#090909' },
  },
  {
    id: 'dark-premium',
    modes: 'dark',
    group: 'effects',
    swatches: ['#09090D', '#26222D', '#FFAE45'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#09090D' },
  },
  {
    id: 'japandi',
    modes: 'light',
    group: 'easy',
    swatches: ['#F1EADC', '#CDB99A', '#695039'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F1EADC' },
  },
  {
    id: 'nature',
    modes: 'light',
    group: 'easy',
    swatches: ['#E9ECD9', '#A5B88A', '#526E3D'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#E9ECD9' },
  },
  {
    id: 'clay',
    modes: 'light',
    group: 'effects',
    swatches: ['#F4D5BD', '#FFEFDE', '#E9754A'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F4D5BD' },
  },
  {
    id: 'material-you',
    modes: 'light',
    group: 'easy',
    swatches: ['#F8F1FA', '#F5DCE7', '#67508E'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F8F1FA' },
  },
  {
    id: 'ios-native',
    modes: 'both',
    group: 'easy',
    swatches: ['#F2F2F7', '#FFFFFF', '#0969DA'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F2F2F7', dark: '#000000' },
  },
  {
    id: 'editorial',
    modes: 'dark',
    group: 'easy',
    swatches: ['#171717', '#FFF9EF', '#EF8A3D'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#171717' },
  },
  {
    id: 'comic',
    modes: 'light',
    group: 'effects',
    swatches: ['#F2E4C9', '#FFF8E9', '#FFAD45'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F2E4C9' },
  },
  {
    id: 'minimal-pro',
    modes: 'light',
    group: 'easy',
    swatches: ['#FFFFFF', '#F5F5F5', '#101010'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#FFFFFF' },
  },
  {
    id: 'glassmorphism',
    modes: 'dark',
    group: 'effects',
    swatches: ['#17171C', '#5A4032', '#FFBB79'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#17171C' },
  },
  {
    id: 'holographic',
    modes: 'light',
    group: 'effects',
    swatches: ['#C3D6FB', '#F8FBFF', '#294C83'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#C3D6FB' },
  },
  {
    id: 'aurora',
    modes: 'dark',
    group: 'effects',
    swatches: ['#160F31', '#674296', '#FFD19C'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#160F31' },
  },
  {
    id: 'neumorphic',
    modes: 'light',
    group: 'effects',
    swatches: ['#E5E8EF', '#F2B77A', '#514292'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#E5E8EF' },
  },
  {
    id: 'skeuomorphic',
    modes: 'dark',
    group: 'effects',
    swatches: ['#151618', '#303338', '#F6A454'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#151618' },
  },
  {
    id: 'cyberpunk',
    modes: 'dark',
    group: 'effects',
    swatches: ['#080619', '#211638', '#FF4FDA'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#080619' },
  },
  {
    id: 'neon-futuristic',
    modes: 'dark',
    group: 'effects',
    swatches: ['#090A0C', '#1B1C1E', '#FF861D'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#090A0C' },
  },
  {
    id: 'aero',
    modes: 'light',
    group: 'effects',
    swatches: ['#A3CFF0', '#EEF9FF', '#124C83'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#A3CFF0' },
  },
  {
    id: 'retro-pixel',
    modes: 'light',
    group: 'effects',
    swatches: ['#92D2FA', '#FFF9E7', '#A8DB62'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#92D2FA' },
  },
  {
    id: 'neobrutalism',
    modes: 'light',
    group: 'effects',
    swatches: ['#F4F1E7', '#FFFEF8', '#FFE500'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#F4F1E7' },
  },
  {
    id: 'cosmos',
    modes: 'dark',
    group: 'effects',
    swatches: ['#080A21', '#37305B', '#C7B6FF'],
    fixedAccent: true,
    effects: true,
    backgrounds: { dark: '#080A21' },
  },
  {
    id: 'playful-3d',
    modes: 'light',
    group: 'effects',
    swatches: ['#FFF1E2', '#DDD0FF', '#5131AD'],
    fixedAccent: true,
    effects: true,
    backgrounds: { light: '#FFF1E2' },
  },
];

export const LOOK_IDS: readonly string[] = LOOKS.map((look) => look.id);

export function findLook(id: string | null | undefined): Look | undefined {
  return LOOKS.find((look) => look.id === id);
}

/** The mode a style imposes, if any. */
export function forcedLookMode(look: Look | undefined): 'light' | 'dark' | undefined {
  return look && look.modes !== 'both' ? look.modes : undefined;
}

/** What the first paint needs of a style: stored per device, or sent by the server in the page. */
export interface LookBoot {
  id: string;
  force?: 'light' | 'dark';
  bg?: { light?: string; dark?: string };
}

export function lookBoot(look: Look): LookBoot {
  const force = forcedLookMode(look);
  return { id: look.id, ...(force ? { force } : {}), bg: look.backgrounds };
}
