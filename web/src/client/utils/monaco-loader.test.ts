// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('initializeMonaco', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'monaco');
  });

  // 2026-11-11: two editors opening together (while the bundle was still loading) both ran
  // the initialization: the language registered twice and two theme observers stayed.
  it('initializes once for callers that arrive while the bundle loads', async () => {
    vi.resetModules();
    const { initializeMonaco } = await import('./monaco-loader.js');
    const register = vi.fn();
    const monaco = {
      languages: { register, setMonarchTokensProvider: vi.fn() },
      editor: { setTheme: vi.fn() },
    };
    const added: HTMLElement[] = [];
    vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
      added.push(node as HTMLElement);
      return node;
    });
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');

    const first = initializeMonaco();
    const second = initializeMonaco();
    // The bundle and its stylesheet arrive.
    (window as unknown as { monaco: unknown }).monaco = monaco;
    for (const node of added) node.onload?.(new Event('load'));
    await Promise.all([first, second]);
    await initializeMonaco();

    expect(register).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(added.filter((node) => node.tagName === 'SCRIPT')).toHaveLength(1);
  });
});
