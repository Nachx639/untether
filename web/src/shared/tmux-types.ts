export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  activity?: string;
  current?: boolean;
  /** What the active pane shows as its title: Claude Code's conversation title. */
  title?: string;
  /** The active pane's program ("claude" for Claude Code's versioned binary) and folder. */
  command?: string;
  path?: string;
}

export interface TmuxWindow {
  session: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface TmuxPane {
  session: string;
  window: number;
  index: number;
  active: boolean;
  title?: string;
  pid?: number;
  command?: string;
  width: number;
  height: number;
  currentPath?: string;
}

export interface TmuxTarget {
  session: string;
  window?: number;
  pane?: number;
}
