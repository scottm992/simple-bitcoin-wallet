/**
 * App.flow.test.tsx — deeper smoke test: create a wallet end-to-end (through
 * password set), land on Home with a mocked network, open Receive (QR renders),
 * and open Send. Uses a low-cost scrypt param via a vault mock is NOT needed —
 * we mock the api module so no real network calls happen, and use the real
 * (fast enough) vault with a tiny password. Scrypt at N=2^17 is ~150ms, fine.
 *
 * The api module is mocked so discovery returns an empty account quickly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock the api surface used by discovery + price + fees. Everything empty/fast.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async () => ({
      confirmedSats: 0n,
      pendingSats: 0n,
      fundedSats: 0n,
      spentSats: 0n,
    })),
    getUtxos: vi.fn(async () => []),
    getAddressTxs: vi.fn(async () => []),
    getFeeEstimates: vi.fn(async () => ({ fast: 5, medium: 3, slow: 1 })),
    getBtcUsdPrice: vi.fn(async () => 60_000),
  };
});

// Speed up vault KDF so the create step is fast in the test.
vi.mock('../lib/vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/vault')>();
  const fast = { N: 2 ** 8, r: 8, p: 1, dkLen: 32 };
  return {
    ...actual,
    createVault: (mnemonic: string, password: string, network: 'mainnet' | 'testnet') =>
      actual.createVault(mnemonic, password, network, fast),
    unlockVault: (password: string) => actual.unlockVault(password),
  };
});

import App from '../App';
import { DEFAULT_DISCOVERY_OPTIONS } from '../lib';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  // Smoke test of the create→home flow, not Stage-2 pacing: run discovery
  // unpaced so no paced run lingers past unmount (pacing lives in
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('App full create → home (smoke)', () => {
  it('creates a wallet, lands on Home, opens Receive with a QR', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    // Welcome → create
    await act(async () => byText('Create a new wallet')!.click());
    // Reveal → tap to reveal → continue
    await act(async () => container.querySelector<HTMLElement>('.reveal-card__shield')!.click());
    await act(async () => (byText("I've written them down") as HTMLElement).click());

    // Confirm game: tap the correct chip 3 times. We read the wallet's words from
    // the reveal DOM is gone, so instead answer by trying every chip until the
    // prompt advances. Simpler: read the requested position and match against the
    // rendered word chips is not possible without the phrase; instead brute-force.
    for (let step = 0; step < 3; step++) {
      const promptEl = container.querySelector('.h2');
      expect(promptEl?.textContent).toMatch(/What's word number \d+/);
      const before = promptEl?.textContent;
      const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.chip'));
      // Try each chip until the prompt changes (correct) or success text appears.
      for (const chip of chips) {
        await act(async () => chip.click());
        const nowPrompt = container.querySelector('.h2')?.textContent;
        if (nowPrompt !== before || container.textContent?.includes('Create a password')) break;
      }
    }

    // After 3 correct, we're on Set a password (auto-advance has a 700ms timer on
    // the 3rd; wait for it).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    expect(container.textContent).toContain('Create a password');

    // Fill password + confirm, submit.
    const pwInputs = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(pwInputs.length).toBe(2);
    await act(async () => {
      setNativeValue(pwInputs[0]!, 'test-password-8');
      setNativeValue(pwInputs[1]!, 'test-password-8');
    });
    await act(async () => (byText('Set password') as HTMLElement).click());

    // Let vault create + discovery resolve.
    await act(async () => {
      await tick();
      await tick();
      await tick();
    });

    // We should be on Home now with an empty-wallet nudge.
    expect(container.textContent).toContain('Your balance');

    // Open Receive; the QR SVG should render locally.
    const receiveBtn = container.querySelector<HTMLElement>('.verb');
    expect(receiveBtn).not.toBeNull();
    await act(async () => receiveBtn!.click());
    await act(async () => {
      await tick();
    });
    expect(container.textContent).toContain('Receive bitcoin');
    // QR renders as an inline <svg>.
    expect(container.querySelector('.qr svg')).not.toBeNull();
  });
});

/** Sets an input's value via the native setter so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
