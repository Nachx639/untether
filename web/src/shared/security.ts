/**
 * Security sweeps (2026-10-23, «agentic loops attacking your own code»): per project, off by
 * default, one switch in its settings (`securitySweep`). Every few hours Untether has an agent
 * hunt for real vulnerabilities in the next section of the repository (rotating; every few
 * rounds the dependencies instead), a second agent with a clean context tries to prove each
 * finding wrong, and only what both confirm reaches the user: one task with the fix made,
 * checked and reviewed in its branch, waiting for «Fusionar». A separate hourly loop crosses
 * new public advisories (OSV, which carries the GitHub Advisory Database) with the project's
 * lockfiles. Shared by the server (security-sweep.ts) and the phone.
 *
 * Its gates and its adversarial reviewer also let an ordinary task with a risky change merge
 * on its own (2026-10-24, riskMergesOnItsOwn): only auth findings in plain source code, never
 * what NEVER_UNATTENDED refuses for any other reason (CI, signing, keychain, credentials,
 * config), after the same countdown.
 */
import type { TaskAgent, TaskRecord } from './tasks.js';

/** How hard an agent thinks: the search may be cheaper, the review the strongest. */
export type SecurityEffort = 'low' | 'medium' | 'high';
export const SECURITY_EFFORTS: readonly SecurityEffort[] = ['low', 'medium', 'high'];

/** Codex's `-c` for each effort (whole strings: nothing spliced into a config value). */
export const CODEX_EFFORT_CONFIG: Record<SecurityEffort, string> = {
  low: 'model_reasoning_effort=low',
  medium: 'model_reasoning_effort=medium',
  high: 'model_reasoning_effort=high',
};

export const SECURITY_SWEEP_HOURS_DEFAULT = 6;
export const SECURITY_SUPPLY_HOURS_DEFAULT = 1;
/** Every this many rounds the round looks at the dependencies instead of a section. */
export const SECURITY_DEPS_EVERY_DEFAULT = 4;
export const SECURITY_SECTIONS_MIN = 5;
export const SECURITY_SECTIONS_MAX = 10;
export const SECURITY_SEARCH_EFFORT_DEFAULT: SecurityEffort = 'medium';
export const SECURITY_REVIEW_EFFORT_DEFAULT: SecurityEffort = 'high';

export const SECURITY_AUTO_MERGE_DELAY_MIN = 10;
/** A fix that merges on its own changes at most this many lines, in at most this many files. */
export const SECURITY_FIX_LINES_MAX = 200;
export const SECURITY_FIX_FILES_MAX = 10;

/** The section name of a dependencies round. */
export const DEPENDENCIES_SECTION = '(dependencies)';
/**
 * The section of a round about what the project exposes while it runs (2026-10-26, «que el
 * barrido mire también lo que corre»): in the rotation only when the repository or what runs
 * shows something reachable from outside (servers, containers, deployments, tunnels, published
 * apps or packages). No switch of its own: the sweep's.
 */
export const EXPOSURE_SECTION = '(exposure)';

/** Where the sweeping agent writes its findings, at its worktree's root (never committed). */
export const SECURITY_FINDINGS_FILE = '.untether-security-findings.json';

/** The settings a sweep reads, with defaults filled in (the advanced ones stay hidden). */
export interface SecuritySweepConfig {
  enabled: boolean;
  paused: boolean;
  everyHours: number;
  /** Empty: deduced from the repository. */
  sections: string[];
  supplyChain: boolean;
  supplyEveryHours: number;
  depsEvery: number;
  searchEffort: SecurityEffort;
  reviewEffort: SecurityEffort;
  /** A patch or minor bump of a dependency an advisory names may merge on its own. */
  autoMergeBumps: boolean;
  /** A confirmed fix that passes every gate (fixMergesOnItsOwn) may merge on its own. */
  autoMerge: boolean;
  /** Minutes between «Se fusiona a las HH:MM» and the merge, when the user may stop it. */
  autoMergeDelayMin: number;
  /** Provider connectors the project set up (none by default). */
  connectors: SecurityConnector[];
}

