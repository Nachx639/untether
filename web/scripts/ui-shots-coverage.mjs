// Optional, exhaustive visual inventory. Runs only through ui-shots and its disposable twin.
// Real navigation where possible; rare transient states use the real component's public API
// with labelled fictitious data. Never ship this bridge in the client bundle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sections = ['general', 'appearance', 'terminal', 'notifications', 'sessions', 'thisMac', 'advanced'];
const scenarios = [
  ...sections.map(section => `settings-${section}`),
  'login', 'palette', 'quick-keys', 'session-attach', 'session-prompts', 'session-files', 'session-copy', 'session-changes',
  'agents', 'agents-select', 'agents-empty', 'session-chat', 'session-menu', 'session-width',
  'session-switcher', 'session-preview', 'task-log', 'task-question', 'task-countdown',
  'home-menu', 'preview-menu', 'preview', 'preview-down', 'new-project', 'project-settings',
  'task-compose', 'scheduled', 'confirm', 'answer', 'toasts', 'whats-new', 'pieces', 'empty',
  'session-share', 'session-keys', 'session-mac-picker', 'session-copilot', 'session-worktrees',
  'needs-expanded', 'quick-start', 'session-away',
  'logs', 'task-confirm', 'git-init', 'orchestrator',
];
export const coverageViews = Object.fromEntries(scenarios.flatMap(scenario => [
  [`coverage-${scenario}-mobile`, { viewport: { width: 390, height: 844 }, phone: true }],
  [`coverage-${scenario}-desktop`, { viewport: { width: 1440, height: 900 }, phone: false }],
]));
let bridge;
async function installBridge(page, assets) {
  const frozen = assets && path.join(assets, '__ui-coverage.mjs');
  if (frozen && fs.existsSync(frozen)) bridge = fs.readFileSync(frozen, 'utf8');
  if (!bridge) {
    const { build } = await import('esbuild');
    const result = await build({
      stdin: { contents: `
        export { toast } from './src/client/utils/action-toast.ts';
        export { openAnswerSheet } from './src/client/components/answer-sheet.ts';
        export { openWhatsNew } from './src/client/components/whats-new-sheet.ts';
        export { setLocale } from './src/client/i18n/index.ts';
      `, resolveDir: webDir, loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    });
    bridge = result.outputFiles[0].text;
  }
  await page.route('**/__ui-coverage.mjs', route => route.fulfill({ contentType: 'text/javascript', body: bridge }));
  await page.evaluate(async () => {
    window.uiCoverage = await import('/__ui-coverage.mjs');
    await window.uiCoverage.setLocale('es');
  });
}

async function mount(page, tag, options) {
  await page.waitForFunction(tag => customElements.get(tag), tag);
  await page.evaluate(async ({ tag, options }) => {
    await customElements.whenDefined(tag);
    const element = document.createElement(tag);
    element.options = options;
    document.body.append(element);
    await element.updateComplete;
  }, { tag, options });
}

export async function openCoverageView(page, url, name, rich, askHeader, assets) {
  const scenario = name.replace(/^coverage-/, '').replace(/-(mobile|desktop)$/, '');
  const phone = name.endsWith('-mobile');
  const now = new Date(rich.now).toISOString();
  let projectRepo;
  if (['project-settings', 'orchestrator'].includes(scenario)) {
    // rich.projects contains display folder names, not absolute repository paths.
    const sessions = await page.request.get(`${url}/api/sessions`).then(response => response.json());
    projectRepo = sessions.find(session => session.id === rich.sessionForDesktop)?.gitMainRepoPath;
    if (!projectRepo) throw new Error('The twin session has no project repository');
  }
  if (scenario === 'task-countdown') {
    await page.route('**/api/tasks', async route => {
      // A poll still in flight when the view closes has its response disposed under us
      // (2026-11-10: "apiResponse.json: Response has been disposed" ended a whole coverage run):
      // that request no longer matters, so it is dropped instead of thrown.
      let body;
      let response;
      try {
        response = await route.fetch();
        body = await response.json();
      } catch {
        await route.abort().catch(() => {});
        return;
      }
      const task = body.tasks.find(task => task.state === 'ready');
      if (!task) throw new Error('No ready task');
      task.autoMergeAt = new Date(rich.now + 300000).toISOString();
      await route.fulfill({ response, json: body }).catch(() => {});
    });
  }
  if (scenario === 'task-log') {
    await page.route('**/api/tasks/*/log?**', route => route.fulfill({ json: { text: 'pnpm test\n✓ 124 comprobaciones correctas\n✗ 2 comprobaciones fallidas\nMigración: falta el índice de reservas\nRegistro ficticio del gemelo' } }));
  }
  if (scenario === 'task-confirm') {
    await page.route('**/api/confirmations', route => route.fulfill({ json: { confirmations: [{
      id: 'coverage-confirm', kind: 'discard', where: 'Migrar la base de datos',
      summary: 'Discard the task worktree', detail: ['Se descartarán los cambios de esta tarea.'],
      createdAt: now, expiresAt: new Date(new Date(rich.now).getTime() + 3600000).toISOString(),
      requestedBy: { name: 'Claude' },
    }] } }));
  }
  if (scenario.includes('preview')) {
    // The inventory checks viewer chrome, not preview authentication. Serve the twin's
    // real fictitious page behind a deterministic ticket; never request an external site.
    const content = await page.request.get(`http://127.0.0.1:${rich.previewPort}`).then(response => response.text());
    await page.route('**/api/preview/config', route => route.fulfill({ json: { enabled: true, port: rich.previewPort, origin: url } }));
    await page.route('**/__ui-preview.html', route => route.fulfill({ contentType: 'text/html', body: content }));
    await page.route('**/api/preview/ticket', route => route.fulfill({ json: { loginOrigin: url, loginPath: '/__ui-preview.html' } }));
  }
  if (scenario.startsWith('settings-')) {
    // This Mac is conditional on server support. The fixture exposes its real controls on
    // the twin without enabling collection or reading sessions from the user's computer.
    await page.route('**/api/config', async route => {
      // Same guard as the tasks route above: a request cut by the view closing is dropped.
      try {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), macSessionsSupported: true } });
      } catch {
        await route.abort().catch(() => {});
      }
    });
  }
  if (scenario === 'session-away') {
    // «Mientras no estabas»: the card needs an absence and activity since. Both are fictitious:
    // this browser last saw the session 45 minutes ago, and the summary is a fixture.
    const seen = { [rich.sessionForDesktop]: { seen: Date.parse(now) - 45 * 60_000 } };
    await page.addInitScript(value => localStorage.setItem('ut-away-seen', value), JSON.stringify(seen));
    await page.route('**/api/sessions/*/away-summary?**', route => route.fulfill({ json: {
      available: true, agent: 'claude', lastActivityAt: now, toolCalls: 10, messages: 3, status: 'waiting',
      files: [{ path: 'src/reservas/calendario.ts', edits: 3 }, { path: 'src/reservas/calendario.test.ts', edits: 1 }],
      commands: [{ command: 'pnpm test calendario', exitCode: 0 }, { command: 'pnpm run check', isError: true, exitCode: 1 }],
      errors: [{ tool: 'Bash', target: 'pnpm run check', text: 'Fallo ficticio de ejemplo' }],
      lastMessage: 'He terminado el calendario de reservas; falta tu visto bueno.',
    } }));
  }
  if (scenario.startsWith('session-')) {
    await page.goto(`${url}/session/${rich.sessionForDesktop}`);
    await page.getByTestId('session-header-bar').first().waitFor({ state: 'visible' });
    if (['session-chat', 'session-attach', 'session-prompts', 'session-mac-picker'].includes(scenario)) {
      await page.getByTestId(phone ? 'chat-mode-toggle-button-compact' : 'chat-mode-toggle-button').first().click();
      await page.locator('claude-chat-view, terminal-chat-view').first().waitFor({ state: 'visible' });
      if (scenario === 'session-mac-picker') {
        await page.route('**/api/fs/browse?**', route => route.fulfill({ json: {
          fullPath: '/projects/faro', files: [
            { name: 'propuesta.md', path: '/projects/faro/propuesta.md', type: 'file', size: 2400, modified: now },
            { name: 'diseno', path: '/projects/faro/diseno', type: 'directory', modified: now },
          ],
        } }));
        await page.evaluate(async () => {
          const el = document.createElement('mac-file-picker');
          document.body.append(el);
          await el.updateComplete;
          await el.show();
        });
        await page.locator('mac-file-picker dialog[open]').waitFor();
      } else if (scenario === 'session-attach') {
        await page.locator('terminal-chat-view .attach-button').first().click();
        await page.locator('terminal-chat-view .plus-sheet[open], terminal-chat-view .attach-popover[open]').first().waitFor();
      } else if (scenario === 'session-prompts') {
        await page.locator('terminal-chat-view').first().evaluate(el => el.openPromptEditor());
        await page.locator('terminal-chat-view .prompt-editor[open]').waitFor();
      }
    } else if (scenario === 'session-away') {
      await page.locator('away-summary-card [data-testid="away-card"]').waitFor({ state: 'visible' });
    } else if (scenario === 'session-copilot') {
      // Render the idle sheet without starting microphone, audio, or a provider connection.
      await mount(page, 'copilot-sheet', {});
      await page.locator('copilot-sheet .frame').waitFor();
    } else if (scenario === 'session-worktrees') {
      await page.evaluate(async () => {
        const el = document.createElement('worktree-manager');
        el.repoPath = '/projects/faro';
        el.showCreateWorktree = true;
        document.querySelector('session-view').replaceChildren(el);
        await el.updateComplete;
      });
      await page.locator('worktree-manager input').first().waitFor();
    } else if (scenario === 'session-keys') {
      await page.evaluate(async () => {
        const el = document.createElement('terminal-quick-keys');
        el.visible = true;
        document.body.append(el);
        await el.updateComplete;
      });
      await page.locator('terminal-quick-keys .qk-key').first().waitFor();
    } else if (scenario === 'session-files') {
      await page.locator('session-view').evaluate(el => el.fileOperationsManager.openFileBrowser());
      await page.getByTestId('file-browser').waitFor();
    } else if (scenario === 'session-copy') {
      await page.locator('session-view').evaluate(el => el.handleSelectText());
      await page.locator('.ut-copy-mode').waitFor();
    } else if (scenario === 'session-preview') {
      await page.evaluate(sessionId => document.querySelector('untether-app').showPreview(sessionId, 4110), rich.sessionForDesktop);
      await page.getByTestId('preview-panel').waitFor({ state: 'visible' });
      await page.frameLocator('[data-testid="preview-panel"] iframe').getByText('Vista previa ficticia').waitFor();
    } else if (scenario === 'session-switcher') {
      if (phone) {
        await page.getByTestId('session-title-container').click();
        await page.locator('.psr-sheet.open').waitFor({ state: 'visible' });
      } // Desktop already displays the sidebar switcher.
    } else {
      await page.locator('compact-menu [data-menu-button]').first().click();
      await page.locator('#compact-menu-panel').first().waitFor({ state: 'visible' });
      if (scenario === 'session-share') {
        await page.getByTestId('compact-share-session').click();
        await page.locator('.ut-share-row').first().waitFor();
      } else if (scenario === 'session-changes') {
        await page.getByTestId('compact-changes').click();
        await page.locator('.ut-chg').waitFor();
      } else if (scenario === 'session-width') {
        if (phone) {
          await page.getByTestId('compact-menu-cancel').click();
          await page.locator('session-view').evaluate(el => el.uiStateManager.setShowWidthSelector(true));
        } else await page.getByTestId('compact-width-settings').click();
        await page.locator('.width-selector-container').waitFor({ state: 'visible' });
      }
    }
    return;
  }
  await page.goto(`${url}/`);
  await page.getByText(rich.sessionTitles[0]).first().waitFor({ state: 'visible' });
  if (scenario === 'logs') {
    await page.route('**/api/logs/info', route => route.fulfill({ json: { sizeHuman: '2 KB' } }));
    await page.route('**/api/logs/raw', route => route.fulfill({ contentType: 'text/plain', body: `${now} LOG [server] Gemelo preparado\n${now} WARN [CLIENT:preview] Vista previa no disponible\n${now} ERROR [task] Comprobación de ejemplo fallida` }));
    await page.goto(`${url}/logs.html`);
    await page.locator('log-viewer .log-container').waitFor();
    if (!assets) await page.waitForFunction(() => !document.documentElement.dataset.look || document.querySelector('#ut-look-' + document.documentElement.dataset.look)?.sheet);
  } else if (scenario === 'task-confirm') {
    // The task-board stream may replace its pending list; open the real sheet with the
    // deterministic GET fixture above, without submitting any confirmation.
    await page.locator('session-list').evaluate(el => el.openConfirmation('coverage-confirm'));
    await page.getByTestId('task-confirm-sheet').waitFor();
  } else if (scenario === 'git-init') {
    await page.route('**/api/projects/git-init/preview', route => route.fulfill({ json: {
      folder: '/projects/faro', files: 12, size: 48000, capped: false, hasGitignore: false,
      ignore: [{ pattern: 'node_modules/', matches: 1 }], flagged: [],
    } }));
    await page.route('**/api/projects/git-init/review', route => route.fulfill({ json: { status: 'unavailable', verdicts: [] } }));
    await mount(page, 'git-init-sheet', { folder: rich.projects[0], name: 'Faro · reservas' });
    await page.getByTestId('git-init-sheet').waitFor();
  } else if (scenario === 'orchestrator') {
    await mount(page, 'orchestrator-sheet', { repoPath: projectRepo, name: 'Faro · reservas' });
    await page.getByTestId('orchestrator-sheet').waitFor();
  } else if (scenario === 'needs-expanded') {
    await page.getByTestId('needs-you-more').click();
  } else if (scenario === 'quick-start') {
    // The editor comes in the create form's chunk, fetched in idle time: wait for it like mount()
    // does (2026-11-11: in Playful 3D the scenario ran first and the editor came up with no rows).
    await page.waitForFunction(() => customElements.get('quick-start-editor'));
    await page.evaluate(async () => {
      const el = document.createElement('quick-start-editor');
      el.commands = [{ name: 'Pruebas', command: 'pnpm test' }, { name: 'Desarrollo', command: 'pnpm dev' }];
      el.editing = true;
      // This standalone desktop specimen needs the same gutter as the real list.
      const content = document.createElement('div');
      content.className = 'ut-list-content';
      content.append(el);
      document.querySelector('session-list').replaceChildren(content);
      await el.updateComplete;
    });
    await page.locator('quick-start-editor input').first().waitFor();
  } else if (scenario === 'login') {
    await page.route('**/api/auth/config', route => route.fulfill({json:{enableSSHKeys:true,disallowUserPassword:false,noAuth:false,passwordAuthMode:'configured'}}));
    await page.evaluate(async () => {
      const el = document.createElement('auth-login');
      el.authClient = { getCurrentSystemUser: async () => '' };
      document.querySelector('untether-app').replaceChildren(el);
      await el.updateComplete;
    });
    await page.locator('#system-password').waitFor();
  } else if (scenario === 'palette') {
    await askHeader(page, 'open-palette');
    await page.locator('.ut-palette').waitFor();
  } else if (scenario === 'quick-keys') {
    await askHeader(page, 'open-settings');
    await page.getByTestId('settings-nav-terminal').click();
    if (phone) await page.getByTestId('settings-quick-keys').click();
    else await page.locator('ut-settings').evaluate(async el => { el.showQuickKeysEditor = true; await el.updateComplete; });
    await page.locator('quick-keys-editor [role="dialog"]').waitFor();
    if (assets) {
      // v2 put this editor behind the phone settings sheet. Expose its original paint for
      // comparison; the current app fixes the layer itself and must pass the hit test below.
      await page.locator('quick-keys-editor > div').evaluate(el => { el.style.zIndex = '2100'; });
    }
    await page.locator('quick-keys-editor [role="dialog"]').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 30);
      if (!el.contains(top)) throw new Error('Quick keys editor is covered by another sheet');
    });
  } else if (scenario.startsWith('settings-')) {
    await askHeader(page, 'open-settings');
    await page.getByTestId('settings-sheet').waitFor({ state: 'visible' });
    // Capability discovery inserts This Mac above Advanced. Wait for the fixture's row,
    // then activate the intended control by keyboard so a late layout shift cannot hit its neighbour.
    await page.getByTestId('settings-nav-thisMac').waitFor({ state: 'visible' });
    await page.getByTestId(`settings-nav-${scenario.slice(9)}`).press('Enter');
    await page.getByTestId(`settings-section-${scenario.slice(9)}`).waitFor({ state: 'visible' });
    if (scenario === 'settings-appearance') await page.locator('[data-testid^="settings-look-"][data-ready]').first().waitFor();
  } else if (scenario.startsWith('agents')) {
    if (phone) await page.getByTestId('tab-agents').click();
    else await page.evaluate(async () => {
      const response = await fetch('/api/sessions').then(r => r.json());
      const el = document.createElement('agent-mission');
      el.sessions = Array.isArray(response) ? response : response.sessions;
      // This standalone desktop specimen needs the same gutter as the real list.
      const content = document.createElement('div');
      content.className = 'ut-list-content';
      content.append(el);
      document.querySelector('session-list').replaceChildren(content);
      await el.updateComplete;
    });
    await page.getByTestId('agent-mission').waitFor({ state: 'visible' });
    if (scenario === 'agents-select') {
      await page.getByTestId('mission-select').click();
      await page.getByTestId('mission-select-all').click();
    } else if (scenario === 'agents-empty') {
      await page.locator('agent-mission').evaluate(async el => { el.sessions = []; await el.updateComplete; });
      await page.getByTestId('mission-empty').waitFor();
    }
  } else if (scenario.startsWith('task-') && ['task-log', 'task-question', 'task-countdown'].includes(scenario)) {
    if (scenario === 'task-log') {
      await page.locator(`[data-testid="task-row"][data-task-id="${rich.taskForSheet}"]`).first().click({ position: { x: 90, y: 16 } });
      await page.getByTestId('task-detail-log').click();
      await page.getByTestId('task-log-sheet').waitFor();
    } else if (scenario === 'task-question') {
      await page.getByTestId('needs-you-action').filter({ hasText: 'Responder' }).first().click();
      await page.getByTestId('answer-sheet').waitFor();
    } else {
      // A real ready task rendered with a fixed, pending auto-merge, never posted to the server.
      await page.locator('task-row').evaluateAll(async rows => {
        const el = rows.find(el => el.task?.autoMergeAt);
        if (!el) throw new Error('No ready task');
        el.expanded = true;
        await el.updateComplete;
        el.scrollIntoView({ block: 'center' });
      });
      await page.getByTestId('task-line').filter({ hasText: 'se fusiona sola' }).waitFor();
    }
  } else if (scenario === 'home-menu') {
    await page.getByTestId(phone ? 'phone-header-more' : 'account-button').click();
    await page.locator('.psr-sheet.open, [data-testid="account-menu"]').first().waitFor();
  } else if (scenario === 'preview-menu') {
    if (!phone) await page.evaluate(async () => {
      const data = await fetch('/api/previews').then(r => r.json());
      const row = document.createElement('preview-row');
      row.item = data.previews[0];
      document.querySelector('session-list').prepend(row);
      await row.updateComplete;
    });
    await page.getByTestId('preview-row-menu').first().click();
    await page.getByTestId('pvr-sheet-rename').waitFor();
  } else if (scenario === 'preview' || scenario === 'preview-down') {
    const previews = await page.request.get(`${url}/api/previews`).then(r => r.json());
    const preview = previews.previews[scenario === 'preview' ? 0 : 1];
    await page.goto(`${url}/preview/${preview.id}`);
    await page.getByTestId('preview-view').waitFor();
    if (scenario === 'preview') await page.frameLocator('preview-view iframe').getByText('Vista previa ficticia').waitFor();
  } else if (scenario === 'new-project') {
    await mount(page, 'new-project-sheet', {});
    await page.getByTestId('new-project-sheet').waitFor();
  } else if (scenario === 'project-settings') {
    await mount(page, 'project-settings-sheet', { repoPath: projectRepo, name: 'Faro · reservas' });
    await page.getByTestId('project-settings-sheet').waitFor();
  } else if (scenario === 'task-compose') {
    await mount(page, 'task-compose-sheet', { repos: rich.projects, repo: rich.projects[0], agents: [{ id: 'claude', label: 'Claude', command: 'claude' }, { id: 'codex', label: 'Codex', command: 'codex' }] });
    await page.getByTestId('task-compose-sheet').waitFor();
  } else if (scenario === 'scheduled') {
    await mount(page, 'task-sheet', { folders: rich.projects, commands: { claude: ['claude'], codex: ['codex'], shell: ['/bin/zsh'] } });
    await page.getByTestId('task-sheet').waitFor();
  } else if (scenario === 'confirm') {
    await mount(page, 'ut-confirm-dialog', { title: '¿Descartar esta tarea?', body: 'Se conservará el registro para consultarlo.', confirmLabel: 'Descartar', cancelLabel: 'Cancelar', tone: 'danger', details: ['Migrar la base de datos'] });
    await page.locator('ut-confirm-dialog [role="dialog"]').waitFor();
  } else if (scenario === 'answer') {
    await installBridge(page, assets);
    const choices = { question: '¿Permitir este comando?', options: ['Sí, continuar', 'No, revisar primero'], detail: ['Bash command', 'pnpm test'], key: 'coverage' };
    await page.route('**/api/sessions/coverage/prompt', route => route.fulfill({ json: { waiting: true, choices } }));
    await page.evaluate(choices => window.uiCoverage.openAnswerSheet({ sessionId: 'coverage', where: 'Faro · reservas', choices }), choices);
    await page.getByTestId('answer-choice').first().waitFor();
  } else if (scenario === 'toasts' || scenario === 'whats-new') {
    await installBridge(page, assets);
    await page.evaluate(scenario => {
      if (scenario === 'whats-new') window.uiCoverage.openWhatsNew();
      else for (const kind of ['success', 'info', 'attention', 'error']) window.uiCoverage.toast({ kind, text: { success: 'Cambios guardados', info: 'La tarea está en cola', attention: 'Una tarea te necesita', error: 'No se pudo guardar. Reintentar.' }[kind], timeoutMs: 0, action: { label: 'Ver', run() {} } });
    }, scenario);
  } else if (scenario === 'pieces') {
    // Shared pieces with no reachable live example (tooltip, disabled/focused controls,
    // progress). This is an explicitly labelled specimen, never a substitute for a screen.
    await page.evaluate(() => {
      const host = document.createElement('section');
      host.className = 'ut-dialog';
      host.style.cssText = 'position:fixed;inset:70px 12px auto;margin:auto;z-index:1900;padding:24px;display:grid;gap:20px;max-height:75vh';
      host.innerHTML = `<h2>Catálogo de piezas compartidas</h2>
        <div class="ut-tooltip" role="tooltip">Tooltip · abrir el registro</div>
        <div><span class="ut-badge ut-badge--success">Lista</span> <span class="ut-chip">3 tareas</span> <kbd class="ut-kbd">⌘ K</kbd></div>
        <input class="ut-field" value="Campo con foco" aria-label="Campo con foco">
        <select class="ut-select" aria-label="Agente"><option>Claude</option><option>Codex</option></select>
        <div><button class="ut-switch" role="switch" aria-label="Activado" aria-checked="true"></button> <button class="ut-switch" role="switch" aria-label="Desactivado" aria-checked="false"></button></div>
        <div><label><input type="checkbox" checked> Casilla</label> <label><input type="radio" checked name="sample"> Opción</label></div>
        <input class="ut-range" type="range" aria-label="Volumen" value="65">
        <progress class="ut-progress" value="65" max="100" aria-label="Progreso"></progress>
        <div class="ut-segmented"><button aria-pressed="true">Chat</button><button aria-pressed="false">Terminal</button></div>
        <div><button class="ut-btn ut-btn--primary">Guardar</button> <button class="ut-btn ut-btn--secondary" disabled>Desactivado</button></div>`;
      document.body.append(host);
      host.querySelector('input').focus();
    });
  } else if (scenario === 'empty') {
    if (phone) {
      await page.locator('session-list').evaluate(async el => { el.phoneQuery = 'Sin coincidencias para este texto'; await el.updateComplete; });
    } else await page.locator('.ut-list-search input').fill('Sin coincidencias para este texto');
    await page.locator('[data-testid="list-no-match"], .phone-search-empty').first().waitFor();
  }
}

