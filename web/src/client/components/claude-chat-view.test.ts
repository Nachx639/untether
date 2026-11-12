/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScreenChoices } from '../../shared/claude-screen.js';
import { setLocale } from '../i18n/index.js';
import {
  ClaudeChatView,
  clearChatCacheForTest,
  extractUploadedImages,
  modeSwitchBlocked,
  parseClaudeMode,
  renderChatMarkdown,
  resetMacVoiceCheck,
  speechLang,
  speechText,
} from './claude-chat-view.js';
import './claude-chat-view.js';
import { resetAnnouncerForTests } from '../utils/announce.js';
import { writeChatStatusLinePref } from '../utils/claude-status-line.js';
import { resetGhostClickGuard, swallowNextClick } from '../utils/ghost-click.js';
import { VoicePlayer } from '../utils/read-aloud-player.js';

// The transcript cache lives for the page load: each test starts without one.
beforeEach(() => clearChatCacheForTest());

/** A run of prose as markdown.ts gives it: in its own element (2026-11-11, the wide desktop column). */
const prose = (html: string) => `<span class="prose">${html}</span>`;

describe('renderChatMarkdown', () => {
  it('escapes markup before formatting', () => {
    expect(renderChatMarkdown('<img src=x onerror=alert(1)> **ok**')).toBe(
      prose('&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong>')
    );
  });

  it('links URLs without letting markup through', () => {
    expect(renderChatMarkdown('Mira https://example.com/a?b=1&c=2. Y (https://x.io)')).toBe(
      prose(
        'Mira <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>. Y (<a href="https://x.io" target="_blank" rel="noopener noreferrer">https://x.io</a>)'
      )
    );
    expect(renderChatMarkdown('https://e.com/"onmouseover="x')).not.toContain('"onmouseover');
  });

  it('formats code, emphasis, headings and bullets', () => {
    expect(renderChatMarkdown('# Title\n- run `ls`\n```sh\necho <hi>\n```')).toBe(
      `${prose('<span class="h h1">Title</span><span class="li" style="margin-inline-start:0em">• run <code>ls</code></span>')}<pre><code>echo &lt;hi&gt;</code></pre>`
    );
  });
});

describe('renderChatMarkdown lists', () => {
  it('renders bullets and numbered items as hanging-indent blocks', () => {
    const html = renderChatMarkdown('Pasos:\n- uno largo\n  - anidado\n2. dos\nfin');
    expect(html).toBe(
      prose(
        'Pasos:<span class="li" style="margin-inline-start:0em">• uno largo</span>' +
          '<span class="li" style="margin-inline-start:1em">• anidado</span>' +
          '<span class="li" style="margin-inline-start:0em">2. dos</span>fin'
      )
    );
  });
});

describe('renderChatMarkdown never injects markup', () => {
  // XSS found in review (2026-10-03): the autolink rule ran over the markup of a markdown link
  // and nested an <a> inside its href; the URL's tail became attributes (onclick).
  it.each([
    '[a](http://x/(http://onclick=alert//)',
    'mira https://a.com/(https://b.com/onclick=x//) ya',
    '[x](https://a.com/"onmouseover="alert(1))',
    '[`code`](https://a.com/(https://b.com/onclick=y//)',
    '| h | y |\n|---|---|\n| [a](http://x/(http://onerror=x//) | y |',
    'trampa \uE0010\uE002 [b](https://ok.com)',
  ])('%s', (text) => {
    const doc = new DOMParser().parseFromString(
      `<div>${renderChatMarkdown(text)}</div>`,
      'text/html'
    );
    for (const element of Array.from(doc.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on'), attribute.name).toBe(false);
      }
    }
    expect(doc.querySelectorAll('a a')).toHaveLength(0);
    for (const link of Array.from(doc.querySelectorAll('a'))) {
      expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
    }
  });
});

describe('renderChatMarkdown links, quotes and rules', () => {
  it('turns [label](url) into a link, but only for web addresses', () => {
    expect(renderChatMarkdown('Ver [la guía **nueva**](https://x.io/a?b=1&c=2).')).toBe(
      prose(
        'Ver <a href="https://x.io/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">la guía <strong>nueva</strong></a>.'
      )
    );
    expect(renderChatMarkdown('[x](javascript:alert(1)) [y](/etc/passwd)')).not.toContain('<a');
  });

  it('sets headings apart by level, deeper ones all alike', () => {
    expect(renderChatMarkdown('Intro\n## Cambios\nuno\n#### Detalle')).toBe(
      prose('Intro<span class="h h2">Cambios</span>uno<span class="h h3">Detalle</span>')
    );
  });

  it('keeps no empty lines between a code block and the text around it', () => {
    expect(renderChatMarkdown('El código:\n\n```ts\nx = 1\n```\n\nListo')).toBe(
      `${prose('El código:')}<pre><code>x = 1</code></pre>${prose('Listo')}`
    );
  });

  it('renders adversarial runs (blank lines, open brackets) in linear time', () => {
    const started = performance.now();
    renderChatMarkdown(`# T\n${'\n'.repeat(40_000)}x`);
    renderChatMarkdown('['.repeat(40_000));
    renderChatMarkdown(`[a${'b'.repeat(40_000)}`);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('keeps no empty lines around headings and rules', () => {
    expect(renderChatMarkdown('## Resumen\n\nDos frases.\n\n---\n\n## Pasos\n\n1. uno')).toBe(
      prose(
        '<span class="h h2">Resumen</span>Dos frases.<span class="hr"></span>' +
          '<span class="h h2">Pasos</span><span class="li" style="margin-inline-start:0em">1. uno</span>'
      )
    );
  });

  it('shows quotes, section rules and strikethrough', () => {
    expect(renderChatMarkdown('Dijo:\n> hola\n> adiós\n---\nya ~~no~~ sí')).toBe(
      prose(
        'Dijo:<span class="quote">hola</span><span class="quote">adiós</span>' +
          '<span class="hr"></span>ya <del>no</del> sí'
      )
    );
  });
});

describe('renderChatMarkdown tables', () => {
  it('renders a table with its formatting, alignment and the text around it', () => {
    const html = renderChatMarkdown(
      'Resumen:\n\n| Paso | Estado | Min |\n|---|:---:|---:|\n| `build` | **ok** | 3 |\n| tests \\| e2e | <b>no</b> | 12 |\n\nFin'
    );
    expect(html).toBe(
      `${prose('Resumen:')}<div class="table-wrap">` +
        '<table><thead><tr><th>Paso</th>' +
        '<th style="text-align:center">Estado</th><th style="text-align:right">Min</th></tr>' +
        '</thead><tbody><tr><td><code>build</code></td>' +
        '<td style="text-align:center"><strong>ok</strong></td>' +
        '<td style="text-align:right">3</td></tr><tr><td>tests | e2e</td>' +
        '<td style="text-align:center">&lt;b&gt;no&lt;/b&gt;</td>' +
        `<td style="text-align:right">12</td></tr></tbody></table></div>${prose('Fin')}`
    );
  });

  it('fills short rows, and leaves pipes alone when there is no delimiter row', () => {
    expect(renderChatMarkdown('| a | b |\n| --- | --- |\n| solo |')).toContain(
      '<tr><td>solo</td><td></td></tr>'
    );
    expect(renderChatMarkdown('a | b\n---')).toBe(prose('a | b<span class="hr"></span>'));
    expect(renderChatMarkdown('cat x | grep y')).toBe(prose('cat x | grep y'));
  });

  it('reads a line of dashes followed by text at once (no catastrophic backtracking)', () => {
    const started = performance.now();
    const text = `${'-'.repeat(80)} hecho\n${'|-'.repeat(40)}x`;
    expect(speechText(text, 'code')).toContain('hecho');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('reads a table aloud as its cells, without the delimiter row', () => {
    expect(speechText('| A | B |\n|---|---|\n| 1 | 2 |', 'code')).toBe('A, B. 1, 2.');
  });
});

describe('parseClaudeMode', () => {
  it.each([
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle)', 'Bypass permissions'],
    ['  ⏸ plan mode on · ? for shortcuts', 'Plan mode'],
    ['  ⏸ manual mode on · ? for shortcuts · ← for agents', 'Manual mode'],
    ['  ⏵⏵ accept edits on', 'Accept edits'],
    ['  ? for shortcuts', 'Default mode'],
    ['$ ls', null],
  ])('reads %j', (line, mode) => {
    expect(parseClaudeMode(line)).toBe(mode);
  });
});

describe('modeSwitchBlocked', () => {
  it('blocks Shift+Tab while a permission dialog shows, even with the mode line visible', () => {
    const dialog = [
      ' Edit file src/app.ts?',
      ' Do you want to make this edit?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');
    expect(modeSwitchBlocked(dialog)).toBe(true);
    expect(modeSwitchBlocked('  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe(false);
    expect(modeSwitchBlocked('$ ls')).toBe(true);
  });
});

describe('parseScreenChoices', () => {
  it('reads a permission prompt with wrapped options', () => {
    const screen = [
      ' Read(/tmp/a.jpeg)',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from',
      '      /tmp during this session',
      '   3. No',
      ' Esc to cancel · Tab to amend',
    ].join('\n');
    expect(parseScreenChoices(screen)).toEqual({
      question: 'Do you want to proceed?',
      options: ['Yes', 'Yes, allow reading from /tmp during this session', 'No'],
      cursor: 0,
      navigate: true,
      numbered: true,
      key: expect.any(String),
    });
  });

  it('joins a label the terminal hard-wrapped mid-word', () => {
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp/alexandrapu',
      '      blicdemouser from this project',
      '   3. No',
    ].join('\n');
    expect(parseScreenChoices(screen, 54)?.options[1]).toBe(
      'Yes, and always allow access to /tmp/alexandrapublicdemouser from this project'
    );
  });

  it('ignores numbered lists that are not a question', () => {
    expect(parseScreenChoices('Ideas:\n1. Sazón\n2. Fogón')).toBeNull();
  });
});

describe('extractUploadedImages', () => {
  it('turns uploaded image paths into attachments', () => {
    expect(
      extractUploadedImages('/Users/x/.untether/control/uploads/ab-1.jpeg que flores son?')
    ).toEqual({ text: 'que flores son?', images: ['ab-1.jpeg'] });
    expect(extractUploadedImages('mira /tmp/foto.png')).toEqual({
      text: 'mira /tmp/foto.png',
      images: [],
    });
  });
});

describe('read aloud text', () => {
  it('drops markdown markers and code blocks', () => {
    expect(speechText('# Done\n- run **`ls`** now\n```sh\nrm -rf x\n```\nok', 'code omitted')).toBe(
      'Done run ls now (code omitted). ok'
    );
  });

  it('reads in the language the answer is written in', () => {
    expect(speechLang('Hecho: el test pasa y la build de la app es correcta', 'en')).toBe('es');
    expect(speechLang('Done: the test passes and the build is fine', 'es')).toBe('en');
    expect(speechLang('Hecho, todo ok', 'fr')).toBe('fr');
    expect(speechLang('تم الانتهاء من الاختبار', 'en')).toBe('ar');
  });
});

function stubChat(messages: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: true, status: 'idle', messages }),
    }))
  );
}

