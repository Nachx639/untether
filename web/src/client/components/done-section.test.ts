// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it } from 'vitest';
import { createTestTask } from '@/test/utils/test-factories';
import type { DoneSection } from './done-section';
import './done-section';

const mount = (layout: 'row' | 'card') =>
  fixture<DoneSection>(html`<done-section
    .tasks=${[createTestTask({ id: 'm', state: 'merged' })]}
    .layout=${layout}
  ></done-section>`);

describe('DoneSection', () => {
  // 2026-11-11: on the desktop «Hechas» wore the phone's eyebrow, whose styles a desktop never
  // loads: its chevron fell on a line of its own, with no hairline, beside «Terminadas».
  it("desktop: folds with the sections' shared header, chevron before its name", async () => {
    localStorage.removeItem('ut-done-tasks-open');
    const el = await mount('card');
    const section = el.querySelector('[data-testid="done-section"]') as HTMLElement;
    expect(section.classList.contains('ut-section')).toBe(true);
    const toggle = el.querySelector('[data-testid="done-toggle"]') as HTMLButtonElement;
    expect(toggle.classList.contains('ut-section-toggle')).toBe(true);
    expect(toggle.parentElement?.classList.contains('ut-section-head')).toBe(true);
    expect(toggle.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(toggle.textContent).toContain('Done (1)');
    expect(el.querySelector('.ut-phone-disclosure')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await el.updateComplete;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[data-testid="done-list"].tsk-grid task-row')).not.toBeNull();
    localStorage.removeItem('ut-done-tasks-open');
  });

  it('phone: keeps its eyebrow', async () => {
    const el = await mount('row');
    const toggle = el.querySelector('[data-testid="done-toggle"]') as HTMLButtonElement;
    expect(toggle.classList.contains('ut-phone-disclosure')).toBe(true);
    expect(toggle.querySelector('.ut-phone-eyebrow')?.textContent).toContain('Done (1)');
  });
});
