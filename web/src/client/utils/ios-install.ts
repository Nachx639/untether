/**
 * iOS only allows web push for a site added to the Home Screen and opened from there. Every
 * iOS browser (Safari, Chrome, Firefox, Edge…) runs WebKit, so this applies to all of them.
 */

export type IOSBrowser = 'safari' | 'chrome' | 'other';

/**
 * iPhone/iPad, including iPadOS and "Request desktop site", which report a Mac user agent
 * but give themselves away with a touch screen.
 */
export function isIOSDevice(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  return ua.includes('macintosh') && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Running as the installed web app (opened from the Home Screen). */
export function isStandaloneApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** An iOS browser tab: push cannot work here until Untether is on the Home Screen. */
export function needsIOSHomeScreenInstall(): boolean {
  return isIOSDevice() && !isStandaloneApp();
}

/** Which iOS browser this is, for wording the install steps. */
export function iosBrowser(): IOSBrowser {
  const ua = navigator.userAgent;
  if (/CriOS/i.test(ua)) return 'chrome';
  if (/FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\//i.test(ua)) return 'other';
  return 'safari';
}