// Runs the view's 1.5 s poll timer on fake time until `check` passes: tests about what a
// later poll does waited 1.5-6 s of real time per test (2026-11-02). Fake time moves only
// when this loop advances it, so a loaded machine cannot make it flake; maxMs bounds it.
async function advanceUntil(check: () => void, maxMs = 30_000, stepMs = 250) {
  for (let elapsed = 0; ; elapsed += stepMs) {
    try {
      check();
      return;
    } catch (error) {
      if (elapsed >= maxMs) throw error;
    }
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

async function mountChat() {
  const view = document.createElement('claude-chat-view') as ClaudeChatView;
  view.sessionId = 's1';
  document.body.appendChild(view);
  await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row')).toBeTruthy());
  return view;
}

describe('ClaudeChatView', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('drops a slow answer for the previous session after switching sessions', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const fetchMock = vi.fn((url: string) =>
      url.includes('/old/')
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({
            ok: true,
            json: async () => ({ available: true, status: 'idle', messages: [] }),
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    // The chat's own requests (the view also asks once whether the Mac has a voice).
    const chatCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat'));
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'old';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(chatCalls()).toHaveLength(1));

    view.sessionId = 'new';
    await vi.waitFor(() => expect(chatCalls()).toHaveLength(2));
    resolveOld({
      ok: true,
      json: async () => ({
        available: true,
        status: 'idle',
        messages: [{ id: 'x', role: 'user', text: 'from the old session' }],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.updateComplete;

    expect(view.shadowRoot?.textContent).not.toContain('from the old session');
  });

  it('announces Claude starting, waiting and finishing once per change, not per poll', async () => {
    resetAnnouncerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    document.body.appendChild(view);
    const region = () => document.querySelector('[data-testid="a11y-live-region"]');
    const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
    const said = async (status: string, waitingFor?: string) => {
      internals.apply({ available: true, status, waitingFor, messages: [] });
      await view.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return region()?.textContent ?? '';
    };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    // The state a session already had when opened is not news.
    expect(region()?.textContent ?? '').toBe('');
    expect(await said('busy')).toBe('Claude is working');
    expect(region()?.getAttribute('aria-live')).toBe('polite');
    expect(await said('waiting', 'permission')).toBe('Claude is waiting for you · permission');
    expect(await said('busy')).toBe('Claude is working');
    expect(await said('idle')).toBe('Claude finished');
    view.remove();
  });

  it('shows the mode last read for a session before its screen has loaded', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    stubChat([{ id: '1', role: 'user', text: 'hola' }]);
    let screen = '⏸ plan mode on';
    const first = document.createElement('claude-chat-view') as ClaudeChatView;
    first.sessionId = 's1';
    first.getScreenTail = () => screen;
    document.body.appendChild(first);
    await vi.waitFor(() =>
      expect(first.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeTruthy()
    );
    first.remove();

    // Reopened: no screen yet, the chip is there at once with the remembered mode.
    screen = '';
    const view = await mountChat();
    const chip = view.shadowRoot?.querySelector('[data-testid="mode-chip"]');
    expect(chip?.textContent).toContain('Plan mode');
  });

  it('shows an interruption in the page language', async () => {
    // The server words it in English; the Spanish chat said "Interrupted" (2026-10-03, SE).
    await setLocale('es');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    document.body.appendChild(view);
    try {
      const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
      await vi.waitFor(() => expect(internals.loaded).toBe(true));
      internals.apply({
        available: true,
        status: 'idle',
        messages: [
          { id: 'u', role: 'user', text: 'haz algo' },
          { id: 'n', role: 'note', text: 'Interrupted' },
        ],
      });
      await view.updateComplete;
      expect(view.shadowRoot?.querySelector('.tool.note')?.textContent?.trim()).toBe(
        'Interrumpido'
      );
    } finally {
      view.remove();
      await setLocale('en');
    }
  });

  it("shows Claude's status line under the conversation only when Settings turns it on", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, agent: 'claude', status: 'idle', messages: [] }),
      }))
    );
    const screen = [
      '─────────────────────────────',
      '❯ ',
      '─────────────────────────────',
      '  Opus 5.5 · 5h 5% · week 16%',
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n');
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    view.getScreenTail = () => screen;
    document.body.appendChild(view);
    const internals = view as unknown as { loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    const statusLine = () => view.shadowRoot?.querySelector('[data-testid="chat-status-line"]');
    expect(statusLine()).toBeNull();

    writeChatStatusLinePref(true);
    await view.updateComplete;
    // One chip per piece; the mode (already the mode chip) is left out.
    const chips = [...(statusLine()?.querySelectorAll('[data-testid="chat-status-chip"]') ?? [])];
    expect(chips.map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Opus 5.5',
      '5h 5%',
      'week 16%',
      '1 shell',
    ]);
    expect(chips[1].querySelector('.status-fill')?.getAttribute('style')).toContain('width: 5%');

    writeChatStatusLinePref(false);
    await view.updateComplete;
    expect(statusLine()).toBeNull();
    view.remove();
  });

  it('speaks of Codex and drops the Claude mode chip in a Codex session', async () => {
    resetAnnouncerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, agent: 'codex', status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    // A Claude-like status line on screen must not bring the mode chip into a Codex chat.
    view.getScreenTail = () => '⏵⏵ bypass permissions on';
    document.body.appendChild(view);
    const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('Send Codex a message below.');
    expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeNull();

    internals.apply({
      available: true,
      agent: 'codex',
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target: 'npm test' },
      messages: [{ id: 'u', role: 'user', text: 'run the tests' }],
    });
    await view.updateComplete;
    const activity = view.shadowRoot?.querySelector('[data-testid="chat-activity"]');
    expect(activity?.textContent).toContain('Codex ·');
    expect(view.shadowRoot?.querySelector('.stop')?.getAttribute('aria-label')).toBe('Stop Codex');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
      'Codex is working'
    );
    view.remove();
  });

  it('says it waits for background agents instead of the typing dots, until a turn starts', async () => {
    await setLocale('es');
    resetAnnouncerForTests();
    let view: ClaudeChatView | undefined;
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ available: true, status: 'busy', messages: [] }),
        }))
      );
      view = document.createElement('claude-chat-view') as ClaudeChatView;
      view.sessionId = 's';
      document.body.appendChild(view);
      const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
      await vi.waitFor(() => expect(internals.loaded).toBe(true));
      await view.updateComplete;
      // A turn in progress: the typing dots.
      expect(view.shadowRoot?.querySelector('.typing')).not.toBeNull();

      internals.apply({
        available: true,
        status: 'busy',
        waitingForBackground: true,
        messages: [
          { id: 'u', role: 'user', text: 'lanza un agente' },
          { id: 'a', role: 'assistant', text: 'Lanzado; te aviso.' },
        ],
      });
      await view.updateComplete;
      const row = view.shadowRoot?.querySelector('[data-testid="chat-background"]');
      expect(row?.textContent?.trim()).toBe('Esperando a agentes en segundo plano');
      expect(view.shadowRoot?.querySelector('.typing')).toBeNull();
      expect(view.shadowRoot?.querySelector('.stop')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
        'Claude ha respondido; los agentes en segundo plano siguen en marcha'
      );

      // A task notification starts a real turn again.
      internals.apply({
        available: true,
        status: 'busy',
        activity: { kind: 'thinking' },
        messages: [
          { id: 'u', role: 'user', text: 'lanza un agente' },
          { id: 'a', role: 'assistant', text: 'Lanzado; te aviso.' },
        ],
      });
      await view.updateComplete;
      expect(view.shadowRoot?.querySelector('[data-testid="chat-background"]')).toBeNull();
      expect(view.shadowRoot?.querySelector('.typing')).not.toBeNull();
    } finally {
      view?.remove();
      await setLocale('en');
    }
  });

  it('speaks of Gemini and drops the Claude mode chip in a Gemini session', async () => {
    resetAnnouncerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, agent: 'gemini', status: 'idle', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's';
    view.getScreenTail = () => '⏵⏵ bypass permissions on';
    document.body.appendChild(view);
    const internals = view as unknown as { apply(chat: unknown): void; loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('Send Gemini a message below.');
    expect(view.shadowRoot?.querySelector('[data-testid="mode-chip"]')).toBeNull();

    internals.apply({
      available: true,
      agent: 'gemini',
      status: 'busy',
      activity: { kind: 'tool', tool: 'Read', target: 'app.ts' },
      messages: [{ id: 'u', role: 'user', text: 'read the app' }],
    });
    await view.updateComplete;
    const activity = view.shadowRoot?.querySelector('[data-testid="chat-activity"]');
    expect(activity?.textContent).toContain('Gemini ·');
    expect(view.shadowRoot?.querySelector('.stop')?.getAttribute('aria-label')).toBe('Stop Gemini');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
      'Gemini is working'
    );
    view.remove();
  });

  it('steps aside for the terminal when the chat endpoint answers with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'remote';
    document.body.appendChild(view);

    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
  });

  it('copies a code block and a whole answer to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [{ id: 'a', role: 'assistant', text: 'Run:\n```sh\nnpm test\n```' }],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.copy-code')).toBeTruthy());

    view.shadowRoot?.querySelector<HTMLButtonElement>('.copy-code')?.click();
    expect(writeText).toHaveBeenLastCalledWith('npm test');
    view.shadowRoot?.querySelector<HTMLButtonElement>('.copy-msg')?.click();
    expect(writeText).toHaveBeenLastCalledWith('Run:\n```sh\nnpm test\n```');
  });

  it('asks with the fingerprint it shows and keeps its list when the server leaves it out', async () => {
    const urls: string[] = [];
    const first = [
      { id: '1', role: 'user', text: 'hola' },
      { id: '2', role: 'assistant', text: 'primera respuesta' },
    ];
    let answer: Record<string, unknown> = {
      available: true,
      status: 'busy',
      messages: first,
      messagesVersion: 'v1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, json: async () => structuredClone(answer) };
      })
    );
    vi.useFakeTimers();
    const view = await mountChat();
    expect(view.shadowRoot?.textContent).toContain('primera respuesta');
    expect(urls[0]).toBe('/api/sessions/s1/claude-chat');

    // Unchanged: no list in the answer, the bubbles stay.
    answer = { available: true, status: 'busy', messagesVersion: 'v1', messagesUnchanged: true };
    await advanceUntil(() => expect(urls.length).toBeGreaterThanOrEqual(3));
    expect(urls[1]).toBe('/api/sessions/s1/claude-chat?have=v1');
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('primera respuesta');

    // An edit keeps the length and the last id: the new fingerprint still shows it.
    answer = {
      available: true,
      status: 'busy',
      messages: [first[0], { ...first[1], text: 'respuesta corregida' }],
      messagesVersion: 'v2',
    };
    await advanceUntil(() => expect(view.shadowRoot?.textContent).toContain('respuesta corregida'));
    await advanceUntil(() => expect(urls[urls.length - 1]).toContain('have=v2'));
  });

  it('shows what an Edit changed, without the stock "file has been updated" line', async () => {
    const edit = {
      id: 'e',
      role: 'tool',
      tool: 'Edit',
      text: 'a.ts',
      detail: '/repo/a.ts',
      result: 'The file /repo/a.ts has been updated successfully.',
      diff: ['#src/a.ts', ' x = 1', '-y = 2', '+y = 3', '…', ' z'],
      diffMore: 3,
    };
    stubChat([{ id: '1', role: 'user', text: 'cambia y' }, edit]);
    const view = await mountChat();
    const root = view.shadowRoot;
    root?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(root?.querySelector('.diff .dl.del')?.textContent).toBe('-y = 2');
    expect(root?.querySelector('.diff .dl.add')?.textContent).toBe('+y = 3');
    expect(root?.querySelectorAll('.diff .dl.ctx')).toHaveLength(2);
    expect(root?.querySelector('.diff .dl.file')?.textContent).toBe('src/a.ts');
    expect(root?.querySelector('.diff')?.textContent).toContain('3 more lines');
    expect(root?.querySelector('.tool-detail pre.out')).toBeNull();
  });

  it('still shows an Edit that failed, with its change', async () => {
    stubChat([
      { id: '1', role: 'user', text: 'cambia y' },
      {
        id: 'e',
        role: 'tool',
        tool: 'Edit',
        text: 'a.ts',
        result: 'String to replace not found in file.',
        isError: true,
        diff: ['-y = 2', '+y = 3'],
      },
    ]);
    const view = await mountChat();
    view.shadowRoot?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.tool-detail pre.out.err')?.textContent).toContain(
      'not found'
    );
    expect(view.shadowRoot?.querySelector('.diff .dl.del')).toBeTruthy();
  });

  it('offers a jump back to the latest reply, counting new ones, while reading older ones', async () => {
    const messages = [
      { id: '1', role: 'user', text: 'hola' },
      { id: '2', role: 'assistant', text: 'hey' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [...messages] }),
      }))
    );
    vi.useFakeTimers();
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('wheel'));
    scroller.dispatchEvent(new Event('scroll'));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.jump')).toBeTruthy();
    expect(view.shadowRoot?.querySelector('.jump .badge')).toBeNull();

    // The server sends a capped window (latest 400): the list slides instead of growing.
    messages.shift();
    messages.push({ id: '3', role: 'assistant', text: 'more' });
    await advanceUntil(() =>
      expect(view.shadowRoot?.querySelector('.jump .badge')?.textContent).toBe('1')
    );
    view.shadowRoot?.querySelector<HTMLButtonElement>('.jump')?.click();
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.jump')).toBeNull();
  });

  it('separates the days of a long conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [
            { id: '1', role: 'user', text: 'a', timestamp: '2025-03-01T10:00:00' },
            { id: '2', role: 'assistant', text: 'b', timestamp: '2025-03-01T10:01:00' },
            { id: '3', role: 'user', text: 'c', timestamp: '2025-03-04T09:00:00' },
            { id: '4', role: 'assistant', text: 'd', timestamp: new Date().toISOString() },
          ],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());

    const days = [...(view.shadowRoot?.querySelectorAll('.day') ?? [])].map((d) => d.textContent);
    expect(days).toHaveLength(3);
    expect(days[2]).toBe('Today');
  });

  it('says when the server cannot be reached and recovers on the next poll', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          status: 'idle',
          messages: [{ id: '1', role: 'assistant', text: 'back' }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.offline')).toBeTruthy());
    expect(view.shadowRoot?.querySelector('.empty')?.textContent).toContain('Loading');

    await advanceUntil(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());
    expect(view.shadowRoot?.querySelector('.offline')).toBeNull();
  });

  it('keeps the time on one line under a one-character message', () => {
    const styles = ClaudeChatView.styles.toString();
    expect(styles).toMatch(/\.time \{[^}]*white-space: nowrap;/);
    // 84px, or more when the system text size makes the time wider.
    expect(styles).toMatch(/\.row\.user \.bubble \{\s*min-width: max\(84px, 5\.25rem\);/);
  });

  it('tells the phone composer while it shows a question with its options', async () => {
    // Both showed the options as buttons, one set over the other (2026-10-03).
    let status = 'waiting';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ available: true, status, waitingFor: 'permission', messages: [] }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    const asking = vi.fn();
    view.addEventListener('claude-chat-asking', (e) => asking((e as CustomEvent<boolean>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(true));

    status = 'idle';
    (view as unknown as { apply(chat: unknown): void }).apply({
      available: true,
      status: 'idle',
      messages: [],
    });
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(false));
    view.remove();

    // Mounted again (back to chat mode) with nothing to ask: it says so at once, or the
    // composer would keep leaving a menu to a view that no longer shows it.
    const again = document.createElement('claude-chat-view') as ClaudeChatView;
    again.sessionId = 's1';
    const told = vi.fn();
    again.addEventListener('claude-chat-asking', (e) => told((e as CustomEvent<boolean>).detail));
    document.body.appendChild(again);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith(false));
    again.remove();
  });

  it('answers a menu on screen through the server, which checks it and presses Enter', async () => {
    // A yes/no letter alone left a line-reading prompt waiting; the server adds Enter.
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/answer')
        ? new Response('{}', { status: 200 })
        : Response.json({
            available: true,
            status: 'waiting',
            waitingFor: 'input needed',
            messages: [],
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => '⏺ Done.\n\nOverwrite it with the new defaults? (y/n)';
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.question')).toBeTruthy());

    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    expect([...(buttons ?? [])].map((b) => b.textContent?.trim()).slice(0, 2)).toEqual([
      'Yes',
      'No',
    ]);
    buttons?.[1].click();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/answer', expect.anything())
    );
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/answer'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ option: 2 });
    expect(sent).not.toHaveBeenCalled();
    view.remove();
  });

  it("shows at once the next command's prompt with the same options as the one answered", async () => {
    // Told apart from the answered one by its options alone, it stayed hidden for 4 s with no
    // buttons anywhere (fourth review of 2026-10-03).
    const permission = (command: string) =>
      [
        '────────────────────────────────────────',
        ' Bash command',
        '',
        `   ${command}`,
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        ' Esc to cancel',
      ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/answer')
          ? new Response('{}', { status: 200 })
          : Response.json({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] })
      )
    );
    let screen = permission('rm -rf dist/');
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => screen;
    view.getMenuScreen = () => screen;
    document.body.appendChild(view);
    const buttons = () => view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    await vi.waitFor(() => expect(buttons()?.length).toBeGreaterThan(0));
    buttons()?.[0].click();
    const internals = view as unknown as { apply(chat: unknown): void; answering: boolean };
    await vi.waitFor(() => expect(internals.answering).toBe(false));
    await view.updateComplete;

    screen = permission('rm -rf src/');
    internals.apply({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] });
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.question')?.textContent).toContain('rm -rf src/');
    expect(buttons()?.[0]?.textContent?.trim()).toBe('Yes');
    view.remove();
  });

  it('says to open the terminal for a menu drawn for a wider PTY, instead of a cut one', async () => {
    // 2026-10-04: a Mac window owned the PTY at 53 columns, the phone's copy had 45 and the
    // menu's longer rows lost their tails; the card showed cut labels nobody could answer.
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /Users/',
      '      apublicdemouser/.untether-qa/qa-git f',
      '   3. No',
      ' Esc to cancel',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] })
      )
    );
    let ptyCols = 53;
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => screen;
    view.getMenuScreen = () => screen;
    view.getScreenLayout = () => ({ cols: 45, ptyCols });
    document.body.appendChild(view);
    const waiting = () => view.shadowRoot?.querySelector('.waiting')?.textContent ?? '';
    await vi.waitFor(() => expect(waiting()).toContain('wider screen'));
    expect(view.shadowRoot?.querySelector('.question')).toBeNull();

    // The PTY back at the phone's width: the menu is read again, the note goes.
    ptyCols = 45;
    const internals = view as unknown as { apply(chat: unknown): void };
    internals.apply({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] });
    await view.updateComplete;
    expect(view.shadowRoot?.querySelectorAll('.question button').length).toBeGreaterThan(0);
    expect(waiting()).not.toContain('wider screen');
    view.remove();
  });

  it('does not open the search when a tap that closed something above it ends on its field', async () => {
    // Closing the "while you were away" card with its × opened the search under it
    // (2026-10-03, iPhone SE simulator): the field under the finger took the tap's focus.
    stubChat([{ id: '1', role: 'user', text: 'hola' }]);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    const proxy = await vi.waitFor(() => {
      const found = view.shadowRoot?.querySelector<HTMLInputElement>('.search-proxy');
      if (!found) throw new Error('no search field yet');
      return found;
    });
    const searching = () => (view as unknown as { searchOpen: boolean }).searchOpen;
    swallowNextClick();
    proxy.dispatchEvent(new FocusEvent('focus'));
    await view.updateComplete;
    expect(searching()).toBe(false);
    resetGhostClickGuard();
    proxy.dispatchEvent(new FocusEvent('focus'));
    await view.updateComplete;
    expect(searching()).toBe(true);
    view.remove();
  });

  it('«Conversar» opens the copilot about this session only, whatever its agent', async () => {
    stubChat([{ id: '1', role: 'user', text: 'hola' }]);
    const view = await mountChat();
    (view as unknown as { agent: string }).agent = 'codex';
    await view.updateComplete;
    const talk = view.shadowRoot?.querySelector<HTMLButtonElement>('#voice-copilot-session-button');
    expect(talk?.classList.contains('voice-toggle')).toBe(true);
    talk?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 0 }));
    const sheet = document.body.querySelector('copilot-sheet');
    expect(sheet?.scope).toEqual({ mode: 'session', sessionId: 's1' });
    sheet?.remove();
    view.remove();
  });

  it('leaves the search field out of iOS reach while the composer has the keyboard', async () => {
    // 2026-10-04: from the focused chat composer iOS offered ↑ ↓ arrows to the invisible
    // search field over the icon (owner's iPhone). It is there only while no field is focused.
    stubChat([{ id: '1', role: 'user', text: 'hola' }]);
    const view = await mountChat();
    const root = view.shadowRoot as ShadowRoot;
    const proxy = () => root.querySelector<HTMLInputElement>('.search-proxy');
    expect(proxy()).toBeTruthy();

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    await vi.waitFor(() => expect(proxy()).toBeNull());

    // A tap on the icon reaches the search button, which opens the search with the keyboard up.
    root.querySelector<HTMLButtonElement>('.search-toggle:not(.voice-toggle)')?.click();
    await vi.waitFor(() => expect(root.querySelector('.search-bar input')).toBeTruthy());
    root
      .querySelector<HTMLInputElement>('.search-bar input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await view.updateComplete;

    // Keyboard down (nothing focused): the field is back, so a tap raises the keyboard.
    composer.focus();
    composer.blur();
    await vi.waitFor(() => expect(proxy()).toBeTruthy());
    composer.remove();
  });

  it("forgets the question card's answer in flight when another session opens", async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/answer')
          ? new Promise<Response>((resolve) => (finish = resolve))
          : Promise.resolve(
              Response.json({
                available: true,
                status: 'waiting',
                waitingFor: 'permission',
                messages: [],
              })
            )
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'a';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    document.body.appendChild(view);
    const buttons = () => [
      ...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button') ?? []),
    ];
    await vi.waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    buttons()[0].click();
    await view.updateComplete;
    view.sessionId = 'b';
    // B's card is not A's: its buttons work (A's answer is still on its way)...
    await vi.waitFor(() => expect(buttons()[0]?.disabled).toBe(false));
    // ...and A's refusal says nothing on it.
    finish(new Response(JSON.stringify({ error: 'The prompt changed' }), { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('.question-note')).toBeNull();
    view.remove();
  });

  it('shows on the card what an answer approves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: true,
          status: 'waiting',
          waitingFor: 'permission',
          messages: [],
        })
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      [
        '─'.repeat(40),
        ' Bash command',
        '',
        '   rm -rf dist/',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No, and tell Claude what to do differently (esc)',
      ].join('\n');
    document.body.appendChild(view);
    await vi.waitFor(() =>
      expect(
        view.shadowRoot?.querySelector('[data-testid="question-detail"]')?.textContent
      ).toContain('rm -rf dist/')
    );
    view.remove();
  });

  it('says why a tap on the card did nothing, and keeps asking while it answers', async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/answer')
          ? new Promise<Response>((resolve) => (finish = resolve))
          : Promise.resolve(
              Response.json({
                available: true,
                status: 'waiting',
                waitingFor: 'permission',
                messages: [],
              })
            )
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () =>
      ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)';
    const asking = vi.fn();
    view.addEventListener('claude-chat-asking', (e) => asking((e as CustomEvent<boolean>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(asking).toHaveBeenLastCalledWith(true));
    const buttons = () => [
      ...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button') ?? []),
    ];
    buttons()[0].click();
    await view.updateComplete;
    // While it answers: buttons off, and still asking (the composer would show them again).
    expect(buttons()[0].disabled).toBe(true);
    expect(asking).toHaveBeenLastCalledWith(true);

    finish(new Response(JSON.stringify({ error: 'The prompt changed' }), { status: 409 }));
    await vi.waitFor(() =>
      expect(view.shadowRoot?.querySelector('.question-note')?.textContent).toContain('changed')
    );
    expect(buttons()[0].disabled).toBe(false);
    view.remove();
  });

  it('answers a pending single-choice question by option number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          available: true,
          status: 'waiting',
          waitingFor: 'input needed',
          messages: [
            {
              id: 'q',
              role: 'tool',
              tool: 'AskUserQuestion',
              text: '',
              question: { text: '¿Fruta?', options: ['Manzana', 'Fresa'] },
            },
          ],
        }),
      }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.question')).toBeTruthy());

    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.question button');
    expect([...(buttons ?? [])].map((b) => b.textContent?.trim())).toEqual(['Manzana', 'Fresa']);
    buttons?.[1].click();

    expect(sent).toHaveBeenCalledWith('2');
  });

  it('renders the transcript as bubbles and hides itself for non-Claude sessions', async () => {
    const respond = vi.fn().mockResolvedValue({
      available: true,
      status: 'busy',
      messages: [
        { id: '1', role: 'user', text: 'hola' },
        {
          id: '2',
          role: 'tool',
          tool: 'Bash',
          text: 'List files',
          detail: '$ ls',
          result: 'a.txt',
        },
        { id: '3', role: 'assistant', text: '**Hola**' },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: respond }))
    );

    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.row.assistant')).toBeTruthy());

    const root = view.shadowRoot;
    expect(root?.querySelector('.row.user .bubble')?.textContent).toContain('hola');
    expect(root?.querySelector('.tool')?.textContent).toContain('Bash');
    expect(root?.querySelector('.row.assistant strong')?.textContent).toBe('Hola');
    expect(root?.querySelector('.tool-detail')).toBeNull();
    root?.querySelector<HTMLButtonElement>('button.tool')?.click();
    await view.updateComplete;
    expect(root?.querySelector('.tool-detail')?.textContent).toContain('$ ls');
    expect(root?.querySelector('.tool-detail')?.textContent).toContain('a.txt');
    expect(root?.querySelector('.typing')).toBeTruthy();
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    root?.querySelector<HTMLButtonElement>('.stop')?.click();
    expect(sent).toHaveBeenCalledWith('\x1b');
    expect(view.hasAttribute('unavailable')).toBe(false);

    respond.mockResolvedValue({ available: false, messages: [] });
    view.sessionId = 's2';
    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
  });

  it('shows a conversation seen before at once when switched back to (user report)', async () => {
    const respond = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        available: true,
        status: 'idle',
        messagesVersion: url.includes('s1') ? 'v1' : 'v2',
        messages: url.includes('s1')
          ? [{ id: 'a', role: 'assistant', text: 'hola desde s1' }]
          : [{ id: 'b', role: 'assistant', text: 'hola desde s2' }],
      }),
    }));
    vi.stubGlobal('fetch', respond);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.shadowRoot?.textContent).toContain('hola desde s1'));
    view.sessionId = 's2';
    await vi.waitFor(() => expect(view.shadowRoot?.textContent).toContain('hola desde s2'));

    // The poll for s1 never answers: what shows comes from the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    view.sessionId = 's1';
    await view.updateComplete;
    await view.updateComplete;
    expect(view.shadowRoot?.textContent).toContain('hola desde s1');
    expect(view.shadowRoot?.textContent).not.toContain('hola desde s2');
    expect(view.shadowRoot?.querySelector('.empty[role="status"]')).toBeNull();
  });

  it('keeps the mode chip steady through a torn footer redraw (user report)', async () => {
    stubChat([{ id: 'a', role: 'assistant', text: 'hola' }]);
    const real = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
    const torn = '  ◯⏵file-browser-search on (shi▱▱▱▱';
    let screen = real;
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'mode-s';
    view.getScreenTail = () => screen;
    document.body.appendChild(view);
    const internals = view as unknown as { apply(chat: unknown): void; mode: string | null };
    await vi.waitFor(() => expect(internals.mode).toBe('Bypass permissions'));
    const chat = { available: true, status: 'idle', messages: [] };
    for (const next of [torn, real, torn, '', real, 'garbage', real, torn]) {
      screen = next || ' ';
      internals.apply(chat);
      expect(internals.mode).toBe('Bypass permissions');
    }
  });

  it('shows the remembered mode while the terminal replays, never a stored workflow name', async () => {
    stubChat([{ id: 'a', role: 'assistant', text: 'hola' }]);
    sessionStorage.setItem('ut-claude-mode-replay-s', 'Plan mode');
    sessionStorage.setItem('ut-claude-mode-stale-s', 'File-browser-search');
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'replay-s';
    view.screenSettling = () => true;
    view.getScreenTail = () => '  ◯ old screen from the history';
    document.body.appendChild(view);
    await view.updateComplete;
    const internals = view as unknown as { apply(chat: unknown): void; mode: string | null };
    const chat = { available: true, status: 'idle', messages: [] };
    internals.apply(chat);
    expect(internals.mode).toBe('Plan mode');

    view.sessionId = 'stale-s';
    await view.updateComplete;
    internals.apply(chat);
    expect(internals.mode).toBeNull();
    sessionStorage.clear();
  });

  it('reads an answer aloud, one at a time, and stops on a second tap', async () => {
    const spoken: Array<{ text: string; lang: string; onend?: () => void }> = [];
    const synth = {
      speak: vi.fn((u: { text: string; lang: string }) => spoken.push(u)),
      cancel: vi.fn(),
      getVoices: () => [],
    };
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        constructor(public text: string) {}
      }
    );
    stubChat([
      { id: 'a', role: 'assistant', text: 'Listo, **ya** está.\n```js\nx()\n```' },
      { id: 'b', role: 'assistant', text: 'Otra respuesta' },
    ]);
    const view = await mountChat();
    const buttons = () => view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.speak-msg') ?? [];
    expect(buttons()).toHaveLength(2);

    buttons()[0].click();
    await view.updateComplete;
    expect(spoken[0].text).toBe('Listo, ya está. (code omitted).');
    expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');

    buttons()[1].click();
    await view.updateComplete;
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken).toHaveLength(2);
    expect(buttons()[0].getAttribute('aria-pressed')).toBe('false');

    buttons()[1].click();
    await view.updateComplete;
    expect(spoken).toHaveLength(2);
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('false');
  });

  it("reads aloud with the Mac's voice when it has one, heard in silent mode", async () => {
    // The phone's own speech synthesis said nothing on an iPhone in silent mode (2026-10-03).
    resetMacVoiceCheck();
    const unlock = vi.spyOn(VoicePlayer.prototype, 'unlock').mockImplementation(() => {});
    let finish: () => void = () => {};
    const speak = vi
      .spyOn(VoicePlayer.prototype, 'speak')
      .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const phone = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] };
    vi.stubGlobal('speechSynthesis', phone);
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        constructor(public text: string) {}
      }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes('/api/tts/status')
            ? { available: true, engine: 'kokoro' }
            : {
                available: true,
                status: 'idle',
                messages: [{ id: 'a', role: 'assistant', text: 'Hecho.' }],
              },
      }))
    );
    try {
      const view = await mountChat();
      const button = () => view.shadowRoot?.querySelector<HTMLButtonElement>('.speak-msg');
      await vi.waitFor(() =>
        expect((view as unknown as { macVoice: boolean }).macVoice).toBe(true)
      );
      button()?.click();
      expect(unlock).toHaveBeenCalled();
      expect(speak).toHaveBeenCalledWith('Hecho.', expect.any(String), expect.any(AbortSignal));
      expect(phone.speak).not.toHaveBeenCalled();
      await view.updateComplete;
      expect(button()?.getAttribute('aria-pressed')).toBe('true');
      finish();
      await vi.waitFor(() => expect(button()?.getAttribute('aria-pressed')).toBe('false'));
    } finally {
      unlock.mockRestore();
      speak.mockRestore();
      resetMacVoiceCheck();
    }
  });

  it('hides the read aloud button without speech synthesis', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    stubChat([{ id: 'a', role: 'assistant', text: 'hola' }]);
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.copy-msg')).toBeTruthy();
    expect(view.shadowRoot?.querySelector('.speak-msg')).toBeNull();
  });

  it('shares an answer as text where the phone can share', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: shareMock });
    stubChat([
      { id: 'u', role: 'user', text: 'hola' },
      { id: 'a', role: 'assistant', text: 'Respuesta **útil**' },
    ]);
    const view = await mountChat();
    const buttons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('.share-msg') ?? [];
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(shareMock).toHaveBeenCalledWith({ text: 'Respuesta **útil**' });
  });

  it('offers no share button without the share sheet', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: undefined });
    stubChat([{ id: 'a', role: 'assistant', text: 'hola' }]);
    const view = await mountChat();
    expect(view.shadowRoot?.querySelector('.share-msg')).toBeNull();
  });

  it('finds words in the conversation and steps through the matches', async () => {
    stubChat([
      { id: '1', role: 'user', text: 'fix the <b>build</b> please' },
      { id: '2', role: 'assistant', text: 'The **build** passes.\n```sh\npnpm build\n```' },
      { id: '3', role: 'assistant', text: 'nothing here' },
    ]);
    const view = await mountChat();
    const root = view.shadowRoot as ShadowRoot;
    // A finger lands on the real field over the icon (iOS ignores a scripted focus()).
    root.querySelector<HTMLInputElement>('.search-proxy')?.focus();
    await view.updateComplete;
    const input = root.querySelector<HTMLInputElement>('.search-bar input');
    if (!input) throw new Error('no search field');
    input.value = 'BUILD';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(root.querySelector('.search-count')?.textContent).toBe('3/3'));

    const marks = [...root.querySelectorAll('mark.hit')];
    expect(marks.map((m) => m.textContent)).toEqual(['build', 'build', 'build']);
    expect(marks[2].classList.contains('current')).toBe(true);
    // The user's literal <b> stays text: matching never turns it into markup.
    expect(root.querySelector('.row.user .md')?.textContent).toBe('fix the <b>build</b> please');
    expect(root.querySelector('.row.user b')).toBeNull();

    root.querySelector<HTMLButtonElement>('.search-prev')?.click();
    await view.updateComplete;
    expect(root.querySelector('.search-count')?.textContent).toBe('2/3');
    expect(root.querySelectorAll('mark.hit')[1].classList.contains('current')).toBe(true);
    root.querySelector<HTMLButtonElement>('.search-next')?.click();
    root.querySelector<HTMLButtonElement>('.search-next')?.click();
    await view.updateComplete;
    expect(root.querySelector('.search-count')?.textContent).toBe('1/3');

    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() =>
      expect(root.querySelector('.search-count')?.textContent).toBe('No results')
    );

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await view.updateComplete;
    expect(root.querySelector('.search-bar')).toBeNull();
    expect(root.querySelector('mark.hit')).toBeNull();
    expect(root.querySelector('.row.assistant .md')?.innerHTML).toContain('<strong>build</strong>');
  });
});

