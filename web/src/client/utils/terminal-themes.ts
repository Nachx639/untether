/**
 * Terminal color themes.
 *
 * Every concrete theme carries its full palette (background, foreground, cursor, cursor text,
 * selection and the 16 ANSI colors) and whether it is a light or a dark theme. Third-party
 * palettes are the values their upstream projects publish for terminals (Catppuccin ports,
 * folke/tokyonight extras, morhetz/gruvbox, rose-pine, rebelot/kanagawa, sainnhe/everforest,
 * Solarized, primer/github-vscode-theme, Monokai Pro, ayu); keep them exact when editing.
 *
 * "Auto" is not a palette: it switches between a dark and a light theme the user pairs
 * (TerminalPreferences.autoDarkTheme / autoLightTheme) following the app's appearance.
 */

export type TerminalAppearance = 'dark' | 'light';

export const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number];

export type TerminalColors = Record<AnsiColorKey, string> & {
  background: string;
  foreground: string;
  /** Hex, or `var(--color-primary)` for themes whose cursor follows the accent. */
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
};

export interface TerminalTheme {
  id: ConcreteTerminalThemeId;
  name: string;
  description: string;
  appearance: TerminalAppearance;
  colors: TerminalColors;
}

/** Builds the 16 ANSI entries from an array in terminal order (0-15). */
function ansi(colors: readonly string[]): Record<AnsiColorKey, string> {
  if (colors.length !== ANSI_COLOR_KEYS.length) {
    throw new Error(`expected 16 ANSI colors, got ${colors.length}`);
  }
  return Object.fromEntries(ANSI_COLOR_KEYS.map((key, i) => [key, colors[i]])) as Record<
    AnsiColorKey,
    string
  >;
}

