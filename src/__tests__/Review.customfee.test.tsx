/**
 * Review.customfee.test.tsx — the Review screen with a CUSTOM fee rate, and
 * the broadcast fee-below-relay-floor rejection surfacing.
 *
 * - The fee row for a custom-rate payment shows the rate itself (not a tier's
 *   arrival-time promise), using the SAME feeRateSatVb the build consumes —
 *   displayed = transmitted, on the last screen before money moves.
 * - A node rejecting the broadcast for "min relay fee not met" (reachable with
 *   a sub-1 custom rate on a busy network) gets specific honest copy and NO
 *   retry (identical bytes → identical rejection); everything else keeps the
 *   generic connection-problem sheet with its safe retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Review, isFeeBelowRelayFloorError, type ReviewNumbers } from '../screens/Review';
import { strings } from '../strings';
import { ApiResponseError } from '../lib';
import type { PendingSend } from '../state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
// Undefined in the pure isFeeBelowRelayFloorError tests, which mount nothing.
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

const CUSTOM_PENDING: PendingSend = {
  recipient: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
  amountSats: 20_000n,
  feeRateSatVb: 2.5,
  feeTier: 'custom',
  sendMax: false,
  allowHighFee: false,
};

const OK_NUMBERS: ReviewNumbers = {
  ok: true,
  amountSats: 20_000n,
  feeSats: 353n,
  totalSats: 20_353n,
};

/** The verbatim body shape Esplora relays from Bitcoin Core on a floor reject. */
const MIN_RELAY_BODY =
  'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 14 < 141"}';

function findButtonIn(scope: ParentNode, text: string): HTMLButtonElement | null {
  for (const b of scope.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

async function renderReview(opts: {
  pending?: PendingSend;
  onConfirm?: () => Promise<void>;
  onBack?: () => void;
}): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Review
        // Practice network: no address checkbox, so tests can click Send now
        // directly. The failure-sheet logic under test is network-independent.
        network="testnet"
        pending={opts.pending ?? CUSTOM_PENDING}
        numbers={OK_NUMBERS}
        btcUsd={60_000}
        onConfirm={opts.onConfirm ?? (async () => {})}
        onBack={opts.onBack ?? (() => {})}
        onAcceptHighFee={() => {}}
      />,
    );
  });
}

describe('isFeeBelowRelayFloorError — narrow broadcast-rejection classifier', () => {
  it("recognizes both of Bitcoin Core's floor-rejection message forms", () => {
    expect(isFeeBelowRelayFloorError(new ApiResponseError(400, MIN_RELAY_BODY))).toBe(true);
    expect(
      isFeeBelowRelayFloorError(new ApiResponseError(400, 'mempool min fee not met, 100 < 250')),
    ).toBe(true);
    expect(isFeeBelowRelayFloorError(new ApiResponseError(400, 'MIN RELAY FEE NOT MET'))).toBe(true);
  });

  it('stays narrow: other rejections and non-API errors keep the generic path', () => {
    expect(isFeeBelowRelayFloorError(new ApiResponseError(429, 'Too many requests'))).toBe(false);
    expect(
      isFeeBelowRelayFloorError(
        new ApiResponseError(400, '{"code":-25,"message":"bad-txns-inputs-missingorspent"}'),
      ),
    ).toBe(false);
    // Matching text on a NON-ApiResponseError is not a node rejection.
    expect(isFeeBelowRelayFloorError(new Error('min relay fee not met'))).toBe(false);
    expect(isFeeBelowRelayFloorError(undefined)).toBe(false);
  });
});

describe('Review — custom fee rate display', () => {
  it("shows the custom rate on the fee row instead of a tier's arrival time", async () => {
    await renderReview({});
    // The rate string is built from the SAME feeRateSatVb the build consumes.
    expect(container.textContent).toContain('at your rate of 2.5 sat/vB');
    expect(container.textContent).not.toContain('arrives in');
  });

  it('a tier payment keeps its arrival-time fee row (unchanged behavior)', async () => {
    await renderReview({ pending: { ...CUSTOM_PENDING, feeTier: 'standard', feeRateSatVb: 30 } });
    expect(container.textContent).toContain('arrives in');
    expect(container.textContent).not.toContain('at your rate of');
  });
});

describe('Review — fee-below-relay-floor broadcast rejection', () => {
  it('shows the honest fee-too-low copy with NO retry; primary action goes back to compose', async () => {
    const onBack = vi.fn();
    await renderReview({
      onConfirm: async () => {
        throw new ApiResponseError(400, MIN_RELAY_BODY);
      },
      onBack,
    });

    await act(async () => findButtonIn(container, strings.review.sendNow)!.click());

    const sheet = container.querySelector('.sheet__actions');
    expect(sheet).not.toBeNull();
    expect(container.textContent).toContain(strings.review.failFeeTooLowBody);
    // No retry: re-broadcasting the identical tx gets the identical answer.
    expect(findButtonIn(sheet!, strings.common.tryAgain)).toBeNull();
    // The way forward is a higher fee — the primary action returns to compose.
    const goBack = findButtonIn(sheet!, strings.review.goBack);
    expect(goBack).not.toBeNull();
    await act(async () => goBack!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('any other broadcast failure keeps the generic sheet with its safe retry', async () => {
    let calls = 0;
    await renderReview({
      onConfirm: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });

    await act(async () => findButtonIn(container, strings.review.sendNow)!.click());

    const sheet = container.querySelector('.sheet__actions');
    expect(container.textContent).toContain(strings.review.failBody);
    expect(container.textContent).not.toContain(strings.review.failFeeTooLowBody);
    const retry = findButtonIn(sheet!, strings.common.tryAgain);
    expect(retry).not.toBeNull();
    await act(async () => retry!.click());
    expect(calls).toBe(2); // the retry really re-attempts
  });
});
