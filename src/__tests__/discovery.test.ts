/**
 * discovery.test.ts — regression tests for the Bug A network overhaul:
 *
 *  - two-phase discovery: a fast phase-1 snapshot first (small request budget),
 *    then the full gap-20 snapshot, with phase 2 reusing every phase-1 response
 *    (no address fetched twice in one run);
 *  - overall deadline: a stalled network settles to the error state — the
 *    loading skeleton is never open-ended (fake timers);
 *  - high-water-mark reuse: a later scan anchors at the cached marks, so even
 *    the FAST phase finds funds a previous scan discovered at a high index;
 *  - single-flight: poll ticks are skipped (zero requests) while a run is in
 *    flight, and a new refresh aborts the previous run;
 *  - cheap poll: only the used addresses + the two tips are re-checked
 *    (a fresh wallet costs exactly 2 requests), never a full rescan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockNet = vi.hoisted(() => ({
  mode: 'instant' as 'instant' | 'hang',
  used: new Set<string>(),
  statsCalls: [] as string[],
  abortedRequests: 0,
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async (_network: unknown, address: string, signal?: AbortSignal) => {
      mockNet.statsCalls.push(address);
      if (mockNet.mode === 'hang') {
        // Simulates mempool.space stalling a throttled connection: the request
        // only ever settles when aborted.
        return new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            mockNet.abortedRequests++;
            reject(new actual.ApiNetworkError('aborted'));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort);
        });
      }
      const used = mockNet.used.has(address);
      return {
        confirmedSats: used ? 10_000n : 0n,
        pendingSats: 0n,
        fundedSats: used ? 10_000n : 0n,
        spentSats: 0n,
      };
    }),
    getUtxos: vi.fn(async () => []),
    getAddressTxs: vi.fn(async () => []),
  };
});

import { startDiscovery, pollAccount, DiscoveryController } from '../actions';
import { getAddressStats } from '../lib/api';
import { setUnlocked, lockNow } from '../session';
import {
  createVault,
  deriveReceiveAddress,
  getCachedHighWater,
  setCachedHighWater,
  type AccountSnapshot,
} from '../lib';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FAST_KDF = { N: 2 ** 8, r: 8, p: 1, dkLen: 32 };

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  mockNet.mode = 'instant';
  mockNet.used.clear();
  mockNet.statsCalls = [];
  mockNet.abortedRequests = 0;
  setUnlocked(ABANDON);
});

afterEach(() => {
  lockNow();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A minimal fresh-wallet snapshot for poll tests. */
function freshSnapshot(): AccountSnapshot {
  return {
    confirmedSats: 0n,
    pendingSats: 0n,
    utxos: [],
    receiveAddress: 'tb1-receive-tip',
    receiveIndex: 0,
    changeAddress: 'tb1-change-tip',
    activity: [],
    usedAddresses: [],
    receiveHighWater: -1,
    changeHighWater: -1,
  };
}

describe('startDiscovery — two-phase scan (Bug A2)', () => {
  it('paints fast (phase 1), then merges the full gap-20 result, reusing phase-1 responses', async () => {
    // Funds sit at receive index 7: a plain gap-5 scan misses them, the full
    // gap-20 scan finds them.
    mockNet.used.add(deriveReceiveAddress(ABANDON, 'testnet', 7).address);

    const snapshots: AccountSnapshot[] = [];
    const callCounts: number[] = [];
    const onError = vi.fn();
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: (snap) => {
        snapshots.push(snap);
        callCounts.push(mockNet.statsCalls.length);
      },
      onError,
    });
    await handle.done;

    expect(onError).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);

    // Phase 1: a 5-gap scan on each chain = 10 requests, painted immediately.
    expect(callCounts[0]).toBe(10);
    expect(snapshots[0]?.confirmedSats).toBe(0n); // idx 7 not yet visible

    // Phase 2: the full scan finds the funds and records the high-water mark.
    expect(snapshots[1]?.confirmedSats).toBe(10_000n);
    expect(snapshots[1]?.receiveHighWater).toBe(7);

    // The run-scoped cache means NO address is ever fetched twice in one run.
    expect(new Set(mockNet.statsCalls).size).toBe(mockNet.statsCalls.length);
  });

  it('fresh wallet: 10 requests to first paint, 40 total for the full run', async () => {
    const callCounts: number[] = [];
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: () => callCounts.push(mockNet.statsCalls.length),
      onError: vi.fn(),
    });
    await handle.done;
    expect(callCounts).toEqual([10, 40]); // phase 1 = 5/chain; phase 2 extends to 20/chain
  });
});

