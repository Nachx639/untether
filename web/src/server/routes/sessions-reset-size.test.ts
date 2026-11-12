// User report (2026-10-14): swiping between sessions on a phone reset each session left to
// its Mac window's size and the phone took it back on return; with a second client on the
// session the two fought over the size. Only the page owning the size gives it back
// (pty/size-owner.ts, tested in size-owner.test.ts).
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createSessionRoutes } from './sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe('POST /sessions/:id/reset-size', () => {
  type Handler = (req: Request, res: Response) => Promise<void>;

  function setup(viewed: boolean) {
    const resetSessionSize = vi.fn(() => ({ reset: false, reason: 'viewed-elsewhere' as const }));
    const isSessionViewed = vi.fn((_id: string, _except?: string | null) => viewed);
    const ptyManager = {
      getSession: vi.fn(() => ({ id: 'fwd_1', status: 'running' })),
      resetSessionSize,
    };
    const router = createSessionRoutes({
      ptyManager: ptyManager as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
      isSessionViewed,
    }) as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    };
    const layer = router.stack.find(
      (l) => l.route?.path === '/sessions/:sessionId/reset-size' && l.route.methods.post
    );
    if (!layer?.route) throw new Error('no reset-size route');
    const handle = layer.route.stack[0].handle;
    const call = async (body: unknown) => {
      const json = vi.fn();
      const res = { json, status: vi.fn(() => res) } as unknown as Response;
      await handle({ params: { sessionId: 'fwd_1' }, body } as unknown as Request, res);
      return json.mock.calls[0]?.[0];
    };
    return { resetSessionSize, isSessionViewed, call };
  }

  it('passes the leaving page and whether another page views the session', async () => {
    const { resetSessionSize, isSessionViewed, call } = setup(true);
    const result = await call({ clientId: 'page-1' });
    expect(isSessionViewed).toHaveBeenCalledWith('fwd_1', 'page-1');
    expect(resetSessionSize).toHaveBeenCalledWith('fwd_1', {
      clientId: 'page-1',
      viewedElsewhere: true,
    });
    expect(result).toEqual({ success: true, reset: false, reason: 'viewed-elsewhere' });
  });

  it('resets unconditionally for a native app that names no page', async () => {
    const { resetSessionSize, call } = setup(true);
    await call({});
    expect(resetSessionSize).toHaveBeenCalledWith('fwd_1', undefined);
  });
});
