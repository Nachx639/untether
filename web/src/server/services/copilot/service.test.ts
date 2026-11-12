import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  CLIP_TURN,
  type CopilotServerMessage,
  decodeAudioFrame,
} from '../../../shared/copilot-protocol';
import { fakeActions, fakeBrain, fakeSession } from '../../../test/helpers/copilot-fakes';
import { RM_TEST_DIR } from '../../../test/helpers/rm-test-dir.js';
import { CopilotService, splitPieces } from './service';
import { CopilotSpeech, type SpeechEngines, silentWav } from './speech';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = os.homedir();

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  json: CopilotServerMessage[] = [];
  binary: Uint8Array[] = [];
  send(data: string | Uint8Array) {
    if (typeof data === 'string') this.json.push(JSON.parse(data));
    else this.binary.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  say(msg: object) {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }
  of<T extends CopilotServerMessage['type']>(type: T) {
    return this.json.filter((m) => m.type === type) as Extract<CopilotServerMessage, { type: T }>[];
  }
}

const engines: SpeechEngines = {
  synthesize: async () => ({ audio: silentWav(50), engine: 'kokoro' }),
  transcribe: async () => '¿cómo va el login?',
  ttsEngine: () => 'kokoro',
  ttsReady: () => true,
  sttAvailable: () => true,
  warmTts: async () => undefined,
  keepAlive: () => undefined,
};

const dirs: string[] = [];
const services: CopilotService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, RM_TEST_DIR);
});

function setup(opts: { idleStopMs?: number } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'copilot-service-'));
  dirs.push(dataDir);
  const sessions = [
    fakeSession({ id: 'a', workingDir: path.join(home, 'Projects', 'login'), claude: 'idle' }),
    fakeSession({ id: 'b', workingDir: path.join(home, 'Projects', 'landing'), claude: 'busy' }),
  ];
  const fa = fakeActions();
  let snapshots = 0;
  fa.access.snapshot = async () => {
    snapshots++;
    return sessions;
  };
  const brains: ReturnType<typeof fakeBrain>[] = [];
  const service = new CopilotService({
    access: fa.access,
    dataDir,
    claudeDir: dataDir,
    speech: new CopilotSpeech(null, engines),
    makeBrain: () => {
      const b = fakeBrain(() => '@none\nLogin está listo y landing trabajando.\n');
      brains.push(b);
      return b.brain;
    },
    idleStopMs: opts.idleStopMs ?? 60_000,
  });
  services.push(service);
  const open = () => {
    const ws = new FakeWs();
    service.attach(ws as unknown as WebSocket);
    return ws;
  };
  return { service, open, brains, snapshots: () => snapshots };
}

