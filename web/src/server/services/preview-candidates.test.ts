import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATES_CACHE_MS,
  createPreviewCandidateFinder,
  listListeners,
  MAX_CANDIDATES,
  type PortListener,
  type ProbeAnswer,
  parseLsofListeners,
  probeHttp,
} from './preview-candidates.js';
import { extractTitle } from './preview-health.js';
import { parseDeniedPorts, previewPortError } from './preview-proxy.js';

// `lsof -nP -iTCP -sTCP:LISTEN -a -u 501 -Fpcn` on a dev Mac (2026-10-03), plus a LAN-only
// listener, a port below 1024 and a worker sharing its parent's socket.
const LSOF_LISTEN = `p952
crapportd
f11
n*:49152
f12
n*:49152
p20336
cPython
f3
n127.0.0.1:5180
p30919
cnode
f78
n127.0.0.1:18789
f79
n[::1]:18789
p50214
cnode
f37
n127.0.0.1:4030
f38
n127.0.0.1:4031
p57475
c2.1.286
f9
n127.0.0.1:59535
p85871
cnode
f31
n127.0.0.1:4020
f32
n127.0.0.1:4021
p91854
cnode
f23
n127.0.0.1:5173
p91860
cnode
f23
n127.0.0.1:5173
p93001
cnode
f20
n[::1]:3000
p93100
cruby
f12
n192.168.1.20:7000
p93200
cnginx
f6
n*:80
`;

// `lsof -a -p <those pids> -d cwd -Fn`: 93200 is missing, it exited between the two calls
// (lsof then exits with status 1 but still prints the others).
const LSOF_CWD = `p952
fcwd
n/
p20336
fcwd
n/
p30919
fcwd
n/Users/me/.demo-agent
p50214
fcwd
n/Users/me/Projects/untether-mobile/web
p57475
fcwd
n/Users/me
p85871
fcwd
n/Users/me/Projects/untether/web
p91854
fcwd
n/Users/me/.untether-qa/vite-app
p91860
fcwd
n/Users/me/.untether-qa/vite-app
p93001
fcwd
n/Users/me/Projects/api
`;

const fakeLsof = () =>
  vi.fn(async (args: string[]) => (args.includes('-sTCP:LISTEN') ? LSOF_LISTEN : LSOF_CWD));

describe('servers listening on this Mac (lsof)', () => {
  it('reads every loopback or wildcard listener with its process, never a LAN-only one', () => {
    const listeners = parseLsofListeners(LSOF_LISTEN);
    expect(listeners).toContainEqual({
      port: 5180,
      pid: 20336,
      command: 'Python',
      host: '127.0.0.1',
    });
    expect(listeners).toContainEqual({
      port: 59535,
      pid: 57475,
      command: '2.1.286',
      host: '127.0.0.1',
    });
    // Vite on "localhost" can listen on ::1 only: the probe has to go there.
    expect(listeners).toContainEqual({ port: 3000, pid: 93001, command: 'node', host: '::1' });
    expect(listeners.filter((listener) => listener.port === 49152)).toHaveLength(2);
    expect(listeners.map((listener) => listener.port)).not.toContain(7000);
  });

  it('adds each process folder from one more lsof call, except "/" and the home folder', async () => {
    const run = fakeLsof();
    const listeners = await listListeners({ run, platform: 'darwin', uid: 501, home: '/Users/me' });
    expect(run.mock.calls[0][0]).toEqual([
      '-nP',
      '-iTCP',
      '-sTCP:LISTEN',
      '-a',
      '-u',
      '501',
      '-Fpcn',
    ]);
    // Only the pids with a listener that could be previewed (not ruby's LAN-only one).
    expect(run.mock.calls[1][0]).toEqual([
      '-a',
      '-p',
      '952,20336,30919,50214,57475,85871,91854,91860,93001,93200',
      '-d',
      'cwd',
      '-Fn',
    ]);
    const folderOf = (port: number) => listeners.find((listener) => listener.port === port)?.folder;
    expect(folderOf(5173)).toBe('vite-app');
    expect(folderOf(3000)).toBe('api');
    expect(folderOf(5180)).toBeUndefined(); // cwd "/"
    expect(folderOf(59535)).toBeUndefined(); // the home folder
    expect(folderOf(80)).toBeUndefined(); // gone before its folder was read
  });

  it('is empty when lsof fails, and anywhere but macOS', async () => {
    expect(await listListeners({ run: async () => '', platform: 'darwin', uid: 501 })).toEqual([]);
    const broken = vi.fn(async () => {
      throw new Error('spawn /usr/sbin/lsof ENOENT');
    });
    expect(await listListeners({ run: broken, platform: 'darwin', uid: 501 })).toEqual([]);
    const linux = fakeLsof();
    expect(await listListeners({ run: linux, platform: 'linux', uid: 1000 })).toEqual([]);
    expect(linux).not.toHaveBeenCalled();
  });
});

