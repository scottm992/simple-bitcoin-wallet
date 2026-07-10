/**
 * Send.customfee.test.tsx — the Custom fee-rate input (owner request
 * 2026-07-10; money-path change, Round-14 territory).
 *
 * What these tests pin:
 *  - STRICT validation (classifyCustomFeeRate): one plain decimal form, window
 *    [MIN_CUSTOM_FEE_RATE = 0.1, MAX_ACCEPTED_FEE_RATE = 500], reject-never-
 *    clamp, scientific notation refused by design;
 *  - F11 single path: the validated rate lands in PendingSend.feeRateSatVb
 *    EXACTLY as typed (decimals and 0.1 included) — the same field a tier rate
 *    uses, consumed by the same downstream dry-run and build;
 *  - F10 unchanged: a custom rate tripping the 25% rule gets the SAME consent
 *    flow as a tier rate — and the sub-1 slow-lane hint is NOT a consent gate;
 *  - display honesty: the Custom chip shows exactly the validated rate, no fee
 *    preview is ever rendered at a rate the user didn't successfully enter,
 *    and a stale custom entry never leaks into a tier send.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MIN_CUSTOM_FEE_RATE, Send, classifyCustomFeeRate } from '../screens/Send';
import { strings } from '../strings';
import { MAX_ACCEPTED_FEE_RATE } from '../lib';
import type { AccountSnapshot } from '../lib/account';
import type { PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
/** Honest, in-window fee estimates; 'standard' maps to medium = 30 sat/vB. */
const FEES = { fast: 120, medium: 30, slow: 5 };
const BTC_USD = 60_000;

let container: HTMLDivElement;
// Undefined in the pure classifyCustomFeeRate tests, which mount nothing.
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  const r = root;
  if (r !== undefined) act(() => r.unmount());
  root = undefined;
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

/** Finds the fee chip whose title text is `title` (e.g. Custom / Standard). */
function chipByTitle(title: string): HTMLButtonElement {
  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.fee'));
  const chip = chips.find((c) => c.querySelector('.fee__title')?.textContent === title);
  expect(chip).not.toBeUndefined();
  return chip!;
}

/** Selects the Custom chip and (optionally) types a rate into its input. */
async function pickCustom(rateText?: string): Promise<void> {
  await act(async () => chipByTitle(strings.send.feeCustom).click());
  if (rateText !== undefined) {
    const input = container.querySelector<HTMLInputElement>('#send-custom-fee');
    expect(input).not.toBeNull();
    await act(async () => setNativeValue(input!, rateText));
  }
}

// ---------------------------------------------------------------------------
// The validation function itself (pure).
// ---------------------------------------------------------------------------