/**
 * Provider connectors (2026-10-26): optional, per project, none by default. Each reads one
 * provider's API with a credential the user names (an environment variable of the server or a
 * keychain item), only reads, and its findings are only told to the user: nothing outside the
 * repository is ever changed. Tailscale is the first.
 */
export type ConnectorProvider = 'tailscale';

export interface ConnectorSpec {
  provider: ConnectorProvider;
  /** The provider's name, as written (not translated). */
  name: string;
  /** The options it reads (strings; the phone shows a field for each). */
  options: readonly string[];
}

export const SECURITY_CONNECTORS: readonly ConnectorSpec[] = [
  // tag: the tag of the project's nodes ("tag:<name>"); sharedPorts: the ports they may open
  // to autogroup:shared ("443, tcp:8443, 8000-8010"). Both empty by default.
  { provider: 'tailscale', name: 'Tailscale', options: ['tag', 'sharedPorts'] },
];

export interface SecurityConnector {
  provider: ConnectorProvider;
  /** Where its API key comes from; the value is never logged, shown or stored by Untether. */
  credential: {
    from: 'env' | 'keychain';
    /** The environment variable, or the keychain item's service. */
    name: string;
    /** The keychain item's account, when it needs one. */
    account?: string;
  };
  options?: Record<string, string>;
}

/** The project settings' security keys (shared/projects.ts ProjectSettings). */
export interface SecuritySweepSettings {
  securitySweep?: boolean;
  securitySweepPaused?: boolean;
  securitySweepHours?: number;
  securitySections?: string[];
  securitySupplyChain?: boolean;
  securitySupplyHours?: number;
  securityDepsEvery?: number;
  securitySearchEffort?: SecurityEffort;
  securityReviewEffort?: SecurityEffort;
  securityAutoMergeBumps?: boolean;
  securityAutoMerge?: boolean;
  securityAutoMergeDelayMin?: number;
  securityConnectors?: SecurityConnector[];
}

export function securityConfig(settings: SecuritySweepSettings): SecuritySweepConfig {
  return {
    enabled: settings.securitySweep === true,
    paused: settings.securitySweepPaused === true,
    everyHours: settings.securitySweepHours ?? SECURITY_SWEEP_HOURS_DEFAULT,
    sections: settings.securitySections ?? [],
    supplyChain: settings.securitySupplyChain !== false,
    supplyEveryHours: settings.securitySupplyHours ?? SECURITY_SUPPLY_HOURS_DEFAULT,
    depsEvery: settings.securityDepsEvery ?? SECURITY_DEPS_EVERY_DEFAULT,
    searchEffort: settings.securitySearchEffort ?? SECURITY_SEARCH_EFFORT_DEFAULT,
    reviewEffort: settings.securityReviewEffort ?? SECURITY_REVIEW_EFFORT_DEFAULT,
    autoMergeBumps: settings.securityAutoMergeBumps !== false,
    autoMerge: settings.securityAutoMerge !== false,
    autoMergeDelayMin: settings.securityAutoMergeDelayMin ?? SECURITY_AUTO_MERGE_DELAY_MIN,
    connectors: settings.securityConnectors ?? [],
  };
}

export type SecuritySeverity = 'high' | 'medium' | 'low';

export type SecurityCategory =
  | 'injection'
  | 'auth'
  | 'secrets'
  | 'ssrf'
  | 'path-traversal'
  | 'deserialization'
  | 'crypto'
  | 'vulnerable-dependency'
  | 'unused-dependency'
  | 'replaceable-dependency'
  | 'exposure'
  | 'other';