describe('ClaudeChatView messages sent from the phone', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetGhostClickGuard();
    document.body.innerHTML = '';
  });

  type Internals = { apply(chat: unknown): void };
  const sent = (text: string, id: string, at = Date.now()) => ({
    sessionId: 's1',
    id,
    text,
    at,
    startedAt: performance.now(),
  });
  const now = () => new Date().toISOString();
  const earlier = { id: 'u0', role: 'user', text: 'ok', timestamp: '2026-10-03T08:00:00Z' };
  /** Mounted on a conversation that already has an "ok"; the server answers nothing more. */
  const mountQuiet = async () => {
    stubChat([
      earlier,
      { id: 'a0', role: 'assistant', text: 'hecho', timestamp: earlier.timestamp },
    ]);
    const view = await mountChat();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    return view;
  };
  const sending = (view: ClaudeChatView) => [
    ...(view.shadowRoot?.querySelectorAll('.row.user[data-send]') ?? []),
  ];
  const userTexts = (view: ClaudeChatView) =>
    [...(view.shadowRoot?.querySelectorAll('.row.user .md') ?? [])].map((md) => md.textContent);

  it('shows a message the moment it is sent, before any poll answers', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('arregla el login', 'p1'));
    // Lit's render (a microtask): no fetch has answered, no timer has run.
    await view.updateComplete;
    const [row] = sending(view);
    expect(row?.getAttribute('data-send')).toBe('sending');
    expect(row?.querySelector('.md')?.textContent).toBe('arregla el login');
    expect(row?.querySelector('.visually-hidden')?.textContent).toBe('Sending…');
    expect(row?.querySelector('.sending-icon')).toBeTruthy();
  });

  it("gives way to the transcript's message, each identical text to one of its own", async () => {
    const view = await mountQuiet();
    const internals = view as unknown as Internals;
    view.addSentMessage(sent('ok', 'p1'));
    view.addSentMessage(sent('ok', 'p2'));
    await view.updateComplete;
    // The "ok" shown before the sends is neither of them.
    expect(sending(view)).toHaveLength(2);
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);

    const first = { id: 'u1', role: 'user', text: ' ok\n', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first] });
    await view.updateComplete;
    // Replaced in the same render: as many bubbles as before, the second still sending.
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);
    expect(sending(view)).toHaveLength(1);

    // The first one's message stands for it only, at the next polls too.
    const reply = { id: 'a1', role: 'assistant', text: 'vale', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first, reply] });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(1);

    const second = { id: 'u2', role: 'user', text: 'ok', timestamp: now() };
    internals.apply({ available: true, status: 'busy', messages: [earlier, first, reply, second] });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
    expect(userTexts(view)).toEqual(['ok', 'ok', 'ok']);
  });

  it('matches a message sent with an image, whether or not its image is logged yet', async () => {
    const view = await mountQuiet();
    const path = '/Users/n/.untether/control/uploads/0b5e-photo.jpg';
    view.addSentMessage(sent(`${path} ¿qué flores son?`, 'p1'));
    (view as unknown as Internals).apply({
      available: true,
      status: 'busy',
      messages: [earlier, { id: 'u1', role: 'user', text: '¿qué flores son?', timestamp: now() }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
  });

  it('takes no older message for it, give or take the clocks', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('sigue', 'p1'));
    const old = new Date(Date.now() - 60_000).toISOString();
    const internals = view as unknown as Internals;
    internals.apply({
      available: true,
      status: 'idle',
      messages: [earlier, { id: 'u1', role: 'user', text: 'sigue', timestamp: old }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(1);
    // The Mac's clock a few seconds behind the phone's.
    const skewed = new Date(Date.now() - 4_000).toISOString();
    internals.apply({
      available: true,
      status: 'busy',
      messages: [earlier, { id: 'u2', role: 'user', text: 'sigue', timestamp: skewed }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
  });

  it('says when it could not be sent; a tap on Retry asks for it again, a drag does not', async () => {
    resetAnnouncerForTests();
    const view = await mountQuiet();
    const retries = vi.fn();
    view.addEventListener('chat-message-retry', (e) => retries((e as CustomEvent).detail));
    view.addSentMessage(sent('usa pnpm', 'p1'));
    view.markSendFailed({ sessionId: 's1', id: 'p1' });
    await view.updateComplete;
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('failed');
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')?.textContent).toContain(
      "Couldn't send"
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('[data-testid="a11y-live-region"]')?.textContent).toBe(
      "Couldn't send"
    );

    const retry = view.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="send-retry"]');
    if (!retry) throw new Error('no Retry button');
    expect(retry.textContent?.trim()).toBe('Retry');
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 200,
        clientY: y,
        bubbles: true,
        composed: true,
      });
      retry.dispatchEvent(new PointerEvent('pointerdown', at(600)));
      retry.dispatchEvent(new PointerEvent('pointerup', at(600 + dy)));
    };
    touch(-80);
    expect(retries).not.toHaveBeenCalled();
    touch(2);
    // The click that follows the tap does not ask a second time.
    retry.click();
    expect(retries).toHaveBeenCalledTimes(1);
    expect(retries).toHaveBeenCalledWith({ sessionId: 's1', id: 'p1' });
    // From the keyboard.
    resetGhostClickGuard();
    retry.click();
    expect(retries).toHaveBeenCalledTimes(2);

    // The composer sends it again: sending, under the same id, no Retry.
    view.addSentMessage(sent('usa pnpm', 'p1'));
    await view.updateComplete;
    expect(sending(view).map((row) => row.getAttribute('data-send'))).toEqual(['sending']);
    expect(view.shadowRoot?.querySelector('[data-testid="send-retry"]')).toBeNull();
  });

  it('says "not confirmed" after 30 s without word, with no Retry, until it comes', async () => {
    const view = await mountQuiet();
    vi.useFakeTimers();
    view.addSentMessage(sent('y la temperatura?', 'p1'));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('sending');
    await vi.advanceTimersByTimeAsync(1_000);
    await view.updateComplete;
    expect(sending(view)[0]?.getAttribute('data-send')).toBe('unconfirmed');
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')?.textContent?.trim()).toBe(
      'Not confirmed yet'
    );
    expect(view.shadowRoot?.querySelector('[data-testid="send-retry"]')).toBeNull();

    // Claude Code took it once done with what it was doing (a queued message).
    (view as unknown as Internals).apply({
      available: true,
      status: 'busy',
      messages: [earlier, { id: 'u1', role: 'user', text: 'y la temperatura?', timestamp: now() }],
    });
    await view.updateComplete;
    expect(sending(view)).toHaveLength(0);
    expect(view.shadowRoot?.querySelector('[data-testid="send-note"]')).toBeNull();
  });

  it('keeps a message that never came before the one sent after it, not below it', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('!ls', 'p1'));
    view.addSentMessage(sent('hola', 'p2'));
    (view as unknown as Internals).apply({
      available: true,
      status: 'idle',
      messages: [
        earlier,
        { id: 'u2', role: 'user', text: 'hola', timestamp: now() },
        { id: 'a2', role: 'assistant', text: 'hey', timestamp: now() },
      ],
    });
    await view.updateComplete;
    const rows = [...(view.shadowRoot?.querySelectorAll('.row') ?? [])].map(
      (row) => `${row.getAttribute('data-send') ?? ''}${row.querySelector('.md')?.textContent}`
    );
    expect(rows).toEqual(['ok', 'sending!ls', 'hola', 'hey']);
  });

  it("logs one QA timing line per send: its bubble, then Claude's thinking", async () => {
    const view = await mountQuiet();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const lines = () =>
        log.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('chat timing'));
      view.addSentMessage(sent('hola', 'p1'));
      await view.updateComplete;
      expect(lines()).toEqual([]);
      const internals = view as unknown as Internals;
      internals.apply({ available: true, status: 'busy', messages: [earlier] });
      await view.updateComplete;
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/chat timing: bubble \d+ ms, thinking \d+ ms$/);
      // Later polls while Claude works add nothing.
      internals.apply({
        available: true,
        status: 'busy',
        messages: [earlier, { ...earlier, id: 'x' }],
      });
      await view.updateComplete;
      expect(lines()).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps sent messages to their session', async () => {
    const view = await mountQuiet();
    view.addSentMessage(sent('hola', 'p1'));
    view.addSentMessage({ ...sent('otra', 'p2'), sessionId: 's2' });
    await view.updateComplete;
    expect(userTexts(view)).toEqual(['ok', 'hola']);

    view.sessionId = 's2';
    await view.updateComplete;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
    view.sessionId = 's1';
    await view.updateComplete;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
  });

  it('shows nothing for a session that is not an agent chat (a shell)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ available: false, messages: [] }) }))
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    await vi.waitFor(() => expect(view.hasAttribute('unavailable')).toBe(true));
    view.addSentMessage(sent('ls', 'p1'));
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector('[data-send]')).toBeNull();
  });
});

