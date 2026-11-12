// Re-export tmux types for compatibility
export type { TmuxPane, TmuxSession, TmuxTarget, TmuxWindow } from './tmux-types.js';

export type MultiplexerType = 'tmux' | 'zellij' | 'screen';

export interface MultiplexerSession {
  name: string;
  type: MultiplexerType;
  windows?: number; // tmux specific
  created?: string;
  attached?: boolean; // tmux specific
  exited?: boolean; // zellij specific
  activity?: string; // tmux specific
  current?: boolean; // tmux specific
  title?: string; // tmux specific: the active pane's title (Claude's conversation title)
  command?: string; // tmux specific: the active pane's program
  path?: string; // tmux specific: the active pane's folder
}

export interface MultiplexerStatus {
  tmux: {
    available: boolean;
    type: MultiplexerType;
    sessions: MultiplexerSession[];
  };
  zellij: {
    available: boolean;
    type: MultiplexerType;
    sessions: MultiplexerSession[];
  };
  screen: {
    available: boolean;
    type: MultiplexerType;
    sessions: MultiplexerSession[];
  };
}

export interface MultiplexerTarget {
  type: MultiplexerType;
  session: string;
  window?: number; // tmux specific
  pane?: number; // tmux specific
}
