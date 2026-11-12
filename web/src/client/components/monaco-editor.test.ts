// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import './monaco-editor.js';

describe('monaco-editor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'monaco');
    document.body.replaceChildren();
  });

  // 2026-11-10: removed while Monaco loaded, it still created a ResizeObserver and an editor
  // that nothing destroyed.
  it('creates no observer and no editor when it is removed while loading', async () => {
    const create = vi.fn(() => ({ dispose: vi.fn(), layout: vi.fn() }));
    (window as unknown as { monaco: unknown }).monaco = { editor: { create } };
    const observers: unknown[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      }
    );
    const el = document.createElement('monaco-editor');
    document.body.append(el);
    el.remove();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observers).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates its editor and observer when it stays connected', async () => {
    const editorStub = {
      dispose: vi.fn(),
      layout: vi.fn(),
      addCommand: vi.fn(),
      onDidChangeModelContent: vi.fn(),
    };
    const create = vi.fn(() => editorStub);
    (window as unknown as { monaco: unknown }).monaco = {
      editor: { create },
      KeyMod: { CtrlCmd: 1 },
      KeyCode: { KeyS: 2 },
    };
    const observers: unknown[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      }
    );
    const el = document.createElement('monaco-editor');
    (el as unknown as { content: string }).content = 'const a = 1;';
    document.body.append(el);
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    expect(observers).toHaveLength(1);
  });
});
