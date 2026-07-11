/**
 * ActivityRow.test.tsx — the redesigned activity row (owner design pass,
 * 2026-07-10). Pins the information hierarchy:
 *  - dual amounts: USD primary + sats secondary (rows stay meaningful offline);
 *  - a pending row carries its status AS the sub-line (waiting style) instead
 *    of the time; settled rows show the time and NO status at all — confirmed
 *    is the default state of the world and spends no ink;
 *  - no StatusPill inside list rows (it still belongs to the detail screen).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActivityRow } from '../components/ActivityRow';
import { strings } from '../strings';
import type { ActivityItem } from '../lib/account';

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

async function renderRow(item: ActivityItem, btcUsd: number | null = 107_000): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<ActivityRow item={item} btcUsd={btcUsd} />);
  });
}

const CONFIRMED_IN: ActivityItem = {
  txid: 'c'.repeat(64),
  confirmed: true,
  blockTime: Math.floor(Date.now() / 1000) - 2 * 3600,
  netSats: 100_000n,
};

const PENDING_IN: ActivityItem = { txid: 'a'.repeat(64), confirmed: false, netSats: 25_000n };

describe('ActivityRow — redesigned information hierarchy', () => {
  it('shows dual amounts: USD primary and sats secondary', async () => {
    await renderRow(CONFIRMED_IN);
    expect(container.querySelector('.row__amount')?.textContent).toBe('+$107.00');
    expect(container.querySelector('.row__btc')?.textContent).toBe('100,000 sats');
  });

  it('keeps the sats line when the price is offline (USD degrades to a dash)', async () => {
    await renderRow(CONFIRMED_IN, null);
    expect(container.querySelector('.row__amount')?.textContent).toBe('+$—');
    expect(container.querySelector('.row__btc')?.textContent).toBe('100,000 sats');
  });

  it('a settled row shows the time and NO status anywhere', async () => {
    await renderRow(CONFIRMED_IN);
    expect(container.querySelector('.row__sub')?.textContent).toBe('2 hours ago');
    expect(container.querySelector('.row__sub--wait')).toBeNull();
    expect(container.querySelector('.status-pill')).toBeNull();
    expect(container.textContent).not.toContain(strings.activity.confirmed);
  });

  it('a pending row carries "Waiting to confirm" as its styled sub-line, no pill', async () => {
    await renderRow(PENDING_IN);
    const sub = container.querySelector('.row__sub--wait');
    expect(sub?.textContent).toBe(strings.activity.waiting);
    expect(container.querySelector('.status-pill')).toBeNull();
  });

  it('a sent row shows the minus sign and no positive coloring', async () => {
    await renderRow({ ...CONFIRMED_IN, netSats: -90_000n });
    expect(container.querySelector('.row__amount')?.textContent).toBe('-$96.30');
    expect(container.querySelector('.row__amount--pos')).toBeNull();
    expect(container.querySelector('.row__btc')?.textContent).toBe('90,000 sats');
  });
});
