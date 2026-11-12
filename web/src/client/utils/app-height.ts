/**
 * The page height outside a session, as index.html sets it: the screen height in an iPhone
 * home-screen app in portrait (innerHeight comes up short by the status bar), else nothing
 * (styles.css: 100dvh, which follows the keyboard by itself). The session view leaves this
 * behind when it closes: since 2026-10-03 the session list's height follows --app-height too,
 * and a value left from an open keyboard would cut it short.
 */
export function resetAppHeight(): void {
  const root = document.documentElement;
  root.style.setProperty('--keyboard-offset', '0px');
  root.style.setProperty('--vv-top', '0px');
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const gap = window.screen.height - window.innerHeight;
  if (
    standalone &&
    /iPhone|iPod/.test(navigator.userAgent) &&
    window.innerWidth < window.innerHeight &&
    gap > 0 &&
    gap <= 80
  ) {
    root.style.setProperty('--app-height', `${window.screen.height}px`);
  } else {
    root.style.removeProperty('--app-height');
  }
}

/**
 * Puts the page height right again after every rotation, outside a session (2026-10-04).
 * viewport-init.js sets it once, at load: in the home-screen app in portrait, the screen's
 * height. Turned on its side, the list kept that portrait height (956 pt on a Pro Max, in a
 * 440 pt window): its bottom bar and the bottom of both columns were off screen. Loaded on its
 * side and turned upright, it missed the status bar's height instead. Inside a session the
 * session view tracks the height itself (lifecycle-event-manager.ts), so this leaves it alone
 * while `inSession()` says so. iOS fires orientationchange before the window has its new size:
 * it is checked again a moment later. Returns the function that stops it.
 */
export function followRotationsOutsideSession(inSession: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const update = () => {
    if (!inSession()) resetAppHeight();
  };
  const rotated = () => {
    update();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      update();
    }, 300);
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', rotated);
  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', rotated);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Height an iPhone home-screen web app is missing (status bar, about 44-62 px). Only iOS
 * standalone in portrait: landscape, iPad, Android and desktop PWAs report real heights,
 * and screen.height there is unrelated to the window (it would push content off-screen).
 * Moved here from lifecycle-event-manager.ts (chat-keyboard-fix3.ts needs it too).
 */
export function iosStandaloneShortfall(innerHeight: number): number {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone || !/iPhone|iPod/.test(navigator.userAgent)) return 0;
  if (window.innerWidth > window.innerHeight) return 0;
  const gap = window.screen.height - innerHeight;
  return gap > 0 && gap <= 80 ? gap : 0;
}

/**
 * Height of the phone session column: the visual viewport, plus iosStandaloneShortfall() only
 * while the window still is the visual viewport (no keyboard). 2026-10-12: in the home-screen
 * app on iOS 26, innerHeight sometimes drops from 956 to 894 (the status bar) with the keyboard
 * up; 956 - 894 looked like the status-bar shortfall, so 62 px were added to the 568 px visible
 * area and the second quick-keys row ended up under iOS's ^ v ✓ bar above the keyboard. Only
 * sometimes, because innerHeight stays 956 on other keyboard openings. Same rule as
 * chatKeyboardFix3Layout().
 */
export function sessionAppHeight(innerHeight: number, viewportHeight: number): number {
  const windowIsVisualViewport = Math.abs(innerHeight - viewportHeight) < 1;
  return viewportHeight + (windowIsVisualViewport ? iosStandaloneShortfall(innerHeight) : 0);
}
