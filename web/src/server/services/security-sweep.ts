/**
 * Security sweeps per project (2026-10-23; shared/security.ts says what they are). Off by
 * default; `securitySweep=true` (the project's gear, or `ut project set`, which asks an agent's
 * caller for the user's OK) turns on both loops, everything else is deduced:
 *
 * Rounds, every `securitySweepHours` (6): one at a time per project, never while the user has
 * tasks of that project at work or the Mac is busy (load per core over LOAD_MAX). Each round
 * takes the next section (rotating; the repository's top folders, 5 to 10, the biggest split)
 * or, every `securityDepsEvery` rounds, the dependencies (unused or replaceable ones, and the
 * locked versions OSV knows advisories for). The search is a hidden worktree task: no push,
 * not on the board, its agent without the user's credentials (session-env.ts withoutSecrets),
 * no network tools, told never to run the code it attacks nor to write secret values. It
 * writes its findings to SECURITY_FINDINGS_FILE. Each finding then goes to the adversarial
 * reviewer (security-review.ts): the other agent when both are installed (the two swap roles
 * every round), told to prove it wrong. What it confirms becomes one fix task: the fix made,
 * checked and reviewed in its branch, waiting in needs_you for «Fusionar» (task-scheduler.ts);
 * what it dismisses goes to the sweep's log, shown in the project's settings. A round with
 * nothing found leaves nothing: its task is discarded, no push, no branch.
 *
 * Supply chain, every `securitySupplyHours` (1): the lockfiles' packages crossed with OSV
 * (supply-chain.ts), not held back by the user's tasks or the load. An advisory not seen
 * before with a patched version in the same major opens a bump at once, one task per lockfile
 * (2026-10-23: arguing exploitability dismissed cheap, safe bumps); it merges on its own only
 * in the safest case, the reviewer judging the upgrade's diff (shared/security.ts
 * bumpMergesOnItsOwn). With no fix or only a major one, the same reviewer decides first. A
 * direct dependency nothing imports is proposed for removal, never merged on its own.
 *
 * Exposure (2026-10-26, «que el barrido mire también lo que corre»; security-exposure.ts), with
 * the supply chain's hours, under the sweep's own switch: the universal deterministic checks
 * (the project's processes listening beyond loopback, its containers published beyond
 * loopback, privileged, on the host network or holding the Docker socket) and the provider
 * connectors the project set up. A high one fixed in the repository opens a task that waits
 * for the user; one outside it (a tailnet policy, an old device) is only told; the rest go to
 * the log. Each is told once while it stays (again after EXPOSURE_REMIND_MS). When the
 * repository or what runs shows any surface, the rotation gains EXPOSURE_SECTION: an agent
 * reads the repository and the read-only facts Untether gathered (it runs nothing itself) and
 * reports what the project exposes, reviewed like any other finding.
 *
 * State (round, rotation, log, advisories seen, exposure) in `<control dir>/security-sweeps.json`.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectSettings } from '../../shared/projects.js';
import {
  CODEX_EFFORT_CONFIG,
  compareVersions,
  DEPENDENCIES_SECTION,
  EXPOSURE_SECTION,
  type ExposureFinding,
  type ExposureStatus,
  isDependencyFinding,
  isSafeBump,
  SECURITY_CATEGORIES,
  SECURITY_FINDINGS_FILE,
  SECURITY_SECTIONS_MAX,
  SECURITY_SECTIONS_MIN,
  type SecurityBump,
  type SecurityCategory,
  type SecurityEffort,
  type SecurityFinding,
  type SecurityLogEntry,
  type SecurityRoundResult,
  type SecuritySeverity,
  type SecuritySweepConfig,
  type SecuritySweepStatus,
  securityConfig,
  type TaskSecurity,
  testsWeakened,
  worstSeverity,
} from '../../shared/security.js';
import {
  TASK_BUSY_STATES,
  TASK_FINAL_STATES,
  type TaskAgent,
  type TaskRecord,
  type TaskRiskReview,
} from '../../shared/tasks.js';
import { run } from '../utils/exec-file.js';
import { every } from '../utils/periodic-loop.js';
import { extractJsonObject } from './ai-json-reply.js';
import { normalizeRepoPath } from './project-settings.js';
import {
  type ConnectorIo,
  containerFindings,
  exposureFacts,
  listenerFindings,
  type ProbeRunner,
  type RunningState,
  readRunning,
  runConnectors,
  runningSurface,
  sortExposureFindings,
  surfaceFrom,
} from './security-exposure.js';
import type { SecurityReviewer, SecurityRuling } from './security-review.js';
import {
  type Advisory,
  type AffectedPackage,
  type LockedPackage,
  lockedPackages,
  queryOsv,
  type UnusedDependency,
  unusedDependencies,
} from './supply-chain.js';
import type { NewTask, TaskActionResult } from './task-scheduler.js';

const STORE_VERSION = 1;
export const SWEEP_TICK_MS = 60_000;
/** A search still at it after this long is given up (its round is abandoned). */
export const SWEEP_MAX_MS = 3 * 60 * 60_000;
/** A search waiting on a prompt this long is given up (nobody looks at its screen). */
export const SWEEP_STUCK_MS = 30 * 60_000;
/** Load per core above which no round starts. */
export const LOAD_MAX = 0.75;
/** Findings reviewed per round, and advisories per supply check. */
const FINDINGS_MAX = 10;
const SUPPLY_PACKAGES_MAX = 5;
/** Bump tasks open at once per project (the first check may find many old advisories). */
const SUPPLY_OPEN_MAX = 3;
const LOG_MAX = 100;
const SEEN_MAX = 5000;
const EXCERPT_LINES = 40;
const CONTEXT_MAX = 12_000;
const AGENTS: readonly TaskAgent[] = ['claude', 'codex'];
/** A risky task's flagged diff is reviewed whole or not at all (reviewRisk). */
export const RISK_DIFF_MAX = CONTEXT_MAX * 4;
/** An exposure finding still there is told again after this long (its task may be gone). */
export const EXPOSURE_REMIND_MS = 7 * 24 * 3_600_000;
const EXPOSURE_TOLD_MAX = 1000;
const AGENT_TOLD = 'agent:';

