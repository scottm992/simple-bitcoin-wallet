/**
 * Send.customgate.test.tsx — the relaxed custom-send gate (owner decision
 * 2026-07-10; Round-15 territory).
 *
 * The change DELIBERATELY REMOVES a fail-closed rail: a VALID CUSTOM rate may
 * now send while fee estimates are unavailable (the user typed an explicit
 * rate; the estimate endpoint being down shouldn't block self-directed
 * sending). What these tests pin:
 *  - fees=null + valid custom rate → Review enabled, PendingSend exact, and
 *    the ENTIRE flow (compose → Review dry-run → mocked broadcast) works with
 *    estimates never loading — proving nothing downstream reads fees when the
 *    rate is explicit;
 *  - fees=null + tier → still blocked: tier chips are disabled and fabricate
 *    no costs (F21 law — the old rate-1 "typical" placeholder is gone, which
 *    matters now that fees-null is a reachable SENDING state);
 *  - the 25% consent rule (F10) still trips for a custom rate during an
 *    estimates outage — the relaxed gate must not skip consent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---------------------------------------------------------------------------
// Mocks for the full-flow test: chain data serves one funded address; fee
// estimates ALWAYS fail (the outage under test); broadcast is captured. The
// created wallet is pinned to the abandon mnemonic so the funded address is
// known before the UI runs.
// ---------------------------------------------------------------------------

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const mockNet = vi.hoisted(() => ({
  fundedAddress: null as string | null,
  broadcasts: [] as string[],
}));

vi.mock('../lib/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/wallet')>();
  return {
    ...actual,
    // Deterministic create flow: the "generated" wallet is the abandon wallet,
    // so the funded-address mock below can be armed before the UI runs.
    generateMnemonic: vi.fn(
      () =>
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ),
  };
});

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async (_network: unknown, address: string) => {
      const funded = address === mockNet.fundedAddress;
      return {
        confirmedSats: funded ? 50_000n : 0n,
        pendingSats: 0n,
        fundedSats: funded ? 50_000n : 0n,
        spentSats: 0n,
      };
    }),
    getUtxos: vi.fn(async (_network: unknown, address: string) =>
      address === mockNet.fundedAddress
        ? [{ txid: 'f'.repeat(64), vout: 0, value: 50_000n, confirmed: true, blockHeight: 1 }]
        : [],
    ),
    getAddressTxs: vi.fn(async (_network: unknown, address: string) =>
      address === mockNet.fundedAddress
        ? [{ txid: 'f'.repeat(64), confirmed: true, blockTime: 1_700_000_000, netSats: 50_000n }]
        : [],
    ),
    // THE outage under test: estimates never load, state.feeEstimates stays null.
    getFeeEstimates: vi.fn(async () => {
      throw new actual.ApiNetworkError('fee estimates down');
    }),
    getBtcUsdPrice: vi.fn(async () => 60_000),
    broadcastTx: vi.fn(async (_network: unknown, txHex: string) => {
      mockNet.broadcasts.push(txHex);
      return 'relay-echo-ignored';
    }),
  };
});

// Fast scrypt for vault creation (same pattern as App.flow / Receive.fallback).
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
import { Send } from '../screens/Send';
import { strings } from '../strings';
import { deriveReceiveAddress, DEFAULT_DISCOVERY_OPTIONS } from '../lib';
import type { AccountSnapshot } from '../lib/account';
import type { PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
const BTC_USD = 60_000;
const PASSWORD = 'test-password-11';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  mockNet.fundedAddress = null;
  mockNet.broadcasts = [];
  (DEFAULT_DISCOVERY_OPTIONS as { waveDelayMs?: number }).waveDelayMs = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

// ---- Shared DOM helpers (house patterns) -----------------------------------

function findButton(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

function byText(text: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>('button, a, h1, h2, div, span')) {
    if (el.textContent?.trim() === text) return el;
  }
  return null;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function chipByTitle(title: string): HTMLButtonElement {
  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.fee'));
  const chip = chips.find((c) => c.querySelector('.fee__title')?.textContent === title);
  expect(chip).not.toBeUndefined();
  return chip!;
}

async function pickCustom(rateText?: string): Promise<void> {
  await act(async () => chipByTitle(strings.send.feeCustom).click());
  if (rateText !== undefined) {
    const input = container.querySelector<HTMLInputElement>('#send-custom-fee');
    expect(input).not.toBeNull();
    await act(async () => setNativeValue(input!, rateText));
  }
}

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

// ---- Component-level: the relaxed gate on the Send screen ------------------

function makeAccount(values: readonly bigint[]): AccountSnapshot {
  return {
    confirmedSats: values.reduce((s, v) => s + v, 0n),
    pendingSats: 0n,
    utxos: values.map((value, i) => ({
      txid: String(i + 1).padStart(64, '0'),
      vout: 0,
      value,
      path: "m/84'/0'/0'/0/0",
      address: 'bc1qowned',
    })),
    receiveAddress: 'bc1qreceive',
    receiveIndex: 0,
    changeAddress: 'bc1qchange',
    activity: [],
    usedAddresses: [],
    receiveHighWater: -1,
    changeHighWater: -1,
  };
}

async function mountSendNoFees(onReview: (pending: PendingSend) => void): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Send
        network="mainnet"
        account={makeAccount([100_000n])}
        btcUsd={BTC_USD}
        fees={null}
        onReview={onReview}
        onBack={() => {}}
      />,
    );
  });
}

async function fillAddressAndAmount(addr: string, usdAmount: string): Promise<void> {
  const to = container.querySelector<HTMLInputElement>('#send-to');
  const amt = container.querySelector<HTMLInputElement>('#send-amt');
  await act(async () => setNativeValue(to!, addr));
  await act(async () => setNativeValue(amt!, usdAmount));
}

describe('Send — custom rate sends without fee estimates (relaxed gate)', () => {
  it('fees unavailable + a valid custom rate → Review enabled, PendingSend exact', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSendNoFees(onReview);
    await fillAddressAndAmount(RECIPIENT, '20');
    await pickCustom('2.5');

    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.feeRateSatVb).toBe(2.5);
    expect(pending?.feeTier).toBe('custom');
    expect(pending?.allowHighFee).toBe(false);
  });

  it('fees unavailable + a tier → still blocked: tier chips disabled, Review held', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSendNoFees(onReview);
    await fillAddressAndAmount(RECIPIENT, '20');

    // A speed that cannot be priced cannot be picked...
    for (const title of [strings.send.feeStandard, strings.send.feeFaster, strings.send.feeEconomy]) {
      expect(chipByTitle(title).disabled, title).toBe(true);
    }
    // ...while the Custom chip stays live (the working path in an outage).
    expect(chipByTitle(strings.send.feeCustom).disabled).toBe(false);
    // Tier selected (the default) with no estimates: Review stays held.
    expect(findButton(strings.send.review)!.disabled).toBe(true);
    expect(onReview).not.toHaveBeenCalled();
  });

  it('fees unavailable → tiers fabricate nothing; the helper points at Custom; a typed rate restores honest previews', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSendNoFees(onReview);
    await fillAddressAndAmount(RECIPIENT, '20');

    // F21 law, now load-bearing: no tier chip cost, no rate line, no total
    // line — no number at a rate nobody chose (the old rate-1 placeholder
    // painted "≈ $..." on every chip here).
    expect(container.textContent).not.toContain('≈ $');
    expect(container.querySelector('.fee__rate')).toBeNull();
    expect(container.textContent).not.toContain("You'll send");
    // The outage is named, with the one live path pointed at.
    expect(container.textContent).toContain(strings.send.feesUnavailable);

    // A typed custom rate brings back honest, rate-derived previews.
    await pickCustom('2.5');
    expect(container.textContent).toContain("You'll send");
    expect(chipByTitle(strings.send.feeCustom).textContent).toContain('2.5 sat/vB');
  });

  it('the 25% consent rule (F10) still trips for a custom rate during an estimates outage', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSendNoFees(onReview);
    // $5 = 8,333 sats; at a custom 30 sat/vB the ~4,230-sat fee is > 25%. The
    // relaxed gate must NOT skip consent — this is the guard the old
    // fees-null short-circuit in highFee would have dropped.
    await fillAddressAndAmount(RECIPIENT, '5');
    await pickCustom('30');

    expect(container.textContent).toContain('Heads up: the network fee for this amount');
    expect(findButton(strings.send.review)!.disabled).toBe(true);
    const anyway = findButton(strings.send.sendAnyway);
    expect(anyway).not.toBeNull();
    await act(async () => anyway!.click());

    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.allowHighFee).toBe(true);
    expect(pending?.feeRateSatVb).toBe(30);
  });
});

// ---- Full flow: compose → Review → broadcast with estimates down -----------

describe('full flow — a custom-rate payment broadcasts while estimates are down', () => {
  it('create → fund → Send (custom 2.5) → Review → Send now → mocked broadcast', async () => {
    // The created wallet is pinned to the abandon mnemonic (wallet mock), so
    // its first receive address can be funded before the UI runs.
    mockNet.fundedAddress = deriveReceiveAddress(ABANDON, 'mainnet', 0).address;

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    // -- Create the wallet through the real UI (house harness pattern).
    await act(async () => byText('Create a new wallet')!.click());
    await act(async () => container.querySelector<HTMLElement>('.reveal-card__shield')!.click());
    await act(async () => (byText("I've written them down") as HTMLElement).click());
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

    // -- Home: the funded balance lands (50k sats @ 60k = $30.00) while fee
    // estimates keep failing — state.feeEstimates stays null for good.
    await until(() => container.textContent?.includes('$30.00') === true, 10_000);

    // -- Send: the estimates outage is visible, and Custom is the live path.
    await act(async () => container.querySelectorAll<HTMLElement>('.verb')[1]!.click());
    await until(() => container.textContent?.includes(strings.send.feesUnavailable) === true);
    await fillAddressAndAmount(RECIPIENT, '20');
    await pickCustom('2.5');
    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    // -- Review: the dry-run built real numbers from the explicit rate alone
    // (App.reviewNumbers reads only pending + account — never fees), and the
    // fee row names the custom rate.
    await until(() => container.textContent?.includes(strings.review.heading) === true);
    expect(container.textContent).toContain('at your rate of 2.5 sat/vB');

    // -- Confirm (Live mode: address checkbox first), then Send now.
    await act(async () => container.querySelector<HTMLElement>('.check-row')!.click());
    await act(async () => findButton(strings.review.sendNow)!.click());
    await until(() => container.textContent?.includes(strings.sent.heading) === true);

    // The payment went out the door with estimates down the whole time: one
    // real signed transaction reached the (mocked) relay.
    expect(mockNet.broadcasts).toHaveLength(1);
    expect(/^[0-9a-f]+$/i.test(mockNet.broadcasts[0]!)).toBe(true);
    expect(mockNet.broadcasts[0]!.length).toBeGreaterThan(100);
  }, 30_000);
});
