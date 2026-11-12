import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeSessionInit,
  FakeSource,
  fakeActions,
  fakeBrain,
  fakeSession,
  nextTurn,
} from '../../../test/helpers/copilot-fakes';
import type { ClaudeChatMessage } from '../claude-chat';
import { Brain } from './brain';
import { Copilot, classifyUtterance, type TurnRecord } from './copilot';
import { Observer } from './observer';
import { ScopedObserver } from './scoped-observer';
import type { AccessAnswer, MenuChoices } from './session-access';

const home = os.homedir();
const LOGIN = path.join(home, 'Projects', 'login');
const LANDING = path.join(home, 'Projects', 'landing');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const READ_MENU: MenuChoices = {
  question: 'Do you want to proceed?',
  options: ['Yes', 'No'],
  detail: ['Read file', 'src/app.ts'],
  key: 'k-read',
};
const PUSH_MENU: MenuChoices = {
  question: 'Do you want to proceed?',
  options: ['Yes', "Yes, and don't ask again", 'No'],
  detail: ['Bash command', 'git push --force origin main'],
  key: 'k-push',
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Setup {
  script?: (content: string) => string | null;
  readonly?: boolean;
  scope?: string;
  answers?: Partial<Record<'input' | 'answer' | 'reply', AccessAnswer>>;
  brainDelayMs?: number;
}

function setup(opts: Setup = {}) {
  const source = new FakeSource();
  let chat: ClaudeChatMessage[] = [];
  const observer = new Observer(
    source.asSource(),
    { chat: async () => ({ available: true, messages: chat }) },
    { doneDebounceMs: 30 }
  );
  observer.start();
  const view = opts.scope ? new ScopedObserver(observer, opts.scope) : observer;
  const forbidden = () => {
    throw new Error('the model was called');
  };
  const fb = fakeBrain(opts.script ?? forbidden, opts.brainDelayMs);
  const menus = new Map<string, MenuChoices | null>();
  const fa = fakeActions(menus, opts.answers);
  const cp = new Copilot(view, fa.access, {
    brain: fb.brain,
    readonly: opts.readonly ?? false,
    mergeWindowMs: 60,
    holdAfterMs: 60_000,
    holdAfterClipMs: 60_000,
  });
  cleanups.push(() => {
    cp.shutdown();
    observer.stop();
  });
  const state = new Map<string, FakeSessionInit>([
    ['a', { id: 'a', workingDir: LOGIN, claude: 'idle', since: 1 }],
    ['b', { id: 'b', workingDir: LANDING, claude: 'idle', since: 1 }],
  ]);
  const look = (changes: Partial<Record<'a' | 'b', Partial<FakeSessionInit>>> = {}) => {
    for (const [id, c] of Object.entries(changes)) {
      state.set(id, { ...(state.get(id) as FakeSessionInit), ...c });
      if (c?.choices) menus.set(id, c.choices);
      else if (c?.claude && c.claude !== 'waiting') menus.set(id, null);
    }
    source.push([...state.values()].map(fakeSession));
  };
  look();
  const say = async (text: string) => {
    const turn = nextTurn(cp, (r) => r.origin === 'user');
    cp.userSaid(text, Date.now(), { source: 'p1' });
    return turn;
  };
  /** Login goes from working to this menu; resolves once the announcement is spoken. */
  const menu = async (id: 'a' | 'b', choices: MenuChoices) => {
    look({ [id]: { claude: 'busy', since: 2 } });
    const turn = nextTurn(cp, (r) => r.origin === 'event');
    look({ [id]: { claude: 'waiting', since: 3, choices } });
    return turn;
  };
  return {
    cp,
    fb,
    fa,
    look,
    say,
    menu,
    setChat: (c: ClaudeChatMessage[]) => {
      chat = c;
    },
  };
}

const speech = (r: TurnRecord) => r.speech.join(' ');

describe('copilot turns (no model)', () => {
  it('answers a benign menu with option 1 on a bare «sí» (scenario 3)', async () => {
    const t = setup();
    const announced = await t.menu('a', READ_MENU);
    expect(speech(announced)).toMatch(/Login quiere leer/);
    const r = await t.say('sí');
    expect(r.fastPath).toBe('yes');
    const answers = t.fa.acted().filter((c) => c.kind === 'answer');
    expect(answers).toEqual([
      {
        kind: 'answer',
        sessionId: 'a',
        body: {
          option: 1,
          question: READ_MENU.question,
          options: READ_MENU.options,
          key: 'k-read',
        },
      },
    ]);
    expect(t.fb.calls).toEqual([]);
  });

  it('holds a risky menu until «confirmo», then answers once (scenario 4)', async () => {
    const t = setup();
    const announced = await t.menu('a', PUSH_MENU);
    expect(speech(announced)).toMatch(/confirmo/i);
    const yes = await t.say('sí');
    expect(t.fa.acted()).toEqual([]);
    expect(yes.actions[0]?.outcome).toBe('held');
    expect(speech(yes)).toMatch(/confirmo/i);
    const ok = await t.say('confirmo');
    expect(ok.fastPath).toBe('confirm');
    const answers = t.fa.acted().filter((c) => c.kind === 'answer');
    expect(answers).toHaveLength(1);
    // Never «don't ask again».
    expect((answers[0].body as { option: number }).option).toBe(1);
    // One «confirmo» = one action.
    const again = await t.say('confirmo');
    expect(again.fastPath).toBe('confirm-none');
    expect(t.fa.acted().filter((c) => c.kind === 'answer')).toHaveLength(1);
  });

  it('asks again when «confirmo» comes after 60 s (scenario 4)', async () => {
    const t = setup();
    await t.menu('a', PUSH_MENU);
    await t.say('sí');
    t.cp.ageConfirmations(65_000);
    const late = await t.say('confirmo');
    expect(late.fastPath).toBe('confirm-expired');
    expect(speech(late)).toMatch(/Ha pasado un rato/);
    expect(t.fa.acted()).toEqual([]);
  });

  it('stops a working session with one Esc on «para» (scenario 8)', async () => {
    const t = setup();
    t.look({ a: { claude: 'busy', since: 2 } });
    const r = await t.say('para');
    expect(r.fastPath).toBe('stop');
    expect(t.fa.acted()).toEqual([{ kind: 'input', sessionId: 'a', body: { key: 'escape' } }]);
    expect(speech(r)).toBe('Parado.');
  });

  it('never sends Esc into an open menu (scenario 8)', async () => {
    const t = setup();
    await t.menu('a', READ_MENU);
    const r = await t.say('para el login');
    expect(t.fa.acted()).toEqual([]);
    expect(r.actions[0]?.outcome).toBe('blocked');
  });

  it('«¿Le digo que no?» + «no» leaves it waiting in one turn that ends (2026-11-11)', async () => {
    const t = setup();
    await t.menu('a', READ_MENU);
    await t.say('para el login');
    const started: TurnRecord[] = [];
    const ended: TurnRecord[] = [];
    t.cp.on('turn-start', (r: TurnRecord) => started.push(r));
    t.cp.on('turn-end', (r: TurnRecord) => ended.push(r));
    const r = await t.say('no');
    expect(r.fastPath).toBe('no-to-reject');
    expect(t.fa.acted()).toEqual([]);
    // One turn, started and ended: a second one was started first and never ended.
    expect(started).toHaveLength(1);
    expect(started[0]).toBe(r);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toBe(r);
  });

  it('drops false triggers before any turn (scenario 10)', () => {
    const t = setup();
    expect(t.cp.userSaid('Gracias por ver el vídeo')).toBe(false);
    expect(t.cp.userSaid('eh')).toBe(false);
    expect(t.fb.calls).toEqual([]);
  });

  it('asks which one when two menus are open and the user says «sí» (scenario 25)', async () => {
    const t = setup();
    await t.menu('a', READ_MENU);
    await t.menu('b', { ...READ_MENU, key: 'k-read-b' });
    const r = await t.say('sí');
    expect(r.fastPath).toBe('which');
    expect(speech(r)).toMatch(/¿Login o landing\?/);
    expect(t.fa.acted()).toEqual([]);
  });

  it('says the menu is gone on a 409 (scenario 14)', async () => {
    const t = setup({
      answers: { answer: { status: 409, body: { error: 'The prompt changed' } } },
    });
    await t.menu('a', READ_MENU);
    const r = await t.say('sí');
    expect(speech(r)).toBe('Ya no está esa pregunta.');
  });

  it('gives fast paths no interjection', async () => {
    const t = setup();
    const clips: unknown[] = [];
    t.cp.on('interject', (c) => clips.push(c));
    t.look({ a: { claude: 'busy', since: 2 } });
    await t.say('para');
    expect(clips).toEqual([]);
    expect(classifyUtterance('sí')).toBe('none');
    expect(classifyUtterance('borra la carpeta dist de la landing')).toBe('risky');
    expect(classifyUtterance('¿cómo va el login?')).toBe('question');
  });
});

describe('copilot turns (scripted model)', () => {
  it('never answers a risky menu without «confirmo», whatever the model writes', async () => {
    const t = setup({ script: () => '@answer s1 1\nHecho.\n' });
    await t.menu('a', PUSH_MENU);
    const r = await t.say('oye dile al login que adelante con lo que pide');
    expect(t.fb.calls.length).toBe(1);
    expect(t.fa.acted().filter((c) => c.kind === 'answer')).toEqual([]);
    expect(r.actions[0]?.outcome).toBe('held');
    expect(speech(r)).toMatch(/confirmo/i);
  });

  it('passes a rambling order on as text and Enter, no Esc (scenario 9)', async () => {
    const t = setup({ script: () => '@send s1 Pasa los tests de usuarios.\nHecho: los tests.\n' });
    const r = await t.say('pues oye mira dile al login que pase los tests de usuarios que tal');
    expect(t.fa.acted()).toEqual([
      { kind: 'input', sessionId: 'a', body: { text: 'Pasa los tests de usuarios.' } },
      { kind: 'input', sessionId: 'a', body: { key: 'enter' } },
    ]);
    expect(r.actions[0]?.outcome).toBe('done');
  });

  it('sends nothing for a read-only page (scenario 18)', async () => {
    const t = setup({ readonly: true, script: () => '@send s1 Pasa los tests.\nHecho.\n' });
    const r = await t.say('dile al login que pase los tests');
    expect(t.fa.acted()).toEqual([]);
    expect(r.actions[0]?.outcome).toBe('readonly');
    expect(speech(r)).toMatch(/solo miro/);
  });

  it('routes a digit typed into a risky menu through the gate (scenario 19)', async () => {
    const t = setup({ script: () => '@send s1 1\nHecho.\n' });
    await t.menu('a', PUSH_MENU);
    const r = await t.say('dile al login que elija la uno');
    expect(t.fa.acted()).toEqual([]);
    expect(r.actions[0]?.outcome).toBe('held');
  });

  it('merges two sessions finishing together into one turn (scenario 12)', async () => {
    const t = setup({ script: () => '@none\nLogin y landing listos: todo en verde.\n' });
    t.setChat([
      { id: '1', role: 'user', text: 'haz los tests' },
      { id: '2', role: 'assistant', text: 'He pasado todos los tests y están en verde ahora.' },
    ]);
    t.look({ a: { claude: 'busy', since: 2 }, b: { claude: 'busy', since: 2 } });
    const turn = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ a: { claude: 'idle', since: 3 }, b: { claude: 'idle', since: 3 } });
    const r = await turn;
    expect(r.input).toMatch(/done:login/);
    expect(r.input).toMatch(/done:landing/);
    expect(t.fb.calls.length).toBe(1);
  });

  it('cuts the turn on barge-in (scenario 13)', async () => {
    const t = setup({ script: () => '@none\nLogin sigue con los tests.\n', brainDelayMs: 300 });
    const turn = nextTurn(t.cp, (r) => r.origin === 'user');
    t.cp.userSaid('¿qué tal va el login ahora mismo?', Date.now(), { source: 'p1' });
    await sleep(20);
    t.cp.bargeIn();
    const r = await turn;
    expect(r.cancelled).toBe(true);
    expect(r.speech).toEqual([]);
  });

  it('says it cannot answer when the model cannot run (no token)', async () => {
    const source = new FakeSource();
    const observer = new Observer(source.asSource(), {
      chat: async () => ({ available: false, messages: [] }),
    });
    observer.start();
    const brain = new Brain('x', {
      tokenFile: path.join(os.tmpdir(), 'no-such-copilot-token'),
      claudeBin: '/bin/echo',
    });
    const fa = fakeActions();
    const cp = new Copilot(observer, fa.access, { brain, readonly: false });
    cleanups.push(() => {
      cp.shutdown();
      observer.stop();
    });
    expect(await brain.warm()).toBe(false);
    expect(brain.problem).toBe('no-token');
    const turn = nextTurn(cp, (r) => r.origin === 'user');
    cp.userSaid('¿qué está haciendo la sesión?');
    const r = await turn;
    expect(speech(r)).toMatch(/no puedo contestar/);
  });
});

