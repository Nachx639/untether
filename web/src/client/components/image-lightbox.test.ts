// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { openImageLightbox } from './image-lightbox.js';

describe('image lightbox', () => {
  afterEach(() => {
    document.querySelector('image-lightbox')?.remove();
  });

  it('shows the image full screen and closes with ✕', async () => {
    const box = openImageLightbox('blob:photo', 'Attached image');
    await box.updateComplete;
    expect(document.querySelectorAll('image-lightbox')).toHaveLength(1);
    expect(box.shadowRoot?.querySelector('img')?.getAttribute('src')).toBe('blob:photo');

    const close = box.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="close"]');
    close?.click();
    expect(document.querySelector('image-lightbox')).toBeNull();
  });

  it('stays open at the end of a drag that started on ✕', async () => {
    const box = openImageLightbox('blob:a');
    await box.updateComplete;
    const close = box.shadowRoot?.querySelector('[data-action="close"]') as HTMLButtonElement;
    const touch = (dy: number) => {
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 340,
        clientY: y,
        bubbles: true,
        composed: true,
      });
      close.dispatchEvent(new PointerEvent('pointerdown', at(40)));
      close.dispatchEvent(new PointerEvent('pointerup', at(40 + dy)));
    };
    touch(100);
    expect(document.querySelector('image-lightbox')).toBe(box);
    touch(2);
    close.click();
    expect(document.querySelector('image-lightbox')).toBeNull();
  });

  it('closes with Escape and keeps only one open', async () => {
    openImageLightbox('blob:a');
    const box = openImageLightbox('blob:b');
    await box.updateComplete;
    expect(document.querySelectorAll('image-lightbox')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('image-lightbox')).toBeNull();
  });

  it('closes on a long swipe down, not a short one', async () => {
    const box = openImageLightbox('blob:a');
    await box.updateComplete;
    const scroller = box.shadowRoot?.querySelector('.scroller') as HTMLElement;
    const pointer = (type: string, y: number) =>
      scroller.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientY: y, bubbles: true }));
    pointer('pointerdown', 100);
    pointer('pointermove', 150);
    pointer('pointerup', 150);
    expect(document.querySelector('image-lightbox')).toBe(box);
    pointer('pointerdown', 100);
    pointer('pointermove', 300);
    pointer('pointerup', 300);
    expect(document.querySelector('image-lightbox')).toBeNull();
  });
});