export async function captureCoverageDetails(page, shotFile, stableShot) {
  const facts = await page.evaluate(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    const facts = [];
    for (const root of roots) for (const el of root.querySelectorAll('[class]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) continue;
      const style = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      if (el.matches('.st-root-row, .ut-row') && style.position === 'fixed') throw new Error('A settings row inherited fixed positioning from its sheet');
      if (!el.matches('[class*="ut-"], .bubble, .composer-capsule, .action-group, .pd')) continue;
      facts.push({ tag: el.localName, classes: el.getAttribute('class') || '', shadow: style.boxShadow,
        material: [style.backgroundImage, before.backgroundImage, after.backgroundImage].some(image => image.includes('/looks/')),
        filter: style.filter, backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none' });
    }
    const rows = [...document.querySelectorAll('.st-root-row')].map(el => el.getBoundingClientRect());
    for (let i = 1; i < rows.length; i++) if (rows[i].top < rows[i - 1].bottom - 1) throw new Error('Settings rows overlap');
    return facts;
  });
  fs.writeFileSync(shotFile.replace(/\.png$/, '-pieces.json'), JSON.stringify(facts, null, 2));
  if (shotFile.includes('coverage-settings-appearance-')) {
    // Inventory complete picker cards, not half a card at an arbitrary viewport edge.
    // WebKit re-rasterizes a few clipped shadow pixels there by 1/255. A locator shot
    // brings each whole card into view and uses the same strict stableShot check.
    for (const card of await page.locator('.ut-look-card').all()) {
      const id = (await card.getAttribute('data-testid')).replace('settings-look-', '');
      const file = shotFile.replace(/\.png$/, `-look-${id}.png`);
      fs.writeFileSync(file, await stableShot(card, file.replace(/\.png$/, '-UNSETTLED')));
      console.log(`ui-shots: ${file}`);
    }
    return;
  }
  // Scroll every other actual overflow panel to the bottom. Each
  // increment has overlap: no section/control between first and last can be silently missed.
  if (!/(?:webkit|chromium)-(mobile|desktop-home|mobile-rows)-|coverage-(settings-|project-settings|task-compose|scheduled|agents-)/.test(shotFile)) return;
  const selector = '.st-scroll, .p-sheet-body, .ans-body, .task-body, .main-list-scroll, .vtm-list';
  const panels = await page.locator(selector).all();
  let part = 0;
  for (const panel of panels) {
    if (!await panel.isVisible()) continue;
    const { height, total } = await panel.evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight }));
    if (total <= height + 8 || height < 100) continue;
    // A modal's background list is inert: do not capture it again underneath the scrim.
    if (await panel.evaluate(el => !el.closest('[role="dialog"]') && [...document.querySelectorAll('[role="dialog"]')].some(dialog => {
      const rect = dialog.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
        && getComputedStyle(dialog).visibility === 'visible';
    }))) continue;
    for (let top = height * .85; top < total; top += height * .85) {
      // Integral CSS coordinates avoid WebKit re-rasterizing miniature shadows at a
      // fractional scroll offset. Keep stableShot's pixel tolerance unchanged.
      await panel.evaluate((el, top) => { el.scrollTop = top; }, Math.round(Math.min(top, total - height)));
      const file = shotFile.replace(/\.png$/, `-scroll-${++part}.png`);
      fs.writeFileSync(file, await stableShot(page, file.replace(/\.png$/, '-UNSETTLED')));
      console.log(`ui-shots: ${file}`);
      if (top >= total - height) break;
    }
  }
}