describe('startDiscovery — deadline (Bug A4)', () => {
  it('a stalled network settles to the error state at the deadline — never an eternal skeleton', async () => {
    vi.useFakeTimers();
    mockNet.mode = 'hang';

    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const handle = startDiscovery({ network: 'testnet', onSnapshot, onError });

    // Well before the deadline: still pending, nothing settled.
    await vi.advanceTimersByTimeAsync(19_000);
    expect(onError).not.toHaveBeenCalled();

    // Deadline: the run aborts its in-flight requests and settles to error.
    await vi.advanceTimersByTimeAsync(1_500);
    await handle.done;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(mockNet.abortedRequests).toBeGreaterThan(0);
  });
});

describe('startDiscovery — high-water-mark reuse (Bug A2)', () => {
  it('anchors the scan at the cached marks so even the FAST phase finds high-index funds', async () => {
    // A vault must exist for the non-secret scan marks to persist.
    await createVault(ABANDON, 'test-password-11', 'testnet', FAST_KDF);
    setCachedHighWater('testnet', { receive: 7, change: -1 });
    mockNet.used.add(deriveReceiveAddress(ABANDON, 'testnet', 7).address);

    const snapshots: AccountSnapshot[] = [];
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: (snap) => snapshots.push(snap),
      onError: vi.fn(),
    });
    await handle.done;

    // WITHOUT the mark, phase 1 (gap 5) would stop at index 4 and report 0.
    // With it, indices 0..7 are always scanned: funds visible on first paint.
    expect(snapshots[0]?.confirmedSats).toBe(10_000n);
    // And the scanned window started from the mark instead of a blind rescan:
    // phase 1 = receive 0..12 (mark 7 + gap 5) + change 0..4 = 18 requests.
    const addr7 = deriveReceiveAddress(ABANDON, 'testnet', 7).address;
    expect(mockNet.statsCalls.slice(0, 18)).toContain(addr7);

    // The refreshed marks are re-persisted for the next session.
    expect(getCachedHighWater('testnet')).toEqual({ receive: 7, change: -1 });
  });
});

describe('DiscoveryController — single-flight (Bug A1)', () => {
  it('poll ticks are skipped (zero requests) while a discovery run is in flight', async () => {
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await tick();
    const inFlight = mockNet.statsCalls.length;
    expect(inFlight).toBeGreaterThan(0);
    expect(controller.busy).toBe(true);

    // A poll tick during the run must not issue a single request.
    const onChanged = vi.fn();
    controller.pollTick({ network: 'testnet', account: freshSnapshot(), onChanged });
    await tick();
    expect(mockNet.statsCalls.length).toBe(inFlight);
    expect(onChanged).not.toHaveBeenCalled();

    controller.abort();
  });

  it('a new refresh aborts the in-flight run and starts fresh (Try again semantics)', async () => {
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    const onError1 = vi.fn();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: onError1 });
    await tick();
    expect(mockNet.abortedRequests).toBe(0);

    // Second refresh: the first run's stalled requests are all aborted...
    const firstRunRequests = mockNet.statsCalls.length;
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await tick();
    expect(mockNet.abortedRequests).toBe(firstRunRequests);
    // ...silently (a superseded run must NOT flip the UI to the error state —
    // the fresh run owns the screen now).
    expect(onError1).not.toHaveBeenCalled();
    // And the fresh run is crawling.
    expect(mockNet.statsCalls.length).toBeGreaterThan(firstRunRequests);

    controller.abort();
  });
});

describe('pollAccount — cheap poll (Bug A3)', () => {
  it('a fresh wallet costs exactly 2 requests (the two tips), never a rescan', async () => {
    const changed = await pollAccount('testnet', freshSnapshot());
    expect(changed).toBe(false);
    expect(mockNet.statsCalls).toEqual(['tb1-receive-tip', 'tb1-change-tip']);
  });

  it('re-checks used addresses + tips only, and reports no change when quiet', async () => {
    mockNet.used.add('tb1-used-a');
    const snap: AccountSnapshot = {
      ...freshSnapshot(),
      confirmedSats: 10_000n,
      usedAddresses: ['tb1-used-a'],
    };
    const changed = await pollAccount('testnet', snap);
    expect(changed).toBe(false);
    expect(new Set(mockNet.statsCalls)).toEqual(
      new Set(['tb1-used-a', 'tb1-receive-tip', 'tb1-change-tip']),
    );
    expect(vi.mocked(getAddressStats)).toHaveBeenCalledTimes(3);
  });

  it('flags a change when a tip address becomes used (incoming payment)', async () => {
    mockNet.used.add('tb1-receive-tip');
    await expect(pollAccount('testnet', freshSnapshot())).resolves.toBe(true);
  });

  it('flags a change when a used address balance moves', async () => {
    const snap: AccountSnapshot = {
      ...freshSnapshot(),
      confirmedSats: 5_000n, // snapshot says 5,000 but the chain now says 10,000
      usedAddresses: ['tb1-used-a'],
    };
    mockNet.used.add('tb1-used-a');
    await expect(pollAccount('testnet', snap)).resolves.toBe(true);
  });
});