const THEMES = [
  // ---- House themes -------------------------------------------------------------------
  {
    id: 'untether',
    name: 'Untether',
    description: 'Warm near-black with the brand orange',
    appearance: 'dark',
    colors: {
      background: '#141210',
      foreground: '#F4EDE4',
      cursor: '#FF6A00',
      cursorAccent: '#141210',
      // #FF6A00 at 30% over the background
      selectionBackground: '#5A2C0B',
      selectionForeground: '#FFF8F0',
      ...ansi([
        '#2A2522',
        '#F2554B',
        '#8FC96B',
        '#FFB000',
        '#6EA8E0',
        '#E07AA6',
        '#5CC6B8',
        '#D6CDC2',
        '#6B625A',
        '#FF7A6B',
        '#B0E08C',
        '#FFCC4D',
        '#92C0F0',
        '#F0A0C0',
        '#86DDD0',
        '#FFF8F0',
      ]),
    },
  },
  {
    id: 'untether-light',
    name: 'Untether Light',
    description: 'Warm paper with the brand orange',
    appearance: 'light',
    colors: {
      background: '#FAF6F1',
      foreground: '#2A2420',
      cursor: '#FF6A00',
      cursorAccent: '#FAF6F1',
      // #FF6A00 at 25% over the background
      selectionBackground: '#FBD3B5',
      selectionForeground: '#2A2420',
      ...ansi([
        '#2A2420',
        '#C8312A',
        '#3F7F22',
        '#A85D00',
        '#1F5FAE',
        '#A33D8A',
        '#13777A',
        '#8A8178',
        '#6B625A',
        '#E04A35',
        '#4F9A2C',
        '#D97B00',
        '#2F78CF',
        '#C050A5',
        '#1B9294',
        '#B5ACA2',
      ]),
    },
  },
  {
    id: 'dark',
    name: 'Classic Dark',
    description: 'Classic xterm colors',
    appearance: 'dark',
    colors: {
      background: '#1E1E1E',
      foreground: '#D4D4D4',
      cursor: 'var(--color-primary)',
      cursorAccent: '#1E1E1E',
      selectionBackground: '#264F78',
      selectionForeground: '#FFFFFF',
      ...ansi([
        '#000000',
        '#CD0000',
        '#00CD00',
        '#CDCD00',
        '#0000EE',
        '#CD00CD',
        '#00CDCD',
        '#E5E5E5',
        '#7F7F7F',
        '#FF0000',
        '#00FF00',
        '#FFFF00',
        '#5C5CFF',
        '#FF00FF',
        '#00FFFF',
        '#FFFFFF',
      ]),
    },
  },
  {
    id: 'light',
    name: 'Soft Light',
    description: 'Soft light theme',
    appearance: 'light',
    colors: {
      background: '#F8F9FA',
      foreground: '#1F2328',
      cursor: 'var(--color-primary)',
      cursorAccent: '#F8F9FA',
      selectionBackground: '#0969DA',
      selectionForeground: '#FFFFFF',
      ...ansi([
        '#24292F',
        '#CF222E',
        '#1A7F37',
        '#9A6700',
        '#0969DA',
        '#8250DF',
        '#1B7C83',
        '#6E7781',
        '#57606A',
        '#DA3633',
        '#2DA44E',
        '#BF8700',
        '#218BFF',
        '#A475F9',
        '#3192AA',
        '#8C959F',
      ]),
    },
  },

  // ---- Dark ---------------------------------------------------------------------------
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'Soothing pastel, darkest flavor',
    appearance: 'dark',
    colors: {
      background: '#1E1E2E',
      foreground: '#CDD6F4',
      cursor: '#F5E0DC',
      cursorAccent: '#1E1E2E',
      selectionBackground: '#353749',
      selectionForeground: '#CDD6F4',
      ...ansi([
        '#45475A',
        '#F38BA8',
        '#A6E3A1',
        '#F9E2AF',
        '#89B4FA',
        '#F5C2E7',
        '#94E2D5',
        '#A6ADC8',
        '#585B70',
        '#F37799',
        '#89D88B',
        '#EBD391',
        '#74A8FC',
        '#F2AEDE',
        '#6BD7CA',
        '#BAC2DE',
      ]),
    },
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    description: 'Soothing pastel, medium contrast',
    appearance: 'dark',
    colors: {
      background: '#24273A',
      foreground: '#CAD3F5',
      cursor: '#F4DBD6',
      cursorAccent: '#24273A',
      selectionBackground: '#3A3E53',
      selectionForeground: '#CAD3F5',
      ...ansi([
        '#494D64',
        '#ED8796',
        '#A6DA95',
        '#EED49F',
        '#8AADF4',
        '#F5BDE6',
        '#8BD5CA',
        '#A5ADCB',
        '#5B6078',
        '#EC7486',
        '#8CCF7F',
        '#E1C682',
        '#78A1F6',
        '#F2A9DD',
        '#63CBC0',
        '#B8C0E0',
      ]),
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Neon lights of downtown Tokyo',
    appearance: 'dark',
    colors: {
      background: '#1A1B26',
      foreground: '#C0CAF5',
      cursor: '#C0CAF5',
      cursorAccent: '#1A1B26',
      selectionBackground: '#283457',
      selectionForeground: '#C0CAF5',
      ...ansi([
        '#15161E',
        '#F7768E',
        '#9ECE6A',
        '#E0AF68',
        '#7AA2F7',
        '#BB9AF7',
        '#7DCFFF',
        '#A9B1D6',
        '#414868',
        '#FF899D',
        '#9FE044',
        '#FABA4A',
        '#8DB0FF',
        '#C7A9FF',
        '#A4DAFF',
        '#C0CAF5',
      ]),
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Retro groove, medium contrast',
    appearance: 'dark',
    colors: {
      background: '#282828',
      foreground: '#EBDBB2',
      cursor: '#EBDBB2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      selectionForeground: '#EBDBB2',
      ...ansi([
        '#282828',
        '#CC241D',
        '#98971A',
        '#D79921',
        '#458588',
        '#B16286',
        '#689D6A',
        '#A89984',
        '#928374',
        '#FB4934',
        '#B8BB26',
        '#FABD2F',
        '#83A598',
        '#D3869B',
        '#8EC07C',
        '#EBDBB2',
      ]),
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    description: "Atom's iconic dark theme",
    appearance: 'dark',
    colors: {
      background: '#21252B',
      foreground: '#ABB2BF',
      cursor: '#ABB2BF',
      cursorAccent: '#21252B',
      selectionBackground: '#323844',
      selectionForeground: '#ABB2BF',
      ...ansi([
        '#21252B',
        '#E06C75',
        '#98C379',
        '#E5C07B',
        '#61AFEF',
        '#C678DD',
        '#56B6C2',
        '#ABB2BF',
        '#767676',
        '#E06C75',
        '#98C379',
        '#E5C07B',
        '#61AFEF',
        '#C678DD',
        '#56B6C2',
        '#ABB2BF',
      ]),
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'All natural pine, faux fur and soho vibes',
    appearance: 'dark',
    colors: {
      background: '#191724',
      foreground: '#E0DEF4',
      cursor: '#E0DEF4',
      cursorAccent: '#191724',
      selectionBackground: '#403D52',
      selectionForeground: '#E0DEF4',
      ...ansi([
        '#26233A',
        '#EB6F92',
        '#31748F',
        '#F6C177',
        '#9CCFD8',
        '#C4A7E7',
        '#EBBCBA',
        '#E0DEF4',
        '#6E6A86',
        '#EB6F92',
        '#31748F',
        '#F6C177',
        '#9CCFD8',
        '#C4A7E7',
        '#EBBCBA',
        '#E0DEF4',
      ]),
    },
  },
  {
    id: 'kanagawa-wave',
    name: 'Kanagawa Wave',
    description: 'Inspired by The Great Wave off Kanagawa',
    appearance: 'dark',
    colors: {
      background: '#1F1F28',
      foreground: '#DCD7BA',
      cursor: '#C8C093',
      cursorAccent: '#1F1F28',
      selectionBackground: '#2D4F67',
      selectionForeground: '#C8C093',
      ...ansi([
        '#16161D',
        '#C34043',
        '#76946A',
        '#C0A36E',
        '#7E9CD8',
        '#957FB8',
        '#6A9589',
        '#C8C093',
        '#727169',
        '#E82424',
        '#98BB6C',
        '#E6C384',
        '#7FB4CA',
        '#938AA9',
        '#7AA89F',
        '#DCD7BA',
      ]),
    },
  },
  {
    id: 'everforest-dark',
    name: 'Everforest Dark',
    description: 'Comfortable green forest, medium',
    appearance: 'dark',
    colors: {
      background: '#2D353B',
      foreground: '#D3C6AA',
      cursor: '#D3C6AA',
      cursorAccent: '#2D353B',
      selectionBackground: '#543A48',
      selectionForeground: '#D3C6AA',
      ...ansi([
        '#475258',
        '#E67E80',
        '#A7C080',
        '#DBBC7F',
        '#7FBBB3',
        '#D699B6',
        '#83C092',
        '#D3C6AA',
        // Upstream repeats black here; grey1 keeps bright-black text (comments, hints) readable.
        '#859289',
        '#E67E80',
        '#A7C080',
        '#DBBC7F',
        '#7FBBB3',
        '#D699B6',
        '#83C092',
        '#D3C6AA',
      ]),
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Precision colors by Ethan Schoonover',
    appearance: 'dark',
    colors: {
      background: '#002B36',
      foreground: '#839496',
      cursor: '#93A1A1',
      cursorAccent: '#002B36',
      selectionBackground: '#073642',
      selectionForeground: '#93A1A1',
      ...ansi([
        '#073642',
        '#DC322F',
        '#859900',
        '#B58900',
        '#268BD2',
        '#D33682',
        '#2AA198',
        '#EEE8D5',
        '#002B36',
        '#CB4B16',
        '#586E75',
        '#657B83',
        '#839496',
        '#6C71C4',
        '#93A1A1',
        '#FDF6E3',
      ]),
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: "GitHub's default dark theme",
    appearance: 'dark',
    colors: {
      background: '#0D1117',
      foreground: '#E6EDF3',
      cursor: '#2F81F7',
      cursorAccent: '#0D1117',
      selectionBackground: '#264F78',
      selectionForeground: '#E6EDF3',
      ...ansi([
        '#484F58',
        '#FF7B72',
        '#3FB950',
        '#D29922',
        '#58A6FF',
        '#BC8CFF',
        '#39C5CF',
        '#B1BAC4',
        '#6E7681',
        '#FFA198',
        '#56D364',
        '#E3B341',
        '#79C0FF',
        '#D2A8FF',
        '#56D4DD',
        '#FFFFFF',
      ]),
    },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    description: 'The classic Monokai, refined',
    appearance: 'dark',
    colors: {
      background: '#2D2A2E',
      foreground: '#FCFCFA',
      cursor: '#FCFCFA',
      cursorAccent: '#2D2A2E',
      selectionBackground: '#5B595C',
      selectionForeground: '#FCFCFA',
      ...ansi([
        '#403E41',
        '#FF6188',
        '#A9DC76',
        '#FFD866',
        '#FC9867',
        '#AB9DF2',
        '#78DCE8',
        '#FCFCFA',
        '#727072',
        '#FF6188',
        '#A9DC76',
        '#FFD866',
        '#FC9867',
        '#AB9DF2',
        '#78DCE8',
        '#FCFCFA',
      ]),
    },
  },
  {
    id: 'ayu-mirage',
    name: 'Ayu Mirage',
    description: 'Simple, bright and elegant, mirage',
    appearance: 'dark',
    colors: {
      background: '#1F2430',
      foreground: '#CCCAC2',
      cursor: '#FFCC66',
      cursorAccent: '#1F2430',
      selectionBackground: '#274364',
      selectionForeground: '#CCCAC2',
      ...ansi([
        '#171B24',
        '#F28273',
        '#87D96C',
        '#FCCA60',
        '#6ACDFF',
        '#DDBBFF',
        '#93E2C8',
        '#C7C7C7',
        '#686868',
        '#F28779',
        '#D5FF80',
        '#FFCD66',
        '#73D0FF',
        '#DFBFFF',
        '#95E6CB',
        '#FFFFFF',
      ]),
    },
  },
  {
    id: 'vscode-dark',
    name: 'VS Code Dark',
    description: 'Popular theme from Visual Studio Code',
    appearance: 'dark',
    colors: {
      background: '#1E1E1E',
      foreground: '#D4D4D4',
      cursor: '#AEAFAD',
      cursorAccent: '#1E1E1E',
      selectionBackground: '#264F78',
      selectionForeground: '#FFFFFF',
      ...ansi([
        '#000000',
        '#CD3131',
        '#0DBC79',
        '#E5E510',
        '#2472C8',
        '#BC3FBC',
        '#11A8CD',
        '#E5E5E5',
        '#666666',
        '#F14C4C',
        '#23D18B',
        '#F5F543',
        '#3B8EEA',
        '#D670D6',
        '#29B8DB',
        '#FFFFFF',
      ]),
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Classic dark theme',
    appearance: 'dark',
    colors: {
      background: '#282A36',
      foreground: '#F8F8F2',
      cursor: '#F8F8F2',
      cursorAccent: '#282A36',
      selectionBackground: '#44475A',
      selectionForeground: '#F8F8F2',
      ...ansi([
        '#21222C',
        '#FF5555',
        '#50FA7B',
        '#F1FA8C',
        '#BD93F9',
        '#FF79C6',
        '#8BE9FD',
        '#F8F8F2',
        '#6272A4',
        '#FF6E6E',
        '#69FF94',
        '#FFFFA5',
        '#D6ACFF',
        '#FF92DF',
        '#A4FFFF',
        '#FFFFFF',
      ]),
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic north-bluish palette',
    appearance: 'dark',
    colors: {
      background: '#2E3440',
      foreground: '#D8DEE9',
      cursor: '#D8DEE9',
      cursorAccent: '#2E3440',
      selectionBackground: '#4C566A',
      selectionForeground: '#D8DEE9',
      ...ansi([
        '#3B4252',
        '#BF616A',
        '#A3BE8C',
        '#EBCB8B',
        '#81A1C1',
        '#B48EAD',
        '#88C0D0',
        '#E5E9F0',
        '#4C566A',
        '#BF616A',
        '#A3BE8C',
        '#EBCB8B',
        '#81A1C1',
        '#B48EAD',
        '#8FBCBB',
        '#ECEFF4',
      ]),
    },
  },

  // ---- Light --------------------------------------------------------------------------
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    description: 'Soothing pastel, light flavor',
    appearance: 'light',
    colors: {
      background: '#EFF1F5',
      foreground: '#4C4F69',
      cursor: '#DC8A78',
      cursorAccent: '#EFF1F5',
      selectionBackground: '#D8DAE1',
      selectionForeground: '#4C4F69',
      ...ansi([
        '#5C5F77',
        '#D20F39',
        '#40A02B',
        '#DF8E1D',
        '#1E66F5',
        '#EA76CB',
        '#179299',
        '#ACB0BE',
        '#6C6F85',
        '#DE293E',
        '#49AF3D',
        '#EEA02D',
        '#456EFF',
        '#FE85D8',
        '#2D9FA8',
        '#BCC0CC',
      ]),
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'Precision colors by Ethan Schoonover',
    appearance: 'light',
    colors: {
      background: '#FDF6E3',
      foreground: '#657B83',
      cursor: '#586E75',
      cursorAccent: '#FDF6E3',
      selectionBackground: '#EEE8D5',
      selectionForeground: '#586E75',
      ...ansi([
        '#073642',
        '#DC322F',
        '#859900',
        '#B58900',
        '#268BD2',
        '#D33682',
        '#2AA198',
        '#EEE8D5',
        '#002B36',
        '#CB4B16',
        '#586E75',
        '#657B83',
        '#839496',
        '#6C71C4',
        '#93A1A1',
        '#FDF6E3',
      ]),
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    description: "GitHub's default light theme",
    appearance: 'light',
    colors: {
      background: '#FFFFFF',
      foreground: '#1F2328',
      cursor: '#0969DA',
      cursorAccent: '#FFFFFF',
      selectionBackground: '#ADD6FF',
      selectionForeground: '#1F2328',
      ...ansi([
        '#24292F',
        '#CF222E',
        '#116329',
        '#4D2D00',
        '#0969DA',
        '#8250DF',
        '#1B7C83',
        '#6E7781',
        '#57606A',
        '#A40E26',
        '#1A7F37',
        '#633C01',
        '#218BFF',
        '#A475F9',
        '#3192AA',
        '#8C959F',
      ]),
    },
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    description: 'Rosé Pine for sunny mornings',
    appearance: 'light',
    colors: {
      background: '#FAF4ED',
      foreground: '#575279',
      cursor: '#575279',
      cursorAccent: '#FAF4ED',
      selectionBackground: '#DFDAD9',
      selectionForeground: '#575279',
      ...ansi([
        '#F2E9E1',
        '#B4637A',
        '#286983',
        '#EA9D34',
        '#56949F',
        '#907AA9',
        '#D7827E',
        '#575279',
        '#9893A5',
        '#B4637A',
        '#286983',
        '#EA9D34',
        '#56949F',
        '#907AA9',
        '#D7827E',
        '#575279',
      ]),
    },
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Retro groove, light medium',
    appearance: 'light',
    colors: {
      background: '#FBF1C7',
      foreground: '#3C3836',
      cursor: '#3C3836',
      cursorAccent: '#FBF1C7',
      selectionBackground: '#D5C4A1',
      selectionForeground: '#3C3836',
      ...ansi([
        '#FBF1C7',
        '#CC241D',
        '#98971A',
        '#D79921',
        '#458588',
        '#B16286',
        '#689D6A',
        '#7C6F64',
        '#928374',
        '#9D0006',
        '#79740E',
        '#B57614',
        '#076678',
        '#8F3F71',
        '#427B58',
        '#3C3836',
      ]),
    },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  description: string;
  appearance: TerminalAppearance;
  colors: TerminalColors;
}[];

export type ConcreteTerminalThemeId = (typeof THEMES)[number]['id'];
export type TerminalThemeId = 'auto' | ConcreteTerminalThemeId;

/** Every concrete theme, house themes first, then dark, then light. */
export const TERMINAL_THEMES: readonly TerminalTheme[] = THEMES;

export const DEFAULT_AUTO_DARK_THEME: ConcreteTerminalThemeId = 'untether';
export const DEFAULT_AUTO_LIGHT_THEME: ConcreteTerminalThemeId = 'untether-light';

export function getTerminalTheme(id: string): TerminalTheme | undefined {
  return TERMINAL_THEMES.find((theme) => theme.id === id);
}

export function isTerminalThemeId(id: unknown): id is TerminalThemeId {
  return id === 'auto' || (typeof id === 'string' && getTerminalTheme(id) !== undefined);
}

/** A concrete theme id of the given appearance, for the Auto pairing. */
export function isThemeOfAppearance(
  id: unknown,
  appearance: TerminalAppearance
): id is ConcreteTerminalThemeId {
  return typeof id === 'string' && getTerminalTheme(id)?.appearance === appearance;
}

export function themesByAppearance(appearance: TerminalAppearance): TerminalTheme[] {
  return TERMINAL_THEMES.filter((theme) => theme.appearance === appearance);
}

export interface AutoThemePair {
  dark: ConcreteTerminalThemeId;
  light: ConcreteTerminalThemeId;
}

/**
 * The palette to paint: the selected theme, or for Auto the paired dark/light theme that
 * matches the app's current appearance.
 */
export function resolveTerminalTheme(
  id: TerminalThemeId,
  appearance: TerminalAppearance,
  pair: AutoThemePair
): TerminalTheme {
  const target = id === 'auto' ? pair[appearance] : id;
  return (
    getTerminalTheme(target) ??
    (getTerminalTheme(
      appearance === 'dark' ? DEFAULT_AUTO_DARK_THEME : DEFAULT_AUTO_LIGHT_THEME
    ) as TerminalTheme)
  );
}
