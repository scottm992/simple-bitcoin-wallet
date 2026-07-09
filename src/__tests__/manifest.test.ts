/**
 * manifest.test.ts — the PWA manifest is valid JSON and carries the members the
 * install flow needs, with subpath-safe relative urls. Cheap guard against a
 * typo silently breaking installability on GitHub Pages' subpath.
 *
 * The manifest is imported as raw text (Vite's ?raw) so the "valid JSON"
 * assertion actually parses the shipped bytes.
 */
import { describe, it, expect } from 'vitest';
import raw from '../../public/manifest.webmanifest?raw';

describe('web app manifest', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const m = JSON.parse(raw) as Record<string, unknown>;

  it('has the required top-level members', () => {
    expect(m.name).toBe('Simple Bitcoin Wallet');
    expect(typeof m.short_name).toBe('string');
    expect((m.short_name as string).length).toBeGreaterThan(0);
    expect((m.short_name as string).length).toBeLessThanOrEqual(12); // fits under a home-screen icon
    expect(typeof m.description).toBe('string');
    expect(m.display).toBe('standalone');
    expect(typeof m.theme_color).toBe('string');
    expect(typeof m.background_color).toBe('string');
  });

  it('uses subpath-safe RELATIVE start_url / scope (never a leading "/")', () => {
    // A leading-slash url would resolve to the GitHub Pages domain root, not the
    // app's /simple-bitcoin-wallet/ subpath. Relative "./" resolves against the
    // manifest url, which is exactly the app root.
    for (const key of ['start_url', 'scope'] as const) {
      const value = m[key];
      expect(typeof value).toBe('string');
      expect(value as string).toBe('./');
    }
  });

  it('declares 192, 512, and a maskable 512 PNG icon with relative srcs', () => {
    const icons = m.icons as Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    expect(Array.isArray(icons)).toBe(true);
    const bySize = (s: string) => icons.filter((i) => i.sizes === s);
    expect(bySize('192x192').length).toBeGreaterThanOrEqual(1);
    expect(bySize('512x512').length).toBeGreaterThanOrEqual(1);
    expect(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      // No leading slash — must resolve relative to the manifest (the subpath).
      expect(icon.src.startsWith('/')).toBe(false);
      expect(icon.src.startsWith('http')).toBe(false);
    }
  });
});
