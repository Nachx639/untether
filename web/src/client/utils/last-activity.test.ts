import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import { lastActivityAt } from './last-activity.js';

const LAST_NIGHT = Date.parse('2026-10-03T23:03:00.000Z');
const REDRAWN = '2026-10-04T12:11:00.000Z';

const session = (over: Partial<Session> = {}) =>
  ({ startedAt: '2026-10-03T09:00:00.000Z', lastModified: REDRAWN, ...over }) as Session;

describe('lastActivityAt', () => {
  it('an idle or waiting Claude: when its status changed, not the screen redrawn since', () => {
    expect(lastActivityAt(session({ claudeStatus: { status: 'idle', since: LAST_NIGHT } }))).toBe(
      LAST_NIGHT
    );
    expect(
      lastActivityAt(session({ claudeStatus: { status: 'waiting', since: LAST_NIGHT } }))
    ).toBe(LAST_NIGHT);
  });

  it('a working Claude or another program: the last input or output', () => {
    expect(lastActivityAt(session({ claudeStatus: { status: 'busy', since: LAST_NIGHT } }))).toBe(
      Date.parse(REDRAWN)
    );
    expect(
      lastActivityAt(
        session({
          activityStatus: { isActive: false, lastActivityAt: '2026-10-04T12:12:00.000Z' },
        })
      )
    ).toBe(Date.parse('2026-10-04T12:12:00.000Z'));
    expect(lastActivityAt(session())).toBe(Date.parse(REDRAWN));
    expect(lastActivityAt(session({ lastModified: '' }))).toBe(
      Date.parse('2026-10-03T09:00:00.000Z')
    );
  });
});
