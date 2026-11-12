// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { focusDiagnostics } from './focus-diagnostics.js';

describe('focusDiagnostics', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists every field iOS could move to, with how it is hidden, and never its text', () => {
    document.body.innerHTML = `
      <textarea id="composer" class="chat-input">secret draft</textarea>
      <input class="keyboard-catcher" style="display:none" value="other secret">
      <input id="off" disabled>`;
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = '<input id="in-shadow" tabindex="-1">';
    document.body.append(host);
    const composer = document.getElementById('composer') as HTMLTextAreaElement;
    composer.focus();

    const line = focusDiagnostics(composer);

    expect(line).toContain('3 fields');
    expect(line).toContain('textarea#composer.chat-input');
    expect(line).toContain('FOCUSED');
    expect(line).toContain('input.keyboard-catcher');
    expect(line).toContain('display:none');
    expect(line).toContain('input#in-shadow');
    expect(line).toContain('tab-1');
    expect(line).not.toContain('#off');
    expect(line).not.toContain('secret');
  });
});