describe('ClaudeChatView with the phone keyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  const scrolledUp = async () => {
    stubChat([
      { id: '1', role: 'user', text: 'hi' },
      { id: '2', role: 'assistant', text: 'hello' },
    ]);
    const view = await mountChat();
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('wheel'));
    scroller.dispatchEvent(new Event('scroll'));
    await view.updateComplete;
    return { view, scroller };
  };

  it('followLatest (the composer was focused) brings a scrolled-up conversation to its end', async () => {
    const { view, scroller } = await scrolledUp();
    expect(view.shadowRoot?.querySelector('.jump')).toBeTruthy();

    view.followLatest();
    await view.updateComplete;
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scroller.scrollTop).toBe(2000);
    expect(view.shadowRoot?.querySelector('.jump')).toBeNull();
  });

  it('stays on the latest message within the same frame when the keyboard resizes it', async () => {
    let onResize: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
    stubChat([{ id: '1', role: 'assistant', text: 'hello' }]);
    const view = await mountChat();
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });
    scroller.scrollTop = 0;

    onResize();

    // No frame painted with the conversation shifted: followed before the next paint.
    expect(scroller.scrollTop).toBe(1200);
  });

  // User report (2026-10-14): a permission card docking over the composer shrinks only the
  // scroller (the view keeps its size), and the transcript jumped ~160 px for a couple of
  // frames until the next frame's scroll caught up.
  it('stays on the latest message within the same frame when the dock over the composer grows', async () => {
    let onResize: () => void = () => {};
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {
          observed.length = 0;
        }
      }
    );
    stubChat([{ id: '1', role: 'assistant', text: 'hello' }]);
    const view = await mountChat();
    const scroller = view.shadowRoot?.querySelector<HTMLElement>('.scroller');
    if (!scroller) throw new Error('no scroller');
    expect(observed).toContain(scroller);

    // The dock took 160 px off the scroller: the bottom is followed before the next paint.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 340 });
    scroller.scrollTop = 700;
    onResize();
    expect(scroller.scrollTop).toBe(1200);

    // Moved in the page and back: still watched.
    view.remove();
    document.body.appendChild(view);
    expect(observed).toContain(scroller);
  });
});

