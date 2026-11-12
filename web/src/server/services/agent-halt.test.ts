import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAgentHalt, haltContinuePrompt, parseResumeAt } from './agent-halt.js';

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__/agent-halt', name), 'utf8');

/** 01-nov 00:53 local, when bakery's Codex tasks hit their limit. */
const NOW = new Date(2026, 10, 1, 0, 53).getTime();

describe('detectAgentHalt', () => {
  it("reads Codex's usage limit (bakery 0cbedf19, 2026-11-01) and when it resets", () => {
    const halt = detectAgentHalt(fixture('codex-usage-limit.txt'), NOW);
    expect(halt?.kind).toBe('usage-limit');
    expect(halt?.message).toMatch(/^You’ve hit your usage limit\. .* try again at 4:25 AM\.$/);
    expect(halt?.resumeAt).toBe(new Date(2026, 10, 1, 4, 25).getTime());
  });

  it('a tool output that merely starts with 402 is not a halt (review 2026-11-08)', () => {
    for (const text of [
      '402 src/server/app.ts',
      '402 files changed, 3 insertions(+)',
      // 2026-11-10: the bare 401 was still read as a lost login.
      '401 src/server/app.ts',
    ]) {
      expect(detectAgentHalt(`⏺ Bash(wc -l src/server/app.ts)\n  ⎿  ${text}`, NOW)).toBeNull();
    }
    expect(
      detectAgentHalt('⏺ Calling the model\n  ⎿  API Error: 402 Payment Required', NOW)?.kind
    ).toBe('usage-limit');
  });

  it('the limit of f3719fe5 as Codex printed it (2026-11-09): typographic apostrophe, "purchase more credits", a dated reset', () => {
    const now = new Date(2026, 10, 9, 22, 47).getTime();
    expect(detectAgentHalt(fixture('codex-usage-limit-fix-round.txt'), now)).toEqual({
      kind: 'usage-limit',
      message:
        'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 11th, 2026 6:48 PM.',
      resumeAt: new Date(2026, 10, 11, 18, 48).getTime(),
    });
  });
  it("reads an external provider's balance/quota error as a usage-limit halt (model-providers)", () => {
    for (const text of [
      'Insufficient balance to complete this request',
      'Payment required',
      'Quota exceeded for this account',
      'API Error: 402 {"error":{"message":"insufficient balance"}}',
    ]) {
      const halt = detectAgentHalt(`⏺ Calling the model\n  ⎿  ${text}`, NOW);
      expect(halt?.kind).toBe('usage-limit');
    }
  });

  it("reads an unknown model as a 'model' halt, so a provider task pauses, not done (2026-11-08)", () => {
    for (const text of [
      'Model "abliterated-model-large-flash" isn\'t recognized',
      "There's an issue with the selected model",
      'The selected model may not exist or you may not have access to it',
      'Model abliteration-x does not exist',
    ]) {
      const halt = detectAgentHalt(`⏺ Starting\n  ⎿  ${text}`, NOW);
      expect(halt?.kind, text).toBe('model');
    }
    // Its continue prompt names the model, not a usage limit or an API error.
    expect(haltContinuePrompt('model')).toMatch(/selected model/);
  });

  it("takes Codex's low-limit warnings for warnings, and a turn at work for work", () => {
    expect(detectAgentHalt(fixture('codex-heads-up.txt'), NOW)).toBeNull();
  });

  it('a limit the agent got past (its turn went on after it) is history', () => {
    expect(detectAgentHalt(fixture('codex-limit-then-worked.txt'), NOW)).toBeNull();
  });

  it('a turn the user interrupted is no halt', () => {
    expect(detectAgentHalt(fixture('codex-interrupted.txt'), NOW)).toBeNull();
  });

  it("reads Codex's stream errors as API errors, with no time", () => {
    const halt = detectAgentHalt(fixture('codex-stream-error.txt'), NOW);
    expect(halt).toMatchObject({ kind: 'api-error' });
    expect(halt?.message).toMatch(/^stream disconnected before completion/);
    expect(halt?.resumeAt).toBeUndefined();
  });

  it("reads Claude's API errors and lost logins (texts from real transcripts)", () => {
    expect(detectAgentHalt(fixture('claude-api-error.txt'), NOW)).toEqual({
      kind: 'api-error',
      message: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    });
    expect(detectAgentHalt(fixture('claude-auth.txt'), NOW)).toEqual({
      kind: 'auth',
      message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
  });

  it("reads Claude's usage limit with its time zone", () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    const halt = detectAgentHalt(fixture('claude-usage-limit.txt'), now);
    expect(halt?.kind).toBe('usage-limit');
    expect(halt?.message).toBe(
      "You've hit your session limit · resets 4:25am (Europe/Madrid) /upgrade to increase your usage limit."
    );
    // 04:25 in Madrid (CET, UTC+1) on Nov 1.
    expect(halt?.resumeAt).toBe(Date.parse('2026-11-01T03:25:00Z'));
  });

  it('an agent that finished, quoting such errors in its work, is not halted', () => {
    expect(detectAgentHalt(fixture('claude-finished.txt'), NOW)).toBeNull();
  });

  it("rows of the agent's own reply never count, whatever they start with (review of 2026-11-01)", () => {
    const reply = (rows: string[]) =>
      detectAgentHalt(['⏺ Done. What changed:', ...rows, '', '❯ ', '  Opus 5.5'].join('\n'), NOW);
    expect(reply(['  API error handling now retries on 529.'])).toBeNull();
    expect(reply(['  Rate limit headers are read from the response.'])).toBeNull();
    expect(reply(['  Overloaded servers get a backoff.'])).toBeNull();
    expect(reply(['  401 responses log the user out.'])).toBeNull();
    expect(detectAgentHalt('⏺ API Error: 529 handled\n\n❯ ', NOW)).toBeNull();
    expect(
      detectAgentHalt('• You’ve hit your usage limit is the message we now show.\n\n› Ask', NOW)
    ).toBeNull();
  });

  it('knows the other wordings of a limit, a login and an outage', () => {
    const one = (line: string) =>
      detectAgentHalt(`• Did things\n${line}\n\n› Ask Codex`, NOW)?.kind;
    expect(one('  ⎿  Claude usage limit reached. Your limit will reset at 5pm')).toBe(
      'usage-limit'
    );
    expect(one('  ⎿  Claude AI usage limit reached|1793520000')).toBe('usage-limit');
    expect(one("  ⎿  You've hit your weekly limit · resets Nov 6, 10am")).toBe('usage-limit');
    expect(one('  ⎿  Credit balance is too low')).toBe('usage-limit');
    expect(one('  ⎿  Invalid API key · Please run /login')).toBe('auth');
    expect(
      one('  ⎿  API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')
    ).toBe('auth');
    expect(
      one('■ unexpected status 401 Unauthorized: Your access token could not be refreshed')
    ).toBe('auth');
    expect(
      one(
        '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
      )
    ).toBe('api-error');
    expect(one('■ exceeded retry limit, last status: 429 Too Many Requests')).toBe('api-error');
    expect(
      one('■ We’re currently experiencing high demand, which may cause temporary errors.')
    ).toBe('api-error');
    // A refused prompt is about the work: going on would be refused again.
    expect(one("  ⎿  API Error: Opus 5.5's safeguards flagged this session")).toBeUndefined();
    // Text that merely mentions a limit, inside the agent's output.
    expect(one('    the usage limit reached state is handled in agent-halt.ts')).toBeUndefined();
  });
});

describe('parseResumeAt', () => {
  it('a time of day already past is tomorrow', () => {
    const now = new Date(2026, 10, 1, 5, 0).getTime();
    expect(parseResumeAt('try again at 4:25 AM.', now)).toBe(
      new Date(2026, 10, 2, 4, 25).getTime()
    );
  });

  it('reads dates, PM, relative times and epochs', () => {
    expect(parseResumeAt('try again at Nov 2nd, 2026 4:25 PM.', NOW)).toBe(
      new Date(2026, 10, 2, 16, 25).getTime()
    );
    expect(parseResumeAt('resets Nov 6, 10am', NOW)).toBe(new Date(2026, 10, 6, 10, 0).getTime());
    expect(parseResumeAt('resets in 2h 13m', NOW)).toBe(NOW + (2 * 60 + 13) * 60_000);
    expect(parseResumeAt('usage limit reached|1793520000', NOW)).toBe(1793520000 * 1000);
    expect(parseResumeAt('Your limit will reset at 5pm', NOW)).toBe(
      new Date(2026, 10, 1, 17, 0).getTime()
    );
  });

  it('no time said: undefined', () => {
    expect(parseResumeAt("You've hit your usage limit. Upgrade to Pro", NOW)).toBeUndefined();
    expect(parseResumeAt('resets soon', NOW)).toBeUndefined();
  });
});

describe('haltContinuePrompt', () => {
  it('tells the agent to go on where it stopped and to finish with ut task done', () => {
    expect(haltContinuePrompt('usage-limit')).toMatch(
      /usage limit.*Continue the task.*ut task done/
    );
  });
});
