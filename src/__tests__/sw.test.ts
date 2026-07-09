/**
 * sw.test.ts — unit tests for the service worker's PURE decision logic.
 *
 * The service worker (public/sw.js) is a classic script, not a module, so we
 * can't import it. Instead we read its source and evaluate it in a sandbox with:
 *   - a stub `self` that has NO addEventListener → the event-wiring block is
 *     skipped, so no listeners register and no I/O helper ever runs;
 *   - a `module` object → the file's test-only CommonJS export populates it with
 *     the pure functions.
 * This exercises exactly the code the browser runs, with zero SW-lifecycle mocks.
 */
import { describe, it, expect } from 'vitest';
import source from '../../public/sw.js?raw';

function loadSw(): {
  isSameOrigin: (url: string, origin: string) => boolean;
  decideStrategy: (
    req: { method: string; url: string; mode?: string },
    origin: string,
  ) => 'passthrough' | 'network-first' | 'cache-first';
  CACHE_NAME: string;
  CACHE_PREFIX: string;
} {
  const moduleObj = { exports: {} as Record<string, unknown> };
  // `self` is a bare object: `self.addEventListener` is undefined, so sw.js's
  // guarded event-wiring block does not execute.
  const fn = new Function('module', 'self', source);
  fn(moduleObj, {});
  return moduleObj.exports as ReturnType<typeof loadSw>;
}

const SELF_ORIGIN = 'https://scottm992.github.io';
const sw = loadSw();

describe('sw: isSameOrigin', () => {
  it('true for same origin, false for cross origin', () => {
    expect(sw.isSameOrigin(`${SELF_ORIGIN}/simple-bitcoin-wallet/`, SELF_ORIGIN)).toBe(true);
    expect(sw.isSameOrigin('https://mempool.space/api/v1/prices', SELF_ORIGIN)).toBe(false);
  });

  it('false (→ passthrough) for an unparseable url', () => {
    expect(sw.isSameOrigin('::::not a url::::', SELF_ORIGIN)).toBe(false);
  });
});

describe('sw: decideStrategy', () => {
  const get = (url: string, mode?: string) => ({ method: 'GET', url, ...(mode ? { mode } : {}) });

  it('NEVER touches cross-origin requests (mempool.space passes through)', () => {
    expect(sw.decideStrategy(get('https://mempool.space/api/address/bc1q'), SELF_ORIGIN)).toBe(
      'passthrough',
    );
    expect(sw.decideStrategy(get('https://mempool.space/api/v1/prices'), SELF_ORIGIN)).toBe(
      'passthrough',
    );
    // ...even for a navigation-mode cross-origin request.
    expect(
      sw.decideStrategy(get('https://example.com/', 'navigate'), SELF_ORIGIN),
    ).toBe('passthrough');
  });

  it('never handles non-GET (even same-origin) — passthrough', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      expect(
        sw.decideStrategy(
          { method, url: `${SELF_ORIGIN}/simple-bitcoin-wallet/` },
          SELF_ORIGIN,
        ),
      ).toBe('passthrough');
    }
  });

  it('same-origin navigation → network-first (fresh HTML always wins)', () => {
    expect(
      sw.decideStrategy(get(`${SELF_ORIGIN}/simple-bitcoin-wallet/`, 'navigate'), SELF_ORIGIN),
    ).toBe('network-first');
  });

  it('same-origin hashed /assets/ file → cache-first (immutable)', () => {
    expect(
      sw.decideStrategy(
        get(`${SELF_ORIGIN}/simple-bitcoin-wallet/assets/index-abc123.js`),
        SELF_ORIGIN,
      ),
    ).toBe('cache-first');
    expect(
      sw.decideStrategy(
        get(`${SELF_ORIGIN}/simple-bitcoin-wallet/assets/index-def456.css`),
        SELF_ORIGIN,
      ),
    ).toBe('cache-first');
  });

  it('other same-origin GETs (manifest, icons) → network-first', () => {
    expect(
      sw.decideStrategy(get(`${SELF_ORIGIN}/simple-bitcoin-wallet/manifest.webmanifest`), SELF_ORIGIN),
    ).toBe('network-first');
    expect(
      sw.decideStrategy(get(`${SELF_ORIGIN}/simple-bitcoin-wallet/icons/icon-192.png`), SELF_ORIGIN),
    ).toBe('network-first');
  });
});

describe('sw: cache name', () => {
  it('is versioned and prefix-scoped so activate can prune older caches', () => {
    expect(sw.CACHE_NAME.startsWith(sw.CACHE_PREFIX)).toBe(true);
    expect(sw.CACHE_NAME).toMatch(/v\d+$/);
  });
});
