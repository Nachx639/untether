// The home-screen app's height and markers (was inline in index.html; a CSP
// allows no inline script).
// Home-screen app, for the CSS that only it needs (styles.css, html[data-standalone]): the
// opaque top that keeps iOS 26+'s scroll-edge blur off the header. navigator.standalone is
// iOS's own flag; display-mode covers the others (and iOS when it matches).
try {
  if (navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches) {
    document.documentElement.setAttribute('data-standalone', '');
  }
} catch (_) {}

// Which fix for that blur (utils/edge-fix.ts: pad by default; a long press on the version in
// Settings switches it): a hidden switch to compare them on a device.
(() => {
  let mode = 'pad';
  try {
    const saved = localStorage.getItem('ut-edge-fix');
    if (saved === 'pad' || saved === 'sticky' || saved === 'off') mode = saved;
  } catch (_) {}
  document.documentElement.setAttribute('data-edge-fix', mode);
})();

// Home-screen web app on iPhone: innerHeight comes up short by the status bar height
// (black-translucent), leaving a blank band at the bottom of every page. The session
// view keeps --app-height current (keyboard included); this covers the other pages.
// Same rule as iosStandaloneShortfall(): iPhone standalone, portrait, status-bar sized gap.
const gap = window.screen.height - window.innerHeight;
if (
  navigator.standalone === true &&
  /iPhone|iPod/.test(navigator.userAgent) &&
  window.innerWidth < window.innerHeight &&
  gap > 0 &&
  gap <= 80
) {
  document.documentElement.style.setProperty('--app-height', `${window.screen.height}px`);
}
