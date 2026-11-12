/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { findOverflow } from './layout-check';

function box(element: Element, left: number, right: number) {
  element.getBoundingClientRect = () =>
    ({ left, right, width: right - left, height: 20, top: 0, bottom: 20 }) as DOMRect;
}

describe('layout check', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reports the outermost element sticking out, with its path, inside shadow roots too', () => {
    const host = document.createElement('div');
    host.className = 'host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="bar"><button class="close">x</button></div><p>ok</p>';
    box(host, 0, 375);
    box(shadow.querySelector('.bar') as Element, 0, 398);
    box(shadow.querySelector('.close') as Element, 354, 398);
    box(shadow.querySelector('p') as Element, 0, 300);
    expect(findOverflow(375)).toEqual(['html > body > div.host > div.bar: 0→398']);
  });

  it('leaves out what is hidden wholly off screen on purpose', () => {
    document.body.innerHTML = '<textarea class="helper"></textarea><div class="drawer"></div>';
    box(document.querySelector('.helper') as Element, -9999, -9975);
    box(document.querySelector('.drawer') as Element, 375, 700);
    expect(findOverflow(375)).toEqual([]);
  });

  it('leaves out the inside of the Monaco editor', () => {
    document.body.innerHTML = '<div class="monaco-editor"><div class="lines-content"></div></div>';
    box(document.querySelector('.monaco-editor') as Element, 0, 375);
    box(document.querySelector('.lines-content') as Element, 34, 16777250);
    expect(findOverflow(375)).toEqual([]);
  });

  it('leaves out what sits in a box that scrolls sideways on purpose', () => {
    document.body.innerHTML =
      '<div class="table-wrap" style="overflow-x: auto"><table class="wide"></table></div>';
    const wrap = document.querySelector('.table-wrap') as HTMLElement;
    Object.defineProperty(wrap, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: 340 });
    box(wrap, 10, 350);
    box(document.querySelector('.wide') as Element, 10, 610);
    expect(findOverflow(375)).toEqual([]);
  });
});