describe('classifyCustomFeeRate — strict money-path parsing', () => {
  it('accepts plain decimals in [MIN_CUSTOM_FEE_RATE, MAX_ACCEPTED_FEE_RATE], exactly', () => {
    expect(classifyCustomFeeRate('1')).toEqual({ kind: 'valid', rate: 1 });
    expect(classifyCustomFeeRate('500')).toEqual({ kind: 'valid', rate: 500 });
    expect(classifyCustomFeeRate('2.5')).toEqual({ kind: 'valid', rate: 2.5 });
    expect(classifyCustomFeeRate('0.1')).toEqual({ kind: 'valid', rate: 0.1 });
    expect(classifyCustomFeeRate('.5')).toEqual({ kind: 'valid', rate: 0.5 });
    expect(classifyCustomFeeRate('1.')).toEqual({ kind: 'valid', rate: 1 });
    expect(classifyCustomFeeRate(' 5 ')).toEqual({ kind: 'valid', rate: 5 }); // trimmed
    // The window bounds come from the real constants, not re-typed literals.
    expect(classifyCustomFeeRate(String(MIN_CUSTOM_FEE_RATE))).toEqual({
      kind: 'valid',
      rate: MIN_CUSTOM_FEE_RATE,
    });
    expect(classifyCustomFeeRate(String(MAX_ACCEPTED_FEE_RATE))).toEqual({
      kind: 'valid',
      rate: MAX_ACCEPTED_FEE_RATE,
    });
  });

  it('rejects out-of-window values (reject, never clamp) — including the sub-floor band', () => {
    for (const text of ['0.09', '0.05', '0', '0.0999', '500.01', '501', '9999']) {
      expect(classifyCustomFeeRate(text), text).toEqual({ kind: 'out-of-range' });
    }
    // An absurd digit run overflows Number to Infinity → out-of-range, never NaN.
    expect(classifyCustomFeeRate('9'.repeat(400))).toEqual({ kind: 'out-of-range' });
  });

  it('rejects every non-plain-decimal form as malformed — no coercion, ever', () => {
    // Signs, commas, multi-dot, letters, hex, whitespace inside, lone dot.
    for (const text of ['-1', '+5', '1.2.3', '1,5', 'abc', '0x5', '5 0', '.', 'NaN', 'Infinity']) {
      expect(classifyCustomFeeRate(text), text).toEqual({ kind: 'malformed' });
    }
    // Scientific notation is rejected BY DESIGN even though Number('1e3')
    // parses: a money number must read exactly as typed — 'e' notation lets
    // one stray keystroke multiply the fee a thousandfold.
    expect(classifyCustomFeeRate('1e3')).toEqual({ kind: 'malformed' });
    expect(classifyCustomFeeRate('1E2')).toEqual({ kind: 'malformed' });
  });

  it('classifies empty (and whitespace-only) input as empty, not an error', () => {
    expect(classifyCustomFeeRate('')).toEqual({ kind: 'empty' });
    expect(classifyCustomFeeRate('   ')).toEqual({ kind: 'empty' });
  });
});

// ---------------------------------------------------------------------------
// The compose flow.
// ---------------------------------------------------------------------------

