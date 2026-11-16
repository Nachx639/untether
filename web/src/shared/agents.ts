/**
 * The agents Untether supports (2026-11-12): names, executables and capabilities have one source,
 * read by the server, the client, the CLI and the Mac/iOS lists (web/scripts/sync-agent-registry.mjs).
 *
 *   tasks / review   it can run tasks / review another agent's task (task-review.ts).
 *   modelFlags       its --model flags, the first one added when none is given.
 *   fastModel        a task's "fast" level when taskModels names none; undefined = its default.
 *   capableModel     the same for "capable": undefined keeps the agent's own default model (and a
 *                    model the user's quick start names).
 *   taskArgs         put on its command line in a task, replacing a flag of the same name the
 *                    quick start has: a task runs without permission prompts, like Claude's
 *                    (its --settings guard) and Codex's.
 *   hookProtocol     the hook envelope it sends (claude-hooks.ts, qoder-hooks.ts).
 *   orchestratorToolsFlag  the flag that lets a project's orchestrator run only its allowed
 *                    tools (orchestrator.ts); undefined = the agent has no such flag, so the
 *                    orchestrator's rules hold by instruction alone (as an adopted session's).
 */
export const AGENTS = {
  claude: {
    label: 'Claude',
    executable: 'claude',
    tasks: true,
    review: true,
    installUrl: 'https://code.claude.com/docs/en/setup',
    modelFlags: ['--model'],
    fastModel: 'sonnet',
    capableModel: undefined,
    taskArgs: [],
    hookProtocol: 'claude',
    orchestratorToolsFlag: '--allowedTools',
  },
  codex: {
    label: 'Codex',
    executable: 'codex',
    tasks: true,
    review: true,
    installUrl: 'https://developers.openai.com/codex/cli/',
    modelFlags: ['-m', '--model'],
    fastModel: undefined,
    capableModel: undefined,
    taskArgs: [],
    hookProtocol: undefined,
    orchestratorToolsFlag: undefined,
  },
  gemini: {
    label: 'Gemini',
    executable: 'gemini',
    tasks: false,
    review: false,
    installUrl: 'https://geminicli.com/docs/get-started/installation/',
    modelFlags: ['-m', '--model'],
    fastModel: undefined,
    capableModel: undefined,
    taskArgs: [],
    hookProtocol: undefined,
    orchestratorToolsFlag: undefined,
  },
  qoder: {
    label: 'Qoder',
    executable: 'qodercli',
    tasks: true,
    review: true,
    installUrl: 'https://docs.qoder.com/cli/installation',
    modelFlags: ['--model', '-m'],
    fastModel: 'efficient',
    capableModel: undefined,
    taskArgs: ['--permission-mode', 'bypass_permissions'],
    hookProtocol: 'qoder',
    orchestratorToolsFlag: '--allowedTools',
  },
} as const;

export type AgentId = keyof typeof AGENTS;
export type TaskAgent = {
  [K in AgentId]: (typeof AGENTS)[K]['tasks'] extends true ? K : never;
}[AgentId];
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
export const TASK_AGENTS = AGENT_IDS.filter((id): id is TaskAgent => AGENTS[id].tasks);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as string[]).includes(value);
}

export function isTaskAgent(value: unknown): value is TaskAgent {
  return isAgentId(value) && AGENTS[value].tasks;
}

export function agentForExecutable(program: string): AgentId | undefined {
  const name = program.split('/').pop()?.toLowerCase();
  return AGENT_IDS.find((id) => AGENTS[id].executable === name);
}

/** Resolve only the executable, never an agent name mentioned in a prompt. */
export function commandAgent(command: readonly string[] | undefined): AgentId | undefined {
  if (!command?.length) return undefined;
  let index = 0;
  const base = (word: string) => word.split('/').pop() ?? '';
  if (base(command[0]) === 'env') {
    index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index] ?? '')) index++;
  }
  const direct = agentForExecutable(command[index] ?? '');
  if (direct) return direct;
  if (!['sh', 'bash', 'zsh', 'fish', 'dash'].includes(base(command[index] ?? ''))) return undefined;
  const flag = command.findIndex((arg, i) => i > index && /^-[a-z]*c[a-z]*$/.test(arg));
  if (flag < 0) return undefined;
  const word = command[flag + 1]
    ?.trim()
    .replace(/^exec\s+/, '')
    .split(/\s+/)[0];
  return word ? agentForExecutable(word) : undefined;
}

