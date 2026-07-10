/**
 * Receive.nudge.test.tsx — the fresh-address nudge (roadmap, owner request).
 *
 * The rotation itself was ALREADY automatic before this feature: Receive
 * renders the snapshot's next-unused address as a prop, so when the poll
 * detects a payment and the refreshed snapshot advances the index, a mounted
 * Receive updates in place (proven end-to-end by Receive.fallback.test.tsx,
 * which this feature must leave green byte-identical). What these tests pin is
 * the NEW piece — the one-time notice explaining a live rotation — and its
 * guards:
 *  - the notice appears when the address changes in place (same network, real
 *    address before and after), alongside the new address + QR;
 *  - it does NOT appear on ordinary mounts, on unchanged re-renders, on the
 *    empty→address fill-in (loading progress, not rotation), or across a
 *    network switch (a different chain's address, not a used one).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import encodeQR from 'qr';
import { Receive } from '../screens/Receive';
import { strings } from '../strings';
import { bitcoinUri } from '../display';
import type { Network } from '../lib';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Two real-shaped mainnet addresses (values only matter for display equality).
const ADDR_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ADDR_1 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
// A testnet address for the network-switch guard.
const TB_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

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

/** Mounts Receive; returns a rerender helper that swaps network/address. */
async function mountReceive(network: Network, address: string): Promise<
  (network: Network, address: string) => Promise<void>
> {
  const render = (n: Network, a: string): void => {
    root.render(<Receive network={n} address={a} onBack={() => {}} />);
  };
  await act(async () => {
    root = createRoot(container);
    render(network, address);
  });
  return async (n, a) => {
    await act(async () => render(n, a));
  };
}

/** The address the screen currently shows (from the address row's aria label). */
function shownAddress(): string {
  const label = container.querySelector('.addr')?.getAttribute('aria-label') ?? '';
  const m = /^Address (\S+)\. Tap to copy\.$/.exec(label);
  return m?.[1] ?? '';
}

/** Normalizes an SVG string through the same DOM parser React's innerHTML uses. */
function normalizeSvg(svg: string): string {
  const d = document.createElement('div');
  d.innerHTML = svg;
  return d.innerHTML;
}

describe('Receive — fresh-address nudge', () => {
  it('a live rotation shows the one-time notice with the new address and QR', async () => {
    const rerender = await mountReceive('mainnet', ADDR_0);
    expect(container.textContent).not.toContain(strings.receive.rotatedNotice);

    // The snapshot advances under the user (poll → refresh → new snapshot):
    // the same prop update App's normal flow delivers to a mounted Receive.
    await rerender('mainnet', ADDR_1);

    expect(container.textContent).toContain(strings.receive.rotatedNotice);
    // The rotation itself: new address on the row, new payload in the QR.
    expect(shownAddress()).toBe(ADDR_1);
    expect(container.querySelector('.qr')?.innerHTML).toBe(
      normalizeSvg(encodeQR(bitcoinUri(ADDR_1), 'svg', { ecc: 'medium', border: 1 })),
    );
    // The notice is a polite status region, not a focus-stealing alert.
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      strings.receive.rotatedNotice,
    );
  });

  it('shows NO notice on an ordinary mount', async () => {
    await mountReceive('mainnet', ADDR_1);
    expect(container.textContent).not.toContain(strings.receive.rotatedNotice);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows NO notice when re-renders leave the address unchanged', async () => {
    const rerender = await mountReceive('mainnet', ADDR_0);
    // Ordinary refreshes re-deliver the same snapshot address all the time.
    await rerender('mainnet', ADDR_0);
    await rerender('mainnet', ADDR_0);
    expect(container.textContent).not.toContain(strings.receive.rotatedNotice);
  });

  it('the empty→address fill-in (offline fallback resolving) is loading, not a rotation', async () => {
    const rerender = await mountReceive('mainnet', '');
    // The unreachable-state copy is up, no notice.
    expect(container.textContent).toContain(strings.receive.unavailable);
    // Discovery lands and the real address fills in: still no notice — nothing
    // the user was showing got used.
    await rerender('mainnet', ADDR_0);
    expect(shownAddress()).toBe(ADDR_0);
    expect(container.textContent).not.toContain(strings.receive.rotatedNotice);
  });

  it('a network switch is a different chain, not a used address — no notice', async () => {
    const rerender = await mountReceive('mainnet', ADDR_0);
    await rerender('testnet', TB_ADDR);
    expect(shownAddress()).toBe(TB_ADDR);
    expect(container.textContent).not.toContain(strings.receive.rotatedNotice);
  });

  it('once shown, the notice persists for the visit and does not stack on further rotations', async () => {
    const rerender = await mountReceive('mainnet', ADDR_0);
    await rerender('mainnet', ADDR_1);
    await rerender('mainnet', ADDR_0); // a second advance while still mounted
    const matches = container.textContent?.split(strings.receive.rotatedNotice).length ?? 0;
    expect(matches - 1).toBe(1); // exactly one copy of the notice on screen
  });
});
