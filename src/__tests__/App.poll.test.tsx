/**
 * App.poll.test.tsx — §1d: the 30s poll cycle fetches price + fees EXACTLY ONCE,
 * even when the tick also triggers a full account refresh (self-heal or a
 * poll-detected change). Before the fix, a change-detecting tick fetched
 * price/fees once itself and then again via the refresh — two of each per cycle.
 *
 * Drives the real App: create a fast-KDF vault, unlock, land on Home (empty
 * wallet), then advance the interval under fake timers and count the mocked
 * price/fees calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockApi = vi.hoisted(() => ({ used: new Set<string>() }));

// Empty/fast api; a tip in `used` reads as funded so the cheap poll flags a
// change. Price + fees are vi.fn so we can count calls per cycle.
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async (_network: unknown, address: string) => ({
      confirmedSats: mockApi.used.has(address) ? 10_000n : 0n,
      pendingSats: 0n,
      fundedSats: mockApi.used.has(address) ? 10_000n : 0n,
      spentSats: 0n,
    })),
    getUtxos: vi.fn(async () => []),
    getAddressTxs: vi.fn(async () => []),
    getFeeEstimates: vi.fn(async () => ({ fast: 5, medium: 3, slow: 1 })),
    getBtcUsdPrice: vi.fn(async () => 60_000),
  };
});

// Fast scrypt so create/unlock are quick.
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
import { getBtcUsdPrice, getFeeEstimates } from '../lib/api';
import { createVault, deriveReceiveAddress, DEFAULT_DISCOVERY_OPTIONS } from '../lib';
import { strings } from '../strings';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'test-password-12';

/**
 * The REAL setTimeout, captured at module load — before any test installs fake
 * timers (vi.useFakeTimers replaces the global property; a saved reference to
 * the original still schedules genuine macrotasks). This is the escape hatch
 * that makes {@link settle} deterministic: unlock awaits Node WebCrypto
 * (crypto.subtle.importKey/decrypt in vault.ts), whose promises resolve on the
 * THREADPOOL via real event-loop turns — not on the faked clock and not on the
 * microtask queue. A one-shot advanceTimersByTimeAsync(N) yields only a bounded
 * number of real turns (one per fired fake timer), so whether the decrypt
 * completion landed inside them was a real-scheduling race (~25% flake, always
 * at the post-unlock assertion).
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** One REAL macrotask turn — lets threadpool completions (WebCrypto) land. */
const realTurn = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 0));

/**
 * Polls the DOM until `pred` holds, alternating one real event-loop turn (for
 * threadpool-resolved promises) with a small fake-clock advance inside `act`
 * (for anything the app scheduled on timers). Bounded: throws if the app never
 * reaches the expected state, so a genuine regression still fails loudly. The
 * fake time consumed is a few ms per iteration — far below the 30s poll
 * interval, so the exactly-one-tick-per-30s assertions in this suite are
 * unaffected (the interval's next fire stays within the tests' 30_000 advance).
 */
async function settle(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await act(async () => {
      await realTurn();
      await vi.advanceTimersByTimeAsync(5);
    });
  }
  throw new Error('settle(): the app never reached the expected state');
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  mockApi.used.clear();
  // This suite tests the price/fees cadence, not Stage-2 pacing, so run
  // discovery unpaced for deterministic timing (pacing is covered in
  // discovery.test.ts).
  (DEFAULT_DISCOVERY_OPTIONS as { waveDelayMs?: number }).waveDelayMs = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Sets an input's value via the native setter so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function byText(text: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>('button, a, h1, h2, div, span')) {
    if (el.textContent?.trim() === text) return el;
  }
  return null;
}

/** Boots App to an unlocked Home on an empty mainnet wallet. */
async function bootToHome(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
  });
  // Boot resolves to the Unlock screen (a vault exists). settle(), not a fixed
  // advance: boot/unlock await WebCrypto, which resolves on real event-loop
  // turns the fake clock does not drive (see realSetTimeout above).
  await settle(() => container.querySelector('input[type="password"]') !== null);
  const pw = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(pw).not.toBeNull();
  await act(async () => setNativeValue(pw!, PASSWORD));
  await act(async () => (byText(strings.unlock.unlock) as HTMLElement).click());
  // Let unlock (scrypt + AES-GCM decrypt on the threadpool) + the initial
  // refreshAll (account + price + fees) settle — polled, not a one-shot 500ms
  // advance, so the WebCrypto completions always get the real turns they need.
  // On Home now: the Receive/Send verb row is present regardless of balance.
  await settle(() => container.querySelector('.verb-row') !== null);
  expect(container.querySelector('.verb-row')).not.toBeNull();
}

describe('App — one price + one fees fetch per 30s cycle (§1d)', () => {
  it('a healthy tick fetches price and fees exactly once', async () => {
    await createVault(ABANDON, PASSWORD, 'mainnet');
    vi.useFakeTimers();
    await bootToHome();

    vi.mocked(getBtcUsdPrice).mockClear();
    vi.mocked(getFeeEstimates).mockClear();

    // One quiet 30s tick: cheap poll finds nothing, so no refresh is triggered.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(vi.mocked(getBtcUsdPrice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getFeeEstimates)).toHaveBeenCalledTimes(1);
  });

  it('a tick that triggers a full refresh STILL fetches price and fees only once', async () => {
    await createVault(ABANDON, PASSWORD, 'mainnet');
    vi.useFakeTimers();
    await bootToHome();

    // The receive tip now receives a payment: the next cheap poll flags a change
    // and triggers a full account refresh in the SAME cycle.
    mockApi.used.add(deriveReceiveAddress(ABANDON, 'mainnet', 0).address);

    vi.mocked(getBtcUsdPrice).mockClear();
    vi.mocked(getFeeEstimates).mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // The refresh path (refreshAccount) must NOT re-fetch price/fees — the tick
    // already did, once. (Pre-§1d this was two of each.)
    expect(vi.mocked(getBtcUsdPrice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getFeeEstimates)).toHaveBeenCalledTimes(1);
  });
});
