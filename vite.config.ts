/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// `base: './'` makes the build deploy correctly from a GitHub Pages subpath.

/**
 * The strict production Content-Security-Policy (per docs brief):
 *   default-src 'self'; connect-src 'self' https://mempool.space
 *   https://blockstream.info; img-src 'self' data:; style-src 'self'
 *   'unsafe-inline'; no script-src beyond 'self'.
 * `object-src 'none'` and `base-uri 'self'` are added as standard hardening.
 *
 * v1.2.0 adds https://blockstream.info to connect-src: chain data (address stats
 * / utxos / txs / one-tx fetch / broadcast) now goes there, while mempool.space
 * is KEPT for fee estimates + USD price. Two hosts, each seeing limited request
 * types (Round 13 audit OWED — trust-model change).
 */
const PROD_CSP = [
  "default-src 'self'",
  "connect-src 'self' https://mempool.space https://blockstream.info",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * Vite's dev server injects an inline HMR client script and connects over a
 * websocket, which the strict policy would block. This dev-only relaxation adds
 * 'unsafe-inline'/'unsafe-eval' to script-src and ws: to connect-src. It applies
 * ONLY when serving (dev), never to the built output.
 */
const DEV_CSP = [
  "default-src 'self'",
  "connect-src 'self' https://mempool.space https://blockstream.info ws: wss:",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * Replaces the CSP_PLACEHOLDER token with the mode-appropriate policy.
 * `enforce: 'post'` ensures this runs after other plugins' HTML processing, so
 * the replacement survives into the emitted index.html.
 */
function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'inject-csp',
    enforce: 'post',
    transformIndexHtml(html: string): string {
      return html.split('CSP_PLACEHOLDER').join(isDev ? DEV_CSP : PROD_CSP);
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), cspPlugin(command === 'serve')],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