export const SECURITY_CATEGORIES: readonly SecurityCategory[] = [
  'injection',
  'auth',
  'secrets',
  'ssrf',
  'path-traversal',
  'deserialization',
  'crypto',
  'vulnerable-dependency',
  'unused-dependency',
  'replaceable-dependency',
  'exposure',
  'other',
];

/** Dependency findings are proposals (attack surface), not ranked by how exploitable they are. */
export function isDependencyFinding(finding: Pick<SecurityFinding, 'category'>): boolean {
  return (
    finding.category === 'vulnerable-dependency' ||
    finding.category === 'unused-dependency' ||
    finding.category === 'replaceable-dependency'
  );
}

/** One finding of a sweep, as the agent reports it (secrets named by place, never by value). */
export interface SecurityFinding {
  file: string;
  line?: number;
  severity: SecuritySeverity;
  category: SecurityCategory;
  /** One short sentence: what it is. */
  title: string;
  /** Why it is exploitable, and how. */
  exploit: string;
  /** The fix proposed. */
  fix: string;
  /** Dependency findings: the package. */
  package?: string;
  /**
   * The fix is outside the repository (a DNS record, a bucket's policy, a provider's setting,
   * an old device): the user is told, no task is opened (2026-10-26).
   */
  outside?: boolean;
}

/** A dependency bump for an advisory: from the locked version to the first fixed one. */
export interface SecurityBump {
  ecosystem: string;
  name: string;
  from: string;
  to: string;
}

/** What a task of the security engine is (TaskRecord.security). */
export interface TaskSecurity {
  /** 'sweep': the hidden search; 'fix': confirmed findings to fix; 'supply': an advisory. */
  kind: 'sweep' | 'fix' | 'supply';
  section?: string;
  findings?: SecurityFinding[];
  /**
   * 'supply': the advisories and the bumps that fix them (2026-10-23: one task per lockfile
   * and round groups every patched version within the same major).
   */
  advisories?: string[];
  bumps?: SecurityBump[];
  /**
   * 'supply': direct dependencies nothing in their package imports, proposed for removal
   * (`<manifest> <name>`). Such a task always waits for the user.
   */
  removals?: string[];
  /** One clear sentence for the user: what, how serious, what the fix does. */
  headline?: string;
  /**
   * The adversarial reviewer's look at the diff, for the commit it read: for a 'fix', it
   * closes the hole without opening another; for a 'supply' bump, the upgrade is safe
   * (compatibility, changelog, nothing else raised or added), never whether the advisory was
   * exploitable here.
   */
  fixReview?: {
    verdict: 'confirmed' | 'dismissed' | 'unavailable';
    reason: string;
    headSha?: string;
  };
}

/** A finding the adversarial reviewer ruled on (the sweep's log, visible in the project). */
export interface SecurityLogEntry {
  at: string;
  section: string;
  verdict: 'confirmed' | 'dismissed';
  /** The reviewer's reason. */
  reason: string;
  finding: SecurityFinding;
  /** None for what a deterministic check or a connector saw (2026-10-26). */
  agent?: TaskAgent;
  reviewer?: TaskAgent;
  /** The task it went into (confirmed). */
  taskId?: string;
  /** Told to the user instead of a task (its fix is outside the repository). */
  notified?: boolean;
}

/**
 * Something the exposure check saw (2026-10-26): the universal deterministic checks (the
 * project's processes listening beyond loopback, its containers privileged, on the host
 * network or holding the Docker socket) and the connectors. Never a secret's value.
 */
export interface ExposureFinding {
  /** Stable while the same thing stays (a service, a port, a rule): it is told once. */
  key: string;
  /**
   * 'listener', 'container', the connector's provider, or 'untether-connector': the project's
   * own Untether connector (connector-http.ts), which an app of the project may call.
   */
  source: 'listener' | 'container' | ConnectorProvider | 'untether-connector';
  severity: SecuritySeverity;
  /** One short sentence: what it is. */
  title: string;
  /** Why it matters. */
  detail: string;
  fix: string;
  /**
   * A change in the repository fixes it (its compose file, a server's bind address): a high one
   * opens a task. Otherwise the user is only told: nothing outside the repository is changed.
   */
  fixable: boolean;
  /** The file to change, when known (the compose file). */
  file?: string;
}

