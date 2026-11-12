// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotServerMessage, CopilotSessionChip } from '../../shared/copilot-protocol.js';
import { Z_INDEX } from '../utils/constants.js';
import { type CopilotSheet, MAX_CAPTIONS, openCopilot } from './copilot-sheet.js';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(msg: CopilotServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  json(type: string) {
    return this.sent.filter((m) => (m as { type?: string }).type === type);
  }
}

const param = () => ({
  value: 1,
  cancelScheduledValues() {},
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
});
const node = () => ({ connect() {}, disconnect() {}, gain: param() });
class FakeAudioContext {
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  createGain() {
    return node();
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { ...node(), start() {}, stop() {}, buffer: null, onended: null };
  }
  createOscillator() {
    return { ...node(), start() {}, stop() {}, frequency: param(), type: '' };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const chip = (over: Partial<CopilotSessionChip> = {}): CopilotSessionChip => ({
  sid: 's1',
  sessionId: 'id-1',
  name: 'ecografía',
  status: 'idle',
  error: false,
  focus: false,
  muted: false,
  ...over,
});

function stateMsg(
  sessions: CopilotSessionChip[],
  over: Partial<Extract<CopilotServerMessage, { type: 'state' }>> = {}
): CopilotServerMessage {
  return {
    type: 'state',
    scope: { mode: 'global' },
    sessions,
    pending: null,
    readOnly: false,
    speech: { tts: 'kokoro', ttsReady: true, stt: true },
    brain: 'ready',
    connected: true,
    ...over,
  };
}

const $ = (sheet: CopilotSheet, id: string) =>
  sheet.shadowRoot?.getElementById(id) as HTMLElement | null;

async function opened(scope: Parameters<typeof openCopilot>[0] = { mode: 'global' }) {
  const sheet = openCopilot(scope);
  await sheet.updateComplete;
  const ws = FakeSocket.all[FakeSocket.all.length - 1];
  ws.open();
  await sheet.updateComplete;
  return { sheet, ws };
}

describe('copilot-sheet («Conversar»)', () => {
  let mic: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    mic = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: mic },
      configurable: true,
    });
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, String(v)),
      removeItem: (k: string) => data.delete(k),
      clear: () => data.clear(),
    });
  });
  afterEach(() => {
    for (const s of document.body.querySelectorAll('copilot-sheet')) s.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.overflow = '';
  });

  it('opens inside the tap as one full-screen dialog on <body>, saying hello with its scope', async () => {
    const { sheet, ws } = await opened({ mode: 'session', sessionId: 'id-1' });
    expect(sheet.parentNode).toBe(document.body);
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.style.zIndex).toBe(String(Z_INDEX.COPILOT_SHEET));
    expect(document.body.style.overflow).toBe('hidden');
    expect(ws.url).toMatch(/\/copilot$/);
    expect(ws.json('hello')).toEqual([
      { type: 'hello', v: 1, mode: 'session', sessionId: 'id-1', readOnly: false, clipLang: 'en' },
    ]);
    // The microphone is asked for within the same tap.
    expect(mic).toHaveBeenCalledOnce();
    for (const id of [
      'copilot-close',
      'copilot-orb',
      'copilot-status',
      'copilot-captions',
      'copilot-handsfree-toggle',
      'copilot-earcons-toggle',
      'copilot-readonly-toggle',
    ]) {
      expect($(sheet, id), id).not.toBeNull();
    }
    // Opened again (the home page's button): the same sheet, moved to the new scope.
    expect(openCopilot({ mode: 'global' })).toBe(sheet);
    expect(document.body.querySelectorAll('copilot-sheet')).toHaveLength(1);
    expect(ws.json('hello').pop()).toMatchObject({ mode: 'global' });
  });

  it('global mode: one chip per session, a tap on one moves the focus there (and back)', async () => {
    const { sheet, ws } = await opened();
    ws.recv(
      stateMsg([
        chip(),
        chip({ sid: 's2', sessionId: 'id-2', name: 'mediguiapp', status: 'waiting', focus: true }),
      ])
    );
    await sheet.updateComplete;
    const one = $(sheet, 'copilot-chip-s1') as HTMLButtonElement;
    const two = $(sheet, 'copilot-chip-s2') as HTMLButtonElement;
    expect(one.tagName).toBe('BUTTON');
    expect(one.textContent).toContain('ecografía');
    expect(two.getAttribute('aria-pressed')).toBe('true');
    expect(two.classList.contains('waiting')).toBe(true);
    // Someone waits: the ring calls attention.
    expect(sheet.hasAttribute('needs')).toBe(true);
    one.click();
    two.click();
    expect(ws.json('focus')).toEqual([
      { type: 'focus', sessionId: 'id-1' },
      { type: 'focus', sessionId: null },
    ]);
  });

  it('session mode: only that session’s name, not a switch', async () => {
    const { sheet, ws } = await opened({ mode: 'session', sessionId: 'id-1' });
    ws.recv(stateMsg([chip({ focus: true })], { scope: { mode: 'session', sessionId: 'id-1' } }));
    await sheet.updateComplete;
    const only = $(sheet, 'copilot-chip-s1') as HTMLElement;
    expect(only.tagName).toBe('SPAN');
    expect(sheet.shadowRoot?.querySelectorAll('.chip')).toHaveLength(1);
    only.click();
    expect(ws.json('focus')).toEqual([]);
  });

  it('the status line says what is happening, one line, never moving anything', async () => {
    const sheet = openCopilot({ mode: 'global' });
    await sheet.updateComplete;
    const status = () => $(sheet, 'copilot-status')?.textContent?.trim();
    expect(status()).toBe('Connecting…');
    const ws = FakeSocket.all[0];
    ws.open();
    ws.recv(stateMsg([chip()]));
    await sheet.updateComplete;
    // No microphone (refused): the line says so and the typing box appears.
    await vi.waitFor(() => expect($(sheet, 'copilot-text-input')).not.toBeNull());
    expect(status()).toBe('No microphone · you can type below');
    expect(sheet.captions.at(-1)?.who).toBe('sys');
    (sheet as unknown as { micProblem: null }).micProblem = null;
    await sheet.updateComplete;
    expect(status()).toBe('Hold to talk');
    ws.recv({ type: 'turn-start', turn: 1, origin: 'user', own: true });
    await sheet.updateComplete;
    expect(status()).toBe('One moment…');
    expect(sheet.dataset.mode).toBe('thinking');
    // Another page's turn does not change this one.
    ws.recv({
      type: 'turn-end',
      turn: 1,
      origin: 'user',
      speech: [],
      actions: [],
      timings: {},
      cancelled: false,
      own: true,
    });
    ws.recv({ type: 'turn-start', turn: 2, origin: 'user', own: false });
    await vi.waitFor(() => expect(status()).toBe('Hold to talk'));
    ws.recv(stateMsg([chip({ status: 'waiting' })], { pending: 'answer ecografía: Yes' }));
    await sheet.updateComplete;
    expect(status()).toBe('Say “confirmo” to go ahead');
    expect($(sheet, 'copilot-status')?.title).toBe('answer ecografía: Yes');
    ws.drop();
    await sheet.updateComplete;
    expect(status()).toBe('No connection to the Mac');
  });

  it('captions: sentences of one turn join, at most 12 lines, and actions show as tags', async () => {
    const { sheet, ws } = await opened();
    ws.recv(stateMsg([chip()]));
    ws.recv({ type: 'sentence', turn: 3, index: 0, text: 'Ecografía pide permiso.', lang: 'es' });
    ws.recv({ type: 'sentence', turn: 3, index: 1, text: 'Di «confirmo».', lang: 'es' });
    ws.recv({
      type: 'turn-end',
      turn: 3,
      origin: 'user',
      speech: [],
      actions: [{ kind: 'answer', sid: 's1', outcome: 'held' }],
      timings: {},
      cancelled: false,
      own: true,
    });
    await sheet.updateComplete;
    const caps = () => Array.from(sheet.shadowRoot?.querySelectorAll('.cap') ?? []);
    const last = caps().at(-1) as HTMLElement;
    expect(last.textContent).toContain('Ecografía pide permiso. Di «confirmo».');
    // A tool line: clock icon, the session in mono, what happened (no leading arrow).
    const held = last.querySelector('.tag.held') as HTMLElement;
    expect(held.textContent).toBe('ecografía: waiting for confirmation');
    expect(held.querySelector('b')?.textContent).toBe('ecografía');
    expect(held.querySelector('svg')).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      ws.recv({ type: 'transcript', text: `frase ${i}` });
    }
    await sheet.updateComplete;
    expect(caps()).toHaveLength(MAX_CAPTIONS);
    expect(caps().at(-1)?.textContent).toContain('frase 19');
    // Ignored (echo) or empty transcripts add nothing.
    ws.recv({ type: 'transcript', text: 'hola', ignored: true });
    await sheet.updateComplete;
    expect(caps().at(-1)?.textContent).toContain('frase 19');
  });

  it('typing (no microphone) sends words, never actions', async () => {
    const { sheet, ws } = await opened();
    await vi.waitFor(() => expect($(sheet, 'copilot-text-input')).not.toBeNull());
    const input = $(sheet, 'copilot-text-input') as HTMLInputElement;
    input.value = '  sí  ';
    $(sheet, 'copilot-text-send')?.click();
    expect(ws.json('text')).toEqual([{ type: 'text', text: 'sí' }]);
    expect(sheet.mode).toBe('thinking');
    expect(
      ws.sent.every((m) => !['answer', 'reply', 'input'].includes((m as { type: string }).type))
    ).toBe(true);
  });

  it('typing while the socket is down keeps the text and does not wait for an answer', async () => {
    const { sheet, ws } = await opened();
    await vi.waitFor(() => expect($(sheet, 'copilot-text-input')).not.toBeNull());
    ws.drop();
    await sheet.updateComplete;
    const input = $(sheet, 'copilot-text-input') as HTMLInputElement;
    input.value = 'hola';
    $(sheet, 'copilot-text-send')?.click();
    expect(ws.json('text')).toEqual([]);
    expect(input.value).toBe('hola');
    expect(sheet.mode).toBe('idle');
  });

  it('a turn in flight stops "thinking" when the socket drops', async () => {
    const { sheet, ws } = await opened();
    await vi.waitFor(() => expect($(sheet, 'copilot-text-input')).not.toBeNull());
    const input = $(sheet, 'copilot-text-input') as HTMLInputElement;
    input.value = 'hola';
    $(sheet, 'copilot-text-send')?.click();
    expect(sheet.mode).toBe('thinking');
    ws.drop();
    expect(sheet.mode).toBe('idle');
  });

  it('keys typed in its text box never reach the app’s shortcuts («?» stays in the box)', async () => {
    const { sheet } = await opened();
    await vi.waitFor(() => expect($(sheet, 'copilot-text-input')).not.toBeNull());
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener('keydown', onKey);
    try {
      $(sheet, 'copilot-text-input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: '?', bubbles: true, composed: true })
      );
    } finally {
      document.removeEventListener('keydown', onKey);
    }
    expect(seen).toEqual([]);
  });

  it('stays «One moment…» at turn end while the answer audio is still being decoded', async () => {
    const { sheet, ws } = await opened();
    ws.recv(stateMsg([chip()]));
    (sheet as unknown as { micProblem: null }).micProblem = null;
    ws.recv({ type: 'turn-start', turn: 1, origin: 'user', own: true });
    await sheet.updateComplete;
    let release!: () => void;
    const internals = sheet as unknown as { decodeChain: Promise<void> };
    internals.decodeChain = new Promise<void>((r) => {
      release = r;
    });
    ws.recv({
      type: 'turn-end',
      turn: 1,
      origin: 'user',
      speech: ['Hola.'],
      actions: [],
      timings: {},
      cancelled: false,
      own: true,
    });
    await sheet.updateComplete;
    await Promise.resolve();
    expect(sheet.mode).toBe('thinking');
    release();
    await vi.waitFor(() => expect(sheet.mode).toBe('idle'));
  });

  it('toggles: «Solo mirar» tells the server and is remembered; no hands-free without a mic', async () => {
    const { sheet, ws } = await opened();
    $(sheet, 'copilot-readonly-toggle')?.click();
    await sheet.updateComplete;
    expect(ws.json('read-only')).toEqual([{ type: 'read-only', on: true }]);
    expect($(sheet, 'copilot-readonly-toggle')?.getAttribute('aria-pressed')).toBe('true');
    expect($(sheet, 'copilot-readonly-badge')).not.toBeNull();
    expect(localStorage.getItem('untether.copilot.readOnly')).toBe('1');
    $(sheet, 'copilot-earcons-toggle')?.click();
    expect(localStorage.getItem('untether.copilot.earcons')).toBe('0');
    const hf = $(sheet, 'copilot-handsfree-toggle') as HTMLButtonElement;
    hf.click();
    await vi.waitFor(() => expect(hf.getAttribute('aria-pressed')).toBe('false'));
    sheet.remove();
    // Next time: read-only from the start, in the hello itself.
    const again = await opened();
    expect(again.ws.json('hello')[0]).toMatchObject({ readOnly: true });
  });

  it('closing ends the socket and the audio, and gives the page its scroll back', async () => {
    const { sheet, ws } = await opened();
    const close = $(sheet, 'copilot-close') as HTMLElement;
    expect(close.getAttribute('aria-label')).toBe('End');
    close.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 0 }));
    expect(sheet.isConnected).toBe(false);
    expect(ws.readyState).toBe(3);
    expect(document.body.style.overflow).toBe('');
  });
});
