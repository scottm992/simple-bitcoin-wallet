/**
 * Send.feerate.test.tsx — the "Show fee rates in sat/vB" display feature
 * (owner request, 2026-07-10).
 *
 * Each fee tier chip now surfaces the underlying sat/vB rate alongside its
 * existing speed/cost lines. This is DISPLAY-ONLY: no fee computation, clamping,
 * selection, or transmission changes. The one property these tests pin is
 * HONESTY — the rate shown on a chip must equal exactly what
 * `feeRateForTier` returns for that tier (the same clamped value the engine
 * signs), INCLUDING the F1-clamped cases where a hostile/spiking estimate is
 * pulled back into `[MIN_ACCEPTED_FEE_RATE, MAX_ACCEPTED_FEE_RATE]`. A chip must
 * never advertise the raw API value while the engine uses the clamped one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Send } from '../screens/Send';
import { strings } from '../strings';
import { feeRateForTier } from '../actions';
import type { FeeEstimates } from '../lib';
import type { AccountSnapshot } from '../lib/account';
import type { FeeTier, PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Honest, in-window estimates: standard→30, faster→120, economy→5 sat/vB. */
const FEES_IN_WINDOW = { fast: 120, medium: 30, slow: 5 };
/**
 * Out-of-window estimates that MUST be clamped by feeRateForTier before display:
 * fast 9999 → 500 (MAX), slow 0 → 1 (MIN); medium 42 stays. The chips must show
 * the clamped values (500 / 42 / 1), never the raw API values.
 */
const FEES_OUT_OF_WINDOW = { fast: 9999, medium: 42, slow: 0 };
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

async function mountSend(fees: FeeEstimates | null): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Send
        network="mainnet"
        account={makeAccount([100_000n])}
        btcUsd={BTC_USD}
        fees={fees}
        onReview={(_pending: PendingSend) => {}}
        onBack={() => {}}
      />,
    );
  });
}

/** The title string shown on the chip for a given tier. */
const TITLE: Record<FeeTier, string> = {
  standard: strings.send.feeStandard,
  faster: strings.send.feeFaster,
  economy: strings.send.feeEconomy,
};

/** Reads the `.fee__rate` text off the chip whose title matches `tier`. */
function rateTextForTier(tier: FeeTier): string | null {
  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.fee'));
  const chip = chips.find((c) => c.querySelector('.fee__title')?.textContent === TITLE[tier]);
  return chip?.querySelector('.fee__rate')?.textContent ?? null;
}

describe('Send — fee-rate display (sat/vB)', () => {
  it('each tier chip shows the sat/vB rate feeRateForTier returns', async () => {
    await mountSend(FEES_IN_WINDOW);

    for (const tier of ['standard', 'faster', 'economy'] as const) {
      const expected = feeRateForTier(FEES_IN_WINDOW, tier); // 30 / 120 / 5
      expect(rateTextForTier(tier)).toBe(strings.send.feeRate(expected));
    }
    // And concretely, so a regression in the mapping is obvious:
    expect(rateTextForTier('standard')).toBe('30 sat/vB');
    expect(rateTextForTier('faster')).toBe('120 sat/vB');
    expect(rateTextForTier('economy')).toBe('5 sat/vB');
  });

  it('displays the CLAMPED rate the engine uses, never the raw out-of-range API value (honesty)', async () => {
    await mountSend(FEES_OUT_OF_WINDOW);

    // The displayed rate must equal feeRateForTier's clamped output for every tier.
    for (const tier of ['standard', 'faster', 'economy'] as const) {
      const clamped = feeRateForTier(FEES_OUT_OF_WINDOW, tier);
      expect(rateTextForTier(tier)).toBe(strings.send.feeRate(clamped));
    }
    // Concretely: 9999 clamps to the 500 MAX, 0 clamps to the 1 MIN, 42 stays.
    expect(rateTextForTier('faster')).toBe('500 sat/vB');
    expect(rateTextForTier('economy')).toBe('1 sat/vB');
    expect(rateTextForTier('standard')).toBe('42 sat/vB');

    // The raw, pre-clamp values must NEVER appear anywhere on screen (the 9999
    // API spike must not leak; economy shows the clamped "1 sat/vB", not "0").
    expect(container.textContent).not.toContain('9999');
    expect(rateTextForTier('economy')).not.toBe('0 sat/vB');
  });

  it('when estimates are absent (fees null) no rate is shown and nothing crashes', async () => {
    await mountSend(null);

    // The compose screen still renders (three tier chips + the Custom chip)...
    expect(container.querySelectorAll('.fee').length).toBe(4);
    // ...but with no rate line on any chip, and no stray "sat/vB" text (the
    // Custom chip shows no rate either — nothing valid has been typed).
    expect(container.querySelector('.fee__rate')).toBeNull();
    expect(container.textContent).not.toContain('sat/vB');
  });
});
