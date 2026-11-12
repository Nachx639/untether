/** Run with: pnpm exec tsx src/test/preview-isolation.browser.ts */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from '@playwright/test';
import { createPreviewProxy, previewAppOrigin } from '../server/services/preview-proxy.js';
import { createPreviewServer } from '../server/services/preview-server.js';

async function verifyBrowserIsolation() {
  const servers: http.Server[] = [];
  const listen = async (server: http.Server) => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  let privateRequests = 0;
  const upstream = (name: string) =>
    http.createServer((req, res) => {
      if (req.url?.startsWith('/private')) privateRequests++;
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<html><head></head><body>${name}<script>localStorage.setItem('app', '${name}')</script></body></html>`
      );
    });
  // Launch independently: the general Playwright suite disables browser web security.
  const browser = await chromium.launch({ headless: true });
  try {
    const firstPort = await listen(upstream('first-app'));
    const secondPort = await listen(upstream('second-app'));
    let mainPort = 0;
    let previewPort = 0;
    const proxy = createPreviewProxy({ getOwnPorts: () => [mainPort, previewPort] });
    previewPort = await listen(createPreviewServer(proxy));
    const firstOrigin = previewAppOrigin(`http://localhost:${previewPort}`, firstPort) as string;
    const secondOrigin = previewAppOrigin(`http://localhost:${previewPort}`, secondPort) as string;
    mainPort = await listen(
      http.createServer((_req, res) => {
        const parentOrigin = `http://localhost:${mainPort}`;
        const frame = (port: number, origin: string, name: string) => {
          const query = new URLSearchParams({
            ticket: proxy.issueTicket(port, parentOrigin, origin),
            next: `/preview/${port}/`,
          });
          return `<iframe name="${name}" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" src="${origin}/__ut_preview_login?${query}"></iframe>`;
        };
        res.setHeader('Content-Type', 'text/html');
        res.end(frame(firstPort, firstOrigin, 'first') + frame(secondPort, secondOrigin, 'second'));
      })
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://localhost:${mainPort}`);
    await page.frameLocator('[name=first]').getByText('first-app', { exact: true }).waitFor();
    await page.frameLocator('[name=second]').getByText('second-app', { exact: true }).waitFor();
    const first = page.frame('first');
    const second = page.frame('second');
    assert(first && second);
    assert.equal(await first.evaluate(() => localStorage.getItem('app')), 'first-app');
    assert.equal(await second.evaluate(() => localStorage.getItem('app')), 'second-app');
    const cookies = (await context.cookies()).filter((cookie) =>
      cookie.name.startsWith('ut_preview_')
    );
    assert.equal(new Set(cookies.map((cookie) => cookie.domain)).size, 2);

    // The attack's unscoped popup: no preview service worker can intercept these fetches.
    const popupPromise = context.waitForEvent('page');
    await first.evaluate(() => window.open('about:blank'));
    const popup = await popupPromise;
    const result = await popup.evaluate(
      async ({ secondOrigin, secondPort }) => {
        const sameHost = await fetch(`/preview/${secondPort}/private`, { credentials: 'include' });
        let readable = false;
        try {
          await fetch(`${secondOrigin}/preview/${secondPort}/private`, { credentials: 'include' });
          readable = true;
        } catch {
          /* Cross-origin response must not be readable. */
        }
        await fetch(`${secondOrigin}/preview/${secondPort}/private`, {
          method: 'POST',
          mode: 'no-cors',
          credentials: 'include',
          body: 'change',
        });
        return { sameHostStatus: sameHost.status, readable, storage: localStorage.getItem('app') };
      },
      { secondOrigin, secondPort }
    );
    assert.deepEqual(result, { sameHostStatus: 401, readable: false, storage: 'first-app' });
    assert.equal(privateRequests, 0);
    await context.close();
    console.log(
      'Preview browser isolation: 2 apps loaded; storage and cookies isolated; popup reads and writes blocked'
    );
  } finally {
    await browser.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

void verifyBrowserIsolation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