describe('copilot session mode', () => {
  it('talks about its session only, and refuses orders to another', async () => {
    const t = setup({ scope: 'a', script: () => '@send s2 Cambia el título.\nHecho.\n' });
    const r = await t.say('cambia también el título de la otra');
    expect(t.fb.calls[0]).toMatch(/MODO SESIÓN/);
    expect(t.fb.calls[0]).not.toMatch(/«landing»/);
    expect(t.fb.calls[0]).toMatch(/«login»/);
    // The others exist: the model is told so, and never to say they don't.
    expect(t.fb.calls[0]).toMatch(/otras sesiones \(landing\)/);
    expect(t.fa.acted()).toEqual([]);
    expect(r.actions[0]?.outcome).not.toBe('done');
  });

  it('says another named session is handled from the home screen, no model, no clip', async () => {
    const t = setup({ scope: 'a' });
    const clips: string[] = [];
    t.cp.on('clip', (c: { id: string }) => clips.push(c.id));
    const r = await t.say('dile a landing que pare');
    expect(r.fastPath).toBe('other-session');
    expect(speech(r)).toBe(
      'Desde aquí solo llevo login. Para landing, abre Conversar desde el inicio.'
    );
    expect(t.fa.acted()).toEqual([]);
    expect(clips).toEqual([]);
    const q = await t.say('¿qué hace landing?');
    expect(q.fastPath).toBe('other-session');
  });

  it('says another session failing, even right after a «te necesita» line', async () => {
    const t = setup({ scope: 'a' });
    t.look({ b: { claude: 'busy', since: 2 } });
    const first = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ b: { claude: 'waiting', since: 3, choices: READ_MENU } });
    expect(speech(await first)).toBe('Por cierto, landing te necesita.');
    // The one-a-minute rule delays the next line; here the minute is nearly over.
    (t.cp as unknown as { lastAsideAt: number }).lastAsideAt = Date.now() - 59_700;
    const second = nextTurn(t.cp, (r) => r.origin === 'event');
    t.setChat([
      { id: '1', role: 'user', text: 'pasa los tests' },
      { id: 't', role: 'tool', tool: 'Bash', text: 'npm test', isError: true, result: 'FAIL' },
      { id: '2', role: 'assistant', text: 'Los tests han fallado.' },
    ]);
    t.look({ b: { claude: 'busy', since: 4 } });
    t.look({ b: { claude: 'idle', since: 5 } });
    expect(speech(await second)).toBe('Por cierto, landing ha fallado.');
    // A second failure later is its own news, not muted by the first one's key.
    (t.cp as unknown as { lastAsideAt: number }).lastAsideAt = 0;
    const third = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ b: { claude: 'busy', since: 6 } });
    t.look({ b: { claude: 'idle', since: 7 } });
    expect(speech(await third)).toBe('Por cierto, landing ha fallado.');
  });

  it('greets with its session only', () => {
    const t = setup({ scope: 'a' });
    expect(t.cp.greetText()).toBe('Login listo.');
    t.look({ a: { claude: 'busy', since: 2 } });
    expect(t.cp.greetText()).toBe('Login está trabajando.');
  });

  it('says one short line when another session needs the user, no model', async () => {
    const t = setup({ scope: 'a', script: () => '@answer s2 1\nVale.\n' });
    t.look({ b: { claude: 'busy', since: 2 } });
    const turn = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ b: { claude: 'waiting', since: 3, choices: READ_MENU } });
    const r = await turn;
    expect(speech(r)).toBe('Por cierto, landing te necesita.');
    expect(t.fb.calls).toEqual([]);
    // A bare «sí» does not answer the other session's menu, even if the model tries.
    await t.say('sí');
    expect(t.fa.acted().filter((c) => c.kind === 'answer')).toEqual([]);
  });

  it('still announces and answers its own session', async () => {
    const t = setup({ scope: 'a' });
    const announced = await t.menu('a', READ_MENU);
    expect(speech(announced)).toMatch(/Login quiere leer/);
    await t.say('sí');
    expect(t.fa.acted().filter((c) => c.kind === 'answer')).toHaveLength(1);
  });

  it('global mode sees every session', async () => {
    const t = setup({ script: () => '@none\nLogin y landing listos.\n' });
    await t.say('¿cómo va todo por aquí?');
    expect(t.fb.calls[0]).toMatch(/«login»/);
    expect(t.fb.calls[0]).toMatch(/«landing»/);
    expect(t.fb.calls[0]).not.toMatch(/MODO SESIÓN/);
  });

  it('announces nothing about a muted session', async () => {
    const t = setup();
    t.look({ a: { claude: 'busy', since: 2, muted: true } });
    let spoke = false;
    t.cp.on('turn-start', () => {
      spoke = true;
    });
    t.look({ a: { claude: 'waiting', since: 3, choices: READ_MENU, muted: true } });
    await sleep(100);
    expect(spoke).toBe(false);
  });
});

