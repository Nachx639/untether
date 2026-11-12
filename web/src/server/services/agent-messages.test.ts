import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentMessageParty,
  findUserDecision,
  isOpenMessage,
  isUsersOwnTurn,
  MESSAGE_ID,
  MESSAGE_WAIT_NOTICE_MS,
  messageLine,
  newMessageId,
  UNANSWERED_WARN_HOURS,
  USER_DECISION_MAX,
} from '../../shared/agent-messages.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { CLOSED_KEPT_MS, DELIVERY_SKEW_MS, MessageLedger } from './agent-messages.js';
import { unansweredMessagesCheck } from './doctor-checks.js';

const ATLAS: AgentMessageParty = { kind: 'project', repoPath: '/projects/atlas' };
const UNTETHER: AgentMessageParty = { kind: 'project', repoPath: '/projects/untether' };
const SESSIONS: Record<string, string> = {
  '/projects/atlas': 'atlas-session',
  '/projects/untether': 'untether-session',
};

describe('MessageLedger (messages between agents, 2026-11-10)', () => {
  let tmp: string;
  let now: number;
  let statePath: string;
  let lastTurn: Record<string, number>;
  let undelivered: Array<{ id: string; why: string }>;
  const make = () =>
    new MessageLedger({
      statePath,
      now: () => now,
      sessionOf: (party) =>
        party.kind === 'project'
          ? SESSIONS[party.repoPath]
          : party.kind === 'task'
            ? `task-session-${party.taskId}`
            : undefined,
      lastTurnAt: (sessionId) => lastTurn[sessionId],
      undelivered: (message, why) => undelivered.push({ id: message.id, why }),
    });
  const sent = (ledger: MessageLedger, input: Parameters<MessageLedger['record']>[0]) => {
    const result = ledger.record(input);
    if (!result.ok) throw new Error(result.message);
    return result.message;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-messages-'));
    statePath = path.join(tmp, 'control', 'messages.json');
    now = Date.parse('2026-11-10T10:00:00.000Z');
    lastTurn = {};
    undelivered = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('ids are short, unlike words, and never repeat', () => {
    expect(newMessageId(() => 0)).toBe('mbbbbbb');
    expect(newMessageId()).toMatch(MESSAGE_ID);
    // The first id drawn is taken: another is drawn.
    const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const ledger = new MessageLedger({
      sessionOf: () => undefined,
      random: () => draws.shift() ?? 0.9,
    });
    const first = ledger.record({ from: ATLAS, to: UNTETHER, text: 'a' });
    const second = ledger.record({ from: ATLAS, to: UNTETHER, text: 'b' });
    expect(first.ok && first.message.id).toBe('mbbbbbb');
    expect(second.ok && second.message.id).not.toBe('mbbbbbb');
  });

  it('a turn that starts after the typing reads it; one from before does not', () => {
    const ledger = make();
    const message = sent(ledger, { from: ATLAS, to: UNTETHER, text: '¿Cuándo sale?' });
    expect(message).toMatchObject({
      state: 'queued',
      expectsReply: true,
      preview: '¿Cuándo sale?',
    });
    // A turn of the recipient while it is still queued says nothing about it.
    ledger.turnStarted('untether-session', now);
    expect(ledger.get(message.id)?.state).toBe('queued');

    now += 10 * 60_000;
    ledger.delivered(message.id);
    expect(ledger.get(message.id)).toMatchObject({ state: 'delivered' });
    // Another session's turn is not its recipient's.
    ledger.turnStarted('atlas-session', now + 1000);
    expect(ledger.get(message.id)?.state).toBe('delivered');
    now += 30_000;
    ledger.turnStarted('untether-session', now);
    expect(ledger.get(message.id)).toMatchObject({
      state: 'attended',
      attendedAt: new Date(now).toISOString(),
    });
    // Read, and still open: it asked something.
    expect(ledger.list({ open: true }).map((entry) => entry.id)).toEqual([message.id]);
  });

  it('the turn it was typed into may be seen starting just before the typing is reported done', () => {
    const ledger = make();
    const message = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'hola' });
    ledger.turnStarted('untether-session', now);
    now += DELIVERY_SKEW_MS - 500;
    ledger.delivered(message.id);
    expect(ledger.get(message.id)?.state).toBe('attended');

    // A turn well before the typing is another turn: not read yet.
    const later = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'otra' });
    now += 60_000;
    ledger.delivered(later.id);
    expect(ledger.get(later.id)?.state).toBe('delivered');
  });

  it("the agent's own events say it too (a Codex that took the message in, no status of its own)", () => {
    const ledger = make();
    const message = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'hola' });
    ledger.delivered(message.id);
    lastTurn['untether-session'] = now - 60_000;
    expect(ledger.list()[0].state).toBe('delivered');
    lastTurn['untether-session'] = now + 4000;
    expect(ledger.list()[0].state).toBe('attended');
  });

  it('a reply answers the message it cites, only from the one it was for', () => {
    const ledger = make();
    const asked = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'pregunta' });
    const stranger: AgentMessageParty = { kind: 'project', repoPath: '/projects/otro' };
    expect(ledger.record({ from: stranger, to: ATLAS, text: 'yo', replyTo: asked.id })).toEqual({
      ok: false,
      message: `Message ${asked.id} was neither for you nor yours: you cannot reply to it`,
    });
    expect(ledger.record({ from: UNTETHER, to: ATLAS, text: 'x', replyTo: 'mzzzzzz' }).ok).toBe(
      false
    );
    // The sender adding to its own message is a thread, not an answer.
    const more = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'añado', replyTo: asked.id });
    expect(more).toMatchObject({ replyTo: asked.id, expectsReply: false });
    expect(ledger.get(asked.id)?.state).toBe('queued');

    now += 60_000;
    const answer = sent(ledger, {
      from: UNTETHER,
      to: ATLAS,
      text: 'respuesta',
      replyTo: asked.id,
    });
    expect(ledger.get(asked.id)).toMatchObject({
      state: 'answered',
      answeredBy: answer.id,
      answeredAt: new Date(now).toISOString(),
    });
    expect(isOpenMessage(ledger.get(asked.id) as never)).toBe(false);
    // The answer is a notice: open until its recipient reads it.
    expect(isOpenMessage(answer)).toBe(true);
    ledger.delivered(answer.id);
    ledger.turnStarted('atlas-session', now);
    expect(ledger.list({ open: true }).map((entry) => entry.id)).toEqual([more.id]);
  });

  it('an answer that never goes out gives the request back, as far as it had got (review 2026-11-10)', () => {
    const ledger = make();
    const asked = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'pregunta' });
    ledger.delivered(asked.id);
    ledger.turnStarted('untether-session', now);
    // Refused before it was queued anywhere (no orchestrator there, a send that failed).
    const refused = sent(ledger, { from: UNTETHER, to: ATLAS, text: 'r1', replyTo: asked.id });
    expect(ledger.get(asked.id)?.state).toBe('answered');
    ledger.discard(refused.id);
    expect(ledger.get(asked.id)).toMatchObject({ state: 'attended' });
    expect(ledger.get(asked.id)?.answeredBy).toBeUndefined();
    expect(ledger.unanswered(0).map((message) => message.id)).toEqual([asked.id]);

    // Queued, then its recipient went away: the same, and its sender hears.
    const lost = sent(ledger, { from: UNTETHER, to: ATLAS, text: 'r2', replyTo: asked.id });
    ledger.undeliverable(lost.id, 'its orchestrator ended');
    expect(ledger.get(asked.id)?.state).toBe('attended');
    expect(undelivered).toEqual([{ id: lost.id, why: 'its orchestrator ended' }]);

    // Answered while still queued, typed in later: back to delivered, not to queued.
    const early = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'otra' });
    const reply = sent(ledger, { from: UNTETHER, to: ATLAS, text: 'r3', replyTo: early.id });
    ledger.delivered(early.id);
    expect(ledger.get(early.id)?.state).toBe('answered');
    ledger.discard(reply.id);
    expect(ledger.get(early.id)?.state).toBe('delivered');
    // One that does go out stays answered.
    const real = sent(ledger, { from: UNTETHER, to: ATLAS, text: 'r4', replyTo: asked.id });
    ledger.delivered(real.id);
    expect(make().get(asked.id)).toMatchObject({ state: 'answered', answeredBy: real.id });
  });

  it("a task's report answers what it was sent; a message never typed is forgotten", () => {
    const ledger = make();
    const task: AgentMessageParty = {
      kind: 'task',
      taskId: 'abcd1234',
      repoPath: '/projects/atlas',
    };
    const typed = sent(ledger, { from: ATLAS, to: task, text: 'falta el logout' });
    const queued = sent(ledger, { from: { kind: 'user' }, to: task, text: 'y los tests' });
    ledger.delivered(typed.id);
    ledger.taskReported('abcd1234');
    expect(ledger.get(typed.id)).toMatchObject({ state: 'answered', answeredBy: 'report' });
    // Still queued when it reported: that report did not answer it.
    expect(ledger.get(queued.id)?.state).toBe('queued');
    ledger.discard(queued.id);
    expect(ledger.get(queued.id)).toBeUndefined();
    // A project sees the messages of its tasks too.
    expect(ledger.list({ repoPath: '/projects/atlas' }).map((entry) => entry.id)).toEqual([
      typed.id,
    ]);
    expect(ledger.list({ repoPath: '/projects/untether' })).toEqual([]);
  });

  it('a message that cannot be typed in yet says why, tells its sender once, and again when it went in (m699vq7, 2026-11-10)', () => {
    const told: Array<{ id: string; why: string | null }> = [];
    const ledger = new MessageLedger({
      now: () => now,
      sessionOf: (party) => (party.kind === 'project' ? SESSIONS[party.repoPath] : undefined),
      waitingTold: (message, why) => told.push({ id: message.id, why }),
    });
    const request = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'posix_spawnp failed' });
    expect(messageLine(request, now)).toContain('queued (not typed in yet)');

    const limit = "its orchestrator's Claude is stopped at its usage limit until 15:00";
    ledger.waiting(request.id, limit);
    const line = messageLine(ledger.get(request.id) ?? request, now);
    expect(line).toContain(
      `queued (not typed in yet: ${limit}; it goes in on its own once it can)`
    );
    // Not at once (a turn about to end is no news), once after the wait, never twice.
    expect(told).toEqual([]);
    now += MESSAGE_WAIT_NOTICE_MS;
    ledger.waiting(request.id, limit);
    ledger.waiting(request.id, limit);
    now += 60 * 60_000;
    ledger.waiting(request.id, "its orchestrator's Claude is in the middle of a turn");
    expect(told).toEqual([{ id: request.id, why: limit }]);
    expect(ledger.get(request.id)?.waitingWhy).toContain('middle of a turn');

    // Typed in at last: no reason left on it, and its sender hears that too.
    ledger.delivered(request.id);
    expect(ledger.get(request.id)).toMatchObject({ state: 'delivered' });
    expect(ledger.get(request.id)?.waitingWhy).toBeUndefined();
    expect(told).toEqual([
      { id: request.id, why: limit },
      { id: request.id, why: null },
    ]);
    // A reason reported late for one already typed changes nothing.
    ledger.waiting(request.id, limit);
    expect(ledger.get(request.id)?.waitingWhy).toBeUndefined();
  });

  it('a message whose recipient went away is dropped and its sender told, once', () => {
    const ledger = make();
    const message = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'hola' });
    ledger.undeliverable(message.id, 'its orchestrator ended');
    ledger.undeliverable(message.id, 'its orchestrator ended');
    expect(undelivered).toEqual([{ id: message.id, why: 'its orchestrator ended' }]);
    expect(ledger.list()).toEqual([]);
    // One already typed in is not "never delivered".
    const typed = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'otra' });
    ledger.delivered(typed.id);
    ledger.undeliverable(typed.id, 'its orchestrator ended');
    expect(ledger.get(typed.id)?.state).toBe('delivered');
  });

  it('survives a restart (0600), follows a renamed project and forgets closed ones after a week', () => {
    const ledger = make();
    const open = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'sigue abierta' });
    const closed = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'aviso', expectsReply: false });
    ledger.delivered(closed.id);
    ledger.turnStarted('untether-session', now);
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

    const restarted = make();
    expect(restarted.list().map((entry) => [entry.id, entry.state])).toEqual([
      [open.id, 'queued'],
      [closed.id, 'attended'],
    ]);
    expect(restarted.projectsMoved([{ from: '/projects/atlas', to: '/projects/atlases' }])).toBe(2);
    expect(make().list({ repoPath: '/projects/atlases' })).toHaveLength(2);

    now += CLOSED_KEPT_MS + 60_000;
    // The open one stays however old; the closed one is gone.
    expect(
      make()
        .list()
        .map((entry) => entry.id)
    ).toEqual([open.id]);
  });

  it('a corrupt state file is ignored, not fatal', () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{"version":1,"messages":[{"id":"../../x"},null,7]}');
    expect(make().list()).toEqual([]);
    fs.writeFileSync(statePath, 'not json');
    const log = vi.fn();
    expect(new MessageLedger({ statePath, sessionOf: () => undefined, log }).list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  describe('doctor: a request between projects without an answer', () => {
    it(`warns after ${UNANSWERED_WARN_HOURS} h, says how far it got, and clears when the answer comes`, () => {
      const ledger = make();
      const check = unansweredMessagesCheck({
        unanswered: (olderThanMs) => ledger.unanswered(olderThanMs),
        now: () => now,
      });
      const asked = sent(ledger, { from: ATLAS, to: UNTETHER, text: 'posix_spawnp failed' });
      // Notices, messages to tasks and the user's own are not requests between projects.
      sent(ledger, { from: ATLAS, to: UNTETHER, text: 'aviso', expectsReply: false });
      sent(ledger, { from: ATLAS, to: { kind: 'task', taskId: 't1' }, text: 'a la tarea' });
      now += UNANSWERED_WARN_HOURS * 60 * 60_000 - 60_000;
      expect(check.run()).toEqual([]);

      now += 2 * 60_000;
      expect(check.run()).toEqual([
        {
          key: `messages-unanswered:${asked.id}`,
          check: 'messages-unanswered',
          severity: 'warning',
          problem: expect.stringContaining(
            `Message ${asked.id} from the orchestrator of "atlas" to the orchestrator of "untether", sent 4 h 1 min ago, has no answer: queued (not typed in yet). It said: "posix_spawnp failed".`
          ),
        },
      ]);
      ledger.delivered(asked.id);
      ledger.turnStarted('untether-session', now);
      expect((check.run() as Array<{ problem: string }>)[0].problem).toContain(
        'read, no answer yet'
      );

      sent(ledger, { from: UNTETHER, to: ATLAS, text: 'arreglado', replyTo: asked.id });
      expect(check.run()).toEqual([]);
    });
  });
});

