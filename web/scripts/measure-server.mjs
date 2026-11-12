#!/usr/bin/env node
/**
 * Measure a running Untether server for a while, without restarting it or installing anything:
 * CPU (process and per source file, from a V8 CPU profile), event loop lag, memory, and the
 * child processes it starts per minute (git, ps, tmux…) with their average time.
 *
 *   node web/scripts/measure-server.mjs [--pid <pid>] [--port 4020] [--seconds 60] [--out <dir>]
 *
 * It opens the server's inspector (SIGUSR1, 127.0.0.1:9229 only), patches child_process in the
 * server to count spawns, takes the profile, then removes the patch and closes the inspector.
 * Written 2026-11-02 for the "lighter server" measurement; the dev server restarts on edits of
 * the main checkout, which cuts a run short: run again (or with fewer --seconds).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    pid: { type: 'string' },
    port: { type: 'string', default: '4020' },
    seconds: { type: 'string', default: '60' },
    out: { type: 'string' },
  },
});
const seconds = Number(values.seconds);
if (!(seconds > 0)) throw new Error(`--seconds takes a number above 0, not ${values.seconds}`);
/** The pid listening on the port ('' when nothing does: lsof exits 1 then). */
const listener = () => {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${values.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0];
  } catch {
    return '';
  }
};
const pid = Number(values.pid ?? listener());
if (!pid) throw new Error(`no server listening on port ${values.port}`);

const INSPECTOR = 'http://127.0.0.1:9229/json/list';
try {
  await fetch(INSPECTOR);
  console.error('Something already listens on 127.0.0.1:9229; close it first.');
  process.exit(2);
} catch {
  // Free: expected.
}
process.kill(pid, 'SIGUSR1');
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try {
    targets = await (await fetch(INSPECTOR)).json();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!targets?.[0]) throw new Error('the server did not open its inspector');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onclose = () => {
  console.error('The inspector connection closed (the server restarted?): run again.');
  process.exit(3);
};
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result?.result?.value;
};

