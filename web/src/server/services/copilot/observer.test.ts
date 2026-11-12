import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeSessionInit, FakeSource, fakeSession } from '../../../test/helpers/copilot-fakes';
import type { ClaudeChatMessage } from '../claude-chat';
import { type CopilotEvent, Observer } from './observer';

const dir = path.join(os.homedir(), 'Projects', 'login');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let chat: ClaudeChatMessage[] = [];
const observers: Observer[] = [];

function setup(opts: { stuckMs?: number } = {}) {
  const source = new FakeSource();
  const observer = new Observer(
    source.asSource(),
    { chat: async () => ({ available: true, messages: chat }) },
    { doneDebounceMs: 40, stuckMs: opts.stuckMs }
  );
  observer.start();
  observers.push(observer);
  const events: CopilotEvent[] = [];
  observer.on('event', (e: CopilotEvent) => events.push(e));
  const look = (init: Partial<FakeSessionInit>) =>
    source.push([fakeSession({ id: 'a', workingDir: dir, ...init })]);
  return { source, observer, events, look };
}

const answer = (text: string, extra: ClaudeChatMessage[] = []): ClaudeChatMessage[] => [
  { id: '1', role: 'user', text: 'pasa los tests' },
  ...extra,
  { id: '2', role: 'assistant', text },
];

afterEach(() => {
  for (const o of observers.splice(0)) o.stop();
  chat = [];
});

describe('copilot observer', () => {
  it('starts the source only when started, and names sessions with the naming rule', () => {
    const source = new FakeSource();
    const observer = new Observer(source.asSource(), {
      chat: async () => ({ available: false, messages: [] }),
    });
    expect(source.started).toBe(false);
    observer.start();
    expect(source.started).toBe(true);
    source.push([
      fakeSession({
        id: 'a',
        workingDir: path.join(os.homedir(), 'Projects'),
        claude: 'idle',
        title: 'Videos del curso de ecografía',
      }),
    ]);
    expect(observer.list()[0].name).toBe('ecografía');
    observer.stop();
    expect(source.started).toBe(false);
  });

  it('says done once busy→idle holds', async () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    chat = answer('Tests en verde, todo listo para revisar.');
    look({ claude: 'idle', since: 2 });
    await sleep(120);
    expect(events.map((e) => e.kind)).toEqual(['done']);
    expect(events[0].summary).toContain('Tests en verde');
  });

  it('says nothing when it goes back to busy within the debounce', async () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    look({ claude: 'idle', since: 2 });
    look({ claude: 'busy', since: 3 });
    await sleep(700);
    expect(events).toEqual([]);
  });

  it('says failed when a tool of the turn failed', async () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    chat = answer('He intentado ejecutar los tests pero no han ido bien al final.', [
      { id: 't', role: 'tool', tool: 'Bash', text: 'npm test', isError: true, result: 'FAIL' },
    ]);
    look({ claude: 'idle', since: 2 });
    await sleep(120);
    expect(events.map((e) => e.kind)).toEqual(['failed']);
  });

  it('waits up to 600 ms for a readable menu, and says it again once it shows', async () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    look({ claude: 'waiting', since: 2 });
    expect(events).toEqual([]);
    await sleep(650);
    look({ claude: 'waiting', since: 2 });
    expect(events.map((e) => e.kind)).toEqual(['needs_you']);
    expect(events[0].summary).toContain('sin menú');
    const menu = { question: 'Do you want to proceed?', options: ['Yes', 'No'], key: 'k1' };
    look({ claude: 'waiting', since: 2, choices: menu });
    expect(events.map((e) => e.kind)).toEqual(['needs_you', 'needs_you']);
    expect(events[1].key).toBe('k1');
  });

  it('announces a different menu right after another', () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    look({
      claude: 'waiting',
      since: 2,
      choices: { question: 'Run npm test?', options: ['Yes', 'No'], key: 'k1' },
    });
    look({
      claude: 'waiting',
      since: 3,
      choices: { question: 'Run git status?', options: ['Yes', 'No'], key: 'k2' },
    });
    expect(events.map((e) => [e.kind, e.key])).toEqual([
      ['needs_you', 'k1'],
      ['needs_you', 'k2'],
    ]);
  });

  it('says replied when only background work keeps it busy', async () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1 });
    look({ claude: 'busy', since: 1, background: true });
    await sleep(20);
    expect(events.map((e) => e.kind)).toEqual(['replied_bg']);
  });

  it('says exited when the session ends', () => {
    const { events, look } = setup();
    look({ claude: 'idle' });
    look({ status: 'exited' });
    expect(events.map((e) => e.kind)).toEqual(['exited']);
  });

  it('says stuck when one tool runs too long', () => {
    const { events, source } = setup({ stuckMs: 100 });
    const busy = (since: number) => {
      const s = fakeSession({ id: 'a', workingDir: dir, claude: 'busy', since: 1 });
      if (s.claudeStatus) s.claudeStatus.activity = { kind: 'tool', tool: 'Bash', since };
      return s;
    };
    source.push([busy(Date.now())]);
    source.push([busy(Date.now() - 5000)]);
    source.push([busy(Date.now() - 5000)]);
    expect(events.map((e) => e.kind)).toEqual(['stuck']);
  });

  it('catches a whole turn that happened between two looks', async () => {
    const { events, look } = setup();
    chat = answer('Primera respuesta completa con varias palabras.');
    look({ claude: 'idle', since: 1 });
    await sleep(20);
    const observer = observers[0];
    await observer.refreshDigest(observer.list()[0]);
    chat = answer('Segunda respuesta, también terminada del todo.');
    look({ claude: 'idle', since: 5 });
    await sleep(150);
    expect(events.map((e) => e.kind)).toEqual(['done']);
  });

  it('carries the muted flag on its events', () => {
    const { events, look } = setup();
    look({ claude: 'busy', since: 1, muted: true });
    look({
      claude: 'waiting',
      since: 2,
      muted: true,
      choices: { question: 'Proceed?', options: ['Yes', 'No'], key: 'k' },
    });
    expect(events[0].muted).toBe(true);
  });

  it('asks the source for fast looks after an action', () => {
    const { source, observer } = setup();
    observer.hurry(2000);
    expect(source.refreshes).toBe(1);
  });
});