/** The exposure check as the phone shows it (SecuritySweepStatus.exposure). */
export interface ExposureStatus {
  checkedAt?: string;
  /** What makes the project reachable from outside (in the repository or running). */
  surface: string[];
  /** What the deterministic checks and the connectors see now, worst first. */
  findings: ExposureFinding[];
  /** What could not be looked at, and why (Docker not running, no credential …). */
  errors: string[];
}

export type SecurityRoundResult = 'clean' | 'confirmed' | 'dismissed' | 'abandoned';

/** A project's sweep as GET /api/projects/settings shows it (`security`). */
export interface SecuritySweepStatus {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  lastRoundAt?: string;
  lastResult?: SecurityRoundResult;
  lastSection?: string;
  nextRoundAt?: string;
  supplyCheckedAt?: string;
  /** The latest rulings, newest first. */
  log: SecurityLogEntry[];
  exposure: ExposureStatus;
}

const SEVERITY_RANK: Record<SecuritySeverity, number> = { high: 3, medium: 2, low: 1 };

/** The most serious severity among findings. */
export function worstSeverity(findings: ReadonlyArray<Pick<SecurityFinding, 'severity'>>) {
  return findings.reduce<SecuritySeverity>(
    (worst, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst,
    'low'
  );
}

/** "1.2.3" → [1, 2, 3]; null when it is not a plain version. */
export function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * A bump that keeps the API by semver: same major (for 0.x the same minor too, where a minor
 * may break), and really up.
 */
export function isSafeBump(from: string, to: string): boolean {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return false;
  if (a[0] === 0 && a[1] !== b[1]) return false;
  return compareVersions(to, from) > 0;
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a) ?? [0, 0, 0];
  const y = versionParts(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/** Manifests and lockfiles: the only files a bump that merges on its own may change. */
const MANIFEST_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.toml',
  'Cargo.lock',
  'Package.swift',
  'Package.resolved',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'Gemfile',
  'Gemfile.lock',
]);

export function onlyManifestFiles(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    files.every((file) => {
      const base = file.split('/').pop() ?? file;
      return MANIFEST_FILES.has(base) || /^requirements[\w.-]*\.txt$/.test(base);
    })
  );
}

/**
 * A bump ready for the adversarial look at its diff (2026-10-23, after the same countdown as
 * a fix): dependencies advisories name raised to their patched versions (patch or minor,
 * never major), its check run and passed, the AI review saw nothing, no risk rule matched and
 * only manifests and lockfiles changed. Never a removal. The project can turn it off
 * (securityAutoMergeBumps=false).
 */
export function bumpReadyForReview(
  task: GateTask,
  settings: SecuritySweepSettings & { aiReview?: boolean }
): boolean {
  const bumps = task.security?.bumps ?? [];
  return (
    task.security?.kind === 'supply' &&
    bumps.length > 0 &&
    !task.security.removals?.length &&
    bumps.every((bump) => isSafeBump(bump.from, bump.to)) &&
    securityConfig(settings).autoMergeBumps &&
    cleanlyChecked(task, settings) &&
    onlyManifestFiles(task.files)
  );
}

/** A bump merges on its own: every gate, and the reviewer's OK on this very commit. */
export function bumpMergesOnItsOwn(
  task: GateTask,
  settings: SecuritySweepSettings & { aiReview?: boolean }
): boolean {
  const look = task.security?.fixReview;
  return (
    bumpReadyForReview(task, settings) &&
    look?.verdict === 'confirmed' &&
    !!task.headSha &&
    look.headSha === task.headSha
  );
}

