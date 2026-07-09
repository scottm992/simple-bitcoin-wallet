/**
 * Send.highfee.test.tsx — regression tests for the F10 informed-consent flow on
 * the compose screen.
 *
 * The old behavior let a small send compose cleanly, then slam into the engine's
 * 25% fee guard at Review with misleading "balance may have changed" copy and no
 * recovery. Now the compose screen pre-checks the fee-vs-amount ratio with the
 * engine's own vsize math and, when it would trip, shows a plain-English notice
 * with the real numbers and a "Send anyway" action that carries
 * `allowHighFee: true` into the PendingSend (and from there through the Review
 * dry-run and broadcast build).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Send } from '../screens/Send';
import { strings } from '../strings';
import type { AccountSnapshot } from '../lib/account';
import type { PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
/** Honest, in-window fee estimates; 'standard' maps to medium = 30 sat/vB. */
const FEES = { fast: 120, medium: 30, slow: 5 };
const BTC_USD = 60_000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Builds a minimal account snapshot holding the given UTXO values. */
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

function findButton(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

/** Sets an input's value via the native setter so React's onChange fires. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountSend(
  account: AccountSnapshot,
  onReview: (pending: PendingSend) => void,
): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Send
        network="mainnet"
        account={account}
        btcUsd={BTC_USD}
        fees={FEES}
        onReview={onReview}
        onBack={() => {}}
      />,
    );
  });
}

async function fillAddressAndAmount(addr: string, usdAmount: string): Promise<void> {
  const to = container.querySelector<HTMLInputElement>('#send-to');
  const amt = container.querySelector<HTMLInputElement>('#send-amt');
  expect(to).not.toBeNull();
  expect(amt).not.toBeNull();
  await act(async () => setNativeValue(to!, addr));
  await act(async () => setNativeValue(amt!, usdAmount));
}

describe('Send — high-fee informed consent (F10)', () => {
  it('a small send shows the notice with real numbers, holds Review, and "Send anyway" carries allowHighFee', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);

    // $5 at 60k = 8,333 sats; fee at 30 sat/vB (1-in/2-out) = 4,230 sats > 25%.
    await fillAddressAndAmount(RECIPIENT, '5');

    // The informed-consent notice is shown, with plain-English copy.
    expect(container.textContent).toContain('Heads up: the network fee for this amount');
    expect(container.textContent).toContain(strings.send.highFeeOptions);

    // The normal Review button is held back...
    const review = findButton(strings.send.review);
    expect(review).not.toBeNull();
    expect(review!.disabled).toBe(true);

    // ...but "Send anyway" proceeds, carrying the informed-consent flag.
    const anyway = findButton(strings.send.sendAnyway);
    expect(anyway).not.toBeNull();
    await act(async () => anyway!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.allowHighFee).toBe(true);
    expect(pending?.amountSats).toBe(8_333n);
    expect(pending?.sendMax).toBe(false);
    expect(pending?.feeRateSatVb).toBe(30);
  });

  it('an ordinary send shows no notice and goes to Review with allowHighFee false', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);

    // $20 = 33,333 sats; the 4,230-sat fee is well under 25%.
    await fillAddressAndAmount(RECIPIENT, '20');

    expect(container.textContent).not.toContain('Heads up: the network fee');
    expect(findButton(strings.send.sendAnyway)).toBeNull();

    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview.mock.calls[0]?.[0]?.allowHighFee).toBe(false);
  });

  it('Send Max on a small balance gets the same informed-consent path, not a dead end', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    // 10,000-sat balance: sweep fee at 30 sat/vB (1-in/1-out) = 3,300 sats > 25%.
    await mountSend(makeAccount([10_000n]), onReview);

    const to = container.querySelector<HTMLInputElement>('#send-to');
    await act(async () => setNativeValue(to!, RECIPIENT));
    const maxBtn = findButton(strings.send.max);
    expect(maxBtn).not.toBeNull();
    await act(async () => maxBtn!.click());

    // Notice shown; Review held; Send anyway available and working.
    expect(container.textContent).toContain('Heads up: the network fee for this amount');
    expect(findButton(strings.send.review)!.disabled).toBe(true);
    const anyway = findButton(strings.send.sendAnyway);
    expect(anyway).not.toBeNull();
    await act(async () => anyway!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.sendMax).toBe(true);
    expect(pending?.allowHighFee).toBe(true);
  });

  it('the notice remains available on the cheapest tier (still recoverable)', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    // Even at the slowest tier (5 sat/vB → 705-sat fee), a 2,000-sat (~$1.20)
    // send is over the 25% line. "Send anyway" must still work — the user is
    // already on the cheapest speed and has nowhere else to go.
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '1.20'); // 2,000 sats

    // Switch to Economy (the cheapest tier) via its fee chip.
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.fee'));
    const economyChip = chips.find((c) => c.textContent?.includes(strings.send.feeEconomy));
    expect(economyChip).not.toBeUndefined();
    await act(async () => economyChip!.click());

    expect(container.textContent).toContain('Heads up: the network fee for this amount');
    const anyway = findButton(strings.send.sendAnyway);
    expect(anyway).not.toBeNull();
    await act(async () => anyway!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.allowHighFee).toBe(true);
    expect(pending?.feeTier).toBe('economy');
  });
});