describe('ClaudeChatView polling', () => {
  let visibility: DocumentVisibilityState = 'visible';
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const answer = (status: string) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        status,
        messages: [{ id: 'a', role: 'assistant', text: 'hola' }],
      }),
    }));

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    // Mocks first: the setTimeout spy of one test wraps the FAKE timer, and restoring it
    // after useRealTimers put the dead fake back for every later test (2026-11-10).
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mount() {
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    document.body.appendChild(view);
    return view;
  }

  it('keeps the conversation through a 503 while the server restarts; steps aside only on 404 (2026-10-20 review)', async () => {
    let status = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        status === 200
          ? Response.json({
              available: true,
              status: 'idle',
              messages: [{ id: 'a', role: 'assistant', text: 'hola' }],
            })
          : Response.json({ error: 'x' }, { status })
      )
    );
    const view = mount();
    const internals = view as unknown as { messages: unknown[]; offline: boolean; poll(): void };
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.messages).toHaveLength(1);

    status = 503;
    internals.poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.messages).toHaveLength(1);
    expect(view.hasAttribute('unavailable')).toBe(false);
    expect(internals.offline).toBe(true);

    status = 404;
    internals.poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.unavailable).toBe(true);
    expect(internals.offline).toBe(false);
  });

  it('counts nothing as unread when no message was shown before (2026-10-20 review)', async () => {
    vi.stubGlobal('fetch', answer('idle'));
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    const internals = view as unknown as {
      messages: unknown[];
      stickToBottom: boolean;
      unread: number;
      apply(chat: unknown): boolean;
    };
    const assistant = (id: string) => ({ id, role: 'assistant', text: id });
    internals.messages = [];
    internals.stickToBottom = false;
    internals.unread = 0;
    internals.apply({
      available: true,
      status: 'idle',
      messagesVersion: 'v1',
      messages: [assistant('1'), assistant('2'), assistant('3')],
    });
    expect(internals.unread).toBe(0);
    // Still counted once something was shown.
    internals.apply({
      available: true,
      status: 'idle',
      messagesVersion: 'v2',
      messages: [assistant('1'), assistant('2'), assistant('3'), assistant('4')],
    });
    expect(internals.unread).toBe(1);
  });

  it('stops while the page is hidden and fetches at once when it is shown', async () => {
    const fetchMock = answer('busy');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No poll timer wakes the phone while hidden (it used to every 1.5 s).
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 1500)).toHaveLength(0);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps 1.5 s while Claude works: 40 requests per minute', async () => {
    const fetchMock = answer('busy');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(41); // first fetch at 0 s, then every 1.5 s
  });

  it('checks a non-Claude session (a shell in chat mode) only every 5 s', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ available: false, messages: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    // 60 s at one check every 5 s is about 12 calls: not more than 13, and still polling.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(13);
  });

  it('polls at once after a send, again at about 300 ms and 800 ms, then at the usual pace', async () => {
    // Claude's "thinking" showed a poll after it started: up to 1.5 s late (2026-10-03).
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ available: true, status: 'idle', messages: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    await vi.advanceTimersByTimeAsync(700);
    expect(polls()).toBe(1);

    view.addSentMessage({ sessionId: 's1', id: 'p1', text: 'hola', at: Date.now(), startedAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(polls()).toBe(4);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(polls()).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(5);
  });

  it('polls at once after an answer from the question card too', async () => {
    // "Thinking…" after tapping "Yes" on a permission came with the usual pace, 1.5 s later.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/answer')
        ? new Response('{}', { status: 200 })
        : Response.json({ available: true, status: 'waiting', waitingFor: 'Bash', messages: [] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    view.getScreenTail = () => 'Overwrite it with the new defaults? (y/n)';
    await vi.advanceTimersByTimeAsync(700);
    await view.updateComplete;
    const before = polls();
    view.shadowRoot?.querySelector<HTMLButtonElement>('.question button')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/answer'))).toBe(true);
    expect(polls()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(polls()).toBe(before + 2);
  });

  it('makes up for the polls a slow answer let pass with one at once', async () => {
    let finish: () => void = () => {};
    let chatCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      const answer = {
        ok: true,
        json: async () => ({ available: true, status: 'idle', messages: [] }),
      };
      return url.includes('/claude-chat') && ++chatCalls === 2
        ? new Promise((resolve) => (finish = () => resolve(answer)))
        : Promise.resolve(answer);
    });
    vi.stubGlobal('fetch', fetchMock);
    const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/claude-chat')).length;
    const view = mount();
    await vi.advanceTimersByTimeAsync(100);
    view.addSentMessage({ sessionId: 's1', id: 'p1', text: 'hola', at: Date.now(), startedAt: 0 });
    // The poll sent at once takes 900 ms: both later ones fell due meanwhile.
    await vi.advanceTimersByTimeAsync(900);
    expect(polls()).toBe(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(polls()).toBe(3);
  });

  it('slows to 3 s on an idle conversation and comes back on a tap', async () => {
    const fetchMock = answer('idle');
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await vi.advanceTimersByTimeAsync(60_000);
    const firstMinute = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length - firstMinute).toBe(20);
    expect(firstMinute).toBeLessThan(41);

    const before = fetchMock.mock.calls.length;
    document.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(before + 2);
  });
});

// An agent running outside Untether, or a tmux session opened to watch: its conversation is
// followed from its own address, and nothing on screen may type into it.
describe('ClaudeChatView read-only', () => {
  let chat: Record<string, unknown> = {};

  beforeEach(() => {
    resetMacVoiceCheck();
    chat = { available: true, status: 'idle', messages: [] };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function mountReadOnly() {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith('/api/mac-sessions/')
        ? Response.json(structuredClone(chat))
        : Response.json({ engine: 'say' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'mac:a-20085-1759500000';
    view.chatUrl = '/api/mac-sessions/a-20085-1759500000/chat';
    view.readOnly = true;
    const sent = vi.fn();
    view.addEventListener('claude-chat-input', (e) => sent((e as CustomEvent<string>).detail));
    document.body.appendChild(view);
    const chatUrls = () =>
      fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/mac-'));
    return { view, fetchMock, sent, chatUrls };
  }

  const apply = (view: ClaudeChatView, answer: Record<string, unknown>) =>
    (view as unknown as { apply(chat: unknown): void }).apply(answer);

  it('reads the conversation from its own address, with the fingerprint it shows', async () => {
    vi.useFakeTimers();
    chat = {
      available: true,
      status: 'busy',
      messages: [{ id: '1', role: 'assistant', text: 'Hecho.' }],
      messagesVersion: 'v1',
    };
    const { view, chatUrls } = mountReadOnly();
    await vi.advanceTimersByTimeAsync(0);
    expect(chatUrls()).toEqual(['/api/mac-sessions/a-20085-1759500000/chat']);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(chatUrls()[1]).toBe('/api/mac-sessions/a-20085-1759500000/chat?have=v1');
    expect(view.hasAttribute('readonly')).toBe(true);
    expect(view.shadowRoot?.textContent).toContain('Hecho.');
  });

  it('shows what is asked without its options, and no Stop, mode, voice or Open terminal', async () => {
    chat = {
      available: true,
      status: 'waiting',
      waitingFor: 'input needed',
      messages: [
        { id: 'a', role: 'assistant', text: 'Una pregunta:' },
        {
          id: 'q',
          role: 'tool',
          tool: 'AskUserQuestion',
          text: '',
          question: { text: '¿Fruta?', options: ['Manzana', 'Fresa'] },
        },
      ],
    };
    const { view, fetchMock, sent } = mountReadOnly();
    // A mode line and a menu on screen (a tmux session opened to watch has a screen).
    let screen = '  ⏵⏵ accept edits on (shift+tab to cycle)';
    view.getScreenTail = () => screen;
    await vi.waitFor(() => expect(view.shadowRoot?.querySelector('.question')).toBeTruthy());
    const root = view.shadowRoot as ShadowRoot;
    const note = "It's waiting for an answer where it runs.".replace("'", '’');

    expect(root.querySelector('.question')?.textContent).toContain('¿Fruta?');
    expect(root.querySelectorAll('.question button')).toHaveLength(0);
    expect(root.querySelector('[data-testid="read-only-question"]')?.textContent).toBe(note);
    expect(root.querySelector('[data-testid="mode-chip"]')).toBeNull();
    expect(root.querySelector('.voice-toggle')).toBeNull();
    // Search reads, so it stays; alone on the right, the title keeps its usual inset.
    expect(root.querySelector('.search-toggle')).toBeTruthy();
    expect(root.querySelector('.top')?.classList.contains('two-icons')).toBe(false);

    screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n  ⏵⏵ accept edits on';
    apply(view, { available: true, status: 'waiting', waitingFor: 'permission', messages: [] });
    await view.updateComplete;
    expect(root.querySelector('.question')?.textContent).toContain('Do you want to proceed?');
    expect(root.querySelectorAll('.question button')).toHaveLength(0);
    expect(root.querySelector('[data-testid="read-only-question"]')).toBeTruthy();

    screen = '';
    apply(view, { available: true, status: 'waiting', waitingFor: 'permission', messages: [] });
    await view.updateComplete;
    expect(root.querySelector('.waiting')?.textContent).toContain('permission');
    expect(root.querySelectorAll('.waiting button')).toHaveLength(0);
    expect(root.querySelector('.waiting [data-testid="read-only-question"]')).toBeTruthy();

    apply(view, {
      available: true,
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target: 'npm test' },
      messages: [],
    });
    await view.updateComplete;
    expect(root.querySelector('.typing')).toBeTruthy();
    expect(root.querySelector('[data-testid="chat-activity"]')?.textContent).toContain('Claude ·');
    expect(root.querySelector('.stop')).toBeNull();

    // Nor through the methods those controls would call.
    const internals = view as unknown as { answer(index: number): Promise<void>; stop(): void };
    await internals.answer(0);
    internals.stop();
    expect(sent).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/answer'))).toBe(false);
  });

  it('does not ask for a message below when there is nowhere to write one', async () => {
    const { view } = mountReadOnly();
    await vi.waitFor(() =>
      expect(view.shadowRoot?.querySelector('.empty')?.getAttribute('role')).toBeNull()
    );
    expect(view.shadowRoot?.querySelector('.empty')?.textContent?.trim()).toBe('No messages yet.');
  });

  it('tells whoever shows it that the conversation is gone (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/mac-sessions/')
          ? Response.json({ error: 'gone' }, { status: 404 })
          : Response.json({})
      )
    );
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'mac:a-1-2';
    view.chatUrl = '/api/mac-sessions/a-1-2/chat';
    view.readOnly = true;
    const errors = vi.fn();
    view.addEventListener('claude-chat-error', (e) => errors((e as CustomEvent<number>).detail));
    document.body.appendChild(view);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(404));
    expect(view.hasAttribute('unavailable')).toBe(true);
  });
});