/** A test file (any of the usual layouts): a fix may add or change tests besides its files. */
export function isTestFile(file: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|specs|[A-Za-z]+Tests)\//.test(file) ||
    /\.(test|spec)\.[A-Za-z0-9]+$/.test(file) ||
    /_test\.(go|py|rs)$/.test(file) ||
    /(^|\/)test_[^/]+\.py$/.test(file)
  );
}

/** Source code a fix that merges on its own may change (by extension). */
const SOURCE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|swift|m|mm|h|hpp|c|cc|cpp|rs|go|py|rb|java|kt|kts|scala|php|cs|dart|ex|exs|lua|vue|svelte)$/;

/** Auth, permission and signing words in a path (NEVER_UNATTENDED; riskFileAllowed). */
const AUTH_WORDS =
  /(auth|permission|policy|polic(y|ies)|rbac|iam|acl|cors|csp|entitlements?|sudoers|keychain|signing|provision)/i;

/**
 * What a fix that merges on its own may never touch, whatever the finding names (its files
 * are written by the searching agent, 2026-10-23 review): CI and workflows, build, install and
 * deploy scripts or config, manifests and lockfiles, auth, permission and deployment config,
 * hidden config files and folders, git hooks.
 */
const NEVER_UNATTENDED: RegExp[] = [
  // Any hidden file or folder: .github/, .gitlab-ci.yml, .husky/, .env*, .eslintrc …
  /(^|\/)\.[^/]/,
  /(^|\/)(workflows?|ci|\.?circleci|buildkite|deploy(ment)?s?|infra|terraform|k8s|kubernetes|helm|charts|hooks?|githooks|scripts?|bin|tools|build|dist|vendor|node_modules|migrations?)\//i,
  /(^|\/)(Makefile|Dockerfile|Containerfile|Jenkinsfile|Procfile|Vagrantfile|Gemfile|Podfile|Brewfile|Fastfile|Rakefile)$/i,
  /(^|\/)(install|setup|postinstall|preinstall|build|deploy|release|bootstrap)[^/]*$/i,
  /\.(config|conf|rc)\.[A-Za-z0-9]+$|(^|\/)(tsconfig|jsconfig|vite|webpack|rollup|esbuild|babel|eslint|prettier|biome|jest|vitest|playwright)[^/]*$/i,
  AUTH_WORDS,
  /\.(sh|bash|zsh|fish|ps1|bat|cmd|ya?ml|toml|ini|cfg|plist|xcconfig|entitlements|gradle|tf|json|lock)$/i,
];

/** A file inside the sweep's section ("web/src/server", "web/*" = right in web, "." = all). */
export function inSection(file: string, section: string): boolean {
  if (!section || section === '.') return true;
  if (section.endsWith('/*')) {
    const dir = section.slice(0, -2);
    return file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/');
  }
  return file.startsWith(`${section}/`);
}

/**
 * The files a confirmed fix may change and still merge on its own (2026-10-23): only source
 * code of the sweep's section, and its tests (in the section, or named after a changed source
 * file). Never anything in NEVER_UNATTENDED; the finding naming a file opens nothing.
 */
export function fixFilesAllowed(files: readonly string[], section: string | undefined): boolean {
  if (!section || section === DEPENDENCIES_SECTION || !files.length) return false;
  const source = files.filter((file) => !isTestFile(file));
  const stems = new Set(
    source.map((file) => (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '').toLowerCase())
  );
  if (!source.length) return false;
  return files.every((file) => {
    if (!SOURCE_FILE.test(file) || NEVER_UNATTENDED.some((rule) => rule.test(file))) return false;
    if (inSection(file, section)) return true;
    if (!isTestFile(file)) return false;
    // A test outside the section, named after the source it tests (db.ts → db.test.ts).
    const base = (file.split('/').pop() ?? file).toLowerCase();
    return [...stems].some((stem) => base.includes(stem));
  });
}

