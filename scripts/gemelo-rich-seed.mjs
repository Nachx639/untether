#!/usr/bin/env node
// Rich fictitious state for the twin (scripts/gemelo.sh … --rich): projects with generated logos,
// orchestrators, Claude/Codex/shell sessions in every state, tasks in every state, previews and
// an external provider. Written BEFORE the twin's server starts, so it loads it as its own state.
//
// Nothing here is real and nothing runs an agent or spends a token:
// - every path is inside the twin's HOME, every name is made up;
// - a "running" session is a `sleep` plus the files Claude Code / Codex would have written;
// - gemelo.sh puts fake-bin first on the server's PATH: a `claude`, `codex` or `gemini` the server
//   decides to launch (a queued task, a one-shot summary) is a stub that does nothing;
// - tasks stay put: the project's limit holds the queued ones, the merge policy is 'ask' and no
//   task is left in a state the scheduler takes up on start (verifying, merging, preparing).
//
// The data is in scripts/gemelo-seed/, one file per fictitious project; this file is the machinery
// that turns it into the twin's state.
//
// The data is written in Spanish. UTT_GEMELO_LOCALE=en gives the same state in English
// (2026-11-11: the README's captures): gemelo-seed/locales/en.mjs holds each text's translation,
// and a text with no translation there fails the seed instead of leaving a mixed-language twin.
//
// Usage: node scripts/gemelo-rich-seed.mjs <twin HOME> <control dir>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const [home, control] = process.argv.slice(2);
if (!home || !control) {
  console.error('usage: gemelo-rich-seed.mjs <twin HOME> <control dir>');
  process.exit(2);
}
if (!/^\/(private\/)?tmp\/utt-gemelo[A-Za-z0-9._-]*$/.test(home) || !control.startsWith(`${home}/`)) {
  console.error(`gemelo-rich-seed: refused, not a twin HOME: ${home}`);
  process.exit(2);
}

/** The twin's fixed "now": the server runs on this clock (gemelo-clock.cjs), the browser too. */
const RICH_NOW = Date.UTC(2026, 10, 9, 10, 30, 0);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'web/package.json'), 'utf8')).version;

/** Free ports, all held at once so they differ: the previews must not land on another service. */
async function freePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
const [previewPort, pausedPreviewPort] = await freePorts(2);
const stateDir = path.join(home, '.untether');
const claudeDir = path.join(home, '.claude');

const ago = (minutes) => new Date(RICH_NOW - minutes * 60_000).toISOString();
const uuid = (n) => `7e57da7a-0000-4000-8000-${String(n).padStart(12, '0')}`;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- Logos: small PNGs drawn here, no outside image ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of `size`² pixels; shape(x, y) in 0..1 says whether a pixel is foreground. */
function logoPng(background, foreground, shape, size = 128) {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = shape((x + 0.5) / size, (y + 0.5) / size) ? foreground : background;
      raw.set(color, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- The language of the data ----

const seedDir = path.join(repoRoot, 'scripts/gemelo-seed');
const locale = process.env.UTT_GEMELO_LOCALE || 'es';
let dictionary = null;
if (locale !== 'es') {
  const file = path.join(seedDir, 'locales', `${locale}.mjs`);
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) || !fs.existsSync(file)) {
    const known = fs.readdirSync(path.join(seedDir, 'locales')).map((name) => path.basename(name, '.mjs'));
    console.error(`gemelo-rich-seed: no seed in «${locale}» (UTT_GEMELO_LOCALE: es, ${known.join(', ')})`);
    process.exit(2);
  }
  dictionary = (await import(pathToFileURL(file).href)).default;
}
const untranslated = new Set();
/** A text of the data in the twin's language. Names of one plain word (paths, commands) may stay. */
function tr(text) {
  if (!dictionary) return text;
  if (Object.hasOwn(dictionary, text)) return dictionary[text];
  if (/\s|[^\x20-\x7e]/.test(text)) untranslated.add(text);
  return text;
}
/** A copy of a piece of data with every text in the twin's language. */
function translated(value, key) {
  // `key` names a piece of the data to the other pieces; `project` is the project itself, already done.
  if (!dictionary || key === 'key' || key === 'project') return value;
  if (typeof value === 'string') return tr(value);
  if (Array.isArray(value)) return value.map((entry) => translated(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, translated(entry, name)]));
  }
  return value;
}

// ---- The data: one file per fictitious project in gemelo-seed/ (and one for what has none) ----

