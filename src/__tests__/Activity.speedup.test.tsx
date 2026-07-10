/**
 * Activity.speedup.test.tsx — focused wiring tests for the "Speed up this
 * payment" entry point in the Activity detail sheet.
 *
 * We keep this light on purpose (no brittle full-sheet simulation): the entry
 * point only appears for pending, outgoing payments; a resolved prepare renders
 * the offer over the engine's real estimate and confirming reaches the bump
 * callback then a success state; a rejected prepare renders the honest dead-end.
 * The fee math and signing beneath these are covered by the engine/actions tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Activity } from '../screens/Activity';
import { strings } from '../strings';
import { CannotBumpError, type FeeEstimates } from '../lib';
import type { AccountSnapshot, ActivityItem } from '../lib/account';
import type { PreparedBump } from '../actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FEES: FeeEstimates = { fast: 20, medium: 10, slow: 5 };
const BTC_USD = 60_000;
const TXID = 'b'.repeat(64);

/** A pending, outgoing payment (net -61,000 sats = 60,000 recipient + 1,000 fee). */
const PENDING_OUT: ActivityItem = { txid: TXID, confirmed: false, netSats: -61_000n };

/** What prepareBump would return for PENDING_OUT: a normal 1-in/2-out send. */
const PREPARED: PreparedBump = {
  txid: TXID,
  utxos: [{ txid: 'c'.repeat(64), vout: 0, value: 100_000n, path: "m/84'/0'/0'/0/0", address: 'bc1qowned' }],
  recipient: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
  recipientAmountSats: 60_000n,
  changeAddress: 'bc1qchange',
  oldFeeSats: 1_000n,
  oldVsize: 141,
  oldRateSatVb: 1_000 / 141,
};

const ACCOUNT: AccountSnapshot = {
  confirmedSats: 39_000n,
  pendingSats: 0n,
  utxos: [],
  receiveAddress: 'bc1qreceive',
  receiveIndex: 0,
  changeAddress: 'bc1qchange',
  activity: [PENDING_OUT],
  usedAddresses: [],
  receiveHighWater: -1,
  changeHighWater: -1,
};

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

function findButtonStartsWith(prefix: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim().startsWith(prefix)) return b as HTMLButtonElement;
  }
  return null;
}

interface Opts {
  items?: readonly ActivityItem[];
  account?: AccountSnapshot | null;
  fees?: FeeEstimates | null;
  onPrepareBump?: (txid: string, signal?: AbortSignal) => Promise<PreparedBump>;
  onBumpConfirm?: (prepared: PreparedBump, feeRateSatVb: number, allowHighFee: boolean) => Promise<void>;
}

async function mountActivity(opts: Opts = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Activity
        network="mainnet"
        items={opts.items ?? [PENDING_OUT]}
        status="ready"
        btcUsd={BTC_USD}
        account={opts.account === undefined ? ACCOUNT : opts.account}
        fees={opts.fees === undefined ? FEES : opts.fees}
        onPrepareBump={opts.onPrepareBump ?? (async () => PREPARED)}
        onBumpConfirm={opts.onBumpConfirm ?? (async () => {})}
        onBack={() => {}}
        onRefresh={() => {}}
      />,
    );
  });
}

/** Opens the first activity row's detail sheet. */
async function openSheet(): Promise<void> {
  const row = container.querySelector<HTMLButtonElement>('.row');
  expect(row).not.toBeNull();
  await act(async () => row!.click());
}

describe('Activity — Speed-up entry point visibility', () => {
  it('shows the CTA in the detail sheet of a pending outgoing payment', async () => {
    await mountActivity();
    await openSheet();
    expect(findButton(strings.speedUp.cta)).not.toBeNull();
  });

  it('does NOT show the CTA for a received (incoming) payment', async () => {
    const incoming: ActivityItem = { txid: TXID, confirmed: false, netSats: 25_000n };
    await mountActivity({ items: [incoming], account: { ...ACCOUNT, activity: [incoming] } });
    await openSheet();
    expect(findButton(strings.speedUp.cta)).toBeNull();
  });

  it('does NOT show the CTA once the payment has confirmed', async () => {
    const confirmed: ActivityItem = { txid: TXID, confirmed: true, netSats: -61_000n, blockTime: 1_700_000_000 };
    await mountActivity({ items: [confirmed], account: { ...ACCOUNT, activity: [confirmed] } });
    await openSheet();
    expect(findButton(strings.speedUp.cta)).toBeNull();
  });
});

describe('Activity — Speed-up offer → success', () => {
  it('renders the offer over the real estimate, confirms, and shows success', async () => {
    const onPrepareBump = vi.fn(async () => PREPARED);
    const onBumpConfirm = vi.fn(async () => {});
    await mountActivity({ onPrepareBump, onBumpConfirm });
    await openSheet();

    // Tap the CTA; one prepare fetch resolves and the sheet becomes an offer.
    await act(async () => findButton(strings.speedUp.cta)!.click());
    await flush();

    expect(onPrepareBump).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(strings.speedUp.feePaidLabel);
    expect(container.textContent).toContain(strings.speedUp.newFeeLabel);
    expect(container.textContent).toContain(strings.speedUp.extraCostLabel);

    // No consent gates for an ordinary bump: the primary button is enabled.
    const confirm = findButtonStartsWith('Speed up —');
    expect(confirm).not.toBeNull();
    expect(confirm!.disabled).toBe(false);

    // Confirm: the bump callback gets the prepared data, the Faster-tier rate
    // (20), and allowHighFee false; then the sheet shows the success state.
    await act(async () => confirm!.click());
    await flush();

    expect(onBumpConfirm).toHaveBeenCalledTimes(1);
    expect(onBumpConfirm).toHaveBeenCalledWith(PREPARED, 20, false);
    expect(container.textContent).toContain(strings.speedUp.successHeading);
    expect(container.textContent).toContain(strings.speedUp.successBody);
  });
});

describe('Activity — Speed-up dead-end', () => {
  it('shows honest "sent before speed-up existed" copy and only a Close', async () => {
    const onPrepareBump = vi.fn(async () => {
      throw new CannotBumpError('not-signaling', 'no input signals BIP125');
    });
    const onBumpConfirm = vi.fn(async () => {});
    await mountActivity({ onPrepareBump, onBumpConfirm });
    await openSheet();

    await act(async () => findButton(strings.speedUp.cta)!.click());
    await flush();

    expect(container.textContent).toContain(strings.speedUp.deadNotSignaling);
    expect(findButton(strings.speedUp.close)).not.toBeNull();
    // No way to trigger a bump from a dead-end.
    expect(findButtonStartsWith('Speed up —')).toBeNull();
    expect(onBumpConfirm).not.toHaveBeenCalled();
  });
});
