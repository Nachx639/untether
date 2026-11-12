// Theme and colour before the first paint, run synchronously from <head>. logs.html loads
// this file; index.html carries an inline copy so its first paint waits on nothing (allowed
// by its hash in server/utils/csp.ts; tests check the copy and the hash).
(() => {
  // The interface style (utils/look.ts): what the first paint needs is in one stored entry
  // (this device's choice; without one, the server's default, written into index.html)
  let look = null;
  try {
    const meta = document.querySelector('meta[name="ut-server-look"]');
    const own = localStorage.getItem('untether-look') || !meta;
    const raw = own ? localStorage.getItem('untether-look-boot') : meta.getAttribute('content');
    const boot = JSON.parse(raw || 'null');
    if (boot && /^[a-z0-9-]+$/.test(boot.id)) look = boot;
  } catch (_) {}
  if (look) document.documentElement.setAttribute('data-look', look.id);

  // Load saved theme preference or use system preference
  const saved = localStorage.getItem('untether-theme');
  const theme = saved || 'system';

  // Apply theme immediately; a style that is only light or only dark decides
  const effectiveTheme =
    look && (look.force === 'light' || look.force === 'dark')
      ? look.force
      : theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);

  // Set initial background color: the style's, or the app's
  var lookBg = look && look.bg && look.bg[effectiveTheme];
  var initialBg = effectiveTheme === 'dark' ? '#131211' : '#FAF9F7';
  if (/^#[0-9a-fA-F]{6}$/.test(lookBg || '')) initialBg = lookBg;
  document.documentElement.style.backgroundColor = initialBg;
  // Browser chrome matches from the first frame instead of flashing the wrong shade
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', initialBg);

  // Color theme (utils/accent-themes.ts) before first paint
  try {
    const accent = localStorage.getItem('untether-accent');
    if (accent) document.documentElement.setAttribute('data-accent', accent);
  } catch (_) {}

  // "Chat width" (utils/chat-width.ts) before first paint; no attribute is the default (full)
  try {
    const chatWidth = localStorage.getItem('ut-chat-width');
    if (chatWidth === 'comfortable') {
      document.documentElement.setAttribute('data-chat-width', chatWidth);
    }
  } catch (_) {}

  // "Use the system text size" (utils/system-text-size.ts) before first paint: the same
  // probe and clamp (16-22 px root, chrome at most 1.15x); the test checks they agree.
  try {
    if (localStorage.getItem('ut-system-text-size') === 'on') {
      const root = document.documentElement;
      const probe = document.createElement('span');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'font: -apple-system-body; position: absolute; visibility: hidden; pointer-events: none;';
      root.appendChild(probe);
      const body = Number.parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      const size = Number.isFinite(body) && body > 0 ? Math.min(Math.max(body, 16), 22) : 16;
      root.setAttribute('data-text-size', 'system');
      root.style.setProperty('--ut-root-text', `${size}px`);
      root.style.setProperty('--ut-chrome-scale', String(Math.min(size / 16, 1.15)));
    }
  } catch (_) {}
})();