describe('copilot service', () => {
  it('starts nothing until a page says hello', async () => {
    const t = setup();
    const ws = t.open();
    await sleep(30);
    expect(t.service.started).toBe(false);
    expect(t.snapshots()).toBe(0);
    expect(t.brains).toEqual([]);
    ws.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(80);
    expect(t.service.started).toBe(true);
    expect(t.snapshots()).toBeGreaterThan(0);
    expect(t.brains).toHaveLength(1);
  });

  it('sends state, the clip pool and a greeting on hello', async () => {
    const t = setup();
    const ws = t.open();
    ws.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(150);
    const state = ws.of('state').at(-1);
    expect(state?.scope).toEqual({ mode: 'global' });
    expect(state?.sessions.map((s) => s.name)).toEqual(['login', 'landing']);
    const clips = ws.of('clips')[0];
    expect(clips?.lang).toBe('es');
    const clipFrames = ws.binary
      .map((f) => decodeAudioFrame(f))
      .filter((f) => f?.turn === CLIP_TURN);
    expect(clipFrames.length).toBe(clips?.clips.length);
    const greeting = ws.of('turn-start').find((m) => m.origin === 'greeting');
    expect(greeting?.own).toBe(true);
    expect(ws.of('sentence').map((s) => s.text)).toContain(
      'Dos sesiones: landing trabajando, login listo.'
    );
  });

  it('plays a turn only on the page it came from', async () => {
    const t = setup();
    const a = t.open();
    const b = t.open();
    a.say({ type: 'hello', v: 1, mode: 'global' });
    b.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(150);
    const before = { a: a.binary.length, b: b.binary.length };
    a.emit('message', silentWav(400), true);
    await sleep(200);
    const startA = a.of('turn-start').find((m) => m.origin === 'user');
    const startB = b.of('turn-start').find((m) => m.origin === 'user');
    expect(startA?.own).toBe(true);
    expect(startB?.own).toBe(false);
    expect(a.of('transcript')[0]?.text).toBe('¿cómo va el login?');
    const turn = startA?.turn;
    const framesFor = (ws: FakeWs, n: number) =>
      ws.binary.slice(n).filter((f) => decodeAudioFrame(f)?.turn === turn);
    expect(framesFor(a, before.a).length).toBeGreaterThan(0);
    expect(framesFor(b, before.b)).toEqual([]);
    // Captions go to both.
    expect(b.of('sentence').some((s) => s.turn === turn)).toBe(true);
  });

  it('keeps session mode to its session', async () => {
    const t = setup();
    const ws = t.open();
    ws.say({ type: 'hello', v: 1, mode: 'session', sessionId: 'b' });
    await sleep(150);
    const state = ws.of('state').at(-1);
    expect(state?.scope).toEqual({ mode: 'session', sessionId: 'b' });
    expect(state?.sessions.map((s) => s.name)).toEqual(['landing']);
    expect(state?.sessions[0].focus).toBe(true);
    expect(ws.of('sentence').map((s) => s.text)).toContain('Landing está trabajando.');
  });

  it('remembers Solo mirar per page', async () => {
    const t = setup();
    const a = t.open();
    const b = t.open();
    a.say({ type: 'hello', v: 1, mode: 'global', readOnly: true });
    b.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(100);
    expect(a.of('state').at(-1)?.readOnly).toBe(true);
    expect(b.of('state').at(-1)?.readOnly).toBe(false);
    b.say({ type: 'read-only', on: true });
    await sleep(20);
    expect(b.of('state').at(-1)?.readOnly).toBe(true);
  });

  it('stops the brain and the source when nobody is left', async () => {
    const t = setup({ idleStopMs: 50 });
    const ws = t.open();
    ws.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(100);
    ws.close();
    await sleep(150);
    expect(t.service.started).toBe(false);
    expect(t.brains[0].shut).toBe(true);
  });

  it('replaces a scope nobody is on when another opens', async () => {
    const t = setup();
    const ws = t.open();
    ws.say({ type: 'hello', v: 1, mode: 'session', sessionId: 'a' });
    await sleep(80);
    ws.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(80);
    expect(t.brains).toHaveLength(2);
    expect(t.brains[0].shut).toBe(true);
    expect(t.service.status().conversations.map((c) => c.scope)).toEqual(['global']);
  });

  it('refuses another protocol version', async () => {
    const t = setup();
    const ws = t.open();
    ws.say({ type: 'hello', v: 99, mode: 'global' });
    await sleep(20);
    expect(ws.of('error')).toEqual([{ type: 'error', code: 'scope' }]);
    expect(t.service.started).toBe(false);
  });

  it('reports timings without any text', async () => {
    const t = setup();
    const ws = t.open();
    ws.say({ type: 'hello', v: 1, mode: 'global' });
    await sleep(100);
    ws.say({ type: 'text', text: '¿cómo va el login?' });
    await sleep(150);
    const status = t.service.status();
    expect(status.turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain('login?');
    expect(status.latency.firstSentenceMs.n).toBeGreaterThan(0);
  });
});

describe('splitPieces', () => {
  it('cuts the first piece at the first pause after two words', () => {
    expect(splitPieces('Login listo: tests en verde y todo subido.', true)).toEqual([
      'Login listo:',
      'tests en verde y todo subido.',
    ]);
    expect(splitPieces('Hecho.', true)).toEqual(['Hecho.']);
  });
});