// Phone addendum (phone-spec §3.5-3.7, 2026-10-12): no title bar, the mode row on top, the
// prompt or the busy strip docked over the composer, folded tool rows, icons on the latest
// answer only, 24 h times at the end of the last bubble of a run.
describe('ClaudeChatView on a phone', () => {
  const detect = ClaudeChatView.detectPhone;
  let chat: Record<string, unknown>;

  beforeEach(async () => {
    ClaudeChatView.detectPhone = () => true;
    await setLocale('es');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/claude-chat')
          ? { ok: true, json: async () => chat }
          : { ok: false, json: async () => ({}) }
      )
    );
  });

  afterEach(async () => {
    ClaudeChatView.detectPhone = detect;
    await setLocale('en');
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-keyboard-visible');
  });

  async function mount(screen = '') {
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 's1';
    view.getScreenTail = () => screen;
    view.getMenuScreen = () => screen;
    document.body.appendChild(view);
    const internals = view as unknown as { loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    return { view, root: view.shadowRoot as ShadowRoot };
  }

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it('drops the title bar and puts the mode and status in one row on top', async () => {
    chat = {
      available: true,
      status: 'idle',
      title: 'Validación',
      messages: [{ id: 'u', role: 'user', text: 'hola', timestamp: at(1) }],
    };
    const { view, root } = await mount('  ⏵⏵ accept edits on (shift+tab to cycle)');
    expect(view.hasAttribute('phone')).toBe(true);
    expect(root.querySelector('.top')).toBeNull();
    const row = root.querySelector('[data-testid="chat-phone-row"]');
    expect(row).not.toBeNull();
    // On top: before the conversation, not under it.
    expect(row?.nextElementSibling?.classList.contains('scroll-area')).toBe(true);
    expect(row?.querySelector('[data-testid="mode-chip"] svg')).not.toBeNull();
    expect(row?.querySelector('.row-search')).not.toBeNull();
    // Voice is the composer's now.
    expect(root.querySelector('.voice-toggle')).toBeNull();

    // The keyboard up hides the row (the session view owns the attribute).
    document.documentElement.setAttribute('data-keyboard-visible', 'true');
    await vi.waitFor(() => expect(view.hasAttribute('kbd')).toBe(true));
  });

  it('reads options the terminal soft-wrapped at column 0 whole', async () => {
    chat = {
      available: true,
      status: 'waiting',
      waitingFor: 'permission prompt',
      messages: [{ id: 'a', role: 'assistant', text: 'Voy a limpiar.', timestamp: at(1) }],
    };
    const rows = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for pnpm build c",
      'ommands in /repo',
      '   3. No, and tell Claude what to do differently (esc)',
    ];
    const { view, root } = await mount(rows.join('\n'));
    view.getScreenLayout = () => ({ cols: 45, wrappedRows: [false, false, false, true, false] });
    (view as unknown as { readScreenMenu: (w: boolean) => void }).readScreenMenu(true);
    await view.updateComplete;
    const labels = [...root.querySelectorAll('.pd-option .pd-label')].map((o) => o.textContent);
    expect(labels[1]).toBe('Sí, y no preguntar más por pnpm build en /repo');
  });

  it('tells the session view when it docks a request', async () => {
    chat = { available: true, status: 'waiting', waitingFor: 'permission prompt', messages: [] };
    const states: unknown[] = [];
    const listen = (e: Event) => states.push((e as CustomEvent).detail);
    document.addEventListener('claude-chat-state', listen);
    try {
      await mount();
      await vi.waitFor(() =>
        expect(states.some((s) => (s as { promptDocked?: boolean }).promptDocked)).toBe(true)
      );
    } finally {
      document.removeEventListener('claude-chat-state', listen);
    }
  });

  it('docks a permission prompt over the composer, translated, option 1 primary', async () => {
    chat = {
      available: true,
      status: 'waiting',
      waitingFor: 'permission prompt',
      messages: [{ id: 'a', role: 'assistant', text: 'Voy a limpiar.', timestamp: at(1) }],
    };
    const screen = [
      '────────────────────────────────────────',
      ' Bash command',
      '',
      '   rm -rf dist/ && pnpm build',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for pnpm build commands in /repo",
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const { root } = await mount(screen);
    await vi.waitFor(() => expect(root.querySelector('.dock .pd')).not.toBeNull());
    // Out of the scroller: always in sight.
    expect(root.querySelector('.scroller .pd')).toBeNull();
    expect(root.querySelector('.scroller .question')).toBeNull();
    expect(root.querySelector('.pd-eyebrow')?.textContent).toContain('Claude te necesita');
    expect(root.querySelector('.pd-eyebrow')?.textContent).not.toContain('permission prompt');
    expect(root.querySelector('.pd-question')?.textContent).toBe('¿Continuar?');
    expect(root.querySelector('.pd-detail-label')?.textContent).toBe('Bash command');
    const options = [...root.querySelectorAll<HTMLButtonElement>('.pd-option')];
    expect(options.map((o) => o.querySelector('.pd-label')?.textContent)).toEqual([
      'Sí',
      'Sí, y no preguntar más por pnpm build en /repo',
      'No, y decirle a Claude qué hacer',
    ]);
    expect(options[0].classList.contains('primary')).toBe(true);
    expect(root.querySelector('.pd-link')?.textContent?.trim()).toBe('Abrir terminal');

    // An answer sends Claude's own option, not the translation.
    const fetchMock = vi.mocked(fetch);
    options[1].click();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/answer'))).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([url]) => String(url).endsWith('/answer'))?.[1]?.body)
    );
    expect(body.option).toBe(2);
    expect(body.options[1]).toContain("don't ask again");
  });

  it('"No, and tell Claude…" focuses the composer instead of answering', async () => {
    chat = { available: true, status: 'waiting', waitingFor: 'permission', messages: [] };
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const composer = document.createElement('terminal-chat-view');
    composer.setAttribute('composerOnly', '');
    const focusComposer = vi.fn(() => true);
    Object.assign(composer, { focusComposer });
    document.body.append(composer);
    const { root } = await mount(screen);
    await vi.waitFor(() => expect(root.querySelectorAll('.pd-option')).toHaveLength(2));
    root.querySelectorAll<HTMLButtonElement>('.pd-option')[1].click();
    expect(focusComposer).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/answer'))).toBe(
      false
    );
  });

  it('a question from the conversation is docked, its tool row hidden', async () => {
    chat = {
      available: true,
      status: 'waiting',
      waitingFor: 'input needed',
      messages: [
        { id: 'a', role: 'assistant', text: 'Una pregunta', timestamp: at(1) },
        {
          id: 'q',
          role: 'tool',
          tool: 'AskUserQuestion',
          text: '¿Fruta?',
          question: { text: '¿Fruta?', options: ['Manzana', 'Fresa'] },
        },
      ],
    };
    const { root } = await mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.dock .pd-option')).toHaveLength(2));
    expect(root.querySelector('button.tool')).toBeNull();
  });

  it('shows the busy strip with Stop in the dock, and tells the composer', async () => {
    chat = {
      available: true,
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: Date.now() - 5000 },
      messages: [{ id: 'u', role: 'user', text: 'tests', timestamp: at(1) }],
    };
    const states: Array<{ busy: boolean }> = [];
    document.addEventListener('claude-chat-state', (e) =>
      states.push((e as CustomEvent<{ busy: boolean }>).detail)
    );
    const { root } = await mount();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="chat-busy-strip"]')).not.toBeNull()
    );
    expect(root.querySelector('.scroller .busy-row')).toBeNull();
    expect(root.querySelector('[data-testid="chat-activity"]')?.textContent).toContain('pnpm test');
    const stop = root.querySelector('.dock-busy .stop');
    expect(stop?.textContent?.trim()).toBe('Detener');
    expect(stop?.querySelector('svg')).not.toBeNull();
    expect(stop?.textContent).not.toContain('■');
    expect(states.at(-1)?.busy).toBe(true);
  });

  it('folds a run of tool rows into "N pasos"; an error always shows', async () => {
    chat = {
      available: true,
      status: 'idle',
      messages: [
        { id: 'a', role: 'assistant', text: 'Voy', timestamp: at(3) },
        {
          id: 't1',
          role: 'tool',
          tool: 'Read',
          text: 'src/app.ts',
          detail: 'src/app.ts',
          result: '',
        },
        {
          id: 't2',
          role: 'tool',
          tool: 'Bash',
          text: 'pnpm test',
          detail: 'pnpm test',
          result: 'boom',
          isError: true,
        },
        { id: 't3', role: 'tool', tool: 'Edit', text: 'app.ts', detail: 'app.ts', result: 'ok' },
        { id: 'b', role: 'assistant', text: 'Hecho', timestamp: at(1) },
      ],
    };
    const { root } = await mount();
    const steps = root.querySelector<HTMLButtonElement>('[data-testid="chat-steps"]');
    expect(steps?.textContent?.trim()).toBe('3 pasos');
    expect(steps?.getAttribute('aria-expanded')).toBe('false');
    // Folded, only the failed step shows, with its verb and target.
    const shown = [...root.querySelectorAll('button.tool')];
    expect(shown).toHaveLength(1);
    expect(shown[0].querySelector('.tool-verb')?.textContent).toBe('Ejecutando');
    expect(shown[0].querySelector('.tool-target')?.textContent).toBe('pnpm test');
    expect(shown[0].querySelector('svg')).not.toBeNull();
    steps?.click();
    await (root.host as ClaudeChatView).updateComplete;
    expect(root.querySelectorAll('button.tool')).toHaveLength(3);
    expect(root.querySelector('button.tool .tool-verb')?.textContent).toBe('Leyendo');
  });

  it('icons on the latest answer only; the others say how to open them, and a long press does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    chat = {
      available: true,
      status: 'idle',
      messages: [
        { id: 'a1', role: 'assistant', text: 'Primera', timestamp: at(10) },
        { id: 'u1', role: 'user', text: 'vale', timestamp: at(9) },
        { id: 'a2', role: 'assistant', text: 'Última', timestamp: at(8) },
      ],
    };
    const { view, root } = await mount();
    const bubbles = [...root.querySelectorAll<HTMLElement>('.row.assistant .bubble')];
    expect(bubbles[0].querySelector('.msg-actions')).toBeNull();
    expect(bubbles[1].querySelector('.msg-actions .copy-msg')).not.toBeNull();
    expect(bubbles[0].className).not.toMatch(/actions-\d/);
    expect(bubbles[0].querySelector('.visually-hidden')?.textContent).toBe(
      'Mantén pulsado para opciones'
    );
    bubbles[0].dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true })
    );
    await vi.advanceTimersByTimeAsync(600);
    await view.updateComplete;
    // A phone's bottom action sheet (phone spec 3.2), in <body>, not a popover in the view.
    expect(root.querySelector('.msg-menu')).toBeNull();
    const sheet = document.querySelector('[data-testid="msg-sheet"]');
    expect(sheet?.classList.contains('psr-sheet')).toBe(true);
    expect(sheet?.textContent).toContain('Copiar mensaje');
    expect(sheet?.querySelector('[data-testid="psr-sheet-cancel"]')).not.toBeNull();
    vi.useRealTimers();
  });

  it('24 h times at the end of the text, on the last bubble of a run only', async () => {
    const base = new Date();
    base.setHours(22, 31, 0, 0);
    const iso = (offsetMin: number) => new Date(base.getTime() + offsetMin * 60_000).toISOString();
    chat = {
      available: true,
      status: 'idle',
      messages: [
        { id: 'u1', role: 'user', text: 'uno', timestamp: iso(0) },
        { id: 'u2', role: 'user', text: 'dos', timestamp: iso(1) },
        { id: 'a1', role: 'assistant', text: 'vale', timestamp: iso(2) },
      ],
    };
    const { root } = await mount();
    const times = [...root.querySelectorAll('.row')].map(
      (row) => row.querySelector('.time-inline')?.textContent?.trim() ?? null
    );
    expect(times).toEqual([null, '22:32', '22:33']);
    // Inside the text, where it floats to the end of the last line.
    expect(root.querySelector('.row.user .md .time-inline')).not.toBeNull();
    expect(root.querySelector('.row .time:not(.time-inline)')).toBeNull();
  });
});

