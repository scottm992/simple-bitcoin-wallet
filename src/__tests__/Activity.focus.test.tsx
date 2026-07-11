/**
 * Activity.focus.test.tsx — tapping a payment row on Home must land on that
 * payment's DETAIL sheet, not the bare Activity list (owner report,
 * 2026-07-10: App discarded the tapped txid). Pins the `initialTxid` one-shot:
 * a provided txid opens its sheet on arrival and is consumed exactly once; an
 * unknown/absent txid degrades to the plain list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Activity } from '../screens/Activity';
import { strings } from '../strings';
import type { FeeEstimates } from '../lib';
import type { AccountSnapshot, ActivityItem } from '../lib/account';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FEES: FeeEstimates = { fast: 20, medium: 10, slow: 5 };
const TXID = 'a'.repeat(64);
const ITEM: ActivityItem = {
  txid: TXID,
  confirmed: true,
  blockTime: 1_752_000_000,
  netSats: 50_000n,
};
const OTHER: ActivityItem = {
  txid: 'b'.repeat(64),
  confirmed: true,
  blockTime: 1_751_000_000,
  netSats: -20_000n,
};

const ACCOUNT: AccountSnapshot = {
  confirmedSats: 30_000n,
  pendingSats: 0n,
  utxos: [],
  receiveAddress: 'bc1qreceive',
  receiveIndex: 0,
  changeAddress: 'bc1qchange',
  activity: [ITEM, OTHER],
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

async function renderActivity(
  initialTxid: string | null,
  onShown: () => void = () => {},
): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Activity
        network="mainnet"
        items={ACCOUNT.activity}
        status="ready"
        btcUsd={60_000}
        account={ACCOUNT}
        fees={FEES}
        onPrepareBump={() => Promise.reject(new Error('unused'))}
        onBumpConfirm={() => Promise.resolve()}
        onBack={() => {}}
        onRefresh={() => {}}
        initialTxid={initialTxid}
        onInitialTxidShown={onShown}
      />,
    );
  });
}

describe('Activity — a Home row tap opens THAT payment, not the bare list', () => {
  it('opens the detail sheet for the given txid on arrival', async () => {
    await renderActivity(TXID);
    // The detail sheet is on screen: its Amount block shows the tapped
    // payment's 8-decimal BTC amount (list rows show sats, so this string is
    // unique to the sheet), alongside its explorer link and Done button.
    expect(container.textContent).toContain('0.00050000 BTC');
    expect(container.textContent).toContain(strings.activity.viewExplorer);
    expect(container.textContent).toContain(strings.common.done);
  });

  it('consumes the txid exactly once', async () => {
    const shown = vi.fn();
    await renderActivity(TXID, shown);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('an unknown txid degrades to the plain list, but still consumes', async () => {
    const shown = vi.fn();
    await renderActivity('f'.repeat(64), shown);
    expect(container.textContent).not.toContain(strings.activity.viewExplorer);
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('no txid: the plain list, no consume call', async () => {
    const shown = vi.fn();
    await renderActivity(null, shown);
    expect(container.textContent).not.toContain(strings.activity.viewExplorer);
    expect(shown).not.toHaveBeenCalled();
  });
});