describe('preview candidates', () => {
  /** What GET / on each port answers; null: not HTTP (or not in time). */
  const ANSWERS = new Map<number, ProbeAnswer | null>([
    [3000, {}],
    [4030, { untether: true }],
    [5173, { title: 'Vite App' }],
    [49152, null],
    [59535, {}],
  ]);
  const setup = (
    over: {
      saved?: number[];
      listeners?: () => Promise<PortListener[]>;
      answers?: Map<number, ProbeAnswer | null>;
    } = {}
  ) => {
    const answers = over.answers ?? ANSWERS;
    const probe = vi.fn(async (port: number, _host: string) => answers.get(port) ?? null);
    const run = fakeLsof();
    const list = vi.fn(
      over.listeners ??
        (() => listListeners({ run, platform: 'darwin', uid: 501, home: '/Users/me' }))
    );
    const untether = vi.fn();
    let clock = 1_000_000;
    const saved = over.saved ?? [5180];
    const find = createPreviewCandidateFinder({
      // As the routes build it: Untether's main and preview ports, the denied ones.
      portError: (port) => previewPortError(port, [4020, 4021], parseDeniedPorts('18789')),
      savedPorts: () => saved,
      onUntetherPort: untether,
      listListeners: list,
      probe,
      now: () => clock,
    });
    return { find, probe, list, untether, saved, tick: (ms: number) => (clock += ms) };
  };

  it('leaves out ephemeral ports and infrastructure that answers HTTP too', async () => {
    // Listed on the Mac: cloudflared's metrics, a local agent gateway's internal ports.
    const { find } = setup({
      listeners: async () => [
        { port: 3000, pid: 1, command: 'node', host: '127.0.0.1' },
        { port: 20241, pid: 2, command: 'cloudflared', host: '127.0.0.1' },
        { port: 56002, pid: 3, command: 'node', host: '127.0.0.1' },
      ],
      answers: new Map([
        [3000, { title: 'App' }],
        [20241, { title: 'metrics' }],
        [56002, { title: 'internal' }],
      ]),
    });
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000]);
  });

  it('leaves out an API with no page at / (2026-10-23: the Atlas bridge, a JSON 404)', async () => {
    const { find } = setup({
      listeners: async () => [
        { port: 3000, pid: 1, command: 'node', host: '127.0.0.1' },
        { port: 8787, pid: 2, command: 'Python', host: '127.0.0.1' },
      ],
      answers: new Map([
        [3000, { title: 'App' }],
        [8787, { noPage: true }],
      ]),
    });
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000]);
  });

  it("offers the HTTP servers, never Untether's, denied, saved or system ports", async () => {
    const { find, probe, untether } = setup();
    expect(await find()).toEqual([
      { port: 3000, process: 'node', folder: 'api' },
      { port: 5173, title: 'Vite App', process: 'node', folder: 'vite-app' },
    ]);
    // Each allowed port once (5173 has two processes); ::1 for the one listening only there.
    expect(probe.mock.calls.sort((a, b) => a[0] - b[0])).toEqual([
      [3000, '::1'],
      [4030, '127.0.0.1'],
      [4031, '127.0.0.1'],
      [5173, '127.0.0.1'],
    ]);
    // Another Untether server (QA on 4030) answered: reported, so it is refused from now on.
    expect(untether).toHaveBeenCalledWith(4030);
  });

  it('offers at most 20, the lowest ports', async () => {
    const many: PortListener[] = Array.from({ length: 30 }, (_, i) => ({
      port: 6029 - i,
      pid: 100 + i,
      command: 'node',
      host: '127.0.0.1',
    }));
    const { find } = setup({
      listeners: async () => many,
      answers: new Map(many.map((listener) => [listener.port, {}])),
    });
    const found = await find();
    expect(found).toHaveLength(MAX_CANDIDATES);
    expect(found.map((candidate) => candidate.port)).toEqual(
      Array.from({ length: 20 }, (_, i) => 6000 + i)
    );
  });

  it('reuses a scan for a few seconds, but never offers a port saved meanwhile', async () => {
    const { find, list, probe, saved, tick } = setup({
      answers: new Map([
        [3000, {}],
        [5173, { title: 'Vite App' }],
      ]),
    });
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000, 5173]);
    tick(1000);
    saved.push(5173); // tapped in the sheet
    expect((await find()).map((candidate) => candidate.port)).toEqual([3000]);
    expect(list).toHaveBeenCalledTimes(1);
    const probes = probe.mock.calls.length;
    tick(CANDIDATES_CACHE_MS);
    await find();
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.length).toBeGreaterThan(probes);
  });

  it('is empty when the listeners cannot be listed', async () => {
    const { find, probe } = setup({
      listeners: async () => {
        throw new Error('lsof timed out');
      },
    });
    expect(await find()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});

// Only servers these tests start themselves, on ports the OS picks: never one of the Mac's.
describe('probing a port', () => {
  const servers: Array<http.Server | net.Server> = [];
  const sockets: net.Socket[] = [];
  const listen = async (server: http.Server | net.Server) => {
    servers.push(server);
    server.on('connection', (socket: net.Socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  const page = (headers: Record<string, string>, body: string) =>
    listen(
      http.createServer((_req, res) => {
        res.writeHead(200, headers);
        res.end(body);
      })
    );

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  it('reads the page title, tidied and at most 60 characters', async () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    const app = await page(html, '<title>\n  Inicio &middot; Hola&#160;Demo &amp;lt;3 </title>');
    expect(await probeHttp(app)).toEqual({ title: 'Inicio · Hola Demo &lt;3' });
    const long = await page(html, `<title>${'Panel '.repeat(20)}</title>`);
    const title = (await probeHttp(long))?.title ?? '';
    expect(title).toHaveLength(59); // 60, then the trailing space trimmed
    expect(extractTitle('<title>&#x1F680; Launch</title>')).toBe('🚀 Launch');
  });

  it('an API without a page is offered without a title; an Untether server is told apart', async () => {
    expect(await probeHttp(await page({ 'content-type': 'application/json' }, '{}'))).toEqual({});
    // 2026-10-23: an API whose `/` is a JSON 404 (the Atlas bridge) has nothing to show.
    const api404 = await listen(
      http.createServer((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"not_found"}}');
      })
    );
    expect(await probeHttp(api404)).toEqual({ noPage: true });
    expect(
      await probeHttp(await page({ 'content-type': 'text/html', 'x-untether-server': '1' }, ''))
    ).toEqual({ untether: true });
  });

  it('a server that answered but is still sending its page counts, without a title', async () => {
    const slow = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head>');
      })
    );
    expect(await probeHttp(slow, '127.0.0.1', 150)).toEqual({});
  });

  it('something that is not HTTP, or says nothing in time, is not offered', async () => {
    const ssh = await listen(net.createServer((socket) => socket.end('SSH-2.0-OpenSSH_9.6\r\n')));
    expect(await probeHttp(ssh)).toBeNull();
    const silent = await listen(net.createServer(() => {}));
    const started = Date.now();
    expect(await probeHttp(silent, '127.0.0.1', 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
