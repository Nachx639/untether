import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';

// Real unix socket in a throwaway control dir: `ut open` → api.sock → server handler.
describe('ut open over the API socket', () => {
  let server: import('./api-socket-server.js').ApiSocketServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vtp-sock-'));
    process.env.UNTETHER_CONTROL_DIR = dir;
    const { ApiSocketServer } = await import('./api-socket-server.js');
    server = new ApiSocketServer();
    server.setPreviewOpenHandler(({ sessionId, target }) =>
      sessionId === 's1' && target === '5173'
        ? { success: true, port: 5173, path: '/' }
        : { success: false, error: 'unknown session' }
    );
    await server.start();
  });

  afterAll(() => {
    server?.stop();
    if (dir) rmSync(dir, RM_TEST_DIR);
  });

  it('asks the server to open the preview of the current session', async () => {
    const { SocketApiClient } = await import('./socket-api-client.js');
    const client = new SocketApiClient();
    expect(await client.openPreview({ sessionId: 's1', target: '5173' })).toEqual({
      success: true,
      port: 5173,
      path: '/',
    });
    expect(await client.openPreview({ sessionId: 'nope', target: '5173' })).toEqual({
      success: false,
      error: 'unknown session',
    });
  });
});
