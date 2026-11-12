import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { staticCacheControl } from './static-cache.js';

const pub = (file: string) => path.join('/srv/web/public', ...file.split('/'));

describe('staticCacheControl', () => {
  it.each([
    // [file, dev mode, production]
    [
      'bundle/chunks/deferred-views-CI45QLPT.js',
      'public, max-age=31536000, immutable',
      'public, max-age=31536000, immutable',
    ],
    ['bundle/chunks/deferred-views-CI45QLPT.js.map', 'no-cache', 'no-cache'],
    // Fixed names that change with every build: always revalidated (deploy-4020.sh, the
    // version watch and the service worker rely on their ETag).
    ['bundle/client-bundle.js', 'no-cache', 'no-cache'],
    ['bundle/styles.css', 'no-cache', 'no-cache'],
    ['sw.js', 'no-cache', 'no-cache'],
    ['index.html', 'no-cache', 'public, max-age=3600'],
    ['fonts/hack-core-regular.woff2', 'no-cache', 'public, max-age=31536000, immutable'],
  ])('%s', (file, dev, production) => {
    expect(staticCacheControl(pub(file), true)).toBe(dev);
    expect(staticCacheControl(pub(file), false)).toBe(production);
  });
});
