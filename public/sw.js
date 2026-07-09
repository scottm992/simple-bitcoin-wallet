/*
 * sw.js — service worker for Simple Bitcoin Wallet (classic script, plain JS).
 *
 * This wallet handles real money and has a deliberately narrow network surface.
 * The service worker exists ONLY to make the static app shell installable and
 * offline-openable. It must add ZERO behavior to money/chain traffic. Every line
 * here is written to be security-audited; read the hard rules before changing it.
 *
 * ============================ HARD RULES ============================
 *
 * 1. NEVER touch cross-origin requests. Anything whose origin differs from ours
 *    (in particular ALL mempool.space API traffic — balances, UTXOs, fees,
 *    broadcast, price) falls straight through: the fetch handler returns without
 *    calling event.respondWith(), so the browser does exactly what it would with
 *    no service worker at all. The discovery layer has strict single-flight /
 *    budget / deadline semantics and the API stall-throttles bursts, so the SW
 *    adds no requests, no retries, and no caching to that traffic. (see
 *    docs/ENGINE.md — src/actions.ts.)
 *
 * 2. Never cache non-GET requests.
 *
 * 3. Navigations / HTML are NETWORK-FIRST: an online user ALWAYS gets the freshest
 *    deployed HTML; the cache is only a fallback when the network fails. This is
 *    the anti-footgun — a bad deploy can never pin clients to stale HTML.
 *
 * 4. Vite's content-hashed, immutable build assets (the /assets/ output) are
 *    CACHE-FIRST, populated at runtime. No precache manifest is needed: the app
 *    is tiny and every asset filename embeds a content hash, so a changed asset
 *    is a NEW url (cache-first can never serve stale content), and a redeploy's
 *    fresh index.html — fetched network-first — references the new urls. The
 *    first real navigation + asset loads warm the cache; that is sufficient.
 *
 * 5. Any internal error in the fetch handler must let the request fall through to
 *    the network. The SW degrades to a no-op; it must never break the app.
 *
 * ---- Update semantics (decision, documented) ----
 * We use the DEFAULT service-worker lifecycle: a new SW installs, then WAITS, and
 * activates on the next launch (once every tab of the old version is gone). We do
 * NOT call skipWaiting(). Reason: skipWaiting swaps the controlling SW mid-session,
 * which could start serving a newer deploy's cache-first assets to the currently
 * running (older) page — a version-skew footgun that is unacceptable in money
 * software. Letting the new SW wait keeps a running session pinned to one coherent
 * version. clients.claim() (below) is a different thing and IS safe here: because
 * we never skipWaiting, claim can only take effect for the initial install (same
 * version — no skew) or for a new SW that has already become the sole controller
 * on a later launch. It simply lets offline caching begin on the very first visit.
 */

// Bump this constant to invalidate the whole runtime cache on the next activate.
var CACHE_PREFIX = 'sbw-cache-';
var CACHE_NAME = CACHE_PREFIX + 'v1';

// ======================= PURE DECISION LOGIC =======================
// These functions do NO I/O and touch no service-worker globals. They take
// everything they need as arguments so they can be unit-tested in isolation
// (see src/__tests__/sw.test.ts, which loads this source and evaluates it with a
// stub `self`, exercising exactly these functions).

/** True when `requestUrl` is on the same origin as `selfOrigin`. Unparseable
 *  urls are treated as NOT same-origin, so they pass through untouched. */
function isSameOrigin(requestUrl, selfOrigin) {
  try {
    return new URL(requestUrl).origin === selfOrigin;
  } catch (e) {
    return false;
  }
}

/**
 * Decide how the fetch handler should treat a request. Returns one of:
 *   'passthrough'   — do NOT call respondWith(); let the browser handle it
 *   'network-first' — fresh-from-network, fall back to cache when offline
 *   'cache-first'   — serve from cache if present, else fetch and cache
 *
 * The ordering encodes the hard rules: non-GET and cross-origin ALWAYS pass
 * through; only same-origin GETs are ever handled.
 */
