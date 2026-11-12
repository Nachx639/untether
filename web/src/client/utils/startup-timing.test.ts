import { describe, expect, it } from 'vitest';
import { describeStartupTiming, readStartupTimes } from './startup-timing.js';

const entries = (byType: Record<string, unknown[]>) =>
  ({ getEntriesByType: (type: string) => byType[type] ?? [] }) as unknown as Performance;

describe('startup timing line', () => {
  it('splits a cold start into the worker boot, the page, the styles and the app', () => {
    const times = readStartupTimes(
      3400.4,
      entries({
        navigation: [{ workerStart: 12, fetchStart: 2812, responseEnd: 2900 }],
        resource: [
          { name: 'https://mac/bundle/chunks/es-1.js', workerStart: 1, responseEnd: 9 },
          { name: 'https://mac/bundle/styles.css', workerStart: 2950, responseEnd: 3010 },
        ],
        paint: [
          { name: 'first-paint', startTime: 2930 },
          { name: 'first-contentful-paint', startTime: 2940 },
        ],
      })
    );
    expect(describeStartupTiming(times)).toBe(
      'startup: worker boot 2800 ms, html 2900 ms, first paint 2940 ms, styles 3010 ms (worker), app code 3400 ms'
    );
  });

  it('says when no worker answered and what is unknown', () => {
    const times = readStartupTimes(
      500,
      entries({
        navigation: [{ workerStart: 0, fetchStart: 3, responseEnd: 80 }],
        resource: [{ name: 'https://mac/bundle/styles.css', workerStart: 0, responseEnd: 120 }],
      })
    );
    expect(describeStartupTiming(times)).toBe(
      'startup: no worker on the page load, html 80 ms, first paint ?, styles 120 ms (network), app code 500 ms'
    );
  });
});