// Every .mjs there is read, by name: a new project is a new file, and a project's sessions, tasks
// and previews change in its own file, never here.
const SEED = [];
for (const file of fs.readdirSync(seedDir).filter((name) => name.endsWith('.mjs')).sort()) {
  SEED.push({ key: path.basename(file, '.mjs'), ...translated((await import(pathToFileURL(path.join(seedDir, file)).href)).default) });
}
/** The ones that are a project: a folder with its repository. The key is the file's name. */
const PROJECTS = Object.fromEntries(SEED.filter((data) => data.folder).map((data) => [data.key, data]));

// ---- Projects: real (throwaway) git repositories, as the server expects ----

const gitEnv = {
  HOME: home,
  PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Gemelo',
  GIT_AUTHOR_EMAIL: 'gemelo@ejemplo.invalid',
  GIT_AUTHOR_DATE: ago(3 * 24 * 60),
  GIT_COMMITTER_NAME: 'Gemelo',
  GIT_COMMITTER_EMAIL: 'gemelo@ejemplo.invalid',
  GIT_COMMITTER_DATE: ago(3 * 24 * 60),
};
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const projectsRoot = path.join(home, tr('proyectos'));
for (const project of Object.values(PROJECTS)) {
  project.repo = path.join(projectsRoot, project.folder);
  fs.mkdirSync(path.join(project.repo, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(project.repo, 'README.md'), project.readme);
  fs.writeFileSync(path.join(project.repo, 'assets/logo.png'), logoPng(project.logo.background, project.logo.foreground, project.logo.shape));
  git(project.repo, 'init', '-q', '-b', project.branch ?? 'main');
  git(project.repo, 'add', '-A');
  git(project.repo, 'commit', '-q', '-m', tr('Primer commit del proyecto ficticio'));
  project.root = git(project.repo, 'rev-list', '--max-parents=0', 'HEAD');
}

function taskWorktree(project, slug) {
  const dir = path.join(home, 'worktrees', project.folder, slug);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(project.repo, 'worktree', 'add', '-q', '-b', `ut/${slug}`, dir);
  return dir;
}

// ---- Sessions ----

const runningPids = [];
function fakeProcess() {
  // Ended by gemelo-keeper.cjs and by gemelo.sh stop (from .gemelo/fake-pids): as a platform binary
  // its environment is invisible to `ps -E`, so nothing can find it by HOME=<twin>.
  const child = spawn('/bin/sleep', ['21600'], { detached: true, stdio: 'ignore' });
  child.unref();
  runningPids.push(child.pid);
  fs.appendFileSync(path.join(home, '.gemelo/fake-pids'), `${child.pid}\n`);
  return child.pid;
}

function claudeTranscript(cwd, conversation, { title, user, assistant, tool }, at) {
  const dir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const base = { sessionId: conversation, cwd, version: '2.9.0', userType: 'external' };
  const lines = [
    { type: 'user', message: { role: 'user', content: user }, uuid: `${conversation}-1`, timestamp: at, ...base },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-falso',
        stop_reason: tool ? 'tool_use' : 'end_turn',
        content: tool
          ? [
              { type: 'text', text: assistant },
              { type: 'tool_use', id: `toolu_${conversation.slice(-6)}`, name: tool.name, input: tool.input },
            ]
          : [{ type: 'text', text: assistant }],
      },
      uuid: `${conversation}-2`,
      parentUuid: `${conversation}-1`,
      timestamp: at,
      ...base,
    },
    { type: 'ai-title', aiTitle: title, sessionId: conversation },
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${conversation}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function codexRollout(cwd, id, { user, assistant, busy, minutesAgo }, startedAt) {
  // The last event decides busy or idle (15 min without one reads as idle).
  const at = ago(minutesAgo);
  const date = new Date(startedAt);
  const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
  const dir = path.join(home, '.codex/sessions', ...parts.map(String));
  const message = (role, text, type) => ({
    timestamp: at,
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type, text }] },
  });
  const lines = [
    { timestamp: startedAt, type: 'session_meta', payload: { id, timestamp: startedAt, cwd, originator: 'codex_cli', cli_version: '0.9.0' } },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started' } },
    message('user', user, 'input_text'),
    message('assistant', assistant, 'output_text'),
    ...(busy ? [] : [{ timestamp: at, type: 'event_msg', payload: { type: 'task_complete' } }]),
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${startedAt.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const castText = (name, lines) =>
  `${[
    JSON.stringify({ version: 2, width: 100, height: 30, timestamp: Math.floor(RICH_NOW / 1000) - 600, title: name }),
    ...lines.map((line, index) => JSON.stringify([index * 0.2, 'o', `${line}\r\n`])),
    // Cursor hidden: its blink would make every screenshot of a terminal different.
    JSON.stringify([lines.length * 0.2, 'o', '\u001b[?25l']),
  ].join('\n')}\n`;

/** One session: session.json, its cast, and what its agent would have left on disk. */
function addSession(spec) {
  const id = uuid(spec.n);
  const dir = path.join(control, id);
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = ago(spec.startedMinutesAgo ?? 45);
  const running = !spec.exited && !spec.suspended;
  const pid = running ? fakeProcess() : undefined;
  const conversation = spec.claude ? uuid(1000 + spec.n) : undefined;

  if (spec.claude) {
    claudeTranscript(spec.workingDir, conversation, spec.claude, ago(spec.claude.minutesAgo ?? 2));
    if (running) {
      writeJson(path.join(claudeDir, 'sessions', `${pid}.json`), {
        pid,
        sessionId: conversation,
        cwd: spec.workingDir,
        startedAt: RICH_NOW - (spec.startedMinutesAgo ?? 45) * 60_000,
        kind: 'interactive',
        entrypoint: 'cli',
        version: '2.9.0',
        status: spec.claude.status,
        statusUpdatedAt: RICH_NOW - (spec.claude.minutesAgo ?? 2) * 60_000,
        ...(spec.claude.waitingFor ? { waitingFor: spec.claude.waitingFor } : {}),
      });
    }
  }
  if (spec.codex) codexRollout(spec.workingDir, uuid(2000 + spec.n), spec.codex, startedAt);

  writeJson(path.join(dir, 'session.json'), {
    id,
    name: spec.name,
    command: spec.command,
    workingDir: spec.workingDir,
    status: running ? 'running' : 'exited',
    ...(spec.exited ? { exitCode: spec.exited.code } : {}),
    startedAt,
    ...(pid ? { pid } : {}),
    initialCols: 100,
    initialRows: 30,
    version,
    ...(spec.project
      ? {
          gitRepoPath: spec.project.repo,
          gitBranch: spec.branch ?? spec.mainBranch ?? 'main',
          gitIsWorktree: !!spec.branch,
          gitMainRepoPath: spec.project.repo,
        }
      : {}),
    ...(spec.userTitle ? { userTitle: spec.userTitle } : {}),
    ...(spec.taskId ? { taskId: spec.taskId } : {}),
    ...(spec.modelProvider ? { modelProvider: spec.modelProvider } : {}),
    ...(conversation ? { claudeSessionId: conversation, claudeTitle: spec.claude.title } : {}),
    ...(spec.suspended
      ? {
          shielded: true,
          shieldEnd: 'suspended',
          suspended: {
            at: ago(spec.suspended.minutesAgo),
            claudeSessionId: conversation,
            command: spec.command,
            workingDir: spec.workingDir,
            shielded: true,
            idleMinutes: spec.suspended.idleMinutes,
          },
        }
      : {}),
  });
  const cast = path.join(dir, 'stdout');
  fs.writeFileSync(cast, castText(spec.name, spec.screen ?? [tr('Sesión ficticia del gemelo.')]));
  const when = new Date(RICH_NOW - (spec.lastActivityMinutesAgo ?? 3) * 60_000);
  fs.utimesSync(cast, when, when);
  return id;
}

// Each data file's sessions, with its own names for them (S.<key> is the session's number) and
// for its task worktrees (wt.<key> is the folder).
let sessionCount = 0;
const sessionNumbers = new Set();
for (const data of SEED) {
  data.wt = Object.fromEntries(Object.entries(data.worktrees ?? {}).map(([key, slug]) => [key, taskWorktree(data, slug)]));
  data.S = {};
  data.titles = {};
  for (const spec of translated(data.sessions?.({ project: data, wt: data.wt, uuid, home }) ?? [])) {
    if (sessionNumbers.has(spec.n)) throw new Error(`gemelo-seed: two sessions share the number ${spec.n} (${spec.name})`);
    sessionNumbers.add(spec.n);
    data.S[spec.key] = spec.n;
    data.titles[spec.key] = spec.claude?.title;
    addSession(spec);
    sessionCount++;
  }
}

// ---- Tasks: one or more in every state the board shows ----

function task(n, state, name, project, fields) {
  const created = fields.createdMinutesAgo ?? 60;
  const id = uuid(n);
  return {
    id,
    name,
    prompt: fields.prompt ?? name,
    workingDir: fields.workingDir ?? project.repo,
    command: fields.agent === 'codex' ? ['codex'] : ['claude'],
    agent: fields.agent ?? 'claude',
    shielded: false,
    notify: true,
    runAt: ago(created),
    createdAt: ago(created),
    state,
    stateSince: ago(fields.sinceMinutesAgo ?? 10),
    isolation: 'worktree',
    origin: fields.origin ?? 'orchestrator',
    repoPath: project.repo,
    baseBranch: 'main',
    mergePolicy: 'ask',
    followUps: fields.followUps ?? [],
    files: fields.files ?? [],
    ...(fields.extra ?? {}),
  };
}

const branchOf = (dir) => `ut/${path.basename(dir)}`;
const worked = (dir, session, files, stats) => ({
  workingDir: dir,
  files,
  extra: {
    worktreePath: dir,
    branch: branchOf(dir),
    sessionId: uuid(session),
    startedAt: ago(40),
    ...(stats ? { stats } : {}),
  },
});
const checked = (dir, tail) => ({
  verify: { command: 'pnpm test', cwd: dir, startedAt: ago(8), finishedAt: ago(4), exitCode: 0, tail },
});
const closed = (minutes, stats, extra = {}) => ({
  sinceMinutesAgo: minutes,
  createdMinutesAgo: minutes + 120,
  extra: { startedAt: ago(minutes + 100), finishedAt: ago(minutes), stats, ...extra },
});

// Every project's tasks in one list, by state as the board shows them and then by number.
const TASK_STATES = ['queued', 'working', 'needs_you', 'ready', 'merged', 'failed'];
const tasks = Object.values(PROJECTS)
  .flatMap((project) =>
    translated((project.tasks ?? (() => []))({
      project,
      wt: project.wt,
      S: project.S,
      ago,
      worked,
      checked,
      closed,
      task: (n, state, name, fields) => task(n, state, name, project, fields),
      // One of a long "Hechas" list shared by the projects: `index` is its place in the list.
      doneFiller: (index, name) =>
        task(120 + index, 'merged', name, project, {
          agent: index % 2 ? 'codex' : 'claude',
          ...closed(1600 + index * 95, { commits: 1 + (index % 3), files: 2, insertions: 30 + index, deletions: index }),
        }),
    }))
  )
  .sort((a, b) => TASK_STATES.indexOf(a.state) - TASK_STATES.indexOf(b.state) || (a.id < b.id ? -1 : 1));
// Two tasks with one number are one id twice, and a state the board does not know sorts first.
for (const [index, entry] of tasks.entries()) {
  if (!TASK_STATES.includes(entry.state)) throw new Error(`gemelo-seed: task «${entry.name}» has an unknown state ${entry.state}`);
  if (tasks[index + 1]?.id === entry.id) throw new Error(`gemelo-seed: two tasks share the number of «${entry.name}»`);
}

// Read from the source: the server sets aside a file of any other version and starts empty.
const schedulerSource = fs.readFileSync(path.join(repoRoot, 'web/src/server/services/task-scheduler-rules.ts'), 'utf8');
const taskStoreVersion = Number(/STORE_VERSION = (\d+)/.exec(schedulerSource)?.[1]);
if (!taskStoreVersion) throw new Error('STORE_VERSION not found in task-scheduler-rules.ts');
writeJson(path.join(control, 'tasks.json'), { version: taskStoreVersion, tasks });

// ---- Project settings, provider, previews ----

const projectEntry = (project, sessionN) => ({
  icon: 'assets/logo.png',
  gitRoot: project.root,
  folderName: project.folder,
  mergePolicy: 'ask',
  maxActiveTasks: 1,
  ...(sessionN ? { orchestratorSessionId: uuid(sessionN) } : {}),
});
writeJson(path.join(stateDir, 'projects.json'), {
  version: 1,
  projects: Object.fromEntries(
    Object.values(PROJECTS).map((project) => [project.repo, projectEntry(project, project.S[project.orchestrator])])
  ),
});

fs.mkdirSync(path.join(control, 'icons'), { recursive: true });
fs.writeFileSync(
  path.join(control, 'icons/nimbo.png'),
  logoPng([13, 71, 161], [255, 255, 255], (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.12)
);
// Image avatars as UntetherConfig.avatarIcons takes them. The seed's config does not use them
// (every other view keeps the app's marks); ui-shots turns them on for its "mobile-done" view.
fs.writeFileSync(
  path.join(control, 'icons/avatar-claude.png'),
  logoPng([201, 100, 66], [255, 247, 242], (x, y) => Math.abs(x - 0.5) < 0.08 || Math.abs(y - 0.5) < 0.08)
);
fs.writeFileSync(
  path.join(control, 'icons/avatar-codex.png'),
  logoPng([24, 24, 27], [250, 250, 250], (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 < 0.1)
);
writeJson(path.join(stateDir, 'config.json'), {
  version: 2,
  quickStartCommands: [{ name: 'claude', command: 'claude' }, { name: 'codex', command: 'codex' }],
  repositoryBasePath: projectsRoot,
  modelProviders: [
    {
      id: 'nimbo',
      label: 'Nimbo',
      baseUrl: 'https://nimbo.ejemplo.invalid',
      // A name, not a key: nothing is stored under it, and nothing here launches a provider.
      keychainService: 'gemelo-nimbo-falso',
      defaultModel: 'nimbo-rapido',
      icon: 'nimbo.png',
      iconFallback: '☁️',
      models: [{ id: 'nimbo-rapido', label: tr('Nimbo rápido'), alias: 'sonnet', contextTokens: 200000 }],
    },
  ],
});

const preview = (id, previewPortNumber, title, session, minutes, pinned) => ({
  id,
  port: previewPortNumber,
  path: '/',
  title,
  createdAt: RICH_NOW - 90 * 60_000,
  lastSeenAt: RICH_NOW - minutes * 60_000,
  lastOpenedAt: RICH_NOW - minutes * 60_000,
  sessionId: uuid(session),
  sessionName: title,
  pinned,
  source: 'ut-open',
});
writeJson(path.join(stateDir, 'previews.json'), {
  version: 1,
  previews: Object.values(PROJECTS).flatMap((project) =>
    (project.previews ?? []).map((entry) =>
      preview(entry.id, entry.port === 'active' ? previewPort : pausedPreviewPort, entry.title, project.S[entry.session], entry.minutes, entry.pinned)
    )
  ),
  dismissed: [],
});

// Every text has been through tr() by now; nothing is running yet that a failure would leave behind.
const previewPage = [tr('Faro · reservas'), tr('Vista previa ficticia')];
if (untranslated.size) {
  console.error(`gemelo-rich-seed: no «${locale}» translation in scripts/gemelo-seed/locales/${locale}.mjs for:`);
  for (const text of untranslated) console.error(`  ${JSON.stringify(text)}`);
  process.exit(1);
}

// The active preview answers on its port (the paused one has no listener). The keeper also ends
// the fake sessions; HOME=<twin> in its environment is what gemelo.sh stop finds it by.
spawn(
  process.execPath,
  [path.join(repoRoot, 'scripts/gemelo-keeper.cjs'), home, String(previewPort), ...previewPage],
  { detached: true, stdio: 'ignore', env: { HOME: home, PATH: '/usr/bin:/bin' } }
).unref();

// ---- Stubs for every agent the server might launch: no tokens, whatever it decides ----

const fakeBin = path.join(home, 'fake-bin');
fs.mkdirSync(fakeBin, { recursive: true });
for (const agent of ['claude', 'codex', 'gemini']) {
  fs.writeFileSync(
    path.join(fakeBin, agent),
    `#!/bin/bash
# The twin's stand-in for ${agent}: it never reaches a model.
case " $* " in
  *" --version "*|*" -v "*) echo "0.0.0 (gemelo)"; exit 0 ;;
  *" -p "*|*" --print "*|*" exec "*) exit 0 ;;
esac
exec /bin/sleep 21600
`,
    { mode: 0o755 }
  );
}

// What ui-shots.mjs and the tests need to know, without parsing anything above.
writeJson(path.join(home, '.gemelo/rich.json'), {
  now: RICH_NOW,
  // Failed, so its row opens the detail sheet instead of a session.
  taskForSheet: uuid(112),
  sessionForDesktop: uuid(PROJECTS.faro.S.pagos),
  avatarIcons: { claude: 'avatar-claude.png', codex: 'avatar-codex.png' },
  sessionTitles: [PROJECTS.faro.titles.pagos, PROJECTS.faro.titles.faroBoss],
  projects: Object.values(PROJECTS).map((project) => project.folder),
  taskStates: tasks.map((entry) => entry.state),
  sessions: sessionCount,
  previewPort,
});
console.log(`gemelo: rich state written (${tasks.length} tasks, ${sessionCount} sessions, ${runningPids.length} fake processes)`);
