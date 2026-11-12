/**
 * The model an agent really ran with, against the one asked for (2026-11-08: every Claude task
 * ran for days on claude-opus-4-8, the account's default for a `claude` without --model, while
 * Opus 5.5 was out and nobody saw it). The real model comes from the agent's own records
 * (Claude's `message.model`, Codex's turn_context), never from what was asked.
 */

/** Claude Code's model aliases, each standing for the newest model of its family. */
const CLAUDE_ALIASES: Record<string, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'fable',
  opusplan: 'opus',
};

export interface ClaudeModelId {
  family: string;
  /** [major, minor]: 4-8 → [4, 8]. */
  version: number[];
}

/** Without a context suffix (`[1m]`) and in lower case. */
function bare(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
}

/**
 * claude-opus-4-8 / claude-haiku-4-5-20251001 / claude-3-5-sonnet-20241022 → family and version;
 * undefined for anything else (another agent's model, `<synthetic>`).
 */
export function parseClaudeModel(model: string): ClaudeModelId | undefined {
  const id = bare(model);
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (modern) {
    return { family: modern[1], version: [Number(modern[2]), Number(modern[3] ?? 0)] };
  }
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(id);
  if (old) return { family: old[3], version: [Number(old[1]), Number(old[2] ?? 0)] };
  return undefined;
}

/** -1, 0, 1 as `a` is older, the same version, newer than `b` (same family assumed). */
export function compareVersions(a: ClaudeModelId, b: ClaudeModelId): number {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const diff = (a.version[i] ?? 0) - (b.version[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** The family an alias names (`opus`, `sonnet[1m]`), else undefined. */
export function aliasFamily(model: string): string | undefined {
  return CLAUDE_ALIASES[bare(model)];
}

/**
 * Whether the model that answered is the one asked for: an alias asks for its family, a model
 * id for itself (a dated release of it counts, `claude-haiku-4-5` → `claude-haiku-4-5-20251001`,
 * nothing else: `claude-opus-4` is not `claude-opus-4-8`).
 * Anything else (another agent's own names) is compared as it is written.
 */
export function modelMatches(requested: string, actual: string): boolean {
  const asked = bare(requested);
  const real = bare(actual);
  // `default` is the agent's own choice; opusplan is Opus in plan mode and Sonnet otherwise.
  if (!asked || asked === 'default' || asked === real) return true;
  if (asked === 'opusplan')
    return ['opus', 'sonnet'].includes(parseClaudeModel(real)?.family ?? '');
  const family = aliasFamily(asked);
  if (family) return parseClaudeModel(real)?.family === family;
  // Only a release date may follow (claude-opus-4 is not claude-opus-4-8).
  const dated = (long: string, short: string) =>
    long.startsWith(`${short}-`) && /^\d{8}$/.test(long.slice(short.length + 1));
  return dated(real, asked) || dated(asked, real);
}

/** A model a transcript names that no model produced (Claude Code's own error messages). */
export function isRealModel(model: unknown): model is string {
  return typeof model === 'string' && !!model.trim() && !model.startsWith('<');
}

/**
 * The model a `claude -p --output-format stream-json` event names: the API's message_start or
 * an assistant message (what really answered), else the init event's (what the CLI resolved).
 */
export function streamEventModel(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const o = event as {
    type?: string;
    subtype?: string;
    model?: unknown;
    message?: { model?: unknown };
    event?: { type?: string; message?: { model?: unknown } };
  };
  const model =
    o.type === 'assistant'
      ? o.message?.model
      : o.type === 'stream_event' && o.event?.type === 'message_start'
        ? o.event.message?.model
        : o.type === 'system' && o.subtype === 'init'
          ? o.model
          : undefined;
  return isRealModel(model) ? model : undefined;
}

/** "claude-opus-4-8", with what was asked when it is not that: "claude-opus-4-8 (asked: claude-opus-5-5)". */
export function actualModelText(actual: string, requested?: string): string {
  return requested && !modelMatches(requested, actual) ? `${actual} (asked: ${requested})` : actual;
}

/** The model a task's agent really runs with now (its newest message), when one was read. */
export function taskActualModel(task: {
  metrics?: { usage?: { lastModel?: { model: string } } };
}): string | undefined {
  return task.metrics?.usage?.lastModel?.model;
}
