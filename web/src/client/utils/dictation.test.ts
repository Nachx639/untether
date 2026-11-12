/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictationController, type DictationError, resetDictationForTests } from './dictation.js';

/** Web Audio double: the processor's onaudioprocess is driven by the test. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  sampleRate = 48000;
  destination = {};
  processor: {
    onaudioprocess: ((e: unknown) => void) | null;
    connect: () => void;
    disconnect: () => void;
  } | null = null;
  constructor() {
    FakeAudioContext.last = this;
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createScriptProcessor() {
    this.processor = {
      onaudioprocess: null,
      connect: () => undefined,
      disconnect: () => undefined,
    };
    return this.processor;
  }
  /** Feed one 4096-sample buffer (a tone, or silence). */
  feed(amplitude: number) {
    const data = new Float32Array(4096).map((_, i) => amplitude * Math.sin(i / 8));
    this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
  }
}

function setup(text = '') {
  let value = text;
  const errors: DictationError[] = [];
  const states: string[] = [];
  const controller = new DictationController({
    getText: () => value,
    setText: (next) => {
      value = next;
    },
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    authHeaders: () => ({ Authorization: 'Bearer t' }),
  });
  return { controller, errors, states, value: () => value };
}

describe('DictationController', () => {
  const track = { stop: vi.fn() };
  beforeEach(() => {
    resetDictationForTests();
    FakeAudioContext.last = null;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) CriOS/140 Mobile',
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records on iOS (Chrome too) and puts the Mac transcription after what was typed', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).startsWith('/api/dictation/status')
        ? new Response(JSON.stringify({ available: true }))
        : new Response(JSON.stringify({ text: 'revisa los tests' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { controller, value, states } = setup('Hola');

    await controller.toggle();
    expect(controller.state).toBe('recording');
    for (let i = 0; i < 12; i++) FakeAudioContext.last?.feed(0.3); // ~1 s of speech
    await controller.toggle(); // stop
    await vi.waitFor(() => expect(value()).toBe('Hola revisa los tests'));

    const upload = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith('/api/dictation/transcribe')
    );
    expect(upload?.[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'audio/wav' } });
    const body = upload?.[1]?.body as Blob;
    expect(body.size).toBeGreaterThan(44 + 16000); // a WAV header plus ~1 s at 16 kHz
    expect(states).toEqual(['starting', 'recording', 'transcribing', 'idle']);
    expect(track.stop).toHaveBeenCalled();
  });

  it('reports the microphone level while recording, and 0 when it stops (level meter)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/dictation/status')
          ? new Response(JSON.stringify({ available: true }))
          : new Response(JSON.stringify({ text: 'hola' }))
      )
    );
    const levels: number[] = [];
    const controller = new DictationController({
      getText: () => '',
      setText: () => undefined,
      onState: () => undefined,
      onError: () => undefined,
      authHeaders: () => ({}),
      onLevel: (level) => levels.push(level),
    });
    await controller.toggle();
    FakeAudioContext.last?.feed(0.2);
    FakeAudioContext.last?.feed(0.5);
    expect(levels[0]).toBeGreaterThan(0.3);
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBe(1);
    controller.cancel();
    expect(levels[levels.length - 1]).toBe(0);
  });

  it('leaves no microphone running when cancelled while waiting for it', async () => {
    let grant: (stream: unknown) => void = () => {};
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => (grant = resolve))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ available: true })))
    );
    const stop = vi.fn();
    const { controller } = setup();
    const starting = controller.toggle();
    expect(controller.state).toBe('starting');
    await controller.toggle(); // a second tap while iOS asks: ignored
    controller.cancel(); // the user left the screen
    grant({ getTracks: () => [{ stop }] });
    await starting;
    expect(stop).toHaveBeenCalled();
    expect(controller.state).toBe('idle');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('says the microphone gave only silence instead of sending it', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify({ available: true }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { controller, errors } = setup();
    await controller.toggle();
    for (let i = 0; i < 12; i++) FakeAudioContext.last?.feed(0);
    await controller.toggle();
    expect(errors).toEqual(['no-audio']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/transcribe'))).toBe(false);
  });

  it('says why when the microphone is refused', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('no'), { name: 'NotAllowedError' })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ available: true })))
    );
    const { controller, errors } = setup();
    await controller.toggle();
    expect(errors).toEqual(['denied']);
    expect(controller.state).toBe('idle');
  });

  it('says so when nothing can transcribe (no Web Speech, Mac without whisper)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ available: false })))
    );
    const { controller, errors } = setup();
    await controller.toggle();
    expect(errors).toEqual(['unsupported']);
  });

  it("always sends 'auto': whisper detects the spoken language (no picker)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith('/api/dictation/status')
        ? new Response(JSON.stringify({ available: true }))
        : new Response(JSON.stringify({ text: 'hi' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { controller } = setup();
    await controller.toggle();
    for (let i = 0; i < 12; i++) FakeAudioContext.last?.feed(0.3);
    await controller.toggle();
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls
          .map(([url]) => String(url))
          .find((url) => url.startsWith('/api/dictation/transcribe'))
      ).toContain('lang=auto')
    );
    vi.mocked(localStorage.getItem).mockReset();
  });

  it("reports the browser recognizer's error instead of going quiet", async () => {
    // The browser recognizer is the fallback where audio can't be recorded.
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/140',
    });
    const started: FakeRecognition[] = [];
    class FakeRecognition {
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      start() {
        started.push(this);
      }
      stop() {
        started.at(-1)?.onend?.();
      }
      abort() {}
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const { controller, errors } = setup();
    await controller.toggle();
    expect(controller.state).toBe('listening');
    started.at(-1)?.onerror?.({ error: 'service-not-allowed' });
    expect(errors).toEqual(['denied']);
    expect(controller.state).toBe('idle');
  });
});