/**
 * The tests of a fix's diff never lose anything (2026-10-23): no line of an existing test
 * removed, no test skipped, focused or disabled. Why it was refused, else undefined.
 */
export function testsWeakened(diff: string): string | undefined {
  let file = '';
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      file = head[2];
      continue;
    }
    if (!file || !isTestFile(file) || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-') && line.slice(1).trim()) return `it removes lines of the test ${file}`;
    if (
      line.startsWith('+') &&
      /\b(it|test|describe|context)\.(skip|only|todo)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|@(Disabled|Ignore|pytest\.mark\.skip)|\bt\.Skip\(|#\[ignore\]|XCTSkip|unittest\.skip/.test(
        line
      )
    ) {
      return `it skips or focuses a test in ${file}`;
    }
  }
  return undefined;
}

/**
 * Nothing of the security engine merges on its own in the project now: its policy asks, its
 * auto-merge is paused (the circuit breaker, or by hand), or its sweep is paused.
 */
export function securityMergeHeld(
  settings: SecuritySweepSettings & {
    mergePolicy?: string;
    autoMergePausedUntil?: string;
  },
  now = Date.now()
): boolean {
  const until = settings.autoMergePausedUntil
    ? Date.parse(settings.autoMergePausedUntil)
    : Number.NaN;
  return (
    settings.mergePolicy === 'ask' ||
    (Number.isFinite(until) && until > now) ||
    settings.securitySweepPaused === true
  );
}

type GateTask = Pick<
  TaskRecord,
  'security' | 'risk' | 'verify' | 'review' | 'files' | 'blocker' | 'stats' | 'headSha'
>;

/** The AI review passed with nothing above low. */
function reviewedClean(task: GateTask, settings: { aiReview?: boolean }): boolean {
  return (
    settings.aiReview !== false &&
    task.review?.verdict === 'ok' &&
    !task.review.issues.some((issue) => issue.severity !== 'low')
  );
}

/** The gates both kinds share: a passed check, a clean AI review, no risk, no blocker. */
function cleanlyChecked(task: GateTask, settings: { aiReview?: boolean }): boolean {
  return (
    settings.aiReview !== false &&
    !task.blocker &&
    !task.risk?.length &&
    task.verify?.exitCode === 0 &&
    !task.verify.timedOut &&
    reviewedClean(task, settings)
  );
}

/**
 * Everything but the adversarial look at the diff (2026-10-23): a confirmed fix (both reviewers
 * agreed on the finding), the setting on, a passed check, a clean AI review, no risk, and a
 * small diff of the section's source code and its tests only (fixFilesAllowed).
 */
export function fixReadyForReview(
  task: GateTask,
  settings: SecuritySweepSettings & { aiReview?: boolean }
): boolean {
  const findings = task.security?.findings ?? [];
  const lines =
    (task.stats?.insertions ?? Number.POSITIVE_INFINITY) +
    (task.stats?.deletions ?? Number.POSITIVE_INFINITY);
  return (
    task.security?.kind === 'fix' &&
    findings.length > 0 &&
    securityConfig(settings).autoMerge &&
    cleanlyChecked(task, settings) &&
    task.files.length > 0 &&
    task.files.length <= SECURITY_FIX_FILES_MAX &&
    lines <= SECURITY_FIX_LINES_MAX &&
    fixFilesAllowed(task.files, task.security?.section)
  );
}

/** A confirmed fix merges on its own: every gate, and the adversarial reviewer's OK on its diff. */
export function fixMergesOnItsOwn(
  task: GateTask,
  settings: SecuritySweepSettings & { aiReview?: boolean }
): boolean {
  const look = task.security?.fixReview;
  return (
    fixReadyForReview(task, settings) &&
    look?.verdict === 'confirmed' &&
    !!task.headSha &&
    look.headSha === task.headSha
  );
}

