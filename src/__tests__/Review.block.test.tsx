/**
 * Review.block.test.tsx — regression test for F4: if the Review dry-run build
 * fails, the screen must BLOCK sending with a "recheck this payment" state and
 * must NOT render a fabricated $0 fee / total-equals-amount on the last-chance
 * money screen.
 *
 * The old code returned `{ feeSats: 0n, totalSats: amount }` on a failed build
 * and left the Send button enabled (gated only on the checkbox). This test
 * drives the real Review component with a blocked `numbers` result and asserts
 * there is no enabled Send button and no fabricated fee row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Review } from '../screens/Review';
import { strings } from '../strings';
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
};

function findButton(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

describe('Review — dry-run failure blocks sending (F4)', () => {
  it('renders a recheck state, no Send button, and no fabricated numbers', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Review
          network="mainnet"
          pending={PENDING}
          numbers={{ ok: false }}
          btcUsd={60_000}
          onConfirm={async () => {
            throw new Error('should never be called in a blocked state');
          }}
          onBack={() => {}}
        />,
      );
    });

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
    await act(async () => {
      root = createRoot(container);
      root.render(
        <Review
          network="testnet" // practice mode: no checkbox gate, Send enabled directly
          pending={PENDING}
          numbers={{ ok: true, amountSats: 20_000n, feeSats: 1_410n, totalSats: 21_410n }}
          btcUsd={60_000}
          onConfirm={async () => {}}
          onBack={() => {}}
        />,
      );
    });

    const send = findButton(strings.review.sendNow);
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(false);
    expect(container.textContent).toContain(strings.review.totalLabel);
  });
});