// Whatever happens next (an error, Ctrl-C), the server gets its functions back and its inspector
// closed: it is a server in use, not to be left patched and listening on 9229.
const RESTORE = `(() => {
  const M = globalThis.__utMeasure;
  if (M) {
    M.lag.disable();
    for (const undo of M.restore) undo();
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
    delete globalThis.__utMeasure;
  }
  return M;
})()`;
let left = false;
const leave = async () => {
  if (left) return;
  left = true;
  ws.onclose = null;
  try {
    await Promise.race([
      send('Runtime.evaluate', {
        expression: `${RESTORE}; process.getBuiltinModule('node:inspector').close()`,
      }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    // The connection is gone: nothing left to tell the server.
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void leave().then(() => process.exit(130)));
}

let result;
let stats;
try {
// The inspector that answered must be the server's, before anything is changed in it.
const answered = await evaluate('process.pid');
if (answered !== pid) throw new Error(`the inspector answered for pid ${answered}, not ${pid}`);

// In the server: count every child process by program and first words, and the loop's lag.
await evaluate(`(() => {
  const cp = process.getBuiltinModule('node:child_process');
  const { monitorEventLoopDelay, performance } = process.getBuiltinModule('node:perf_hooks');
  const M = (globalThis.__utMeasure = { spawns: {}, restore: [], cpu0: process.cpuUsage(), t0: performance.now() });
  M.lag = monitorEventLoopDelay({ resolution: 10 });
  M.lag.enable();
  const key = (file, args) => {
    const program = String(file).split('/').pop();
    const words = (args || []).filter((a) => typeof a === 'string' && !a.includes('/'));
    return program + ' ' + (program === 'git' ? words.slice(0, 2) : words.filter((a) => !a.startsWith('-')).slice(0, 1)).join(' ');
  };
  const record = (k, ms) => { const s = (M.spawns[k] ??= { n: 0, ms: 0 }); s.n++; s.ms += ms; };
  const proto = cp.ChildProcess.prototype;
  const spawn = proto.spawn;
  proto.spawn = function (o) {
    const t = performance.now();
    const k = key(o.file, (o.args || []).slice(1));
    const r = spawn.call(this, o);
    this.once('exit', () => record(k, performance.now() - t));
    return r;
  };
  M.restore.push(() => { proto.spawn = spawn; });
  for (const name of ['spawnSync', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function (file, args, ...rest) {
      const t = performance.now();
      try { return original.call(this, file, args, ...rest); }
      finally { record(key(file, Array.isArray(args) ? args : []), performance.now() - t); }
    };
    M.restore.push(() => { cp[name] = original; });
  }
  process.getBuiltinModule('node:module').syncBuiltinESMExports();
  return process.pid;
})()`);
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 1000 });
await send('Profiler.start');
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
({ result } = await send('Profiler.stop'));
stats = await evaluate(`(() => {
  const M = ${RESTORE};
  const { performance } = process.getBuiltinModule('node:perf_hooks');
  const cpu = process.cpuUsage(M.cpu0);
  const wallMs = performance.now() - M.t0;
  const mem = process.memoryUsage();
  return {
    wallMs,
    cpuPct: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
    lagMs: { p50: M.lag.percentile(50) / 1e6, p99: M.lag.percentile(99) / 1e6, max: M.lag.max / 1e6 },
    memMB: { rss: mem.rss >> 20, heapUsed: mem.heapUsed >> 20, heapTotal: mem.heapTotal >> 20 },
    spawns: M.spawns,
  };
})()`);
} finally {
  await leave();
}

const profile = result.profile;
if (values.out) {
  fs.mkdirSync(values.out, { recursive: true });
  fs.writeFileSync(path.join(values.out, 'server.cpuprofile'), JSON.stringify(profile));
  fs.writeFileSync(path.join(values.out, 'server-stats.json'), JSON.stringify(stats, null, 1));
}

// Profile time by the nearest source file of the server up each stack.
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const time = new Map();
profile.samples.forEach((id, i) => time.set(id, (time.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const byFile = {};
let total = 0;
for (const [id, us] of time) {
  total += us;
  let node = byId.get(id);
  const name = node.callFrame.functionName;
  let owner = ['(idle)', '(program)', '(garbage collector)'].includes(name) ? name : '(node/library)';
  for (; owner === '(node/library)' && node; node = byId.get(parent.get(node.id))) {
    const match = /\/web\/(src\/.*)$/.exec(node.callFrame.url);
    if (match) owner = match[1];
  }
  byFile[owner] = (byFile[owner] ?? 0) + us;
}

const perMinute = 60_000 / stats.wallMs;
console.log(`pid ${pid}, ${(stats.wallMs / 1000).toFixed(0)} s`);
console.log(`CPU ${stats.cpuPct.toFixed(1)} % of a core`);
console.log(
  `event loop lag p50 ${stats.lagMs.p50.toFixed(1)} ms (10 ms resolution), p99 ${stats.lagMs.p99.toFixed(1)} ms, max ${stats.lagMs.max.toFixed(0)} ms`
);
console.log(
  `memory rss ${stats.memMB.rss} MB, heap ${stats.memMB.heapUsed}/${stats.memMB.heapTotal} MB`
);
let count = 0;
let childMs = 0;
console.log('child processes per minute:');
for (const [what, s] of Object.entries(stats.spawns).sort((a, b) => b[1].n - a[1].n)) {
  count += s.n;
  childMs += s.ms;
  console.log(`  ${(s.n * perMinute).toFixed(0).padStart(5)}  ${(s.ms / s.n).toFixed(0).padStart(5)} ms  ${what}`);
}
console.log(`  total ${(count * perMinute).toFixed(0)}/min, ${((childMs * perMinute) / 1000).toFixed(1)} s/min in children`);
console.log('profile by source file:');
for (const [file, us] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)} %  ${file}`);
}
process.exit(0);