/** An exposure round's finding, told only once: by where and what it is. */
function agentFindingKey(finding: Pick<SecurityFinding, 'file' | 'title'>): string {
  const hash = createHash('sha256')
    .update(`${finding.file}\n${finding.title.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `${AGENT_TOLD}${hash}`;
}

/** What the sweeper needs of the task scheduler. */
export interface SweepTasks {
  create(input: NewTask): Promise<TaskRecord>;
  get(id: string): TaskRecord | undefined;
  list(): TaskRecord[];
  discard(id: string, options?: { confirm?: boolean }): Promise<TaskActionResult>;
}

export interface SecuritySweeperDeps {
  statePath: string;
  settings: {
    list(): Array<{ repoPath: string; settings: ProjectSettings }>;
    get(repoPath: string): ProjectSettings;
  };
  tasks: () => SweepTasks | null;
  /** The user's command line for an agent (its quick start), without the sweep's flags. */
  commandFor: (agent: TaskAgent) => string[];
  /** The agents installed on this Mac. */
  agents: () => Promise<TaskAgent[]>;
  reviewer: SecurityReviewer;
  /** Load per core (default: os.loadavg()[0] / cores). */
  load?: () => number;
  sections?: (repoPath: string) => Promise<string[]>;
  locked?: (repoPath: string) => Promise<LockedPackage[]>;
  advisories?: (packages: LockedPackage[]) => Promise<AffectedPackage[]>;
  /** The code around a finding, read from the base commit (secrets masked). */
  excerpt?: (repoPath: string, rev: string, file: string, line?: number) => Promise<string>;
  /** A fix's diff, base to head, of `paths` when given (default: git diff in its worktree). */
  fixDiff?: (cwd: string, baseSha: string, headSha: string, paths?: string[]) => Promise<string>;
  /** Files that use a package (supply-chain reviews). */
  usages?: (repoPath: string, name: string) => Promise<string[]>;
  /** Direct dependencies nothing in their package uses. */
  unused?: (repoPath: string) => Promise<UnusedDependency[]>;
  /** Exposure (2026-10-26): the read-only probes, and the connectors' credential and API. */
  exposure?: {
    probe?: ProbeRunner;
    running?: (repoPath: string) => Promise<RunningState>;
    connectors?: ConnectorIo;
    home?: string;
    /**
     * The project's Untether connector (2026-10-31): its channels as surface lines and what is
     * wrong with them (a listener beyond loopback, a token store others can read).
     */
    untetherConnector?: (repoPath: string) => { surface: string[]; findings: ExposureFinding[] };
  };
  /** Tells the user something with no fix in the repository (a push). */
  notify?: (notice: { repoPath: string; title: string; body: string }) => void;
  now?: () => number;
  log?: (message: string) => void;
}

interface CurrentRound {
  taskId: string;
  section: string;
  kind: 'code' | 'deps' | 'exposure';
  /** An exposure round: the read-only facts its agent got (the reviewer gets them too). */
  facts?: string;
  agent: TaskAgent;
  reviewer: TaskAgent;
  startedAt: string;
}

interface ProjectSweepState {
  round: number;
  sectionIndex: number;
  lastRoundAt?: string;
  lastResult?: SecurityRoundResult;
  lastSection?: string;
  current?: CurrentRound;
  log: SecurityLogEntry[];
  supplyCheckedAt?: string;
  /** The last exposure check (2026-10-26). */
  exposure?: ExposureStatus;
  /** Exposure findings already told or turned into a task, and when (key → ISO). */
  exposureTold?: Record<string, string>;
  /**
   * Advisory keys already ruled on or bumped ("<id> <ecosystem>/<name>@<version> <lockfile>"),
   * and removals proposed ("unused <manifest> <name>").
   */
  seen: string[];
}

// --- pure parts (tested on their own) --------------------------------------------------------

/**
 * The next round's section: the dependencies every `depsEvery` rounds, else the next one
 * (EXPOSURE_SECTION among them is an exposure round).
 */
export function pickSection(
  round: number,
  sectionIndex: number,
  sections: readonly string[],
  depsEvery: number
): { section: string; kind: 'code' | 'deps' | 'exposure'; nextIndex: number } {
  if (depsEvery > 0 && (round + 1) % depsEvery === 0) {
    return { section: DEPENDENCIES_SECTION, kind: 'deps', nextIndex: sectionIndex };
  }
  if (!sections.length) return { section: '.', kind: 'code', nextIndex: 0 };
  const index = ((sectionIndex % sections.length) + sections.length) % sections.length;
  const section = sections[index];
  return {
    section,
    kind: section === EXPOSURE_SECTION ? 'exposure' : 'code',
    nextIndex: (index + 1) % sections.length,
  };
}

/**
 * Who searches and who reviews this round: they take turns among the installed agents, and the
 * reviewer is the other one whenever there are two.
 */
export function pickAgents(
  round: number,
  installed: readonly TaskAgent[]
): { agent: TaskAgent; reviewer: TaskAgent } | null {
  const agents = AGENTS.filter((agent) => installed.includes(agent));
  if (!agents.length) return null;
  const agent = agents[round % agents.length];
  const reviewer = agents.length > 1 ? agents[(round + 1) % agents.length] : agent;
  return { agent, reviewer };
}

/** Folders that are not code worth sweeping. */
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'docs',
  'doc',
  'assets',
  'images',
  'img',
  'fixtures',
  '__snapshots__',
]);
const NON_CODE =
  /\.(md|mdx|txt|png|jpe?g|gif|webp|svg|ico|icns|pdf|mp[34]|mov|woff2?|ttf|otf|lock|snap)$/i;

/**
 * Sections deduced from the tracked files: the top folders holding code, the biggest split
 * into its subfolders while there are fewer than SECURITY_SECTIONS_MIN or one holds over half
 * the code, at most SECURITY_SECTIONS_MAX (the biggest), sorted so the rotation is stable.
 */
export function deduceSectionsFrom(files: readonly string[]): string[] {
  const code = files.filter((file) => {
    const parts = file.split('/');
    if (parts.length < 2 || NON_CODE.test(file)) return false;
    return !parts
      .slice(0, -1)
      .some((part) => SKIP_DIRS.has(part) || (part.startsWith('.') && part !== '.github'));
  });
  const countBy = (prefixes: string[]) => {
    const counts = new Map<string, number>();
    for (const file of code) {
      const prefix = prefixes.find((dir) => file.startsWith(`${dir}/`));
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return counts;
  };
  let sections = [...new Set(code.map((file) => file.split('/')[0]))];
  for (let step = 0; step < 20; step++) {
    const counts = countBy(sections);
    const total = code.length;
    const [biggest, size] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (!biggest) break;
    const needMore = sections.length < SECURITY_SECTIONS_MIN || size > total / 2;
    // Split even past the most: the smallest sections are dropped at the end.
    if (!needMore) break;
    const depth = biggest.split('/').length;
    const children = [
      ...new Set(
        code
          .filter((file) => file.startsWith(`${biggest}/`) && file.split('/').length > depth + 1)
          .map((file) =>
            file
              .split('/')
              .slice(0, depth + 1)
              .join('/')
          )
      ),
    ];
    // A folder with no subfolders stays whole.
    if (!children.length) break;
    const direct = code.some(
      (file) => file.startsWith(`${biggest}/`) && file.split('/').length === depth + 1
    );
    sections = [...sections.filter((dir) => dir !== biggest), ...children];
    if (direct) sections.push(`${biggest}/*`);
    if (sections.length > SECURITY_SECTIONS_MAX * 2) break;
  }
  const counts = new Map<string, number>();
  for (const section of sections) {
    const dir = section.endsWith('/*') ? section.slice(0, -2) : section;
    const depth = dir.split('/').length;
    counts.set(
      section,
      code.filter((file) =>
        section.endsWith('/*')
          ? file.startsWith(`${dir}/`) && file.split('/').length === depth + 1
          : file.startsWith(`${dir}/`)
      ).length
    );
  }
  return sections
    .filter((section) => (counts.get(section) ?? 0) > 0)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    .slice(0, SECURITY_SECTIONS_MAX)
    .sort();
}

export async function deduceSections(repoPath: string): Promise<string[]> {
  const listed = await run('git', ['ls-files', '-z'], repoPath, 30_000);
  return listed.code === 0 ? deduceSectionsFrom(listed.stdout.split('\0').filter(Boolean)) : [];
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[private key]',
  ],
  [
    /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|ya29\.[A-Za-z0-9_-]{20,})\b/g,
    '[secret]',
  ],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret]'],
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[\w-]*["']?\s*[:=]\s*["'`])([^"'`\s]{6,})(["'`])/gi,
    '$1[secret]$3',
  ],
  [
    /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?!["'`]?\[secret\])(\S{6,})/gim,
    '$1[secret]',
  ],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, '$1[secret]$3'],
];

/**
 * Exact secret values registered at runtime (model-providers.ts keys): their format is the
 * provider's own, not a known pattern, so they are masked by value wherever text is redacted
 * (task notes, `ut task status`, orchestrator relays, connector replies, the screen capture).
 */
const DYNAMIC_SECRETS = new Set<string>();

/** Register a secret value so redactSecrets masks it everywhere (a provider key, once read). */
export function registerSecretValue(value: string | undefined | null): void {
  if (value && value.length >= 6) DYNAMIC_SECRETS.add(value);
}

/** Secret values masked (keys, tokens, passwords, private keys, URL credentials). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const value of DYNAMIC_SECRETS) {
    if (out.includes(value)) out = out.split(value).join('[secret]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const SEVERITIES: readonly SecuritySeverity[] = ['high', 'medium', 'low'];

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? redactSecrets(value.trim()).slice(0, max) : '';
}

/**
 * The findings a sweep reported: its JSON ({"findings":[…]}), or a ```security-findings
 * block in its report. Null when it reported none of either (not even an empty list). Secret
 * values are masked whatever the agent wrote.
 */
export function parseFindings(text: string | undefined): SecurityFinding[] | null {
  if (!text?.trim()) return null;
  // The first object with a findings list, wherever it is (ai-json-reply.ts, 2026-10-25).
  const read = extractJsonObject(text, (data) => {
    const findings = (data as { findings?: unknown }).findings;
    return Array.isArray(findings) ? findings : null;
  });
  if (!read.ok) return null;
  const raw: unknown[] = read.value;
  const out: SecurityFinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const file = cleanText(item.file, 300);
    const title = cleanText(item.title, 300);
    if (!title || file.split('/').includes('..') || path.isAbsolute(file)) continue;
    const line = Number(item.line);
    const category = SECURITY_CATEGORIES.includes(item.category as SecurityCategory)
      ? (item.category as SecurityCategory)
      : 'other';
    const pkg = cleanText(item.package, 200);
    out.push({
      file,
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      severity: SEVERITIES.includes(item.severity as SecuritySeverity)
        ? (item.severity as SecuritySeverity)
        : 'medium',
      category,
      title,
      exploit: cleanText(item.exploit, 1500),
      fix: cleanText(item.fix, 1500),
      ...(pkg ? { package: pkg } : {}),
      ...(item.outside === true ? { outside: true } : {}),
    });
  }
  return out;
}

/** Tools a sweep's Claude may never use: the network, running the code, reading the env. */
export const SWEEP_DENIED_TOOLS = [
  'WebFetch',
  'WebSearch',
  ...[
    'curl',
    'wget',
    'nc',
    'ncat',
    'telnet',
    'ssh',
    'scp',
    'sftp',
    'rsync',
    'ftp',
    'git push',
    'git fetch',
    'git pull',
    'git clone',
    'git remote',
    'gh',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'bun',
    'bunx',
    'node',
    'deno',
    'tsx',
    'ts-node',
    'python',
    'python3',
    'pip',
    'pip3',
    'uv',
    'ruby',
    'gem',
    'bundle',
    'php',
    'perl',
    'cargo',
    'rustc',
    'go',
    'swift',
    'xcodebuild',
    'make',
    'docker',
    'podman',
    'kubectl',
    'sh',
    'bash',
    'zsh',
    'env',
    'printenv',
    'export',
    'security',
    'open',
    'osascript',
  ].map((program) => `Bash(${program}:*)`),
];

/** Model flags per effort: Claude by model, Codex by reasoning effort. */
const CLAUDE_SEARCH_MODEL: Record<SecurityEffort, string> = {
  low: 'haiku',
  medium: 'sonnet',
  high: 'opus',
};

/**
 * The sweep's command line: the user's own (their quick start), its model or effort as the
 * project asks, and for Claude the denied tools; Codex runs in its workspace sandbox with no
 * network and no approvals, whatever the user's quick start bypasses.
 */
export function sweepCommand(
  base: readonly string[],
  agent: TaskAgent,
  effort: SecurityEffort
): string[] {
  const out: string[] = [];
  const dropWithValue =
    agent === 'claude'
      ? ['--model', '--allowedTools', '--allowed-tools']
      : ['--sandbox', '-s', '--ask-for-approval', '-a', '--model', '-m'];
  const dropAlone =
    agent === 'claude'
      ? []
      : ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto'];
  for (let i = 0; i < base.length; i++) {
    const arg = base[i];
    if (i > 0 && dropWithValue.includes(arg)) {
      i++;
      continue;
    }
    if (i > 0 && dropWithValue.some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (i > 0 && dropAlone.includes(arg)) continue;
    out.push(arg);
  }
  if (agent === 'claude') {
    return [
      ...out,
      '--model',
      CLAUDE_SEARCH_MODEL[effort],
      '--disallowedTools',
      ...SWEEP_DENIED_TOOLS,
    ];
  }
  return [
    ...out,
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    CODEX_EFFORT_CONFIG[effort],
  ];
}

const FINDING_SHAPE =
  '{"findings":[{"file":"<path in the repository>","line":<number>,"severity":"high"|"medium"|"low","category":"<one of the categories>","title":"<what it is, one sentence>","exploit":"<why it is exploitable and how an attacker would do it>","fix":"<the fix you propose>","package":"<dependency findings only>"}]}';

/**
 * What an exposure round looks for (2026-10-26): any way the project is reachable from outside;
 * the agent says which apply here and audits only those.
 */
const EXPOSURE_KINDS = [
  'ports and services listening beyond the machine itself, and containers that publish them',
  'tunnels (ngrok, cloudflared, Tailscale serve or funnel, frp …) and reverse proxies',
  'domains and DNS records that point at it',
  'public buckets or storage',
  'incoming webhooks and callbacks (are they authenticated, signed, replay-safe?)',
  'published APIs and admin panels (authentication, rate limits, debug endpoints)',
  'open CORS',
  'keys or tokens with more permissions than needed, or leaked (in the repository, its git history, Docker images, logs)',
  'published mobile or desktop apps that carry endpoints or keys inside',
  'serverless functions and their triggers',
  'credentials in deployment environment variables or config',
  'public repositories or published packages that ship more than they should (files, source maps, .env)',
];

/** The sweep's prompt (its own rules: it commits nothing and asks nobody). */
export function sweepPrompt(
  section: string,
  kind: 'code' | 'deps' | 'exposure',
  known: readonly string[] = [],
  facts = ''
): string {
  const scope =
    kind === 'exposure'
      ? [
          'Look at what this project EXPOSES TO THE OUTSIDE while it runs, not only its code: first find out from the repository how it is run and deployed (compose files, Dockerfiles, Kubernetes or Helm, launchd or systemd, Fly, Vercel, Netlify, Workers, serverless, proxies, VPNs, tunnels, published apps and packages), then audit the real state below.',
          'Kinds of exposure (decide which apply to this project and audit only those):',
          ...EXPOSURE_KINDS.map((line) => `- ${line}`),
          'Report only what really makes something reachable or leaks something, with how. Use the category "exposure" (or a more precise one). For something running, name in "file" the repository file that sets it up when there is one (else "."). Set "outside": true when the fix is not a change in this repository (a DNS record, a bucket policy, a provider setting, revoking a key): the user is told instead.',
          ...(known.length
            ? [
                '',
                'ALREADY KNOWN TO UNTETHER (its deterministic checks; do not repeat them):',
                ...known,
              ]
            : []),
          '',
          'THE REAL STATE, gathered by Untether with read-only commands (you run nothing yourself; values of secrets are masked, container environments left out):',
          facts || '(nothing could be gathered)',
        ]
      : kind === 'deps'
        ? [
            "Look at this repository's DEPENDENCIES (every manifest: package.json, Cargo.toml, Package.swift, go.mod, requirements, pyproject …).",
            '- Dependencies nothing imports any more (unused-dependency).',
            '- Dependencies a few lines of our own code would replace (replaceable-dependency): each one is attack surface. Only when the replacement is small and obvious.',
            '- Locked versions with known vulnerabilities (vulnerable-dependency): Untether already asked the public advisory databases; what they said is below. Say which of them really affect how this project uses the package.',
            ...(known.length ? ['', 'KNOWN ADVISORIES FOR THE LOCKED VERSIONS:', ...known] : []),
          ]
        : [
            `Look for REAL, exploitable vulnerabilities in the section \`${section}\` of this repository (read other code only to follow a data flow).`,
            'Categories: injection (shell, SQL, HTML/XSS, template, argv built from strings), auth (missing or bypassable authentication or permission checks, weak session or token handling), secrets (credentials committed or logged), ssrf, path-traversal, deserialization (unsafe parsing of untrusted data), crypto (weak or misused cryptography, predictable randomness for secrets), other.',
            'Report only what an attacker could really exploit, with the path the data takes. No style, no best practices with no attack, no test code.',
          ];
  return [
    'You are a security researcher sweeping this repository for Untether (a scheduled security sweep). You only read and report: change no file, commit nothing.',
    '',
    ...scope,
    '',
    'RULES (they are enforced; breaking one ends the sweep):',
    '- Never make network requests, never fetch or install anything.',
    '- Never run, build or test the code you are looking at, nor its scripts; read it.',
    '- Never print or copy a secret value: name a secret only by its file and line.',
    '- Never ask the user anything: nobody is looking at this session.',
    '',
    `When you are done, write your findings as JSON to the file \`${SECURITY_FINDINGS_FILE}\` at the root of this folder (it is never committed), with this shape:`,
    FINDING_SHAPE,
    'With nothing found, write {"findings":[]}. Write title, exploit and fix in Spanish unless the repository is written in another language.',
    "Then run `ut task done --summary '<how many findings>'` (single quotes).",
  ].join('\n');
}

/**
 * The prompt of a task for what the project exposes (2026-10-26): the change in the
 * repository's own setup that closes it. It always waits for the user, who restarts what runs.
 */
export function exposureFixPrompt(findings: readonly SecurityFinding[]): string {
  return [
    `Untether's security sweep saw ${findings.length === 1 ? 'something' : `${findings.length} things`} this project exposes while it runs:`,
    '',
    ...findings.map(findingLine),
    '',
    'Fix them in this branch in the repository’s own setup (its compose file, its server’s bind address, its config) with the smallest change: bind to 127.0.0.1 what does not need to be reachable, drop privileges the service does not need. If one must stay as it is (it is meant to be reachable), leave it and say why in your report.',
    'Never run, stop or restart containers, services or the project, and never change anything outside this repository: the user restarts what runs after merging. Never print or copy secret values. Say in one sentence per finding what the fix does and what the user must restart.',
  ].join('\n');
}

function findingLine(finding: SecurityFinding, index: number): string {
  return [
    `${index + 1}. [${finding.severity}, ${finding.category}] ${finding.title}`,
    `   Where: ${finding.file}${finding.line ? `:${finding.line}` : ''}${finding.package ? ` (package ${finding.package})` : ''}`,
    `   Why it is exploitable: ${finding.exploit}`,
    `   Proposed fix: ${finding.fix}`,
  ].join('\n');
}

/** The fix task's prompt: what two reviewers confirmed, to fix in this branch. */
export function fixPrompt(section: string, findings: readonly SecurityFinding[]): string {
  return [
    `Untether's security sweep found ${findings.length === 1 ? 'a problem' : `${findings.length} problems`} in \`${section}\`, and an independent reviewer confirmed ${findings.length === 1 ? 'it' : 'them'}:`,
    '',
    ...findings.map(findingLine),
    '',
    'Fix them in this branch with the smallest change that closes the hole, and add a test that would have caught it where the project has tests for that code. For a dependency finding, remove or replace the dependency as proposed (update its lockfile with the project’s package manager). If, reading the code, one of them is not a real problem after all, leave it and say why in your report.',
    `Keep the fix to source code inside \`${section}\` and its tests: add tests, never remove, skip or loosen existing ones, and leave CI, build and install scripts, manifests and lockfiles, auth, permission and deployment config, hidden config files and git hooks alone (a fix that touches them waits for the user).`,
    'Never print or copy secret values (name them by file and line). Say in one sentence per finding what the fix does: the user reads it before the fix goes in.',
  ].join('\n');
}

/**
 * The prompt of a bump the reviewer confirmed: a locked dependency an advisory names with no
 * patched version in the same major (in every lockfile that pins that version).
 */
export function supplyPrompt(
  pkg: LockedPackage,
  lockfiles: readonly string[],
  lines: readonly string[],
  bump?: SecurityBump
): string {
  const where = lockfiles.map((file) => `\`${file}\``).join(', ');
  return [
    `A public security advisory names ${pkg.name}@${pkg.version} (${pkg.ecosystem}), locked in ${where}, and an independent reviewer confirmed it affects this project:`,
    ...lines,
    '',
    bump
      ? `Upgrade ${pkg.name} to ${bump.to} (the first fixed version) or the newest version with the same major, with the project's own package manager, so the manifest and the lockfile change together. Change nothing else; if the upgrade breaks something, fix only that and say so.`
      : `No fixed version is published yet: mitigate it (an override, a patch, a safer way to use it, or replacing the package) with the smallest change, and say what you did.`,
    'Run the project check before you report.',
  ].join('\n');
}

/** One package of a grouped bump: what to raise, and the advisories it closes. */
export interface BumpEntry {
  pkg: LockedPackage;
  bump: SecurityBump;
  lines: string[];
}

/**
 * The prompt of the bumps of one lockfile (2026-10-23): every package advisories name with a
 * patched version in the same major, raised at once, without arguing exploitability.
 */
export function bumpPrompt(lockfile: string, entries: readonly BumpEntry[]): string {
  return [
    `Public security advisories name packages locked in \`${lockfile}\`, and a patched version within the same major is published for each. Untether upgrades them whether or not the flaw is reachable here: the upgrade is cheap and leaves nothing vulnerable behind.`,
    '',
    ...entries.flatMap(({ pkg, bump, lines }) => [
      `${pkg.name} ${pkg.version} → ${bump.to}:`,
      ...lines,
    ]),
    '',
    `Raise each of them to its version above (or the newest one with the same major) in \`${lockfile}\` with the project's own package manager, so its manifest and lockfile change together; for a package that is only a transitive dependency, refresh it in the lockfile (or add the package manager's override if nothing else reaches it). Change nothing else: no other package, no code. If an upgrade breaks something, fix only that and say so.`,
    'Run the project check before you report.',
  ].join('\n');
}

/**
 * The prompt of a removal (2026-10-23): direct dependencies nothing in their package names.
 * It always waits for the user.
 */
export function removalPrompt(
  manifest: string,
  entries: ReadonlyArray<{ dep: UnusedDependency; lines: readonly string[] }>
): string {
  return [
    `These dependencies are declared in \`${manifest}\` but nothing in its package uses them. Each is attack surface for nothing:`,
    '',
    ...entries.flatMap(({ dep, lines }) => [
      `${dep.name}: ${dep.proof}.`,
      ...(lines.length ? ['  Public advisories name its locked version:', ...lines] : []),
    ]),
    '',
    `Look again before removing one: if it is used after all (a dynamic import, a binary run by a script or a tool, a plugin named in a config, a peer another package needs), keep it and say where. Remove the others from \`${manifest}\` with the project's own package manager, so the manifest and its lockfile change together. Change nothing else.`,
    'Run the project check before you report. Say in one sentence per package why nothing needs it: the user reads it before it goes in.',
  ].join('\n');
}

function excerptLines(text: string, line?: number): string {
  const lines = text.split('\n');
  const from = line ? Math.max(0, line - 1 - EXCERPT_LINES) : 0;
  const to = line ? Math.min(lines.length, line + EXCERPT_LINES) : Math.min(lines.length, 120);
  return lines
    .slice(from, to)
    .map((text, index) => `${String(from + index + 1).padStart(5)}| ${text}`)
    .join('\n');
}

export async function gitExcerpt(
  repoPath: string,
  rev: string,
  file: string,
  line?: number
): Promise<string> {
  if (!file || path.isAbsolute(file) || file.split('/').includes('..')) return '(no file given)';
  const shown = await run('git', ['show', `${rev}:${file}`], repoPath, 30_000);
  if (shown.code !== 0) return `(${file} is not in the repository)`;
  return redactSecrets(excerptLines(shown.stdout, line)).slice(0, CONTEXT_MAX);
}

export async function gitFixDiff(
  cwd: string,
  baseSha: string,
  headSha: string,
  paths: string[] = []
): Promise<string> {
  const diff = await run(
    'git',
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      baseSha,
      headSha,
      ...(paths.length ? ['--', ...paths] : []),
    ],
    cwd,
    30_000
  );
  return diff.code === 0 ? diff.stdout : '';
}

export async function gitUsages(repoPath: string, name: string): Promise<string[]> {
  const found = await run('git', ['grep', '-l', '-F', '--', name], repoPath, 30_000);
  return found.code === 0 ? found.stdout.split('\n').filter(Boolean).slice(0, 15) : [];
}

function advisoryLine(advisory: Advisory): string {
  return `- ${advisory.id}${advisory.aliases.length ? ` (${advisory.aliases.join(', ')})` : ''}, ${advisory.severity}: ${advisory.summary}${advisory.fixed ? ` Fixed in ${advisory.fixed}.` : ''}`;
}

/** The finding an advisory makes of a locked package. */
function supplyFinding(
  pkg: LockedPackage,
  fresh: readonly Advisory[],
  fixed?: string
): SecurityFinding {
  const lines = fresh.map(advisoryLine);
  return {
    file: pkg.lockfile,
    severity: worstSeverity(fresh),
    category: 'vulnerable-dependency',
    title: `${pkg.name}@${pkg.version}: ${fresh[0].summary}`.slice(0, 300),
    exploit: lines.join('\n').slice(0, 1500),
    fix: fixed ? `Upgrade ${pkg.name} to ${fixed}` : 'No fixed version yet: mitigate',
    package: pkg.name,
  };
}

/**
 * The headline is the user's at a glance in any language: how serious (this mark), what (the
 * finding's title, which the agent writes in the user's language) → what the fix does.
 */
const SEVERITY_MARK: Record<SecuritySeverity, string> = {
  high: '🔴',
  medium: '🟠',
  low: '🟡',
};

const isFinal = (task: TaskRecord) => TASK_FINAL_STATES.includes(task.state);

export class SecuritySweeper {
  private state = new Map<string, ProjectSweepState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = new Set<string>();
  private jobs = new Set<Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: SecuritySweeperDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  start(intervalMs = SWEEP_TICK_MS): void {
    if (this.timer) return;
    this.timer = every('security sweep', () => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the projects with the sweep on; resolves when what it started is done. */
  async tick(): Promise<void> {
    for (const { repoPath, settings } of this.deps.settings.list()) {
      const config = securityConfig(settings);
      if (!config.enabled || settings.missingSince) continue;
      const repo = normalizeRepoPath(repoPath);
      if (this.busy.has(repo)) continue;
      this.busy.add(repo);
      const job = this.step(repo, config)
        .catch((error) => this.deps.log?.(`security sweep ${repo}: ${error}`))
        .finally(() => this.busy.delete(repo));
      this.jobs.add(job);
      void job.finally(() => this.jobs.delete(job));
    }
    await Promise.all(this.jobs);
  }

  /**
   * Project folders that moved: their sweep's state (round, log, findings seen, the task under
   * way) follows them (2026-10-25: security-sweeps.json stayed keyed by the old folder, so a
   * renamed project's sweep started over). How many moved.
   */
  projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): number {
    let count = 0;
    for (const { from, to } of moved) {
      const state = this.state.get(from);
      if (!state) continue;
      this.state.delete(from);
      if (!this.state.has(to)) this.state.set(to, state);
      count++;
    }
    if (count) this.save();
    return count;
  }

  /** The project's sweep as the phone shows it. */
  status(repoPath: string): SecuritySweepStatus {
    const repo = normalizeRepoPath(repoPath);
    const config = securityConfig(this.deps.settings.get(repo));
    const state = this.state.get(repo);
    const next = this.nextRoundAt(state, config);
    return {
      enabled: config.enabled,
      paused: config.paused,
      running: !!state?.current,
      ...(state?.lastRoundAt ? { lastRoundAt: state.lastRoundAt } : {}),
      ...(state?.lastResult ? { lastResult: state.lastResult } : {}),
      ...(state?.lastSection ? { lastSection: state.lastSection } : {}),
      ...(config.enabled && !config.paused && next !== undefined
        ? { nextRoundAt: new Date(next).toISOString() }
        : {}),
      ...(state?.supplyCheckedAt ? { supplyCheckedAt: state.supplyCheckedAt } : {}),
      log: (state?.log ?? []).slice(-20).reverse(),
      exposure: state?.exposure ?? { surface: [], findings: [], errors: [] },
    };
  }

  /**
   * Projects whose sweep stopped happening (the doctor's check, 2026-10-23: a sweep that
   * fails every time would otherwise go unseen): no round in 3× its hours, or no advisory
   * check in a day.
   */
  stale(): Array<{ repoPath: string; problem: string }> {
    const out: Array<{ repoPath: string; problem: string }> = [];
    for (const { repoPath, settings } of this.deps.settings.list()) {
      const config = securityConfig(settings);
      if (!config.enabled || config.paused || settings.missingSince) continue;
      const state = this.state.get(normalizeRepoPath(repoPath));
      const hours = (iso?: string) =>
        iso ? (this.now() - Date.parse(iso)) / 3_600_000 : Number.NaN;
      const sinceRound = hours(state?.lastRoundAt);
      if (sinceRound > config.everyHours * 3) {
        out.push({
          repoPath,
          problem: `no security sweep round in ${Math.round(sinceRound)} h (every ${config.everyHours} h)`,
        });
      }
      const sinceSupply = hours(state?.supplyCheckedAt);
      if (config.supplyChain && sinceSupply > Math.max(24, config.supplyEveryHours * 3)) {
        out.push({
          repoPath,
          problem: `security advisories not checked in ${Math.round(sinceSupply)} h`,
        });
      }
      const sinceExposure = hours(state?.exposure?.checkedAt);
      if (sinceExposure > Math.max(24, config.supplyEveryHours * 3)) {
        out.push({
          repoPath,
          problem: `exposure not checked in ${Math.round(sinceExposure)} h`,
        });
      }
    }
    return out;
  }

  /**
   * The adversarial reviewer on a confirmed fix's diff (2026-10-23): does it close every
   * finding without opening another hole? On a bump's diff: is the upgrade safe? The other
   * agent than the one that wrote it, the project's review effort; Claude when Codex cannot
   * answer. Secrets in the diff masked.
   */
  async reviewFix(task: TaskRecord): Promise<NonNullable<TaskSecurity['fixReview']>> {
    const findings = task.security?.findings ?? [];
    const bumps = task.security?.kind === 'supply' ? (task.security.bumps ?? []) : [];
    const repo = task.repoPath ?? task.workingDir;
    const cwd = task.worktreePath ?? repo;
    if (!findings.length || !task.baseSha || !task.headSha) {
      return { verdict: 'unavailable', reason: 'nothing to review' };
    }
    if (task.security?.kind === 'supply' && !bumps.length) {
      return { verdict: 'unavailable', reason: 'no bump to review' };
    }
    const diff = await (this.deps.fixDiff ?? gitFixDiff)(cwd, task.baseSha, task.headSha).catch(
      () => ''
    );
    if (!diff.trim()) return { verdict: 'unavailable', reason: 'the diff could not be read' };
    // Its tests may only add (2026-10-23): no existing test removed, skipped or focused.
    const weakened = testsWeakened(diff);
    if (weakened) return { verdict: 'dismissed', reason: weakened, headSha: task.headSha };
    const config = securityConfig(this.deps.settings.get(repo));
    const installed = await this.deps.agents().catch((): TaskAgent[] => []);
    const reviewer =
      AGENTS.find((agent) => agent !== task.agent && installed.includes(agent)) ?? task.agent;
    const ruling = await this.review({
      finding: {
        ...findings[0],
        title: findings
          .map((finding) => finding.title)
          .join(' · ')
          .slice(0, 600),
        fix: findings
          .map((finding) => finding.fix)
          .join(' · ')
          .slice(0, 1500),
      },
      section: task.security?.section ?? '.',
      context: [
        ...(bumps.length
          ? [
              'THE UPGRADES ASKED FOR:',
              ...bumps.map(
                (bump) => `- ${bump.name} (${bump.ecosystem}) ${bump.from} → ${bump.to}`
              ),
            ]
          : findings.map((finding, index) => findingLine(finding, index))),
        '',
        redactSecrets(diff).slice(0, CONTEXT_MAX * 4),
      ].join('\n'),
      agent: reviewer,
      effort: config.reviewEffort,
      diff: bumps.length ? 'bump' : 'fix',
    });
    return {
      verdict: ruling.verdict,
      reason: redactSecrets(ruling.reason),
      headSha: task.headSha,
    };
  }

  /**
   * The second, risk-focused review of a task a risk rule flagged (2026-10-24): the diff of its
   * flagged files, why they were flagged, and whether the change weakens auth, permissions,
   * secrets handling or session isolation. The other agent than the one that wrote it, the
   * project's review effort; Claude when Codex cannot answer. Secrets in the diff masked.
   */
  async reviewRisk(task: TaskRecord): Promise<TaskRiskReview> {
    const risk = (task.risk ?? []).map(({ rule, file }) => ({ rule, file }));
    const files = [...new Set(risk.map((finding) => finding.file).filter(Boolean))];
    const repo = task.repoPath ?? task.workingDir;
    const cwd = task.worktreePath ?? repo;
    if (!files.length || !task.baseSha || !task.headSha) {
      return { verdict: 'unavailable', reason: 'nothing to review' };
    }
    const diff = await (this.deps.fixDiff ?? gitFixDiff)(
      cwd,
      task.baseSha,
      task.headSha,
      files
    ).catch(() => '');
    if (!diff.trim()) return { verdict: 'unavailable', reason: 'the diff could not be read' };
    // Never a cut diff (2026-10-24 review): an OK on its first part would merge the rest unread.
    const shown = redactSecrets(diff);
    if (shown.length > RISK_DIFF_MAX) {
      return {
        verdict: 'unavailable',
        reason: `the diff of the flagged files is too long to review whole (${shown.length} characters)`,
        headSha: task.headSha,
      };
    }
    const config = securityConfig(this.deps.settings.get(repo));
    const installed = await this.deps.agents().catch((): TaskAgent[] => []);
    const reviewer =
      AGENTS.find((agent) => agent !== task.agent && installed.includes(agent)) ?? task.agent;
    const why = (task.risk ?? [])
      .map((finding) => `${finding.file || '(all)'}: ${finding.rule}, ${finding.detail ?? ''}`)
      .join('; ')
      .slice(0, 1500);
    const ruling = await this.review({
      finding: {
        file: files[0],
        severity: 'medium',
        category: 'auth',
        // Not the agent's own summary (2026-10-24 review): the reviewed agent's words stay out.
        title: task.name.slice(0, 200),
        exploit: why,
        fix: '',
      },
      section: '.',
      context: shown,
      agent: reviewer,
      effort: config.reviewEffort,
      diff: 'risk',
    });
    return {
      verdict: ruling.verdict,
      reason: redactSecrets(ruling.reason),
      headSha: task.headSha,
      risk,
    };
  }

  private project(repo: string): ProjectSweepState {
    let state = this.state.get(repo);
    if (!state) {
      state = { round: 0, sectionIndex: 0, log: [], seen: [] };
      this.state.set(repo, state);
    }
    return state;
  }

  private nextRoundAt(
    state: ProjectSweepState | undefined,
    config: SecuritySweepConfig
  ): number | undefined {
    if (state?.current) return undefined;
    const last = state?.lastRoundAt ? Date.parse(state.lastRoundAt) : Number.NaN;
    return Number.isFinite(last) ? last + config.everyHours * 3_600_000 : this.now();
  }

  private async step(repo: string, config: SecuritySweepConfig): Promise<void> {
    const state = this.project(repo);
    if (state.current) {
      await this.followRound(repo, state, config);
    } else if (
      !config.paused &&
      (this.nextRoundAt(state, config) ?? Number.POSITIVE_INFINITY) <= this.now()
    ) {
      const why = this.holdBack(repo);
      if (why) this.deps.log?.(`security sweep ${repo}: not now (${why})`);
      else await this.startRound(repo, state, config);
    }
    const checked = state.supplyCheckedAt ? Date.parse(state.supplyCheckedAt) : Number.NaN;
    if (
      config.supplyChain &&
      !config.paused &&
      (!Number.isFinite(checked) || this.now() - checked >= config.supplyEveryHours * 3_600_000)
    ) {
      await this.checkSupply(repo, state, config);
    }
    const exposed = state.exposure?.checkedAt ? Date.parse(state.exposure.checkedAt) : Number.NaN;
    if (
      !config.paused &&
      (!Number.isFinite(exposed) || this.now() - exposed >= config.supplyEveryHours * 3_600_000)
    ) {
      await this.checkExposure(repo, state, config);
    }
  }

  /** Why no round starts now: the user's tasks of the project at work, or a busy Mac. */
  private holdBack(repo: string): string | undefined {
    const tasks = this.deps.tasks();
    if (!tasks) return 'no task engine';
    const working = tasks
      .list()
      .some(
        (task) =>
          !task.security &&
          TASK_BUSY_STATES.includes(task.state) &&
          normalizeRepoPath(task.repoPath ?? task.workingDir) === repo
      );
    if (working) return 'tasks of the project are at work';
    const load = this.deps.load
      ? this.deps.load()
      : os.loadavg()[0] / Math.max(1, os.cpus().length);
    if (load > LOAD_MAX) return `the Mac is busy (load ${load.toFixed(2)} per core)`;
    return undefined;
  }

  private async startRound(
    repo: string,
    state: ProjectSweepState,
    config: SecuritySweepConfig
  ): Promise<void> {
    const tasks = this.deps.tasks();
    if (!tasks) return;
    const agents = pickAgents(state.round, await this.deps.agents());
    if (!agents) {
      this.deps.log?.(`security sweep ${repo}: no agent installed`);
      return;
    }
    const sections = config.sections.length
      ? [...config.sections]
      : await (this.deps.sections ?? deduceSections)(repo);
    // What runs joins the rotation only when the project exposes something (2026-10-26).
    if (state.exposure?.surface.length && !sections.includes(EXPOSURE_SECTION)) {
      sections.push(EXPOSURE_SECTION);
    }
    const pick = pickSection(state.round, state.sectionIndex, sections, config.depsEvery);
    let facts = '';
    if (pick.kind === 'exposure') {
      const running = await this.running(repo);
      facts = await exposureFacts(
        repo,
        { ...running, surface: state.exposure?.surface ?? [] },
        {
          redact: redactSecrets,
          ...(this.deps.exposure?.probe ? { probe: this.deps.exposure.probe } : {}),
          ...(this.deps.exposure?.home ? { home: this.deps.exposure.home } : {}),
        }
      ).catch((error) => `(the facts could not be gathered: ${String(error).slice(0, 200)})`);
    }
    let known: string[] = [];
    if (pick.kind === 'deps') {
      try {
        known = (await this.affected(repo)).flatMap(({ pkg, advisories }) =>
          advisories.map(
            (advisory) =>
              `- ${pkg.name}@${pkg.version} (${pkg.lockfile}): ${advisory.id} ${advisory.severity}: ${advisory.summary}${advisory.fixed ? ` (fixed in ${advisory.fixed})` : ''}`
          )
        );
      } catch (error) {
        this.deps.log?.(`security sweep ${repo}: advisories unavailable: ${error}`);
      }
    }
    const task = await tasks.create({
      name: `Security sweep: ${pick.section}`,
      prompt:
        pick.kind === 'exposure'
          ? sweepPrompt(
              pick.section,
              'exposure',
              (state.exposure?.findings ?? []).map(
                (finding) => `- [${finding.severity}] ${finding.title}`
              ),
              facts
            )
          : sweepPrompt(pick.section, pick.kind, known.slice(0, 60)),
      workingDir: repo,
      repoPath: repo,
      command: sweepCommand(this.deps.commandFor(agents.agent), agents.agent, config.searchEffort),
      agent: agents.agent,
      shielded: false,
      notify: false,
      isolation: 'worktree',
      origin: 'schedule',
      mergePolicy: 'ask',
      security: { kind: 'sweep', section: pick.section },
    });
    const at = new Date(this.now()).toISOString();
    state.round++;
    state.sectionIndex = pick.nextIndex;
    state.lastRoundAt = at;
    state.lastSection = pick.section;
    state.current = {
      taskId: task.id,
      section: pick.section,
      kind: pick.kind,
      agent: agents.agent,
      reviewer: agents.reviewer,
      startedAt: at,
      ...(facts ? { facts } : {}),
    };
    this.save();
    this.deps.log?.(
      `security sweep ${repo}: round ${state.round} (${pick.section}) by ${agents.agent}, reviewed by ${agents.reviewer}`
    );
  }

  private async followRound(
    repo: string,
    state: ProjectSweepState,
    config: SecuritySweepConfig
  ): Promise<void> {
    const current = state.current as CurrentRound;
    const tasks = this.deps.tasks();
    if (!tasks) return;
    const task = tasks.get(current.taskId);
    if (!task || isFinal(task)) return this.endRound(state, 'abandoned');
    const age = this.now() - Date.parse(current.startedAt);
    const findings = this.readFindings(task);
    if (
      task.state === 'scheduled' ||
      task.state === 'queued' ||
      // Paused by its agent's usage limit: Untether sends it on by itself (2026-11-10: the
      // round was given up as "reported nothing" a minute later and its section skipped).
      task.state === 'paused' ||
      TASK_BUSY_STATES.includes(task.state)
    ) {
      if (age > SWEEP_MAX_MS) await this.giveUp(repo, state, task, 'took too long');
      return;
    }
    if (task.state === 'needs_you' && findings === null) {
      if (this.now() - Date.parse(task.stateSince) > SWEEP_STUCK_MS) {
        await this.giveUp(repo, state, task, 'stuck on a prompt');
      }
      return;
    }
    if (findings === null) return this.giveUp(repo, state, task, 'reported nothing');
    const worth = findings
      .filter((finding) => isDependencyFinding(finding) || finding.severity !== 'low')
      .slice(0, FINDINGS_MAX);
    const confirmed: SecurityFinding[] = [];
    let dismissed = 0;
    const rev = task.baseSha ?? 'HEAD';
    for (const finding of worth) {
      const excerpt = await (this.deps.excerpt ?? gitExcerpt)(
        repo,
        rev,
        finding.file,
        finding.line
      ).catch(() => '(the code could not be read)');
      // An exposure finding is judged against the real state its agent read too.
      const context = current.facts
        ? `${excerpt.slice(0, CONTEXT_MAX / 2)}\n\nTHE REAL STATE (read-only, gathered by Untether):\n${current.facts.slice(0, CONTEXT_MAX)}`
        : excerpt;
      const ruling = await this.review({
        finding,
        section: current.section,
        context,
        agent: current.reviewer,
        effort: config.reviewEffort,
      });
      if (ruling.verdict === 'confirmed') confirmed.push(finding);
      else dismissed++;
      this.note(state, {
        at: new Date(this.now()).toISOString(),
        section: current.section,
        verdict: ruling.verdict === 'confirmed' ? 'confirmed' : 'dismissed',
        reason:
          ruling.verdict === 'unavailable'
            ? `Not reviewed (${ruling.reason}): not reported`
            : redactSecrets(ruling.reason),
        finding,
        agent: current.agent,
        reviewer: current.reviewer,
      });
    }
    // Fixed outside the repository (DNS, a bucket, a provider): told, never a task (2026-10-26).
    const outside = confirmed.filter((finding) => finding.outside);
    const inside = confirmed.filter((finding) => !finding.outside);
    if (inside.length) {
      const fix = await this.openFixTask(repo, current, inside);
      for (const entry of state.log.slice(-worth.length)) {
        if (entry.verdict === 'confirmed' && inside.includes(entry.finding)) {
          entry.taskId = fix.id;
        }
      }
    }
    if (outside.length) {
      // Told once per finding across rounds too (2026-10-26 review: every exposure round that
      // saw the same public bucket pushed it again), again after EXPOSURE_REMIND_MS.
      const told = { ...state.exposureTold };
      const now = this.now();
      const fresh = outside.filter((finding) => {
        const when = Date.parse(told[agentFindingKey(finding)] ?? '');
        return !Number.isFinite(when) || now - when >= EXPOSURE_REMIND_MS;
      });
      this.tell(repo, fresh);
      for (const finding of fresh) told[agentFindingKey(finding)] = new Date(now).toISOString();
      state.exposureTold = Object.fromEntries(Object.entries(told).slice(-EXPOSURE_TOLD_MAX));
      for (const entry of state.log.slice(-worth.length)) {
        if (entry.verdict === 'confirmed' && fresh.includes(entry.finding)) {
          entry.notified = true;
        }
      }
    }
    // Nothing of the search is kept: its folder, its branch, its findings file go.
    await this.discard(task);
    this.endRound(state, confirmed.length ? 'confirmed' : dismissed ? 'dismissed' : 'clean');
  }

  /** The reviewer, and Claude when Codex could not answer (never confirmed on no answer). */
  private async review(request: Parameters<SecurityReviewer>[0]): Promise<SecurityRuling> {
    const ruling = await this.deps
      .reviewer(request)
      .catch((error): SecurityRuling => ({ verdict: 'unavailable', reason: String(error) }));
    if (ruling.verdict !== 'unavailable' || request.agent === 'claude') return ruling;
    this.deps.log?.(`security review by ${request.agent} unavailable (${ruling.reason}): Claude`);
    return this.deps
      .reviewer({ ...request, agent: 'claude' })
      .catch((error): SecurityRuling => ({ verdict: 'unavailable', reason: String(error) }));
  }

  private readFindings(task: TaskRecord): SecurityFinding[] | null {
    if (task.worktreePath) {
      try {
        const file = path.join(task.worktreePath, SECURITY_FINDINGS_FILE);
        if (fs.existsSync(file)) {
          const parsed = parseFindings(fs.readFileSync(file, 'utf8').slice(0, 512 * 1024));
          if (parsed) return parsed;
        }
      } catch {
        // Unreadable: the report may still hold them.
      }
    }
    return parseFindings(task.summary);
  }

  private async openFixTask(
    repo: string,
    current: CurrentRound,
    findings: SecurityFinding[]
  ): Promise<TaskRecord> {
    const tasks = this.deps.tasks() as SweepTasks;
    const worst = worstSeverity(findings);
    const first = findings[0];
    const more = findings.length > 1 ? ` (+${findings.length - 1})` : '';
    const fix = first.fix ? ` → ${first.fix}` : '';
    const headline = `${SEVERITY_MARK[worst]} ${first.title}${more}${fix}`.slice(0, 500);
    return tasks.create({
      name: `Security fix: ${first.title}`.slice(0, 80),
      prompt:
        current.section === EXPOSURE_SECTION
          ? exposureFixPrompt(findings)
          : fixPrompt(current.section, findings),
      workingDir: repo,
      repoPath: repo,
      command: this.deps.commandFor(current.agent),
      agent: current.agent,
      shielded: true,
      notify: true,
      isolation: 'worktree',
      origin: 'schedule',
      mergePolicy: 'ask',
      security: { kind: 'fix', section: current.section, findings, headline },
    });
  }

  private async giveUp(
    repo: string,
    state: ProjectSweepState,
    task: TaskRecord,
    why: string
  ): Promise<void> {
    this.deps.log?.(`security sweep ${repo}: round given up (${why})`);
    await this.discard(task);
    this.endRound(state, 'abandoned');
  }

  private async discard(task: TaskRecord): Promise<void> {
    const result = await this.deps
      .tasks()
      ?.discard(task.id, { confirm: true })
      .catch((error) => ({ ok: false as const, message: String(error) }));
    if (result && !result.ok) {
      this.deps.log?.(`security sweep: could not discard ${task.id}: ${result.message}`);
    }
  }

  private endRound(state: ProjectSweepState, result: SecurityRoundResult): void {
    state.lastResult = result;
    delete state.current;
    this.save();
  }

  private note(state: ProjectSweepState, entry: SecurityLogEntry): void {
    state.log.push(entry);
    if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  }

  private async affected(repo: string): Promise<AffectedPackage[]> {
    const packages = await (this.deps.locked ?? lockedPackages)(repo);
    if (!packages.length) return [];
    return (this.deps.advisories ?? ((list) => queryOsv(list)))(packages);
  }

  /**
   * New advisories for the project's locked packages (2026-10-23): a patched version within
   * the same major is opened as a bump at once, one task per lockfile (the reviewer only judges
   * the upgrade's diff, not whether the flaw is reachable); anything else (no fix, a major
   * bump) goes to the adversarial reviewer first. Direct dependencies nothing imports are
   * proposed for removal instead, in a task that waits for the user.
   */
  private async checkSupply(
    repo: string,
    state: ProjectSweepState,
    config: SecuritySweepConfig
  ): Promise<void> {
    let affected: AffectedPackage[];
    try {
      affected = await this.affected(repo);
    } catch (error) {
      this.deps.log?.(`supply chain ${repo}: advisories unavailable: ${error}`);
      return;
    }
    state.supplyCheckedAt = new Date(this.now()).toISOString();
    const tasks = this.deps.tasks();
    const agents = pickAgents(state.round, await this.deps.agents());
    if (!tasks || !agents) {
      this.save();
      return;
    }
    const open = tasks
      .list()
      .filter(
        (task) =>
          task.security?.kind === 'supply' &&
          !isFinal(task) &&
          (task.repoPath ?? task.workingDir) === repo
      );
    // Sections: a lockfile (bumps), a package (reviewed advisory) or a manifest (removals).
    const busy = new Set(open.map((task) => task.security?.section));
    const removing = new Set(open.flatMap((task) => task.security?.removals ?? []));
    let opened = open.length;
    const seen = new Set(state.seen);
    const at = () => new Date(this.now()).toISOString();
    const key = (id: string, pkg: LockedPackage) =>
      `${id} ${pkg.ecosystem}/${pkg.name}@${pkg.version} ${pkg.lockfile}`;
    const manifestOf = (lockfile: string) =>
      path.posix.join(path.posix.dirname(lockfile), 'package.json');

    // Unused direct dependencies: their advisories wait for the removal instead of a bump.
    const unused = await (this.deps.unused ?? unusedDependencies)(repo).catch(
      (): UnusedDependency[] => []
    );
    const removals = new Map<string, UnusedDependency[]>();
    const covered = new Set<string>();
    for (const dep of unused) {
      const id = `${dep.manifest} ${dep.name}`;
      if (removing.has(id)) covered.add(id);
      if (removing.has(id) || seen.has(`unused ${id}`) || busy.has(dep.manifest)) continue;
      covered.add(id);
      removals.set(dep.manifest, [...(removals.get(dep.manifest) ?? []), dep]);
    }

    const fast = new Map<string, Array<{ pkg: LockedPackage; fresh: Advisory[]; to: string }>>();
    const slow = new Map<string, { pkgs: LockedPackage[]; fresh: Advisory[] }>();
    const advisoriesOf = new Map<string, Advisory[]>();
    for (const { pkg, advisories } of affected) {
      if (pkg.ecosystem === 'npm') {
        advisoriesOf.set(`${manifestOf(pkg.lockfile)} ${pkg.name}`, advisories);
      }
      const fresh = advisories.filter((advisory) => !seen.has(key(advisory.id, pkg)));
      if (!fresh.length) continue;
      if (pkg.ecosystem === 'npm' && covered.has(`${manifestOf(pkg.lockfile)} ${pkg.name}`)) {
        continue;
      }
      const fixes = fresh.map((advisory) => advisory.fixed);
      const to = fixes.every((fixed): fixed is string => !!fixed)
        ? fixes.sort(compareVersions).pop()
        : undefined;
      if (to && isSafeBump(pkg.version, to)) {
        fast.set(pkg.lockfile, [...(fast.get(pkg.lockfile) ?? []), { pkg, fresh, to }]);
        continue;
      }
      const same = `${pkg.ecosystem}/${pkg.name}@${pkg.version}`;
      const entry = slow.get(same) ?? { pkgs: [], fresh: [] };
      entry.pkgs.push(pkg);
      for (const advisory of fresh) {
        if (!entry.fresh.some((known) => known.id === advisory.id)) entry.fresh.push(advisory);
      }
      slow.set(same, entry);
    }

    const create = (input: {
      name: string;
      prompt: string;
      security: TaskSecurity;
    }): Promise<TaskRecord> =>
      tasks.create({
        name: input.name.slice(0, 80),
        prompt: input.prompt,
        workingDir: repo,
        repoPath: repo,
        command: this.deps.commandFor(agents.agent),
        agent: agents.agent,
        shielded: true,
        notify: true,
        isolation: 'worktree',
        origin: 'schedule',
        mergePolicy: 'ask',
        security: input.security,
      });

    // A patched version in the same major: upgraded at once, one task per lockfile.
    for (const [lockfile, entries] of fast) {
      const group = entries.filter(({ pkg }) => !busy.has(pkg.name));
      if (!group.length || busy.has(lockfile)) continue;
      if (opened >= SUPPLY_OPEN_MAX) break;
      const bumps: BumpEntry[] = group.map(({ pkg, fresh, to }) => ({
        pkg,
        bump: { ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, to },
        lines: fresh.map(advisoryLine),
      }));
      const findings = group.map(({ pkg, fresh, to }) => supplyFinding(pkg, fresh, to));
      const severity = worstSeverity(findings);
      const advisories = group.flatMap(({ fresh }) => fresh.map((advisory) => advisory.id));
      const task = await create({
        name: `Security: upgrade ${group.map(({ pkg }) => pkg.name).join(', ')}`,
        prompt: bumpPrompt(lockfile, bumps),
        security: {
          kind: 'supply',
          section: lockfile,
          findings,
          advisories: [...new Set(advisories)],
          bumps: bumps.map(({ bump }) => bump),
          headline:
            `${SEVERITY_MARK[severity]} ${lockfile}: ${bumps.map(({ bump }) => `${bump.name} ${bump.from} → ${bump.to}`).join(', ')} (${advisories.length === 1 ? group[0].fresh[0].summary : `${advisories.length} advisories`})`.slice(
              0,
              500
            ),
        },
      });
      opened++;
      busy.add(lockfile);
      for (const { pkg, fresh } of group) {
        for (const advisory of fresh) seen.add(key(advisory.id, pkg));
      }
      for (const finding of findings) {
        this.note(state, {
          at: at(),
          section: lockfile,
          verdict: 'confirmed',
          reason:
            'A patched version within the same major is published: upgraded without arguing whether it is exploitable here.',
          finding,
          agent: agents.agent,
          reviewer: agents.reviewer,
          taskId: task.id,
        });
      }
    }

    // No patched version, or only a major one: the adversarial reviewer decides first.
    let reviewed = 0;
    for (const { pkgs, fresh } of slow.values()) {
      const pkg = pkgs[0];
      if (busy.has(pkg.name)) continue;
      if (opened >= SUPPLY_OPEN_MAX) break;
      if (reviewed++ >= SUPPLY_PACKAGES_MAX) break;
      const lockfiles = pkgs.map((each) => each.lockfile);
      const fixed = fresh
        .map((advisory) => advisory.fixed)
        .filter((version): version is string => !!version)
        .sort(compareVersions)
        .pop();
      const lines = fresh.map(advisoryLine);
      const finding = supplyFinding(pkg, fresh, fixed);
      const usages = await (this.deps.usages ?? gitUsages)(repo, pkg.name).catch(() => []);
      const ruling = await this.review({
        finding,
        section: `${pkg.ecosystem} ${pkg.name}`,
        context: [
          `ADVISORIES for ${pkg.name}@${pkg.version} (${pkg.ecosystem}, locked in ${lockfiles.join(', ')}):`,
          ...lines,
          '',
          `FILES THAT MENTION ${pkg.name}:`,
          ...(usages.length ? usages : ['(none: it may be a transitive dependency)']),
        ]
          .join('\n')
          .slice(0, CONTEXT_MAX),
        agent: agents.reviewer,
        effort: config.reviewEffort,
      });
      if (ruling.verdict === 'unavailable') continue;
      for (const each of pkgs) {
        for (const advisory of fresh) seen.add(key(advisory.id, each));
      }
      let taskId: string | undefined;
      if (ruling.verdict === 'confirmed') {
        const bump = fixed
          ? { ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, to: fixed }
          : undefined;
        const severity = worstSeverity(fresh);
        const task = await create({
          name: `Security: upgrade ${pkg.name}`,
          prompt: supplyPrompt(pkg, lockfiles, lines, bump),
          security: {
            kind: 'supply',
            section: pkg.name,
            findings: [finding],
            advisories: fresh.map((advisory) => advisory.id),
            ...(bump ? { bumps: [bump] } : {}),
            headline:
              `${SEVERITY_MARK[severity]} ${pkg.name}@${pkg.version}: ${fresh[0].summary} (${fresh[0].id}) → ${bump ? `${pkg.name} ${bump.to}` : '…'}`.slice(
                0,
                500
              ),
          },
        });
        taskId = task.id;
        opened++;
        busy.add(pkg.name);
      }
      this.note(state, {
        at: at(),
        section: `${pkg.ecosystem} ${pkg.name}`,
        verdict: ruling.verdict,
        reason: redactSecrets(ruling.reason),
        finding,
        agent: agents.agent,
        reviewer: agents.reviewer,
        ...(taskId ? { taskId } : {}),
      });
    }

    // Direct dependencies nothing uses: removed only with the user's «Fusionar».
    for (const [manifest, deps] of removals) {
      if (opened >= SUPPLY_OPEN_MAX) break;
      const entries = deps.map((dep) => ({
        dep,
        advisories: advisoriesOf.get(`${manifest} ${dep.name}`) ?? [],
      }));
      const findings = entries.map(
        ({ dep, advisories }): SecurityFinding => ({
          file: manifest,
          severity: advisories.length ? worstSeverity(advisories) : 'low',
          category: 'unused-dependency',
          title: `${dep.name}: nothing in ${path.posix.dirname(manifest)} uses it`.slice(0, 300),
          exploit: (advisories.length
            ? advisories.map(advisoryLine).join('\n')
            : 'Attack surface with no use.'
          ).slice(0, 1500),
          fix: `Remove ${dep.name} from ${manifest}`,
          package: dep.name,
        })
      );
      const severity = worstSeverity(findings);
      const task = await create({
        name: `Security: remove unused ${deps.map((dep) => dep.name).join(', ')}`,
        prompt: removalPrompt(
          manifest,
          entries.map(({ dep, advisories }) => ({ dep, lines: advisories.map(advisoryLine) }))
        ),
        security: {
          kind: 'supply',
          section: manifest,
          findings,
          removals: deps.map((dep) => `${manifest} ${dep.name}`),
          headline:
            `${SEVERITY_MARK[severity]} ${manifest}: ${deps.map((dep) => dep.name).join(', ')} unused (nothing imports ${deps.length === 1 ? 'it' : 'them'}) → remove`.slice(
              0,
              500
            ),
        },
      });
      opened++;
      for (const [index, dep] of deps.entries()) {
        seen.add(`unused ${manifest} ${dep.name}`);
        this.note(state, {
          at: at(),
          section: manifest,
          verdict: 'confirmed',
          reason: `Proposed for removal, waiting for the user: ${dep.proof}.`.slice(0, 600),
          finding: findings[index],
          agent: agents.agent,
          reviewer: agents.reviewer,
          taskId: task.id,
        });
      }
    }
    state.seen = [...seen].slice(-SEEN_MAX);
    this.save();
  }

  private running(repo: string): Promise<RunningState> {
    return (
      this.deps.exposure?.running ?? ((dir: string) => readRunning(dir, this.deps.exposure?.probe))
    )(repo);
  }

  /** A push for what has no fix in the repository: what, and what to do. */
  private tell(
    repo: string,
    findings: ReadonlyArray<Pick<SecurityFinding, 'title' | 'fix'>>
  ): void {
    if (!findings.length) return;
    const first = findings[0];
    const more = findings.length > 1 ? ` (+${findings.length - 1})` : '';
    this.deps.notify?.({
      repoPath: repo,
      title: `${first.title}${more}`.slice(0, 200),
      body: redactSecrets(first.fix || first.title).slice(0, 300),
    });
  }

  /**
   * The exposure check (2026-10-26): the surface (repository and what runs), the universal
   * deterministic checks and the project's connectors. A high finding fixed in the repository
   * opens a task waiting for the user (none while one is open); one fixed outside is told; the
   * rest go to the log. Each once while it stays, again after EXPOSURE_REMIND_MS.
   */
  private async checkExposure(
    repo: string,
    state: ProjectSweepState,
    config: SecuritySweepConfig
  ): Promise<void> {
    const running = await this.running(repo).catch(
      (error): RunningState => ({
        files: [],
        containers: [],
        listeners: [],
        errors: [`what runs: ${String(error).slice(0, 200)}`],
      })
    );
    const read = (file: string) => {
      try {
        return fs.readFileSync(path.join(repo, file), 'utf8').slice(0, 256 * 1024);
      } catch {
        return null;
      }
    };
    const connectors = config.connectors.length
      ? await runConnectors(config.connectors, {
          now: this.now,
          ...this.deps.exposure?.connectors,
        }).catch((error) => ({ findings: [], errors: [`connectors: ${String(error)}`] }))
      : { findings: [], errors: [] };
    const connector = this.deps.exposure?.untetherConnector?.(repo) ?? {
      surface: [],
      findings: [],
    };
    const findings = sortExposureFindings([
      ...containerFindings(running.containers, repo),
      ...listenerFindings(running.listeners),
      ...connectors.findings,
      ...connector.findings,
    ]);
    const now = this.now();
    const at = new Date(now).toISOString();
    state.exposure = {
      checkedAt: at,
      surface: [
        ...surfaceFrom(running.files, read),
        ...runningSurface(running),
        ...connector.surface,
      ],
      findings,
      errors: [...running.errors, ...connectors.errors].map(redactSecrets).slice(0, 20),
    };
    // Forget what is gone: if it comes back, it is told again. What an exposure round's agent
    // told (agent:…) is not seen here: it is forgotten once its reminder time is over.
    const told = Object.fromEntries(
      Object.entries(state.exposureTold ?? {}).filter(([key, when]) =>
        key.startsWith(AGENT_TOLD)
          ? now - Date.parse(when) < EXPOSURE_REMIND_MS
          : findings.some((finding) => finding.key === key)
      )
    );
    const fresh = findings.filter((finding) => {
      const when = told[finding.key] ? Date.parse(told[finding.key]) : Number.NaN;
      return !Number.isFinite(when) || now - when >= EXPOSURE_REMIND_MS;
    });
    const asFinding = (finding: ExposureFinding): SecurityFinding => ({
      file: finding.file ?? '.',
      severity: finding.severity,
      category: 'exposure',
      title: finding.title,
      exploit: finding.detail,
      fix: finding.fix,
      ...(finding.fixable ? {} : { outside: true }),
    });
    const note = (finding: ExposureFinding, extra: Partial<SecurityLogEntry> = {}) => {
      told[finding.key] = at;
      this.note(state, {
        at,
        section: EXPOSURE_SECTION,
        verdict: 'confirmed',
        reason: `Seen by Untether's ${finding.source} check (deterministic, no agent).`,
        finding: asFinding(finding),
        ...extra,
      });
    };
    const toFix = fresh.filter((finding) => finding.severity === 'high' && finding.fixable);
    const toTell = fresh.filter((finding) => finding.severity === 'high' && !finding.fixable);
    for (const finding of fresh.filter((each) => each.severity !== 'high')) note(finding);
    if (toTell.length) {
      this.tell(repo, toTell.map(asFinding));
      for (const finding of toTell) note(finding, { notified: true });
    }
    const tasks = this.deps.tasks();
    const agents = toFix.length ? pickAgents(state.round, await this.deps.agents()) : null;
    const open = tasks
      ?.list()
      .some(
        (task) =>
          task.security?.kind === 'fix' &&
          task.security.section === EXPOSURE_SECTION &&
          !isFinal(task) &&
          normalizeRepoPath(task.repoPath ?? task.workingDir) === repo
      );
    // With a task still open, the new ones wait for it to end (then they are fresh again).
    if (toFix.length && tasks && agents && !open) {
      const task = await this.openFixTask(
        repo,
        {
          taskId: '',
          section: EXPOSURE_SECTION,
          kind: 'exposure',
          agent: agents.agent,
          reviewer: agents.reviewer,
          startedAt: at,
        },
        toFix.map(asFinding)
      );
      for (const finding of toFix) note(finding, { taskId: task.id });
    }
    state.exposureTold = Object.fromEntries(Object.entries(told).slice(-EXPOSURE_TOLD_MAX));
    this.save();
  }

  private load(): void {
    let data: { version?: number; projects?: Record<string, ProjectSweepState> };
    try {
      data = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8'));
    } catch {
      return;
    }
    if (data?.version !== STORE_VERSION || !data.projects || typeof data.projects !== 'object') {
      return;
    }
    for (const [repo, value] of Object.entries(data.projects)) {
      if (!value || typeof value !== 'object') continue;
      this.state.set(repo, {
        round: Number.isInteger(value.round) ? value.round : 0,
        sectionIndex: Number.isInteger(value.sectionIndex) ? value.sectionIndex : 0,
        log: Array.isArray(value.log) ? value.log.slice(-LOG_MAX) : [],
        seen: Array.isArray(value.seen) ? value.seen.slice(-SEEN_MAX) : [],
        ...(value.lastRoundAt ? { lastRoundAt: value.lastRoundAt } : {}),
        ...(value.lastResult ? { lastResult: value.lastResult } : {}),
        ...(value.lastSection ? { lastSection: value.lastSection } : {}),
        ...(value.current?.taskId ? { current: value.current } : {}),
        ...(value.supplyCheckedAt ? { supplyCheckedAt: value.supplyCheckedAt } : {}),
        ...(value.exposure && Array.isArray(value.exposure.findings)
          ? { exposure: value.exposure }
          : {}),
        ...(value.exposureTold && typeof value.exposureTold === 'object'
          ? { exposureTold: value.exposureTold }
          : {}),
      });
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
      const tmp = `${this.deps.statePath}.${process.pid}.tmp`;
      const data = { version: STORE_VERSION, projects: Object.fromEntries(this.state) };
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.deps.statePath);
    } catch (error) {
      this.deps.log?.(`security sweeps: could not save ${this.deps.statePath}: ${error}`);
    }
  }
}
