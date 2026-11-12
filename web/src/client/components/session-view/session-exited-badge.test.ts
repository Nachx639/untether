/**
 * @vitest-environment happy-dom
 */
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { SessionExitedBadge } from './session-exited-badge.js';
import './session-exited-badge.js';

const resumeButton = (element: HTMLElement) =>
  [...element.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Resume Claude conversation')
  );

describe('SessionExitedBadge', () => {
  it('offers to resume the Claude conversation of an exited session', async () => {
    const resume = vi.fn();
    const element = await fixture<SessionExitedBadge>(html`
      <session-exited-badge
        .session=${
          {
            id: 's',
            status: 'exited',
            claudeSessionId: 'c1',
            claudeResumable: true,
          } as unknown as Session
        }
        @resume-claude=${resume}
      ></session-exited-badge>
    `);

    expect(element.textContent).toContain('Session exited');
    // The tap that ended the session (approving a task merge) lands on the button: ignored.
    resumeButton(element)?.click();
    expect(resume).not.toHaveBeenCalled();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1500);
    resumeButton(element)?.click();
    vi.restoreAllMocks();

    expect(resume).toHaveBeenCalledOnce();
  });

  // 2026-11-10: an ended Codex session had no way back to its conversation.
  it('offers to resume the Codex thread of an exited session, when it can be', async () => {
    const codex = (codexResumable: boolean | undefined) =>
      fixture<SessionExitedBadge>(html`
        <session-exited-badge
          .session=${
            {
              id: 's',
              status: 'exited',
              codexThreadId: '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28',
              codexResumable,
            } as unknown as Session
          }
        ></session-exited-badge>
      `);
    const button = (element: HTMLElement) =>
      [...element.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Resume Codex conversation')
      );
    const element = await codex(true);
    const resume = vi.fn();
    element.addEventListener('resume-claude', resume);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1500);
    button(element)?.click();
    vi.restoreAllMocks();
    expect(resume).toHaveBeenCalledOnce();
    expect(resumeButton(element)).toBeUndefined();
    expect(button(await codex(false))).toBeUndefined();
    expect(button(await codex(undefined))).toBeUndefined();
  });

  it('has no resume button when the conversation cannot be resumed', async () => {
    const element = await fixture<SessionExitedBadge>(html`
      <session-exited-badge
        .session=${
          {
            id: 's',
            status: 'exited',
            claudeSessionId: 'c1',
            claudeResumable: false,
          } as unknown as Session
        }
      ></session-exited-badge>
    `);

    expect(element.textContent).toContain('Session exited');
    expect(resumeButton(element)).toBeUndefined();
  });

  it('has no resume button while resumability is unknown (as Reopen decides)', async () => {
    const element = await fixture<SessionExitedBadge>(html`
      <session-exited-badge
        .session=${{ id: 's', status: 'exited', claudeSessionId: 'c1' } as unknown as Session}
      ></session-exited-badge>
    `);

    expect(resumeButton(element)).toBeUndefined();
  });

  it('shows nothing while the session runs', async () => {
    const element = await fixture<SessionExitedBadge>(html`
      <session-exited-badge
        .session=${{ id: 's', status: 'running', claudeSessionId: 'c1' } as unknown as Session}
      ></session-exited-badge>
    `);

    expect(element.textContent?.trim()).toBe('');
  });
});