function decideStrategy(request, selfOrigin) {
  // Rule 2: only GET is ever handled.
  if (request.method !== 'GET') return 'passthrough';
  // Rule 1: cross-origin (mempool.space + anything not us) is never touched.
  if (!isSameOrigin(request.url, selfOrigin)) return 'passthrough';
  // Rule 3: top-level navigations / documents are network-first.
  if (request.mode === 'navigate') return 'network-first';
  // Rule 4: Vite's content-hashed immutable assets are cache-first.
  var path;
  try {
    path = new URL(request.url).pathname;
  } catch (e) {
    return 'passthrough';
  }
  if (path.indexOf('/assets/') !== -1) return 'cache-first';
  // Everything else same-origin (manifest, icons, root files): network-first, so
  // a redeploy is always reflected and the cache only serves them when offline.
  return 'network-first';
}

// ======================= RUNTIME (I/O) HELPERS =====================
// Only reached from the fetch handler, i.e. only in a real service worker.

// Network-first: try the network, cache a good copy, fall back to cache offline.
function networkFirst(request) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return fetch(request).then(
      function (response) {
        // What each layer excludes from the cache: `response.ok` excludes
        // non-2xx (error/redirect statuses); `type === 'basic'` excludes
        // cross-origin/opaque responses. Note a 206 partial PASSES `ok` (ok is
        // any 200-299) — it is the Cache API itself that rejects storing a 206,
        // which is one reason put() below can reject. The response is returned
        // to the page regardless of whether it was stored.
        if (response && response.ok && response.type === 'basic') {
          // Caching is best-effort by design: a rejected put (quota pressure, a
          // 206 the Cache API refuses, Vary: *) must never surface as an
          // unhandled rejection — the page already has its response.
          cache.put(request, response.clone()).catch(function () {});
        }
        return response;
      },
      function (networkError) {
        // Offline (or the deploy is unreachable): serve a cached copy if we have
        // one. ignoreSearch so a navigation with a query string still matches the
        // cached app shell. Nothing cached → rethrow so the browser shows its own
        // offline error (we never fabricate a response).
        return cache.match(request, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          throw networkError;
        });
      },
    );
  });
}

// Cache-first: content-hashed assets are immutable, so a hit is always correct.
function cacheFirst(request) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        // Same guards + Cache API behavior as networkFirst (see comment there).
        if (response && response.ok && response.type === 'basic') {
          // Best-effort: swallow put() rejections; the page has its response.
          cache.put(request, response.clone()).catch(function () {});
        }
        return response;
      });
    });
  });
}

// ======================= EVENT WIRING ==============================
// Guarded so this file can also be loaded by the unit test (which provides a
// stub `self` with no addEventListener) purely to exercise the pure functions.

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', function () {
    // No precache (see hard rule 4). Deliberately NO skipWaiting() (see header):
    // the new worker waits and activates on the next launch.
  });

  self.addEventListener('activate', function (event) {
    // Drop any of OUR older caches; leave other origins'/apps' caches alone.
    event.waitUntil(
      caches
        .keys()
        .then(function (keys) {
          return Promise.all(
            keys
              .filter(function (key) {
                return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
              })
              .map(function (key) {
                return caches.delete(key);
              }),
          );
        })
        .then(function () {
          // Safe here (see header): we never skipWaiting, so claiming only ever
          // controls same-version pages. Lets offline caching start first visit.
          return self.clients.claim();
        }),
    );
  });

  self.addEventListener('fetch', function (event) {
    var strategy;
    try {
      strategy = decideStrategy(event.request, self.location.origin);
    } catch (e) {
      // Rule 5: any error → do nothing → the browser performs the default fetch.
      return;
    }
    // Passthrough MUST NOT call respondWith (hard rules 1 & 2): returning here
    // leaves the request exactly as if no service worker existed.
    if (strategy === 'passthrough') return;

    if (strategy === 'network-first') {
      event.respondWith(networkFirst(event.request));
    } else if (strategy === 'cache-first') {
      event.respondWith(cacheFirst(event.request));
    }
    // Any other value: fall through (no respondWith) — safe by construction.
  });
}

// Test-only export. In a real service worker `module` is undefined, so this is a
// no-op there; the unit test supplies a `module` object to capture the pure
// functions. (The `typeof` guard means this never throws in the browser.)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isSameOrigin, decideStrategy, CACHE_NAME, CACHE_PREFIX };
}
