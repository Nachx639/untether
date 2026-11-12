/**
 * Theme detection utilities
 */

/**
 * Gets the current effective theme (light or dark)
 * Handles both explicit theme setting and system preference
 */
export function getCurrentTheme(): 'light' | 'dark' {
  const explicitTheme = document.documentElement.getAttribute('data-theme');

  if (explicitTheme === 'dark') return 'dark';
  if (explicitTheme === 'light') return 'light';

  // No explicit theme set, use system preference
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Checks if the current effective theme is dark mode
 */
export function isDarkMode(): boolean {
  return getCurrentTheme() === 'dark';
}
