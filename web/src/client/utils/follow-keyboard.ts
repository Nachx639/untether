import { softKeyboardTarget, watchSoftKeyboard } from './soft-keyboard.js';

/**
 * Keeps a bottom sheet above the soft keyboard: iOS leaves `position: fixed` elements under it,
 * so a sheet's sticky Start/Lanzar button sat behind the keyboard while typing the goal
 * (2026-10-20 audit; the same fix answer-sheet.ts has had). Returns the cleanup.
 * 2026-11-11: only while a field has the focus, and looked at again when it loses it or the
 * page comes back (soft-keyboard.ts): a viewport left at its keyboard-up size held the sheet up.
 */
export function followKeyboard(sheet: HTMLElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const sync = () => {
    const covered = window.innerHeight - (vv.height + vv.offsetTop);
    if (covered > 80 && softKeyboardTarget()) {
      sheet.style.bottom = `${Math.round(covered)}px`;
      sheet.style.maxHeight = `${Math.round(vv.height) - 8}px`;
    } else {
      sheet.style.removeProperty('bottom');
      sheet.style.removeProperty('max-height');
    }
  };
  sync();
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  const stopWatching = watchSoftKeyboard(sync);
  return () => {
    stopWatching();
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
  };
}
