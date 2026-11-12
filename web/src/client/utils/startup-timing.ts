/**
 * One log line per page load with where the time before the app went (2026-10-04): a cold start
 * of the home-screen app showed 3 s of white on the iPhone SE before anything painted, and the
 * frames alone can't tell the service worker's boot from the network or the page. Read from
 * Navigation/Resource/Paint Timing, all in ms since the navigation started:
 *
 * - `worker boot`: fetchStart − workerStart of the page load, the service worker starting before
 *   it could answer (0 when it was already running; absent without one);
 * - `html`: responseEnd of the page; `first paint`: first-contentful-paint;
 * - `styles`: when styles.css arrived, and whether the worker answered it;
 * - `app code`: when the bundle started running.
 */

export interface StartupTimes {
  workerStart?: number;
  fetchStart?: number;
  htmlEnd?: number;
  firstPaint?: number;
  stylesEnd?: number;
  stylesFromWorker?: boolean;
  appCode: number;
}

const ms = (value: number) => `${Math.round(value)} ms`;

export function describeStartupTiming(times: StartupTimes): string {
  const parts: string[] = [];
  if (times.workerStart && times.fetchStart !== undefined) {
    parts.push(`worker boot ${ms(Math.max(0, times.fetchStart - times.workerStart))}`);
  } else {
    parts.push('no worker on the page load');
  }
  if (times.htmlEnd !== undefined) parts.push(`html ${ms(times.htmlEnd)}`);
  parts.push(
    times.firstPaint !== undefined ? `first paint ${ms(times.firstPaint)}` : 'first paint ?'
  );
  if (times.stylesEnd !== undefined) {
    parts.push(
      `styles ${ms(times.stylesEnd)}${times.stylesFromWorker ? ' (worker)' : ' (network)'}`
    );
  }
  parts.push(`app code ${ms(times.appCode)}`);
  return `startup: ${parts.join(', ')}`;
}

/** The times of this page load (call after it, so paint entries exist). */
export function readStartupTimes(appCode: number, perf: Performance = performance): StartupTimes {
  const navigation = perf.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const styles = perf
    .getEntriesByType('resource')
    .find((entry) => entry.name.endsWith('/bundle/styles.css')) as
    | PerformanceResourceTiming
    | undefined;
  const paint = perf
    .getEntriesByType('paint')
    .find((entry) => entry.name === 'first-contentful-paint');
  return {
    workerStart: navigation?.workerStart,
    fetchStart: navigation?.fetchStart,
    htmlEnd: navigation?.responseEnd,
    firstPaint: paint?.startTime,
    stylesEnd: styles?.responseEnd,
    stylesFromWorker: styles ? styles.workerStart > 0 : undefined,
    appCode,
  };
}