/**
 * Risky tasks merge on their own too (2026-10-24, «que se revisen y se autofusionen»): a task
 * of a project with mergePolicy auto whose diff a risk rule flagged (task-risk.ts) used to wait
 * for «Fusionar» every time, even when only a sessions file matched "auth". Now it merges after
 * the security countdown when every other gate holds and a second, risk-focused review (the
 * adversarial reviewer of the security sweep, the other agent when both are installed) read
 * the diff of the flagged files, was told why they were flagged, and confirms the change
 * weakens no auth, permission, secrets handling or session isolation.
 *
 * Only these rules go to that review: the others (secrets, CI and deploy config, signing,
 * migrations, mass deletions, a check's own config, disabled tests, conflict markers,
 * binaries, submodules) keep waiting for the user.
 */
export const RISK_REVIEW_RULES: readonly string[] = ['auth'];

/** Never unattended, source code or not: signing, entitlements, keychain, credentials. */
const NEVER_UNATTENDED_SOURCE = /(entitlements?|keychain|signing|provision|sudoers|credential)/i;

/**
 * A file a risky task may change and still merge on its own: nothing NEVER_UNATTENDED refuses,
 * except ordinary source code it refuses only for an auth or permission word in its path
 * (web/src/server/services/auth-service.ts); never signing, entitlements, keychain or
 * credential code.
 */
export function riskFileAllowed(file: string): boolean {
  if (NEVER_UNATTENDED_SOURCE.test(file)) return false;
  const refused = NEVER_UNATTENDED.filter((rule) => rule.test(file));
  return (
    !refused.length || (SOURCE_FILE.test(file) && refused.every((rule) => rule === AUTH_WORDS))
  );
}

/** The findings may go to the second review: only RISK_REVIEW_RULES, only allowed files. */
export function riskReviewable(
  risk: ReadonlyArray<{ rule: string; file?: string }>,
  files: readonly string[]
): boolean {
  return (
    risk.length > 0 &&
    risk.every((finding) => RISK_REVIEW_RULES.includes(finding.rule)) &&
    files.length > 0 &&
    files.every(riskFileAllowed)
  );
}

type RiskGateTask = GateTask & Pick<TaskRecord, 'revertOf' | 'riskReview'>;

/**
 * A risky task ready for the second review: never a revert or a security task, no blocker, its
 * findings reviewable (riskReviewable), its check passed on this commit (or none and the
 * project allows merging without one), the AI review clean (nothing above low).
 */
export function riskReadyForReview(
  task: RiskGateTask,
  settings: { aiReview?: boolean; allowMergeWithoutCheck?: boolean }
): boolean {
  const checked =
    task.verify?.exitCode === 0 && !task.verify.timedOut && task.verify.headSha === task.headSha;
  return (
    !task.revertOf &&
    !task.security &&
    !task.blocker &&
    !!task.headSha &&
    riskReviewable(task.risk ?? [], task.files) &&
    (checked || settings.allowMergeWithoutCheck === true) &&
    reviewedClean(task, settings)
  );
}

/**
 * A risky task merges on its own: every gate, the project not held (securityMergeHeld), and the
 * second review's OK on this very commit for every finding it has now.
 */
export function riskMergesOnItsOwn(
  task: RiskGateTask,
  settings: SecuritySweepSettings & {
    aiReview?: boolean;
    allowMergeWithoutCheck?: boolean;
    mergePolicy?: string;
    autoMergePausedUntil?: string;
  },
  now = Date.now()
): boolean {
  const look = task.riskReview;
  return (
    riskReadyForReview(task, settings) &&
    !securityMergeHeld(settings, now) &&
    look?.verdict === 'confirmed' &&
    look.headSha === task.headSha &&
    (task.risk ?? []).every((finding) =>
      (look.risk ?? []).some((seen) => seen.rule === finding.rule && seen.file === finding.file)
    )
  );
}
