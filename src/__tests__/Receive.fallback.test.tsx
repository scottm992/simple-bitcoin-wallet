/**
 * Receive.fallback.test.tsx — regression tests for the PM-reported bug: with
 * account discovery failed (flaky network at first load), the Receive screen
 * rendered an EMPTY address row and a scannable v1 QR encoding a bare
 * `bitcoin:` URI.
 *
 * Fixed behavior under test:
 *  (a) discovery failed → Receive falls back to a LOCALLY derived receive
 *      address (cached last-known index, else index 0) with a QR whose payload
 *      contains that address;
 *  (b) the Qr component refuses an empty/scheme-only payload outright, and
 *      Receive shows a plain-English message if it ever has no address;
 *  (c) once discovery succeeds, Receive shows the true next-unused address,
 *      and the index is cached so a later offline session still derives it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import encodeQR from 'qr';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Controllable network mock: starts DOWN; `used` marks addresses as on-chain
// used so discovery picks the next index.
const mockNet = vi.hoisted(() => ({ fail: true, used: new Set<string>() }));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async (_network: unknown, address: string) => {
      if (mockNet.fail) throw new actual.ApiNetworkError('offline');
      const used = mockNet.used.has(address);
      return {
        confirmedSats: used ? 10_000n : 0n,
        pendingSats: 0n,
        fundedSats: used ? 10_000n : 0n,
        spentSats: 0n,
      };
    }),
    getUtxos: vi.fn(async () => []),
    getAddressTxs: vi.fn(async () => []),
    getFeeEstimates: vi.fn(async () => ({ fast: 5, medium: 3, slow: 1 })),
    getBtcUsdPrice: vi.fn(async () => 60_000),
  };
});

// Fast scrypt for vault creation (same pattern as App.flow.test).
vi.mock('../lib/vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vault')>();
  const fast = { N: 2 ** 8, r: 8, p: 1, dkLen: 32 };
  return {
    ...actual,
    createVault: (mnemonic: string, password: string, network: 'mainnet' | 'testnet') =>
      actual.createVault(mnemonic, password, network, fast),
  };
});

import App from '../App';
import { Qr } from '../components/Qr';
import { Receive } from '../screens/Receive';
import { strings } from '../strings';
import { bitcoinUri } from '../display';
import { deriveReceiveAddress, getCachedReceiveIndex, DEFAULT_DISCOVERY_OPTIONS } from '../lib';

const PASSWORD = 'test-password-11';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  mockNet.fail = true;
  mockNet.used.clear();
  // This suite tests Receive's local-derivation fallback, not Stage-2 pacing, so
  // run discovery unpaced for deterministic timing (pacing lives in
  // discovery.test.ts).
  (DEFAULT_DISCOVERY_OPTIONS as { waveDelayMs?: number }).waveDelayMs = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function byText(text: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>('button, a, h1, h2, div, span')) {
    if (el.textContent?.trim() === text) return el;
  }
  return null;
}

function buttonContaining(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.includes(text)) return b as HTMLButtonElement;
  }
  return null;
}

/** Polls until `pred` holds (act-wrapped), or fails the test. */
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

/** Sets an input's value via the native setter so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Normalizes an SVG string through the same DOM parser React's innerHTML uses. */
function normalizeSvg(svg: string): string {
  const d = document.createElement('div');
  d.innerHTML = svg;
  return d.innerHTML;
}

/** Expected QR innerHTML for an address, built with the Qr component's exact params. */
function expectedQrHtml(address: string): string {
  return normalizeSvg(encodeQR(bitcoinUri(address), 'svg', { ecc: 'medium', border: 1 }));
}

/**
 * Drives the full create flow (harvesting the generated 12 words from the
 * reveal DOM) through to Home. Returns the wallet's mnemonic.
 */
async function createWalletThroughUi(): Promise<string> {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });

  await act(async () => byText('Create a new wallet')!.click());
  await act(async () => container.querySelector<HTMLElement>('.reveal-card__shield')!.click());

  // Harvest the revealed words: each chip renders "<n><word>".
  const words = Array.from(container.querySelectorAll<HTMLElement>('.word')).map((el) =>
    (el.textContent ?? '').replace(/^\d+/, '').trim(),
  );
  expect(words).toHaveLength(12);

  await act(async () => (byText("I've written them down") as HTMLElement).click());

  // Confirm game: brute-force chips until each prompt advances (proven pattern).
  for (let step = 0; step < 3; step++) {
    const before = container.querySelector('.h2')?.textContent;
    for (const chip of Array.from(container.querySelectorAll<HTMLButtonElement>('.chip'))) {
      await act(async () => chip.click());
      const now = container.querySelector('.h2')?.textContent;
      if (now !== before || container.textContent?.includes('Create a password')) break;
    }
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 800));
  });
  expect(container.textContent).toContain('Create a password');

  const pw = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
  await act(async () => {
    setNativeValue(pw[0]!, PASSWORD);
    setNativeValue(pw[1]!, PASSWORD);
  });
  await act(async () => (byText('Set password') as HTMLElement).click());
  await until(() => container.textContent?.includes('Your balance') === true);

  return words.join(' ');
}

