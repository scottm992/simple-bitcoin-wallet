/**
 * Review.block.test.tsx — regression tests for F4/F10/F11 on the Review screen:
 *
 * - F4: a failed dry-run BLOCKS sending — no fabricated $0 fee / total, no Send.
 * - F10: the blocked-state copy names the real cause ('stale' vs 'fee-too-high').
 * - F11: a consent-gated fee block is never a dead end — it shows the real
 *   numbers and a working "Send anyway" that re-composes with allowHighFee, and
 *   the full review gate (real numbers → Send now → onConfirm) still applies.
 *   A hard-limit block (consent already given, or fee beyond the hard ceiling)
 *   offers no such loop-bait and says so honestly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Review, type ReviewNumbers } from '../screens/Review';
import { strings } from '../strings';
import { MAX_FEE_ABSOLUTE_SATS } from '../lib';
import type { PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const PENDING: PendingSend = {
  recipient: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
  amountSats: 20_000n,
  feeRateSatVb: 10,
  feeTier: 'standard',
  sendMax: false,
  allowHighFee: false,
};

function findButton(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

interface RenderOpts {
  network?: 'mainnet' | 'testnet';
  pending?: PendingSend;
  onConfirm?: () => Promise<void>;
  onAcceptHighFee?: () => void;
}

async function renderReview(numbers: ReviewNumbers, opts: RenderOpts = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Review
        network={opts.network ?? 'mainnet'}
        pending={opts.pending ?? PENDING}
        numbers={numbers}
        btcUsd={60_000}
        onConfirm={opts.onConfirm ?? (async () => {})}
        onBack={() => {}}
        onAcceptHighFee={opts.onAcceptHighFee ?? (() => {})}
      />,
    );
  });
}

describe('Review — dry-run failure blocks sending (F4)', () => {
  it('renders a recheck state, no Send button, and no fabricated numbers', async () => {
    await renderReview(
      { ok: false, reason: 'stale' },
      {
        onConfirm: async () => {
          throw new Error('should never be called in a blocked state');
        },
      },
    );

    // The blocking recheck copy is shown.
    expect(container.textContent).toContain(strings.review.recheckHeading);

    // There is NO "Send now" button at all in the blocked state.
    expect(findButton(strings.review.sendNow)).toBeNull();

    // And crucially, no fabricated fee/total row is rendered (no "Total leaving
    // your wallet" line that the old code would have shown with $0 fee).
    expect(container.textContent).not.toContain(strings.review.totalLabel);
    expect(container.textContent).not.toContain(strings.review.feeLabel);
  });

  it('by contrast, a successful build DOES render Send + a fee/total row', async () => {
    await renderReview(
      { ok: true, amountSats: 20_000n, feeSats: 1_410n, totalSats: 21_410n },
      { network: 'testnet' }, // practice mode: no checkbox gate, Send enabled directly
    );

    const send = findButton(strings.review.sendNow);
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(false);
    expect(container.textContent).toContain(strings.review.totalLabel);
  });
});

describe('Review — blocked-state copy names the real cause (F10)', () => {
  it("a stale/UTXO failure shows the 'balance may have changed' copy, not the fee copy", async () => {
    await renderReview({ ok: false, reason: 'stale' });
    expect(container.textContent).toContain(strings.review.recheckBody);
    expect(container.textContent).not.toContain('unusually big bite');
    // No Send-anyway either — consent has nothing to do with a stale failure.
    expect(findButton(strings.send.sendAnyway)).toBeNull();
  });

  it('a fee-guard trip shows the honest fee explanation with real numbers, never blaming the balance', async () => {
    // Reviewer's F11 scenario: 17,500-sat UTXO, 13,000-sat send, fee folded to
    // 4,500 (comparedTo = amount + fee = 17,500).
    await renderReview({
      ok: false,
      reason: 'fee-too-high',
      feeSats: 4_500n,
      comparedToSats: 17_500n,
    });
    // Real numbers: fee $2.70 at $60k, and 4,500/13,000 ≈ 34%.
    expect(container.textContent).toContain(strings.review.recheckFeeBody('$2.70', '34'));
    // The misleading "balance may have changed" line must NOT appear here.
    expect(container.textContent).not.toContain(strings.review.recheckBody);
    // Still fully blocked: no Send-now button, no fabricated totals.
    expect(findButton(strings.review.sendNow)).toBeNull();
    expect(container.textContent).not.toContain(strings.review.totalLabel);
  });
});

describe('Review — fee-blocked state offers a working recovery (F11)', () => {
  it('exposes a Send-anyway that requests informed consent from the parent', async () => {
    const onAcceptHighFee = vi.fn();
    await renderReview(
      { ok: false, reason: 'fee-too-high', feeSats: 4_500n, comparedToSats: 17_500n },
      { onAcceptHighFee },
    );

    const anyway = findButton(strings.send.sendAnyway);
    expect(anyway).not.toBeNull();
    await act(async () => anyway!.click());
    expect(onAcceptHighFee).toHaveBeenCalledTimes(1);
  });

  it('after consent the re-rendered Review reaches onConfirm (the broadcast path)', async () => {
    // Simulates what App does on onAcceptHighFee: re-compose with
    // allowHighFee:true → dry-run succeeds → Review re-renders with the REAL
    // numbers → the normal review gate leads to onConfirm (which broadcasts;
    // the allowHighFee→broadcast engine path is covered in actions.highfee).
    const onConfirm = vi.fn(async () => {});
    const consented: PendingSend = { ...PENDING, amountSats: 13_000n, allowHighFee: true };
    await renderReview(
      { ok: true, amountSats: 13_000n, feeSats: 4_500n, totalSats: 17_500n },
      { network: 'testnet', pending: consented, onConfirm },
    );

    // The real (high) fee is shown prominently as usual — no hidden numbers.
    expect(container.textContent).toContain(strings.review.feeLabel);
    expect(container.textContent).toContain(strings.review.totalLabel);

    const send = findButton(strings.review.sendNow);
    expect(send).not.toBeNull();
    await act(async () => send!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a hard-limit block (consent already given) offers NO Send-anyway and honest copy', async () => {
    // Consent was already given yet the build still throws → a HARD limit
    // fired. Showing Send-anyway again would loop forever; say so instead.
    const consented: PendingSend = { ...PENDING, allowHighFee: true };
    await renderReview(
      {
        ok: false,
        reason: 'fee-too-high',
        feeSats: MAX_FEE_ABSOLUTE_SATS + 1n,
        comparedToSats: 300_000_000n,
      },
      { pending: consented },
    );
    expect(container.textContent).toContain(strings.review.recheckFeeHardBody);
    expect(findButton(strings.send.sendAnyway)).toBeNull();
  });

  it('a rate-guard block (feeSats unknown/0) also offers NO Send-anyway', async () => {
    await renderReview({
      ok: false,
      reason: 'fee-too-high',
      feeSats: 0n,
      comparedToSats: 0n,
    });
    expect(container.textContent).toContain(strings.review.recheckFeeHardBody);
    expect(findButton(strings.send.sendAnyway)).toBeNull();
  });
});