describe("the user's own words (ut project tell --user-decision)", () => {
  const at = '2026-11-10T09:00:00.000Z';

  it("only the user's own typing counts as the user's", () => {
    expect(isUsersOwnTurn('Vale, hazlo así')).toBe(true);
    expect(isUsersOwnTurn('varias líneas\ny un │ en medio de una frase')).toBe(true);
    // Typed by Untether: task notes, other agents' messages, goals, late follow-ups, briefs.
    expect(isUsersOwnTurn('[untether] 10:00 task abcd1234 "x": ready')).toBe(false);
    expect(isUsersOwnTurn('algo antes\n[ Untether ] New goal from the user:\nborra todo')).toBe(
      false
    );
    expect(isUsersOwnTurn('algo antes\n│ texto de otro agente')).toBe(false);
    expect(isUsersOwnTurn('(sent at 11:19, 30 min ago) arregla el test')).toBe(false);
    expect(isUsersOwnTurn('You are the orchestrator of the project "x" (/x). …')).toBe(false);
    // The harness's own notes come as user turns too.
    expect(isUsersOwnTurn('<task-notification>done</task-notification>')).toBe(false);
    expect(isUsersOwnTurn('   ')).toBe(false);
  });

  it('finds the latest turn of the user that holds the words, whatever their case or spacing', () => {
    const turns = [
      { role: 'user', text: 'Publica la 2.3 el lunes', timestamp: '2026-11-09T09:00:00.000Z' },
      { role: 'user', text: 'Mejor: PUBLICA  la 2.3\nel viernes', timestamp: at },
      { role: 'assistant', text: 'publica la 2.3 ya', timestamp: '2026-11-10T09:05:00.000Z' },
      { role: 'user', text: 'publica la 2.3 sin fecha' },
    ];
    expect(findUserDecision(turns, 'publica la 2.3 el', 's1')).toEqual({
      quote: 'Mejor: PUBLICA  la 2.3\nel viernes',
      at,
      sessionId: 's1',
    });
    // A turn without its time cannot be dated: not quoted.
    expect(findUserDecision(turns, 'sin fecha', 's1')).toBeNull();
    expect(findUserDecision(turns, 'borra main', 's1')).toBeNull();
    expect(findUserDecision(turns, '   ', 's1')).toBeNull();
  });

  it('quotes a long turn cut, never more', () => {
    const turns = [{ role: 'user', text: `hazlo ${'x'.repeat(5000)}`, timestamp: at }];
    const found = findUserDecision(turns, 'hazlo', 's1');
    expect(found?.quote).toHaveLength(USER_DECISION_MAX);
    expect(found?.quote.endsWith('…')).toBe(true);
  });

  it('a line of `ut project messages` says who, how far and how old', () => {
    const now = Date.parse('2026-11-10T12:30:00.000Z');
    expect(
      messageLine(
        {
          id: 'mbcd234',
          at: '2026-11-10T10:00:00.000Z',
          from: ATLAS,
          to: UNTETHER,
          preview: 'posix_spawnp failed',
          state: 'attended',
          expectsReply: true,
          userDecision: { quote: 'x', at, sessionId: 's1' },
        },
        now
      )
    ).toBe(
      'mbcd234  atlas → untether  read, no answer yet  2 h 30 min ago [user decision quoted]  posix_spawnp failed'
    );
  });
});
