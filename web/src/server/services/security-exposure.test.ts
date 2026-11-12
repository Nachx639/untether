import { describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../utils/exec-file.js';
import {
  containerFindings,
  type DockerContainer,
  exposureFacts,
  historySecrets,
  listenerFindings,
  type ProbeRunner,
  parseCwd,
  parseLsof,
  parsePs,
  probeAllowed,
  projectContainers,
  projectListeners,
  readRunning,
  runConnectors,
  surfaceFrom,
  tailscaleFindings,
} from './security-exposure.js';
import { redactSecrets } from './security-sweep.js';

const REPO = '/srv/example-app';
const HOME = '/home/someone';
const NOW = new Date('2026-10-26T10:00:00Z').getTime();
const DAY = 86_400_000;
/** Credential-shaped test data built at run time: no literal looks like a credential. */
const FAKE_API_KEY = ['tskey-api-', 'k'.repeat(20)].join('');
const FAKE_GH_TOKEN = ['gh', 'p_', 'c'.repeat(36)].join('');

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

/** Recorded `docker inspect` of a compose project: api exposed, db on loopback, worker risky. */
const compose = (service: string, extra: Partial<DockerContainer> = {}): DockerContainer => ({
  Id: `${service}0123456789abcdef`,
  Name: `/example-app-${service}-1`,
  Config: {
    Image: `example-app-${service}`,
    User: '',
    Labels: {
      'com.docker.compose.project': 'example-app',
      'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': REPO,
      'com.docker.compose.project.config_files': `${REPO}/compose.yaml`,
    },
  },
  HostConfig: { Privileged: false, NetworkMode: 'example-app_default', CapAdd: null },
  NetworkSettings: { Ports: {} },
  Mounts: [],
  ...extra,
});

const INSPECT: DockerContainer[] = [
  compose('api', {
    NetworkSettings: {
      Ports: {
        '8080/tcp': [
          { HostIp: '0.0.0.0', HostPort: '8080' },
          { HostIp: '::', HostPort: '8080' },
        ],
        '9090/tcp': null,
      },
    },
  }),
  compose('db', {
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } },
    Mounts: [{ Type: 'bind', Source: `/host_mnt${REPO}/data`, Destination: '/data', RW: true }],
  }),
  compose('worker', {
    HostConfig: { Privileged: true, NetworkMode: 'host', CapAdd: ['SYS_ADMIN'] },
    Mounts: [
      {
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
        RW: true,
      },
    ],
  }),
  // Another project's container: never looked at.
  {
    ...compose('other'),
    Config: {
      Image: 'nginx:latest',
      Labels: {
        'com.docker.compose.project': 'other',
        'com.docker.compose.project.working_dir': '/srv/other',
      },
    },
    HostConfig: { Privileged: true },
  },
];

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` with a dev server on *, one on loopback, one not ours. */
const LSOF = [
  'p101',
  'cnode',
  'f23',
  'n*:5173',
  'f24',
  'n[::]:5173',
  'p102',
  'cpython3',
  'f5',
  'n127.0.0.1:8000',
  'p103',
  'cpostgres',
  'f7',
  'n*:5433',
  'p104',
  'cruby',
  'f9',
  'n192.168.1.20:3000',
  '',
].join('\n');

describe('read-only probes', () => {
  it('only the whitelisted argv runs, every argument checked (2026-10-26 review)', () => {
    const id = 'a'.repeat(64);
    expect(probeAllowed('docker', ['inspect', id, 'b'.repeat(12)])).toBe(true);
    expect(probeAllowed('docker', ['ps', '-q', '--no-trunc'])).toBe(true);
    expect(
      probeAllowed('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', 'app-api:1.2'])
    ).toBe(true);
    expect(
      probeAllowed('git', [
        'log',
        '--all',
        '-p',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-n300',
        '--format=@@@ %h',
      ])
    ).toBe(true);
    expect(probeAllowed('ps', ['-ww', '-o', 'pid=,command=', '-p', '1,22,333'])).toBe(true);
    expect(probeAllowed('tailscale', ['serve', 'status', '--json'])).toBe(true);
    for (const [program, args] of [
      ['docker', ['rm', '-f', id]],
      ['docker', ['exec', id, 'sh']],
      ['docker', ['inspect', 'abc']],
      ['docker', ['inspect', '-H', 'tcp://evil:2375', id]],
      ['docker', ['inspect', '--context', 'remote', id]],
      ['docker', ['ps', '-q', '--no-trunc', '-H', 'tcp://evil:2375']],
      ['docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', '--host=x']],
      [
        'git',
        [
          'log',
          '--all',
          '-p',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '-n300',
          '--ext-diff',
        ],
      ],
      ['git', ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--textconv']],
      ['git', ['-c', 'core.pager=sh', 'log']],
      ['git', ['ls-files', '-z', '--', '../x']],
      ['ps', ['-ww', '-o', 'pid=,command=', '-p', '1;rm']],
      ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn', '+D', '/']],
      ['kubectl', ['delete', 'pod', 'x']],
      [
        'kubectl',
        ['get', 'services,ingresses', '--all-namespaces', '-o', 'wide', '--kubeconfig=/tmp/x'],
      ],
      ['tailscale', ['serve', 'reset']],
      ['tailscale', ['serve', 'status', '--json', '--bg']],
      ['security', ['find-generic-password', '-w']],
      ['sh', ['-c', 'ls']],
    ] as Array<[string, string[]]>) {
      expect(probeAllowed(program, args), `${program} ${args.join(' ')}`).toBe(false);
    }
  });
});

describe('the surface', () => {
  it('names what makes the project reachable, once per kind', () => {
    const files = [
      'compose.yaml',
      'compose.override.yaml',
      'api/Dockerfile',
      'deploy/k8s/service.yaml',
      'fly.toml',
      'infra/main.tf',
      'ops/cloudflared-config.yml',
      '.github/workflows/deploy.yml',
      'src/index.ts',
      'packages/lib/package.json',
      'package.json',
    ];
    const read = (file: string) =>
      file === 'package.json'
        ? JSON.stringify({ name: 'root', private: true })
        : JSON.stringify({ name: '@example/lib' });
    const surface = surfaceFrom(files, read);
    expect(surface).toContain('Docker Compose (compose.yaml)');
    expect(surface).toContain('container image (api/Dockerfile)');
    expect(surface).toContain('Kubernetes (deploy/k8s/service.yaml)');
    expect(surface).toContain('Fly.io (fly.toml)');
    expect(surface).toContain('Terraform (infra/main.tf)');
    expect(surface).toContain('tunnel (ops/cloudflared-config.yml)');
    expect(surface).toContain('deploy workflow (.github/workflows/deploy.yml)');
    expect(surface).toContain('published package (packages/lib/package.json)');
    expect(surface.filter((line) => line.startsWith('Docker Compose'))).toHaveLength(1);
  });

  it('documentation never counts', () => {
    expect(
      surfaceFrom(['docs/tailscale.md', 'docs/deploy/compose.yaml', 'NOTES-ngrok.txt'])
    ).toEqual([]);
  });

  it('a plain library or script has none', () => {
    expect(
      surfaceFrom(['src/a.ts', 'README.md', 'package.json'], () => '{"private":true}')
    ).toEqual([]);
  });
});

describe('containers (docker inspect)', () => {
  it("only the project's containers, by compose's working dir", () => {
    const names = projectContainers(INSPECT, REPO).map((container) => container.Name);
    expect(names).toEqual(['/example-app-api-1', '/example-app-db-1', '/example-app-worker-1']);
  });

  it('flags ports beyond loopback, privileged, host network and the Docker socket', () => {
    const findings = containerFindings(projectContainers(INSPECT, REPO), REPO);
    const keys = findings.map((finding) => finding.key).sort();
    expect(keys).toEqual(
      [
        'container:example-app/api:port:8080:0.0.0.0',
        'container:example-app/api:port:8080:::',
        'container:example-app/worker:docker-sock',
        'container:example-app/worker:network-host',
        'container:example-app/worker:privileged',
      ].sort()
    );
    expect(findings.every((finding) => finding.severity === 'high' && finding.fixable)).toBe(true);
    expect(findings[0].file).toBe('compose.yaml');
    // Loopback ports and binds inside the repository are fine.
    expect(keys.some((key) => key.includes('/db:'))).toBe(false);
  });
});

describe('listening processes (lsof)', () => {
  it('parses lsof, ps and cwd output', () => {
    const listeners = parseLsof(LSOF);
    expect(listeners).toEqual([
      { pid: 101, command: 'node', address: '*', port: 5173 },
      { pid: 101, command: 'node', address: '[::]', port: 5173 },
      { pid: 102, command: 'python3', address: '127.0.0.1', port: 8000 },
      { pid: 103, command: 'postgres', address: '*', port: 5433 },
      { pid: 104, command: 'ruby', address: '192.168.1.20', port: 3000 },
    ]);
    expect(parsePs('  101 node /srv/example-app/node_modules/.bin/vite --host\n').get(101)).toBe(
      'node /srv/example-app/node_modules/.bin/vite --host'
    );
    expect(parseCwd('p101\nfcwd\nn/srv/example-app\np103\nfcwd\nn/\n').get(101)).toBe(
      '/srv/example-app'
    );
  });

  it("flags only the project's processes listening beyond loopback", () => {
    const ours = projectListeners(
      parseLsof(LSOF),
      [
        { pid: 101, cwd: '/srv/example-app/web', args: 'node vite --host' },
        { pid: 102, cwd: REPO, args: 'python3 -m http.server --bind 127.0.0.1' },
        { pid: 103, cwd: '/', args: '/usr/local/bin/postgres -D /usr/local/var/pg' },
        { pid: 104, cwd: '/', args: `ruby ${REPO}/bin/server.rb` },
      ],
      { repo: REPO }
    );
    expect(ours.map((listener) => listener.pid)).toEqual([101, 101, 102, 104]);
    const findings = listenerFindings(ours);
    expect(findings.map((finding) => [finding.key, finding.severity])).toEqual([
      ['listener:node:5173', 'high'],
      ['listener:ruby:3000', 'medium'],
    ]);
    // A path that only starts the same is another folder.
    expect(
      projectListeners(
        parseLsof(LSOF),
        [{ pid: 104, cwd: '/', args: `ruby ${REPO}-old/server.rb` }],
        { repo: REPO }
      )
    ).toEqual([]);
  });

  it('this server is never its own finding', () => {
    expect(
      projectListeners(parseLsof(LSOF), [{ pid: 101, cwd: REPO }], { repo: REPO, selfPid: 101 })
    ).toEqual([]);
  });
});

describe('reading what runs', () => {
  it('uses only read-only probes and keeps the parts that answered', async () => {
    const calls: string[][] = [];
    const probe: ProbeRunner = async (program, args) => {
      calls.push([program, ...args]);
      expect(probeAllowed(program, args)).toBe(true);
      if (program === 'git') return ok('compose.yaml\0src/a.ts\0');
      if (program === 'docker' && args[0] === 'ps') return ok('0123456789abcdef\n');
      if (program === 'docker') return ok(JSON.stringify(INSPECT));
      if (program === 'lsof' && args[0] === '-nP') return ok(LSOF);
      if (program === 'lsof') return ok('p101\nfcwd\nn/srv/example-app\n');
      if (program === 'ps') return ok('101 node vite\n103 postgres\n');
      return { code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' };
    };
    const state = await readRunning(REPO, probe, 999);
    expect(state.files).toEqual(['compose.yaml', 'src/a.ts']);
    expect(state.containers).toHaveLength(3);
    expect(state.listeners.map((listener) => listener.pid)).toEqual([101, 101]);
    expect(state.errors).toEqual([]);
    expect(calls.every(([program]) => ['git', 'docker', 'lsof', 'ps'].includes(program))).toBe(
      true
    );
  });

  it('Docker installed but down, in a project that uses it, is said', async () => {
    const probe: ProbeRunner = async (program) => {
      if (program === 'git') return ok('compose.yaml\0');
      if (program === 'docker')
        return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      return ok('');
    };
    const state = await readRunning(REPO, probe);
    expect(state.errors).toEqual(['docker ps: Cannot connect to the Docker daemon']);
  });
});

describe('the facts an exposure round reads', () => {
  it('no container environment, secrets masked, whitelisted commands only', async () => {
    const withEnv = {
      ...INSPECT[0],
      Config: { ...INSPECT[0].Config, Env: [`GITHUB_TOKEN=${FAKE_GH_TOKEN}`] },
    } as DockerContainer;
    const probe: ProbeRunner = vi.fn(async (program, args) => {
      expect(probeAllowed(program, args)).toBe(true);
      if (program === 'docker') return ok(`/bin/sh -c echo token=${FAKE_GH_TOKEN} > /x\n`);
      if (program === 'ps') return ok(`200 cloudflared tunnel run example\n201 vim notes\n`);
      if (program === 'gh') return ok('{"nameWithOwner":"example/app","visibility":"PUBLIC"}');
      if (program === 'git') {
        return ok(
          `@@@ abc1234\ndiff --git a/.env b/.env\n+++ b/.env\n+API_TOKEN=${FAKE_GH_TOKEN}\n@@@ def5678\n+++ b/a.ts\n+const a = 1;\n`
        );
      }
      return { code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' };
    });
    const facts = await exposureFacts(
      REPO,
      {
        files: ['compose.yaml'],
        containers: [withEnv],
        listeners: [{ pid: 101, command: 'node', address: '*', port: 5173 }],
        errors: [],
        surface: ['Docker Compose (compose.yaml)', 'tunnel (cloudflared.yml)'],
      },
      { redact: redactSecrets, probe, home: HOME }
    );
    expect(facts).toContain('api (example-app-api-1)');
    expect(facts).toContain('0.0.0.0:8080->8080/tcp');
    expect(facts).toContain('node (pid 101) *:5173');
    expect(facts).toContain('200 cloudflared tunnel run example');
    expect(facts).not.toContain('vim notes');
    expect(facts).toContain('"visibility":"PUBLIC"');
    expect(facts).toContain('abc1234 .env');
    expect(facts).not.toContain('def5678');
    expect(facts).not.toContain(FAKE_GH_TOKEN);
    expect(facts).not.toContain('GITHUB_TOKEN');
  });

  it('history: where a secret was committed, never its value', () => {
    const log = `@@@ abc1234\n+++ b/config.js\n+const key = "${FAKE_GH_TOKEN}";\n+const x = 1;\n`;
    const hits = historySecrets(log, redactSecrets);
    expect(hits).toEqual(['abc1234 config.js']);
    expect(hits.join()).not.toContain(FAKE_GH_TOKEN);
  });
});

describe('the Tailscale connector (recorded API answers)', () => {
  const ACL = {
    acls: [
      { action: 'accept', src: ['*'], dst: ['tag:example:443'] },
      { action: 'accept', src: ['group:admins'], dst: ['*:*'] },
      { action: 'accept', src: ['*'], dst: ['*:*'], proto: 'icmp' },
      { action: 'accept', src: ['autogroup:shared'], dst: ['tag:example:443,8080'] },
      { action: 'accept', src: ['autogroup:shared'], dst: ['tag:unrelated:22'] },
    ],
    grants: [{ src: ['autogroup:member'], dst: ['*'], ip: ['*'] }],
  };
  const DEVICES = {
    devices: [
      {
        nodeId: 'n1',
        name: 'old-laptop.tail.ts.net',
        lastSeen: new Date(NOW - 90 * DAY).toISOString(),
      },
      {
        nodeId: 'n2',
        name: 'phone.tail.ts.net',
        lastSeen: new Date(NOW - 2 * DAY).toISOString(),
        updateAvailable: true,
      },
      {
        nodeId: 'n3',
        name: 'server',
        lastSeen: new Date(NOW - 99 * DAY).toISOString(),
        connectedToControl: true,
      },
    ],
  };
  const SETTINGS = { devicesApprovalOn: false, usersApprovalOn: true };
  const KEYS = {
    keys: [
      {
        id: 'k1',
        keyType: 'auth',
        expires: new Date(NOW + 30 * DAY).toISOString(),
        capabilities: { devices: { create: { reusable: true } } },
      },
      {
        id: 'k2',
        keyType: 'auth',
        expires: new Date(NOW - DAY).toISOString(),
        capabilities: { devices: { create: { reusable: true } } },
      },
      {
        id: 'k3',
        keyType: 'auth',
        expires: new Date(NOW + DAY).toISOString(),
        capabilities: { devices: { create: { reusable: false } } },
      },
      { id: 'k4', keyType: 'api', expires: new Date(NOW + DAY).toISOString() },
    ],
  };

  it('flags open rules, shared ports beyond the allowed, old devices, approvals and keys', () => {
    const findings = tailscaleFindings(
      { acl: ACL, devices: DEVICES, settings: SETTINGS, keys: KEYS },
      { tag: 'tag:example', sharedPorts: ['443'] },
      NOW
    );
    const titles = findings.map((finding) => finding.title);
    expect(titles).toContain('Policy rule open to every source: * → tag:example:443');
    expect(titles).toContain('Policy rule opens every port of every device: group:admins → *:*');
    expect(titles.some((title) => title.includes('icmp'))).toBe(false);
    expect(titles).toContain('Shared users reach tag:example on 8080');
    expect(titles.some((title) => title.includes('tag:unrelated'))).toBe(false);
    expect(titles).toContain('Grant opens every port of every device: autogroup:member → * *');
    expect(titles).toContain('old-laptop not connected for 90 days');
    expect(titles.some((title) => title.startsWith('server'))).toBe(false);
    expect(titles).toContain('phone: Tailscale update available');
    expect(titles).toContain('Device approval is off');
    expect(titles).not.toContain('User approval is off');
    expect(titles.filter((title) => title.startsWith('Reusable auth key'))).toEqual([
      'Reusable auth key k1 still valid',
    ]);
    // Only ever told: nothing a change in the repository fixes.
    expect(findings.every((finding) => !finding.fixable && finding.source === 'tailscale')).toBe(
      true
    );
    expect(findings.find((finding) => finding.title.startsWith('phone'))?.severity).toBe('low');
  });

  it('no tag set: the shared-ports check is skipped', () => {
    const findings = tailscaleFindings({ acl: ACL }, { sharedPorts: [] }, NOW);
    expect(findings.some((finding) => finding.key.startsWith('tailscale:shared'))).toBe(false);
  });

  it('reads with the credential the user named and never shows it', async () => {
    const get = vi.fn(async (_provider: string, secret: string, apiPath: string) => {
      expect(secret).toBe(FAKE_API_KEY);
      if (apiPath.endsWith('/devices')) return DEVICES;
      if (apiPath.endsWith('/acl')) return ACL;
      if (apiPath.endsWith('/settings')) return SETTINGS;
      if (apiPath.includes('/keys?')) return { keys: [{ id: 'k1' }] };
      if (apiPath.endsWith('/keys/k1')) return KEYS.keys[0];
      throw new Error('HTTP 404');
    });
    const credential = vi.fn(async () => FAKE_API_KEY);
    const result = await runConnectors(
      [
        {
          provider: 'tailscale',
          credential: { from: 'keychain', name: 'some-service' },
          options: { tag: 'example', sharedPorts: '443' },
        },
      ],
      { credential, get, now: () => NOW }
    );
    expect(credential).toHaveBeenCalledWith({ from: 'keychain', name: 'some-service' });
    expect(get).toHaveBeenCalledWith('tailscale', FAKE_API_KEY, '/tailnet/-/keys/k1');
    expect(result.errors).toEqual([]);
    expect(result.findings.some((finding) => finding.key === 'tailscale:key:k1')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_API_KEY);
  });

  it('no credential, or an API error: said without the credential, others still run', async () => {
    const missing = await runConnectors(
      [{ provider: 'tailscale', credential: { from: 'env', name: 'SOME_VAR' } }],
      { credential: async () => null }
    );
    expect(missing).toEqual({
      findings: [],
      errors: ['tailscale: no credential in the environment variable SOME_VAR'],
    });
    const failing = await runConnectors(
      [{ provider: 'tailscale', credential: { from: 'env', name: 'SOME_VAR' } }],
      {
        credential: async () => FAKE_API_KEY,
        get: async (_provider, _secret, apiPath) => {
          if (apiPath.endsWith('/settings')) return SETTINGS;
          throw new Error('HTTP 403');
        },
        now: () => NOW,
      }
    );
    expect(failing.errors).toContain('tailscale /tailnet/-/acl: HTTP 403');
    expect(failing.findings.map((finding) => finding.title)).toEqual(['Device approval is off']);
    expect(JSON.stringify(failing)).not.toContain(FAKE_API_KEY);
  });
});
