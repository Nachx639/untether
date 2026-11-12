// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { micProblem, ScreenAwake, wav16k } from './copilot-audio.js';
import { copilotUrl } from './copilot-socket.js';

describe('copilot audio helpers', () => {
  it('sends 16 kHz mono 16-bit WAV, whatever rate the microphone runs at', () => {
    const half = new Float32Array(24000).fill(0.5);
    const wav = wav16k([half, half], 48000);
    const v = new DataView(wav);
    const text = (at: number) => String.fromCharCode(...new Uint8Array(wav, at, 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    // One second of audio: 16000 samples.
    expect(v.getUint32(40, true)).toBe(32000);
    expect(v.getInt16(44 + 100, true)).toBe(Math.trunc(0.5 * 0x7fff));
  });

  it('names why the microphone cannot be used', () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => undefined },
      configurable: true,
    });
    expect(micProblem(new DOMException('x', 'NotAllowedError'))).toBe('denied');
    expect(micProblem(new DOMException('x', 'NotFoundError'))).toBe('none');
    expect(micProblem(new Error('other'))).toBe('other');
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(micProblem(new DOMException('x', 'NotAllowedError'))).toBe('insecure');
  });

  it('connects to /copilot with the login token, wss on https', () => {
    const loc = { protocol: 'https:', host: 'mac.example:443' } as Location;
    expect(copilotUrl('a b', loc)).toBe('wss://mac.example:443/copilot?token=a%20b');
    expect(copilotUrl(undefined, { protocol: 'http:', host: 'h' } as Location)).toBe(
      'ws://h/copilot'
    );
  });

  // A wake lock nobody can release keeps the screen on until the page closes.
  it('never keeps a wake lock it was told to release or that it replaced', async () => {
    const released: number[] = [];
    let grant: Array<() => void> = [];
    let made = 0;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () =>
          new Promise((resolve) => {
            const id = ++made;
            grant.push(() =>
              resolve({
                release: async () => {
                  released.push(id);
                },
              })
            );
          }),
      },
    });
    try {
      // Released while the request is pending: the lock that arrives late is given back.
      const awake = new ScreenAwake();
      const pending = awake.acquire();
      awake.release();
      grant[0]();
      await pending;
      expect(released).toEqual([1]);

      // Asked twice (page visible again): the first lock is given back, the second is held.
      grant = [];
      const first = awake.acquire();
      grant[0]();
      await first;
      const second = awake.acquire();
      grant[1]();
      await second;
      expect(released).toEqual([1, 2]);
      awake.release();
      expect(released).toEqual([1, 2, 3]);
    } finally {
      Reflect.deleteProperty(navigator, 'wakeLock');
    }
  });
});