// Desktop chat mode (2026-10-12): the session view shows this view off a phone with `desktop`
// instead of a chat parsed from the terminal's output. The phone's dock and tool anatomy, the
// title bar and its search kept, in a centred column.
describe('ClaudeChatView in desktop chat mode', () => {
  const detect = ClaudeChatView.detectPhone;
  let chat: Record<string, unknown>;

  beforeEach(async () => {
    ClaudeChatView.detectPhone = () => false;
    await setLocale('es');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/claude-chat')
          ? { ok: true, json: async () => chat }
          : { ok: false, json: async () => ({}) }
      )
    );
  });

  afterEach(async () => {
    ClaudeChatView.detectPhone = detect;
    await setLocale('en');
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function mount(screen = '') {
    const view = document.createElement('claude-chat-view') as ClaudeChatView;
    view.sessionId = 'd1';
    view.desktop = true;
    view.getScreenTail = () => screen;
    view.getMenuScreen = () => screen;
    view.getScreenLayout = () => ({ cols: 100 });
    document.body.appendChild(view);
    const internals = view as unknown as { loaded: boolean };
    await vi.waitFor(() => expect(internals.loaded).toBe(true));
    await view.updateComplete;
    return { view, root: view.shadowRoot as ShadowRoot };
  }

  const messages = [
    { id: 'u', role: 'user', text: 'Limpia dist', timestamp: new Date().toISOString() },
    { id: 't1', role: 'tool', tool: 'Read', text: 'package.json', detail: 'package.json' },
    { id: 't2', role: 'tool', tool: 'Bash', text: 'rm -rf dist/', detail: 'rm -rf dist/' },
    { id: 'a', role: 'assistant', text: 'Voy a limpiar.', timestamp: new Date().toISOString() },
  ];

  it('keeps the title bar and its search, without the phone row or the keyboard proxy', async () => {
    chat = { available: true, status: 'idle', title: 'Limpiar', messages };
    const { view, root } = await mount();
    expect(view.hasAttribute('desktop')).toBe(true);
    expect(view.hasAttribute('phone')).toBe(false);
    expect(root.querySelector('.top .title')?.textContent).toBe('Limpiar');
    expect(root.querySelector('.top .search-toggle:not(.voice-toggle)')).not.toBeNull();
    // The iOS keyboard trick took the mouse's click over the button.
    expect(root.querySelector('.search-proxy')).toBeNull();
    expect(root.querySelector('[data-testid="chat-phone-row"]')).toBeNull();
  });

  it('folds tool rows into steps with verbs, as on a phone', async () => {
    chat = { available: true, status: 'idle', messages };
    const { root } = await mount();
    const steps = root.querySelector<HTMLButtonElement>('[data-testid="chat-steps"]');
    expect(steps?.textContent?.trim()).toBe('2 pasos');
    steps?.click();
    await (root.host as ClaudeChatView).updateComplete;
    expect(
      [...root.querySelectorAll('button.tool .tool-verb')].map((verb) => verb.textContent)
    ).toEqual(['Leyendo', 'Ejecutando']);
  });

  it('docks a permission prompt over the composer with its options', async () => {
    chat = { available: true, status: 'waiting', waitingFor: 'permission prompt', messages };
    const screen = [
      ' Bash command',
      '   rm -rf dist/',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for rm commands in /tmp/app",
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const { root } = await mount(screen);
    await vi.waitFor(() => expect(root.querySelector('.dock .pd')).not.toBeNull());
    // Docked: after the scroll area, not at the end of the conversation.
    expect(root.querySelector('.scroller .question')).toBeNull();
    expect(
      root.querySelector('.dock')?.previousElementSibling?.classList.contains('scroll-area')
    ).toBe(true);
    const options = [...root.querySelectorAll('.dock .pd-option')];
    expect(options).toHaveLength(3);
    expect(options[0].classList.contains('primary')).toBe(true);
  });

  it('docks the busy strip with Stop instead of a row in the conversation', async () => {
    chat = {
      available: true,
      status: 'busy',
      activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: Date.now() - 5000 },
      messages,
    };
    const { root } = await mount();
    expect(root.querySelector('.scroller .busy-row')).toBeNull();
    expect(root.querySelector('.dock [data-testid="chat-busy-strip"] .stop')).not.toBeNull();
  });

  it('lays out a centred column of the chat column token only under [desktop]', () => {
    const css = (ClaudeChatView.styles as unknown as Array<{ cssText?: string }>)
      .map((sheet) => sheet.cssText ?? '')
      .join('');
    expect(css).toMatch(
      /:host\(\[desktop\]\) \{[^}]*--chat-column-inset: max\(16px, calc\(\(100% - var\(--ut-chat-column\)\) \/ 2\)\)/
    );
    expect(css).toMatch(/:host\(\[desktop\]\) \.scroller \{[^}]*var\(--chat-column-inset\)/);
  });

  // 2026-11-11: the default chat takes the whole area; a bubble grows with the text up to
  // --ut-chat-bubble-max on its own side, and running text has no measure (it stayed at 76
  // characters pinned left on a 3440 px window).
  it('lets a bubble grow to the bubble token on the desktop, with no measure on running text', () => {
    const css = (ClaudeChatView.styles as unknown as Array<{ cssText?: string }>)
      .map((sheet) => sheet.cssText ?? '')
      .join('');
    expect(css).toMatch(/\n\s*\.prose \{[^}]*display: contents/);
    expect(css).toMatch(
      /:host\(\[desktop\]\) \.bubble \{[^}]*max-width: var\(--ut-chat-bubble-max\)/
    );
    expect(css).not.toContain('--ut-chat-measure');
    expect(css).not.toMatch(/:host\(\[desktop\]\) \.prose/);
    expect(css).not.toContain('.bubble:has(pre');
  });

  it('wraps each run of prose, and neither code nor tables, in .prose', () => {
    const html = renderChatMarkdown(
      'uno\n\n```\ncode\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\ndos'
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    expect([...host.children].map((child) => child.className || child.tagName)).toEqual([
      'prose',
      'PRE',
      'table-wrap',
      'prose',
    ]);
    expect(host.querySelector('.prose pre, .prose table')).toBeNull();
    expect(renderChatMarkdown('```\nsolo\n```')).not.toContain('prose');
  });
});

describe('ClaudeChatView audit fixes (2026-11-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    resetMacVoiceCheck();
  });

  it('asks the Mac for its voice again after a non-OK answer, and keeps a real one', async () => {
    const { checkMacVoice } = await import('./claude-chat-view/speech.js');
    resetMacVoiceCheck();
    let answer: Response = new Response('{}', { status: 401 });
    const fetchMock = vi.fn(async () => answer.clone());
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkMacVoice()).toBe(false);
    answer = Response.json({ engine: 'kokoro' });
    expect(await checkMacVoice()).toBe(true);
    expect(await checkMacVoice()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('uploaded images', () => {
    const upload = '/Users/x/.untether/control/uploads/ab-1.jpeg mira';
    const created: string[] = [];
    const revoked: string[] = [];
    let imageAnswer: Promise<Response> | null = null;

    beforeEach(() => {
      created.length = 0;
      revoked.length = 0;
      imageAnswer = null;
      vi.stubGlobal(
        'URL',
        Object.assign(URL, {
          createObjectURL: vi.fn(() => {
            created.push(`blob:img-${created.length + 1}`);
            return created[created.length - 1];
          }),
          revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
        })
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).startsWith('/api/files/')
            ? (imageAnswer ?? new Response(new Blob(['x'])))
            : Response.json({
                available: true,
                status: 'idle',
                messagesVersion: 'v1',
                messages: [{ id: 'u', role: 'user', text: upload }],
              })
        )
      );
    });

    it('fetches the image again when the view is attached again, not painting a revoked URL', async () => {
      const view = await mountChat();
      await vi.waitFor(() => expect(view.shadowRoot?.querySelector('img.attachment')).toBeTruthy());
      const first = view.shadowRoot?.querySelector('img.attachment')?.getAttribute('src');
      view.remove();
      expect(revoked).toContain(first);
      expect((view as unknown as { imageUrls: Map<string, string> }).imageUrls.size).toBe(0);

      document.body.appendChild(view);
      await vi.waitFor(() => expect(created).toHaveLength(2));
      await vi.waitFor(() => {
        const src = view.shadowRoot?.querySelector('img.attachment')?.getAttribute('src');
        expect(src).toBe(created[1]);
      });
    });

    it('creates no blob URL for a fetch that ends after the view was removed', async () => {
      let finish: (response: Response) => void = () => {};
      imageAnswer = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const view = await mountChat();
      await vi.waitFor(() =>
        expect(
          vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/files/'))
        ).toBe(true)
      );
      view.remove();
      finish(new Response(new Blob(['x'])));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(created).toHaveLength(0);
    });
  });

  it('a poll that brings the same activity again asks for no render', async () => {
    stubChat([{ id: 'a', role: 'assistant', text: 'hola' }]);
    const view = await mountChat();
    const internals = view as unknown as { apply(chat: unknown): boolean };
    const busy = () => ({
      available: true,
      status: 'busy',
      messagesVersion: 'v1',
      activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: 'x' },
      messages: [{ id: 'a', role: 'assistant', text: 'hola' }],
    });
    expect(internals.apply(busy())).toBe(true);
    await view.updateComplete;
    // No property changed: no update is pending.
    expect(internals.apply(busy())).toBe(false);
    expect(view.isUpdatePending).toBe(false);
    // A different activity still renders.
    const next = busy();
    next.activity.target = 'pnpm build';
    expect(internals.apply(next)).toBe(true);
    expect(view.isUpdatePending).toBe(true);
  });

  it('markdown rendered twice is the same, and the label is part of what is remembered', () => {
    const text = 'Run `ls`\n```sh\necho hi\n```';
    const plain = renderChatMarkdown(text);
    expect(renderChatMarkdown(text)).toBe(plain);
    const labelled = renderChatMarkdown(text, 'Copy');
    expect(labelled).toContain('Copy');
    expect(labelled).not.toBe(plain);
    expect(renderChatMarkdown(text)).toBe(plain);
  });
});