describe('copilot gate races (review 2026-10-13)', () => {
  const NODETAIL: MenuChoices = {
    question: 'Do you want to proceed?',
    options: ['Yes', "Yes, and don't ask again", 'No'],
    key: 'k-nodetail',
  };
  const CODEX: MenuChoices = { question: 'Allow command?', options: ['Yes', 'No'], key: 'k-codex' };
  const RM_MENU: MenuChoices = {
    ...PUSH_MENU,
    detail: ['Bash command', 'rm -rf ~/Documents'],
    key: 'k-rm',
  };
  const answers = (t: ReturnType<typeof setup>) =>
    t.fa.acted().filter((c) => c.kind === 'answer' || c.kind === 'input' || c.kind === 'reply');

  for (const [label, m] of [
    ['a permission menu with no detail', NODETAIL],
    ['a Codex menu', CODEX],
  ] as const) {
    it(`a bare «sí» does not approve ${label} (command unseen)`, async () => {
      const t = setup();
      const announced = await t.menu('a', m);
      expect(speech(announced)).toMatch(/Di confirmo/);
      await t.say('sí');
      expect(answers(t)).toEqual([]);
      await t.say('confirmo');
      expect(answers(t)).toHaveLength(1);
    });
  }

  for (const u of [
    'Confirmo. No, espera, no lo hagas.',
    'confirmo, pero no',
    'Sí, confirmo, aunque mejor no lo subas',
  ]) {
    it(`«${u}» runs nothing`, async () => {
      const t = setup({ script: () => '@none\nVale.\n' });
      await t.menu('a', PUSH_MENU);
      await t.say('sí');
      const r = await t.say(u);
      await sleep(100);
      expect(answers(t)).toEqual([]);
      expect(speech(r)).not.toMatch(/Forzando/);
    });
  }

  it('«confirmo, pero …» keeps the hold and asks for a bare «confirmo»', async () => {
    const t = setup();
    await t.menu('a', PUSH_MENU);
    await t.say('sí');
    const r = await t.say('confirmo, pero avísame luego');
    expect(r.fastPath).toBe('confirm-hedged');
    expect(answers(t)).toEqual([]);
    await t.say('confirmo');
    expect(answers(t)).toHaveLength(1);
  });

  it('a «confirmo» begun before the menu changed does not approve the new menu', async () => {
    const t = setup();
    await t.menu('a', PUSH_MENU);
    await t.say('sí');
    const startedAt = Date.now();
    const ev = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ a: { claude: 'waiting', since: 4, choices: RM_MENU } });
    await ev;
    const turn = nextTurn(t.cp, (r) => r.origin === 'user');
    // Audio of «confirmo»: began before the new menu was said, arrives (transcribed) after it.
    t.cp.userSaid('confirmo', Date.now(), { source: 'p1', startedAt });
    const r = await turn;
    expect(answers(t)).toEqual([]);
    expect(speech(r)).toMatch(/Ha cambiado/);
    // Said again after hearing it: now it runs.
    await sleep(450);
    const again = nextTurn(t.cp, (x) => x.origin === 'user');
    t.cp.userSaid('confirmo', Date.now(), { source: 'p1', startedAt: Date.now() - 10 });
    await again;
    expect(answers(t)).toHaveLength(1);
  });

  it('a «sí» begun before a new harmless menu was said does not answer it', async () => {
    const t = setup({ script: () => '@answer s1 1\nHecho.\n' });
    await t.menu('a', READ_MENU);
    const startedAt = Date.now() - 1000;
    const NEXT: MenuChoices = { ...READ_MENU, detail: ['Read file', 'src/b.ts'], key: 'k-read2' };
    const ev = nextTurn(t.cp, (r) => r.origin === 'event');
    t.look({ a: { claude: 'busy', since: 4 } });
    t.look({ a: { claude: 'waiting', since: 5, choices: NEXT } });
    await ev;
    const turn = nextTurn(t.cp, (r) => r.origin === 'user');
    t.cp.userSaid('dile al login que sí', Date.now(), { source: 'p1', startedAt });
    await turn;
    expect(answers(t)).toEqual([]);
  });

  it('«para, para, vale ya» after cutting in is «be quiet», no order', async () => {
    const t = setup();
    await t.menu('b', READ_MENU);
    t.cp.bargeIn();
    const r = await t.say('Para, para, vale ya');
    expect(r.fastPath).toBe('hush');
    expect(speech(r)).toBe('Vale.');
    expect(t.fa.acted()).toEqual([]);
    const c = await t.say('cállate');
    expect(c.fastPath).toBe('hush');
  });

  it('plays no error sound for a failure it will not say (just stopped)', async () => {
    const t = setup();
    const earcons: string[] = [];
    t.cp.on('earcon', (k: string) => earcons.push(k));
    t.look({ a: { claude: 'busy', since: 2 } });
    await sleep(20);
    (t.cp as unknown as { stoppedAt: Map<string, number> }).stoppedAt.set('s1', Date.now());
    t.setChat([
      { id: '1', role: 'user', text: 'pasa los tests' },
      { id: 't', role: 'tool', tool: 'Bash', text: 'npm test', isError: true, result: 'FAIL' },
      { id: '2', role: 'assistant', text: 'Han fallado.' },
    ]);
    t.look({ a: { claude: 'idle', since: 3 } });
    await sleep(200);
    expect(earcons).not.toContain('error');
  });
});
