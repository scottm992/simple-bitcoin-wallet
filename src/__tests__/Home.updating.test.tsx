/**
 * Home.updating.test.tsx — F12: while the balance on screen came only from the
 * fast phase-1 scan (accountComplete=false), Home shows a subtle, non-alarming
 * "checking for updates" cue; it disappears once a full snapshot lands, and it
 * never shows when there is no snapshot at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Home } from '../screens/Home';
import { strings } from '../strings';
import type { AccountSnapshot } from '../lib/account';
import type { ScanProgress } from '../state';

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

const ACCOUNT: AccountSnapshot = {
  confirmedSats: 50_000n,
  pendingSats: 0n,
  utxos: [],
  receiveAddress: 'bc1qreceive',
  receiveIndex: 0,
  changeAddress: 'bc1qchange',
  activity: [],
  usedAddresses: [],
  receiveHighWater: -1,
  changeHighWater: -1,
};

async function renderHome(
  account: AccountSnapshot | null,
  accountComplete: boolean,
  opts: {
    scanProgress?: ScanProgress | null;
    accountStatus?: 'idle' | 'loading' | 'ready' | 'error';
    onRefresh?: () => void;
  } = {},
): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Home
        network="mainnet"
        account={account}
        accountStatus={opts.accountStatus ?? (account ? 'ready' : 'loading')}
        accountComplete={accountComplete}
        scanProgress={opts.scanProgress ?? null}
        btcUsd={60_000}
        unit="usd"
        onCycleUnit={() => {}}
        firstVisit={false}
        onReceive={() => {}}
        onSend={() => {}}
        onSeeAll={() => {}}
        onOpenActivity={() => {}}
        onSettings={() => {}}
        onRefresh={opts.onRefresh ?? (() => {})}
      />,
    );
  });
}

describe('Home — scan-progress cue (F12 visibility unchanged; text + tap added)', () => {
  it('State A: shows "Checking address N of ~M" while a run is actively scanning', async () => {
    await renderHome(ACCOUNT, false, { scanProgress: { checked: 3, estimatedTotal: 40 } });
    expect(container.textContent).toContain(strings.home.checkingAddress(3, 40));
    // Not the State-B wait text while actively scanning.
    expect(container.textContent).not.toContain(strings.home.balanceBehind);
  });

  it('State A: falls back to the calm generic cue when a run has started but no count yet', async () => {
    // status 'loading' = run started, first paint (and first progress tick) not
    // yet in — the cue reads the calm generic text, never the State-B wait text.
    await renderHome(ACCOUNT, false, { accountStatus: 'loading' });
    expect(container.textContent).toContain(strings.home.stillChecking);
    expect(container.textContent).not.toContain(strings.home.balanceBehind);
  });

  it('State B: shows the tappable wait text when incomplete but no run is in flight', async () => {
    // Snapshot incomplete (phase-1 only) and no run scanning (status 'ready', no
    // progress) — the backoff ladder is deliberately waiting.
    await renderHome(ACCOUNT, false, { accountStatus: 'ready' });
    expect(container.textContent).toContain(strings.home.balanceBehind);
    expect(container.textContent).not.toContain(strings.home.stillChecking);
  });

  it('State B: tapping the cue fires the manual refresh exactly once', async () => {
    let refreshes = 0;
    await renderHome(ACCOUNT, false, {
      accountStatus: 'ready',
      onRefresh: () => {
        refreshes++;
      },
    });
    const btn = container.querySelector<HTMLButtonElement>('.pending-line--tappable');
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(refreshes).toBe(1);
  });

  it('clears the cue once a full snapshot lands', async () => {
    await renderHome(ACCOUNT, false, { scanProgress: { checked: 3, estimatedTotal: 40 } });
    expect(container.textContent).toContain(strings.home.checkingAddress(3, 40));
    await act(async () => root.unmount());
    await renderHome(ACCOUNT, true);
    expect(container.textContent).not.toContain(strings.home.checkingAddress(3, 40));
    expect(container.textContent).not.toContain(strings.home.balanceBehind);
  });

  it('never shows the cue without a snapshot (loading skeleton instead)', async () => {
    await renderHome(null, true);
    expect(container.textContent).not.toContain(strings.home.stillChecking);
    expect(container.textContent).not.toContain(strings.home.balanceBehind);
  });
});

/** Renders Home with full control over account + status. */
async function renderHomeStatus(
  account: AccountSnapshot | null,
  accountStatus: 'idle' | 'loading' | 'ready' | 'error',
): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Home
        network="mainnet"
        account={account}
        accountStatus={accountStatus}
        accountComplete={true}
        btcUsd={60_000}
        unit="usd"
        onCycleUnit={() => {}}
        firstVisit={false}
        onReceive={() => {}}
        onSend={() => {}}
        onSeeAll={() => {}}
        onOpenActivity={() => {}}
        onSettings={() => {}}
        onRefresh={() => {}}
      />,
    );
  });
}

const EMPTY_ACCOUNT: AccountSnapshot = {
  ...ACCOUNT,
  confirmedSats: 0n,
  pendingSats: 0n,
};

describe('Home — no empty-nudge/activity swap during a background refresh (§1e)', () => {
  it('keeps the empty-wallet nudge when a background refresh flips status to loading', async () => {
    await renderHomeStatus(EMPTY_ACCOUNT, 'ready');
    expect(container.textContent).toContain(strings.home.emptyBalanceHeading);
    expect(container.textContent).not.toContain(strings.home.recentActivity);

    // The 30s poll refresh flips accountStatus to 'loading' while KEEPING the
    // account snapshot. Pre-§1e this swapped the empty nudge for the activity
    // block (the symptom-4 flicker); now isEmpty is derived from the account, so
    // the layout holds.
    await act(async () => root.unmount());
    await renderHomeStatus(EMPTY_ACCOUNT, 'loading');
    expect(container.textContent).toContain(strings.home.emptyBalanceHeading);
    expect(container.textContent).not.toContain(strings.home.recentActivity);
  });

  it('keeps the activity block for a funded wallet during a background refresh', async () => {
    await renderHomeStatus(ACCOUNT, 'ready');
    expect(container.textContent).toContain(strings.home.recentActivity);
    expect(container.textContent).not.toContain(strings.home.emptyBalanceHeading);

    await act(async () => root.unmount());
    await renderHomeStatus(ACCOUNT, 'loading');
    expect(container.textContent).toContain(strings.home.recentActivity);
    expect(container.textContent).not.toContain(strings.home.emptyBalanceHeading);
  });
});
