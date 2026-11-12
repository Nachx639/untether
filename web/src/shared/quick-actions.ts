/**
 * Quick actions: one-tap prompts on the phone, in a strip above the session's bottom bar.
 *
 * A project defines its own in `.untether/quick-actions.json` at the root of the session's
 * repository or worktree:
 *
 *   { "version": 1, "actions": [
 *       { "id": "status", "emoji": "📊", "label": "Status", "prompt": "Where are we?",
 *         "confirm": false, "agents": ["claude", "codex"] } ] }
 *
 * `agents` limits an action to sessions running those agents; without it the action shows in
 * every session (shells too). Without a file the strip shows DEFAULT_QUICK_ACTIONS. Reading is
 * lenient (an invalid entry is skipped with a warning, the rest still show); saving from the
 * editor is strict (the server refuses a list with any invalid entry).
 */

export const QUICK_ACTIONS_VERSION = 1;
/** Relative to the repository (or worktree) root. */
export const QUICK_ACTIONS_FILE = '.untether/quick-actions.json';

export const QUICK_ACTION_AGENTS = ['claude', 'codex'] as const;
export type QuickActionAgent = (typeof QUICK_ACTION_AGENTS)[number];

export const QUICK_ACTION_LIMITS = {
  actions: 50,
  id: 64,
  emoji: 16,
  label: 40,
  prompt: 4000,
} as const;

export interface QuickAction {
  id: string;
  emoji: string;
  label: string;
  prompt: string;
  confirm?: boolean;
  agents?: QuickActionAgent[];
}

export interface QuickActionsConfig {
  version: number;
  actions: QuickAction[];
}

/** GET/PUT /api/sessions/:id/quick-actions. */
export interface QuickActionsResponse {
  /** "file": read from the project's file; "default": there is none (or it has no actions). */
  source: 'file' | 'default';
  /** Absolute path of the file (existing or where saving creates it). */
  path: string;
  actions: QuickAction[];
  /** Entries skipped while reading the file, or why the file itself was not usable. */
  warnings: string[];
}

export const DEFAULT_QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: 'status',
    emoji: '📊',
    label: 'Status',
    prompt: 'Give me a short status: what you are doing, what is done and what is left.',
    agents: ['claude', 'codex'],
  },
  {
    id: 'next-steps',
    emoji: '➡️',
    label: 'Next steps',
    prompt: 'What are the next steps? List them briefly, most important first.',
    agents: ['claude', 'codex'],
  },
  {
    id: 'run-tests',
    emoji: '🧪',
    label: 'Run tests',
    prompt: "Run the project's tests and tell me what fails, if anything.",
    agents: ['claude', 'codex'],
  },
  {
    id: 'summarize-changes',
    emoji: '📝',
    label: 'Summarize changes',
    prompt: 'Summarize the changes you made so far, file by file, in a few lines.',
    agents: ['claude', 'codex'],
  },
  {
    id: 'compact',
    emoji: '🗜️',
    label: 'Compact',
    prompt: '/compact',
    confirm: true,
    agents: ['claude'],
  },
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One entry checked: the action (unknown keys dropped), or why it is not one. */
export function validateQuickAction(raw: unknown): { action: QuickAction } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' };
  const entry = raw as Record<string, unknown>;
  const text = (key: 'id' | 'emoji' | 'label' | 'prompt'): string | { error: string } => {
    const value = entry[key];
    if (typeof value !== 'string' || !value.trim()) return { error: `${key} is required` };
    if (value.length > QUICK_ACTION_LIMITS[key]) {
      return { error: `${key} is longer than ${QUICK_ACTION_LIMITS[key]} characters` };
    }
    return key === 'prompt' ? value : value.trim();
  };
  const id = text('id');
  if (typeof id !== 'string') return id;
  if (!ID_PATTERN.test(id)) return { error: 'id may only hold letters, digits, - and _' };
  const emoji = text('emoji');
  if (typeof emoji !== 'string') return emoji;
  const label = text('label');
  if (typeof label !== 'string') return label;
  const prompt = text('prompt');
  if (typeof prompt !== 'string') return prompt;

  const action: QuickAction = { id, emoji, label, prompt };
  if (entry.confirm !== undefined) {
    if (typeof entry.confirm !== 'boolean') return { error: 'confirm must be true or false' };
    if (entry.confirm) action.confirm = true;
  }
  if (entry.agents !== undefined) {
    const agents = entry.agents;
    if (
      !Array.isArray(agents) ||
      agents.length === 0 ||
      !agents.every((a) => (QUICK_ACTION_AGENTS as readonly unknown[]).includes(a))
    ) {
      return { error: `agents must be a non-empty list of ${QUICK_ACTION_AGENTS.join(', ')}` };
    }
    action.agents = [...new Set(agents as QuickActionAgent[])];
  }
  return { action };
}

/**
 * The file's content read leniently: valid entries kept in order, the others (and duplicate
 * ids, after the first) reported in `warnings`. `config` is null when the file as a whole is
 * unusable (not JSON, no actions list, a version this build does not know).
 */
export function parseQuickActions(content: string): {
  config: QuickActionsConfig | null;
  warnings: string[];
} {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { config: null, warnings: ['not valid JSON'] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { config: null, warnings: ['not a JSON object'] };
  }
  const { version, actions } = data as Record<string, unknown>;
  if (version !== QUICK_ACTIONS_VERSION) {
    return { config: null, warnings: [`unsupported version ${JSON.stringify(version)}`] };
  }
  if (!Array.isArray(actions)) return { config: null, warnings: ['actions must be a list'] };

  const warnings: string[] = [];
  const kept: QuickAction[] = [];
  const ids = new Set<string>();
  actions.forEach((raw, index) => {
    const result = validateQuickAction(raw);
    if ('error' in result) {
      warnings.push(`action ${index + 1}: ${result.error}`);
    } else if (ids.has(result.action.id)) {
      warnings.push(`action ${index + 1}: duplicate id "${result.action.id}"`);
    } else if (kept.length >= QUICK_ACTION_LIMITS.actions) {
      warnings.push(`action ${index + 1}: more than ${QUICK_ACTION_LIMITS.actions} actions`);
    } else {
      ids.add(result.action.id);
      kept.push(result.action);
    }
  });
  return { config: { version: QUICK_ACTIONS_VERSION, actions: kept }, warnings };
}

/** A list to save, checked strictly: every entry valid, ids unique. */
export function validateQuickActionsForSave(
  raw: unknown
): { actions: QuickAction[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'actions must be a list' };
  if (raw.length > QUICK_ACTION_LIMITS.actions) {
    return { error: `at most ${QUICK_ACTION_LIMITS.actions} actions` };
  }
  const actions: QuickAction[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const result = validateQuickAction(entry);
    if ('error' in result) return { error: `action ${index + 1}: ${result.error}` };
    if (ids.has(result.action.id)) {
      return { error: `action ${index + 1}: duplicate id "${result.action.id}"` };
    }
    ids.add(result.action.id);
    actions.push(result.action);
  }
  return { actions };
}

/**
 * The actions a session shows: those for its agent (an action without `agents` is for every
 * session). `agent` is null for a shell or an agent the schema does not name (Gemini).
 */
export function quickActionsFor(
  actions: readonly QuickAction[],
  agent: QuickActionAgent | null
): QuickAction[] {
  return actions.filter((a) => !a.agents || (agent !== null && a.agents.includes(agent)));
}

/** A fresh id for a new action, unique in the list ("action", "action-2"…). */
export function newQuickActionId(label: string, taken: readonly QuickAction[]): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'action';
  const ids = new Set(taken.map((a) => a.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