describe('Send — custom fee rate (F11 single path)', () => {
  it('a typed custom rate flows to PendingSend.feeRateSatVb exactly, decimals included', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20'); // 33,333 sats

    await pickCustom('2.5');
    // Display honesty: the chip shows exactly the validated rate.
    expect(chipByTitle(strings.send.feeCustom).textContent).toContain('2.5 sat/vB');

    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    expect(onReview).toHaveBeenCalledTimes(1);
    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.feeRateSatVb).toBe(2.5); // exactly — never rounded/clamped
    expect(pending?.feeTier).toBe('custom');
    expect(pending?.allowHighFee).toBe(false);
  });

  it('0.1 is accepted: flows exactly, shows the slow-lane hint, and is NOT consent-gated', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20');

    await pickCustom('0.1');
    // The chip shows the fractional sub-1 rate exactly.
    expect(chipByTitle(strings.send.feeCustom).textContent).toContain('0.1 sat/vB');
    // The sub-1 hint is visible…
    expect(container.textContent).toContain(strings.send.customFeeSlowHint);
    // …but it is informational only: no consent notice, Review stays enabled.
    expect(container.textContent).not.toContain('Heads up: the network fee');
    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    const pending = onReview.mock.calls[0]?.[0];
    expect(pending?.feeRateSatVb).toBe(0.1);
    expect(pending?.feeTier).toBe('custom');
  });

  it('accepts the lower boundary: exactly 1 sat/vB, with no sub-1 hint', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20');
    await pickCustom('1');
    expect(container.textContent).not.toContain(strings.send.customFeeSlowHint); // 1 is not sub-1
    await act(async () => findButton(strings.send.review)!.click());
    expect(onReview.mock.calls[0]?.[0]?.feeRateSatVb).toBe(1);
  });

  it('accepts the upper boundary: exactly 500 sat/vB (the F1 ceiling)', async () => {
    // 500 sat/vB needs a payment large enough that the ~70k-sat fee stays
    // under the 25% consent line — $600 (1M sats) from a 1-BTC wallet.
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '600');
    await pickCustom('500');
    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());
    expect(onReview.mock.calls[0]?.[0]?.feeRateSatVb).toBe(500);
  });

  it('rejected input disables Review and shows the right plain-English message', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20');
    await pickCustom();

    const outOfRangeMsg = strings.send.customFeeOutOfRange(
      String(MIN_CUSTOM_FEE_RATE),
      String(MAX_ACCEPTED_FEE_RATE),
    );
    const cases: { text: string; message: string }[] = [
      { text: '0.09', message: outOfRangeMsg },
      { text: '0', message: outOfRangeMsg },
      { text: '500.01', message: outOfRangeMsg },
      { text: '1.2.3', message: strings.send.customFeeMalformed },
      { text: '1,5', message: strings.send.customFeeMalformed },
      { text: 'abc', message: strings.send.customFeeMalformed },
      { text: '1e3', message: strings.send.customFeeMalformed }, // no scientific notation
      { text: '-1', message: strings.send.customFeeMalformed },
    ];
    const input = container.querySelector<HTMLInputElement>('#send-custom-fee')!;
    for (const c of cases) {
      await act(async () => setNativeValue(input, c.text));
      expect(container.textContent, c.text).toContain(c.message);
      expect(findButton(strings.send.review)!.disabled, c.text).toBe(true);
      // Nothing was accepted: the chip carries no rate line.
      expect(chipByTitle(strings.send.feeCustom).querySelector('.fee__rate'), c.text).toBeNull();
    }

    // Empty input: the gentle explainer (with the real bounds), still no Review.
    await act(async () => setNativeValue(input, ''));
    expect(container.textContent).toContain(
      strings.send.customFeeExplainer(String(MIN_CUSTOM_FEE_RATE), String(MAX_ACCEPTED_FEE_RATE)),
    );
    expect(findButton(strings.send.review)!.disabled).toBe(true);
    expect(onReview).not.toHaveBeenCalled();
  });

  it('a custom rate tripping the 25% rule gets the SAME consent flow as a tier (F10)', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    // $5 = 8,333 sats; at a custom 30 sat/vB the ~4,230-sat fee is > 25%.
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
    expect(pending?.feeTier).toBe('custom');
  });

  it('no fee/total preview is ever shown at a rate the user did not enter', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20');

    // With a tier selected the total line is up…
    expect(container.textContent).toContain("You'll send");
    // …but on Custom with nothing valid typed, every rate-derived number goes
    // dark instead of silently previewing at some rate nobody chose.
    await pickCustom();
    expect(container.textContent).not.toContain("You'll send");
    await pickCustom('abc');
    expect(container.textContent).not.toContain("You'll send");
    // The tier chips keep their own honest rate lines throughout.
    expect(chipByTitle(strings.send.feeStandard).textContent).toContain('30 sat/vB');
    // A valid entry brings the preview back.
    await pickCustom('2.5');
    expect(container.textContent).toContain("You'll send");
  });

  it('a stale custom entry never leaks into a tier send (switch-back restores tier behavior)', async () => {
    const onReview = vi.fn<(pending: PendingSend) => void>();
    await mountSend(makeAccount([100_000n]), onReview);
    await fillAddressAndAmount(RECIPIENT, '20');

    // Type a big custom rate, then change your mind and pick Standard again.
    await pickCustom('250');
    await act(async () => chipByTitle(strings.send.feeStandard).click());

    const review = findButton(strings.send.review);
    expect(review!.disabled).toBe(false);
    await act(async () => review!.click());

    const pending = onReview.mock.calls[0]?.[0];
    // The tier's rate and label — nothing of the abandoned custom entry.
    expect(pending?.feeRateSatVb).toBe(30);
    expect(pending?.feeTier).toBe('standard');
  });
});