/** Opens Receive from Home (first verb tile). */
async function openReceive(): Promise<void> {
  await until(() => container.querySelector('.verb') !== null);
  await act(async () => container.querySelector<HTMLElement>('.verb')!.click());
  await until(() => container.textContent?.includes(strings.receive.heading) === true);
}

/** Returns the raw address shown by the Receive screen's address row. */
function shownAddress(): string {
  const label = container.querySelector('.addr')?.getAttribute('aria-label') ?? '';
  const m = /^Address (\S+)\. Tap to copy\.$/.exec(label);
  return m?.[1] ?? '';
}

describe('Qr — refuses empty payloads (belt and braces)', () => {
  it('renders no scannable QR for "" or a bare "bitcoin:" URI', async () => {
    for (const data of ['', '   ', 'bitcoin:']) {
      await act(async () => {
        root = createRoot(container);
        root.render(<Qr data={data} />);
      });
      expect(container.querySelector('.qr svg')).toBeNull();
      expect(container.textContent).toContain(strings.receive.qrError);
      act(() => root.unmount());
    }
    // Keep afterEach happy with a mounted root.
    await act(async () => {
      root = createRoot(container);
      root.render(<Qr data="bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" />);
    });
    expect(container.querySelector('.qr svg')).not.toBeNull();
  });
});

describe('Receive — empty-address state (should be unreachable)', () => {
  it('shows a plain-English message instead of an empty address row + QR', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<Receive network="mainnet" address="" onBack={() => {}} />);
    });
    expect(container.textContent).toContain(strings.receive.unavailable);
    expect(container.querySelector('.qr svg')).toBeNull();
    expect(container.querySelector('.addr')).toBeNull();
  });
});

describe('Receive — locally derived fallback when discovery is unavailable', () => {
  it('failed discovery → derived index-0 address with a QR encoding it; after discovery + relock → cached index', async () => {
    const mnemonic = await createWalletThroughUi();
    const addr0 = deriveReceiveAddress(mnemonic, 'mainnet', 0).address;
    const addr1 = deriveReceiveAddress(mnemonic, 'mainnet', 1).address;

    // -- (a) Discovery failed (network down): Home is in the error state, yet
    // Receive shows the REAL, locally derived index-0 address — never an empty
    // row or an empty QR.
    expect(container.textContent).toContain(strings.errors.network);
    await openReceive();
    expect(shownAddress()).toBe(addr0);
    // The QR payload provably contains the address: byte-identical SVG to an
    // encoding of bitcoin:<addr0> with the component's exact parameters.
    expect(container.querySelector('.qr')?.innerHTML).toBe(expectedQrHtml(addr0));

    // -- (c) Network recovers with index 0 used on-chain: after a retry,
    // Receive shows the TRUE next-unused address (index 1)...
    await act(async () => container.querySelector<HTMLElement>('.topbar__back')!.click());
    mockNet.fail = false;
    mockNet.used.add(addr0);
    await act(async () => (byText('Try again') as HTMLElement).click());
    await until(() => container.textContent?.includes(strings.errors.network) === false);
    await openReceive();
    expect(shownAddress()).toBe(addr1);
    expect(container.querySelector('.qr')?.innerHTML).toBe(expectedQrHtml(addr1));

    // ...and the index was cached (non-secret) alongside the vault.
    expect(getCachedReceiveIndex('mainnet')).toBe(1);

    // -- (a, cached) Lock, go offline again, unlock: with discovery failing,
    // Receive now derives from the CACHED index (1), not index 0.
    mockNet.fail = true;
    await act(async () => container.querySelector<HTMLElement>('.topbar__back')!.click());
    await act(async () => container.querySelector<HTMLElement>('.topbar__gear')!.click());
    await act(async () => buttonContaining(strings.settings.lockNow)!.click());
    await until(() => container.textContent?.includes(strings.unlock.heading) === true);

    const pw = container.querySelector<HTMLInputElement>('input[type="password"]');
    await act(async () => setNativeValue(pw!, PASSWORD));
    await act(async () => (byText(strings.unlock.unlock) as HTMLElement).click());
    await until(() => container.textContent?.includes('Your balance') === true);
    await until(() => container.textContent?.includes(strings.errors.network) === true);

    await openReceive();
    expect(shownAddress()).toBe(addr1);
    expect(container.querySelector('.qr')?.innerHTML).toBe(expectedQrHtml(addr1));
  }, 20_000);
});
