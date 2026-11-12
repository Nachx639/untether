/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

// src/test/setup.ts wraps customElements.define; these guard that wrapper itself.
describe('test setup: customElements.define', () => {
  it('registers an element first defined inside a test', () => {
    class Late extends HTMLElement {}
    customElements.define('ut-setup-late', Late);
    expect(customElements.get('ut-setup-late')).toBe(Late);
    expect(document.createElement('ut-setup-late')).toBeInstanceOf(Late);
  });

  it('still registers one in a later test, and ignores a second definition', () => {
    class Later extends HTMLElement {}
    customElements.define('ut-setup-later', Later);
    expect(() =>
      customElements.define('ut-setup-later', class extends HTMLElement {})
    ).not.toThrow();
    expect(customElements.get('ut-setup-later')).toBe(Later);
  });
});