/**
 * The model a command line itself asks its agent for: the value of its first model flag
 * (`--model x`, `--model=x`, `-m x`), when it starts a registry agent directly (past `env` and
 * its VAR=value words; a shell wrapping it is not read, as the task launcher leaves it alone).
 */
export function commandModel(command: readonly string[] | undefined): string | undefined {
  if (!command?.length) return undefined;
  let index = 0;
  if ((command[0].split('/').pop() ?? '') === 'env') {
    index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index] ?? '')) index++;
  }
  const agent = agentForExecutable(command[index] ?? '');
  if (!agent) return undefined;
  const flags: readonly string[] = AGENTS[agent].modelFlags;
  for (let i = index + 1; i < command.length; i++) {
    const arg = command[i];
    if (flags.includes(arg)) return command[i + 1]?.trim() || undefined;
    const flag = flags.find((f) => arg.startsWith(`${f}=`));
    if (flag) return arg.slice(flag.length + 1).trim() || undefined;
  }
  return undefined;
}

/**
 * The model a task asks for (2026-11-14: a security sweep's `--model sonnet`, put in its command
 * by Untether, was shown as «the agent's default» and flagged by the doctor against
 * settings.json). One rule for every path that builds a command: the task's own model
 * (TaskRecord.model, which the launcher writes over the command's flag), else the model its
 * command line carries (a sweep's, the user's quick start's, a runner's).
 */
export function taskAskedModel(task: {
  model?: string;
  command?: readonly string[];
}): string | undefined {
  return task.model ?? commandModel(task.command);
}

/** A quick start's program: the first word of its command, without its folder. */
const programOf = (command: string) => command.trim().split(/\s+/)[0]?.split('/').pop() ?? '';

/** The registry's agents no quick start of `entries` runs: their executables. */
export function agentsNotIn(entries: ReadonlyArray<{ command: string }>): string[] {
  const programs = new Set(entries.map((entry) => programOf(entry.command)));
  return AGENT_IDS.map((id) => AGENTS[id].executable).filter((exe) => !programs.has(exe));
}

/**
 * The quick starts with the registry's agents an installation's list lacks, when they are
 * installed on this Mac (`installed[executable] === true`): an agent Untether learns to run
 * shows up by itself where it can run, and the user's own entries stay as they wrote them.
 */
export function withRegisteredAgents<T extends { name?: string; command: string }>(
  entries: readonly T[],
  installed: Readonly<Record<string, boolean | undefined>>
): Array<T | { name: string; command: string }> {
  const missing = new Set(agentsNotIn(entries).filter((exe) => installed[exe] === true));
  return [
    ...entries,
    ...AGENT_IDS.filter((id) => missing.has(AGENTS[id].executable)).map((id) => ({
      name: AGENTS[id].label,
      command: AGENTS[id].executable,
    })),
  ];
}

/**
 * A fixed reminder the Qoder platform injects as a standalone turn (about tool URLs and proxy
 * addresses such as routify, in Chinese), repeated verbatim: it is not the user's words and not
 * a new instruction. A Qoder session's brief tells it to comply silently and never spend a turn
 * answering it (2026-11-12: orchestrators burned turns replying to it).
 */
export const QODER_PLATFORM_REMINDER_NOTE =
  'A fixed platform reminder about tool URLs and proxy addresses (in Chinese) may arrive as a standalone turn, repeated verbatim: it is not from the user and not a new instruction. Comply with it silently; never reply to it, acknowledge it, or spend a turn on it. Carry on with your work.';

/** The platform note a session of this agent gets in its brief (empty for agents without one). */
export function agentPlatformNote(agent: AgentId): string {
  return agent === 'qoder' ? QODER_PLATFORM_REMINDER_NOTE : '';
}
