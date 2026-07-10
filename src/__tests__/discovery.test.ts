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
  mode: 'instant' as 'instant' | 'hang' | 'manual',
  /** When set, requests beyond this many stats calls hang (stalls phase 2). */
  hangAfter: null as number | null,
  used: new Set<string>(),
  statsCalls: [] as string[],
  abortedRequests: 0,
  /** 'manual' mode: resolvers for every pending stats request, in order. */
  pending: [] as (() => void)[],
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getAddressStats: vi.fn(async (_network: unknown, address: string, signal?: AbortSignal) => {
      mockNet.statsCalls.push(address);
      const statsFor = (addr: string) => {
        const used = mockNet.used.has(addr);
        return {
          confirmedSats: used ? 10_000n : 0n,
          pendingSats: 0n,
          fundedSats: used ? 10_000n : 0n,
          spentSats: 0n,
        };
      };
      if (mockNet.mode === 'manual') {
        // The test resolves each request explicitly, so it can wedge an abort
        // between a phase's resolution and its queued continuation.
        return new Promise<ReturnType<typeof statsFor>>((resolve) => {
          mockNet.pending.push(() => resolve(statsFor(address)));
        });
      }
      const stall =
        mockNet.mode === 'hang' ||
        (mockNet.hangAfter !== null && mockNet.statsCalls.length > mockNet.hangAfter);
      if (stall) {
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
      return statsFor(address);
    }),
    getUtxos: vi.fn(async () => []),
    getAddressTxs: vi.fn(async () => []),
  };
});

import { startDiscovery, pollAccount, DiscoveryController, invalidateScanCache } from '../actions';
import { getAddressStats } from '../lib/api';
import { setUnlocked, lockNow } from '../session';
import {
  createVault,
  DEFAULT_DISCOVERY_OPTIONS,
  deriveReceiveAddress,
  discoverAccount,
  getCachedHighWater,
  PACING_WAVE_DELAY_MS,
  setCachedHighWater,
  type AccountSnapshot,
} from '../lib';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FAST_KDF = { N: 2 ** 8, r: 8, p: 1, dkLen: 32 };

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Spins the microtask/timer loop (real timers) until `pred` holds or we give up. */
async function waitUntil(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error('waitUntil: condition never held');
}

beforeEach(() => {
  localStorage.clear();
  // The scan cache is now cross-run / module-scope (§1b), so it MUST be cleared
  // between cases or a prior test's cached responses leak in and skew counts.
  invalidateScanCache();
  // These tests pin request COUNTS and orderings, so they run with Stage-2
  // pacing OFF (waveDelayMs 0) — the pacing itself is exercised in its own suite
  // below, which re-enables it explicitly. Concurrency stays at its real value.
  (DEFAULT_DISCOVERY_OPTIONS as { waveDelayMs?: number }).waveDelayMs = 0;
  mockNet.mode = 'instant';
  mockNet.hangAfter = null;
  mockNet.used.clear();
  mockNet.statsCalls = [];
  mockNet.abortedRequests = 0;
  mockNet.pending = [];
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
    controller.pollTick({ network: 'testnet', account: freshSnapshot(), accountComplete: true, onChanged });
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

describe('startDiscovery — snapshot completeness (F12)', () => {
  it('flags phase 1 as incomplete and the full scan as complete', async () => {
    const flags: boolean[] = [];
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: (_snap, complete) => flags.push(complete),
      onError: vi.fn(),
    });
    await handle.done;
    expect(flags).toEqual([false, true]);
  });
});

describe('deadline-cut phase 2 self-heals — but only after the backoff window (F12 + §1a)', () => {
  it('keeps the incomplete phase-1 result, suppresses self-heal in the window, then completes', async () => {
    vi.useFakeTimers();
    // Phase 1 (10 stats requests) succeeds instantly; everything after stalls,
    // so the 20s deadline cuts phase 2 off — exactly the throttled-burst case.
    mockNet.hangAfter = 10;

    const controller = new DiscoveryController();
    const flags: boolean[] = [];
    const onError = vi.fn();
    controller.refresh({
      network: 'testnet',
      onSnapshot: (_snap, complete) => flags.push(complete),
      onError,
    });

    await vi.advanceTimersByTimeAsync(20_500); // past the 20s deadline
    // The run settled: phase-1 kept (incomplete), no error, controller idle.
    expect(flags).toEqual([false]);
    expect(onError).not.toHaveBeenCalled();
    expect(controller.busy).toBe(false);

    // §1a: the cut run ESCALATED the ladder, so the very next poll tick — still
    // inside the backoff window — must NOT self-heal. It issues nothing, so a
    // stalled run cannot trigger a second run within the window (this is the
    // whole fix: no more 30s hammer). This behaviour is a deliberate change from
    // the pre-v1.1.1 "self-heal on the very next tick".
    const before = mockNet.statsCalls.length;
    const onChanged = vi.fn();
    controller.pollTick({
      network: 'testnet',
      account: freshSnapshot(),
      accountComplete: false,
      onChanged,
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(mockNet.statsCalls.length).toBe(before);

    // Once the window elapses (level-1 = ~60s + up to 10s jitter; advance well
    // past it), the tick self-heals — a full refresh (onChanged) WITHOUT issuing
    // any requests of its own.
    await vi.advanceTimersByTimeAsync(71_000);
    controller.pollTick({
      network: 'testnet',
      account: freshSnapshot(),
      accountComplete: false,
      onChanged,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mockNet.statsCalls.length).toBe(before);

    // The caller reacts by refreshing; the network has recovered, so the run
    // now finishes with a COMPLETE snapshot — the cue can clear and the ladder
    // resets.
    mockNet.hangAfter = null;
    controller.refresh({
      network: 'testnet',
      onSnapshot: (_snap, complete) => flags.push(complete),
      onError,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flags).toEqual([false, false, true]);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('network switch — no stale dispatch after an eager abort (F13)', () => {
  it('a snapshot resolved-but-not-yet-dispatched is dropped when the run is aborted on the same frame', async () => {
    // Reproduces the exact F13 race: phase 1 has RESOLVED (its continuation is
    // queued as a microtask) when switchNetwork aborts the run. Without the
    // pre-dispatch abort guard, the stale old-network snapshot would still
    // dispatch after the switch cleared the account.
    mockNet.mode = 'manual';
    const controller = new DiscoveryController();
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    controller.refresh({ network: 'testnet', onSnapshot, onError });

    // Phase 1 is a gap-5 scan on each chain at concurrency 2 (Stage 2), so it
    // resolves in three waves per chain: [0,1] then [2,3] then [4]. Drain the
    // first two waves (4 requests each across the two chains).
    await tick();
    expect(mockNet.pending.length).toBe(4); // wave 1: idx 0,1 on each chain
    for (const resolve of mockNet.pending.splice(0)) resolve();
    await tick();
    expect(mockNet.pending.length).toBe(4); // wave 2: idx 2,3 on each chain
    for (const resolve of mockNet.pending.splice(0)) resolve();

    // Phase 1, final index per chain.
    await tick();
    expect(mockNet.pending.length).toBe(2); // wave 3: idx 4 on each chain

    // Resolve the last requests and — SYNCHRONOUSLY, before any microtask can
    // run — abort, exactly as switchNetwork now does.
    for (const resolve of mockNet.pending.splice(0)) resolve();
    controller.abort();

    // Flush everything: the resolved phase-1 must have been dropped silently.
    await tick();
    await tick();
    await tick();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §1b — cross-run scan cache: the scan converges across attempts instead of
// restarting forever.
// ---------------------------------------------------------------------------

describe('cross-run scan cache (§1b)', () => {
  it('a run cut mid-scan resumes and pays only the remainder within the TTL', async () => {
    vi.useFakeTimers();
    // Empty wallet; the first ~25 requests land, everything after stalls, and the
    // 20s deadline cuts phase 2 off — exactly the throttled-burst case.
    mockNet.hangAfter = 25;
    const flags1: boolean[] = [];
    const h1 = startDiscovery({
      network: 'testnet',
      onSnapshot: (_s, c) => flags1.push(c),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(20_500);
    await h1.done;
    // Phase 1 landed; phase 2 was cut. Exactly 25 responses landed in the cache
    // (the successful ones; the stalled in-flight requests are never cached).
    expect(flags1).toEqual([false]); // incomplete — phase 2 never completed

    // Resume immediately (well within the ~100s TTL), network recovered. The
    // resumed run reuses the 25 cached responses and pays ONLY the remaining 15
    // of the 40-address full scan — the scan converges instead of restarting.
    mockNet.hangAfter = null;
    const before = mockNet.statsCalls.length;
    const flags2: boolean[] = [];
    let snap2: AccountSnapshot | null = null;
    const h2 = startDiscovery({
      network: 'testnet',
      onSnapshot: (s, c) => {
        flags2.push(c);
        if (c) snap2 = s;
      },
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await h2.done;
    const resumedCost = mockNet.statsCalls.length - before;
    expect(resumedCost).toBe(15); // 40 total − 25 already cached
    expect(flags2).toEqual([false, true]); // the resumed run completes
    expect(snap2).not.toBeNull();
    vi.useRealTimers();
  });

  it('re-fetches an entry once it is older than the TTL', async () => {
    vi.useFakeTimers();
    const h1 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);
    await h1.done;
    const afterFirst = mockNet.statsCalls.length;
    expect(afterFirst).toBe(40); // cold empty-wallet full run

    // A second run BEFORE the TTL reuses everything (0 new requests)...
    const h2 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);
    await h2.done;
    expect(mockNet.statsCalls.length - afterFirst).toBe(0);

    // ...but once every entry has aged past the TTL, the next run re-fetches all
    // 40 — a stale "unused" answer is never served past its lifetime.
    await vi.advanceTimersByTimeAsync(100_001); // > SCAN_CACHE_TTL_MS
    const beforeThird = mockNet.statsCalls.length;
    const h3 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);
    await h3.done;
    expect(mockNet.statsCalls.length - beforeThird).toBe(40);
    vi.useRealTimers();
  });

  it('is keyed per network (F13) and invalidation targets one network only', async () => {
    // Testnet full run: 40 requests, cached under testnet.
    const t1 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await t1.done;
    expect(mockNet.statsCalls.length).toBe(40);

    // Mainnet uses DIFFERENT addresses and its OWN cache — a testnet response can
    // never be reused for a mainnet scan, so it pays the full 40 fresh.
    let n = mockNet.statsCalls.length;
    const m1 = startDiscovery({ network: 'mainnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await m1.done;
    expect(mockNet.statsCalls.length - n).toBe(40);

    // Invalidate ONLY testnet: mainnet's cache must survive untouched.
    invalidateScanCache('testnet');
    n = mockNet.statsCalls.length;
    const m2 = startDiscovery({ network: 'mainnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await m2.done;
    expect(mockNet.statsCalls.length - n).toBe(0); // mainnet still fully cached

    // ...while testnet, having been cleared, pays the full 40 again.
    n = mockNet.statsCalls.length;
    const t2 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await t2.done;
    expect(mockNet.statsCalls.length - n).toBe(40);
  });

  it('invalidateScanCache() with no argument clears every network (lock)', async () => {
    const t1 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await t1.done;
    const m1 = startDiscovery({ network: 'mainnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await m1.done;

    invalidateScanCache(); // lock / logout clears all

    let n = mockNet.statsCalls.length;
    const t2 = startDiscovery({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await t2.done;
    expect(mockNet.statsCalls.length - n).toBe(40);
    n = mockNet.statsCalls.length;
    const m2 = startDiscovery({ network: 'mainnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await m2.done;
    expect(mockNet.statsCalls.length - n).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// §7 — the staleness landmine: a poll-detected change must never be un-detected
// by a cached rescan.
// ---------------------------------------------------------------------------

describe('cross-run cache staleness (§7)', () => {
  it('a poll-detected change invalidates the cache so the rescan sees the funds', async () => {
    const controller = new DiscoveryController();
    let account1: AccountSnapshot | null = null;
    controller.refresh({
      network: 'testnet',
      onSnapshot: (s, c) => {
        if (c) account1 = s;
      },
      onError: vi.fn(),
    });
    await waitUntil(() => account1 !== null && !controller.busy);
    const snap1 = account1 as unknown as AccountSnapshot;
    // Empty wallet: the receive tip (index 0) is cached as UNUSED.
    expect(snap1.confirmedSats).toBe(0n);
    const tip = snap1.receiveAddress;

    // The tip now RECEIVES a payment on-chain.
    mockNet.used.add(tip);

    // The cheap poll notices the tip became used and — per §7 — the controller
    // invalidates the cache BEFORE triggering the refresh, so the rescan fetches
    // the tip FRESH. Without that, the cached "unused" answer would UN-DETECT the
    // payment and the balance would wrongly stay $0.
    let account2: AccountSnapshot | null = null;
    const onChanged = (): void => {
      controller.refresh({
        network: 'testnet',
        onSnapshot: (s, c) => {
          if (c) account2 = s;
        },
        onError: vi.fn(),
      });
    };
    controller.pollTick({ network: 'testnet', account: snap1, accountComplete: true, onChanged });
    await waitUntil(() => account2 !== null);
    expect((account2 as unknown as AccountSnapshot).confirmedSats).toBe(10_000n);
  });

  it('the self-heal path does NOT invalidate — it resumes from the cache', async () => {
    vi.useFakeTimers();
    // Land phase 1 (10), stall the rest so phase 2 is cut → incomplete snapshot.
    mockNet.hangAfter = 10;
    const controller = new DiscoveryController();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(controller.busy).toBe(false);

    // Recover the network, then let the backoff window elapse and self-heal.
    mockNet.hangAfter = null;
    await vi.advanceTimersByTimeAsync(71_000);
    const before = mockNet.statsCalls.length;
    let resumed = false;
    controller.pollTick({
      network: 'testnet',
      account: freshSnapshot(),
      accountComplete: false,
      onChanged: () => {
        resumed = true;
        controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
      },
    });
    expect(resumed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    // The resumed run reused the 10 phase-1 responses (self-heal must NOT nuke
    // the cache) and paid only the remaining 30 of the 40-address scan.
    expect(mockNet.statsCalls.length - before).toBe(30);
    controller.abort();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// §1a/§1f — automatic-refresh backoff ladder.
// ---------------------------------------------------------------------------

describe('automatic-refresh backoff ladder (§1a/§1f)', () => {
  it('a manual refresh is always instant, even while backed off', async () => {
    vi.useFakeTimers();
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(20_500); // deadline → error → escalate (backed off)
    expect(controller.busy).toBe(false);

    // A manual refresh ignores the backoff window entirely — it starts a run now.
    mockNet.mode = 'instant';
    const before = mockNet.statsCalls.length;
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(50);
    expect(mockNet.statsCalls.length).toBeGreaterThan(before);
    controller.abort();
    vi.useRealTimers();
  });

  it('the error state does not hammer behind the banner', async () => {
    vi.useFakeTimers();
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    const onError = vi.fn();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(onError).toHaveBeenCalledTimes(1);

    // Behind the error banner the cheap poll is also gated — an immediate tick
    // issues ZERO requests, so nothing hammers the wedged network.
    const before = mockNet.statsCalls.length;
    const onChanged = vi.fn();
    controller.pollTick({
      network: 'testnet',
      account: freshSnapshot(),
      accountComplete: true,
      onChanged,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(mockNet.statsCalls.length).toBe(before);
    expect(onChanged).not.toHaveBeenCalled();
    controller.abort();
    vi.useRealTimers();
  });

  it('a successful complete snapshot resets the ladder', async () => {
    vi.useFakeTimers();
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(20_500); // escalate → backed off

    // A completing manual refresh resets the ladder...
    mockNet.mode = 'instant';
    let completed = false;
    controller.refresh({
      network: 'testnet',
      onSnapshot: (_s, c) => {
        if (c) completed = true;
      },
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(completed).toBe(true);
    expect(controller.busy).toBe(false);

    // ...so the very next poll tick is NO LONGER gated — the cheap 2-request poll
    // runs immediately (ladder is back to healthy).
    const before = mockNet.statsCalls.length;
    controller.pollTick({
      network: 'testnet',
      account: freshSnapshot(),
      accountComplete: true,
      onChanged: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(mockNet.statsCalls.length - before).toBe(2); // the two tips
    controller.abort();
    vi.useRealTimers();
  });

  it('offered load decays: full runs get rarer under a persistently wedged network', async () => {
    vi.useFakeTimers();
    mockNet.mode = 'hang';
    const controller = new DiscoveryController();
    let runsStarted = 0;
    const startRun = (): void => {
      runsStarted++;
      controller.refresh({ network: 'testnet', onSnapshot: vi.fn(), onError: vi.fn() });
    };
    startRun(); // the initial run

    // Simulate the App's dumb 30s clock for 12 minutes. Every tick tries to
    // self-heal (the snapshot never completes because the network is wedged).
    for (let elapsed = 0; elapsed < 12 * 60_000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      controller.pollTick({
        network: 'testnet',
        account: freshSnapshot(),
        accountComplete: false,
        onChanged: startRun,
      });
    }
    // Without backoff the self-heal would fire a fresh 40-request run roughly
    // every tick (~15+ over 12 min). With the ladder, runs get exponentially
    // rarer: a small handful.
    expect(runsStarted).toBeLessThanOrEqual(7);
    expect(runsStarted).toBeGreaterThanOrEqual(2);
    controller.abort();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// F12 regression (round 5): a stale/ahead high-water mark can never HIDE funds —
// phase 2 always evaluates from index 0.
// ---------------------------------------------------------------------------

describe('high-water mark can never hide funds (F12, round-5 property)', () => {
  it('an AHEAD mark still finds low-index funds and rewrites the mark down', async () => {
    await createVault(ABANDON, 'test-password-11', 'testnet', FAST_KDF);
    // A mark far ahead of reality (e.g. a seed used more heavily elsewhere).
    setCachedHighWater('testnet', { receive: 30, change: 30 });
    // But the only funds are at receive index 3.
    mockNet.used.add(deriveReceiveAddress(ABANDON, 'testnet', 3).address);

    const flags: boolean[] = [];
    let final: AccountSnapshot | null = null;
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: (s, c) => {
        flags.push(c);
        if (c) final = s;
      },
      onError: vi.fn(),
    });
    await handle.done;

    const snap = final as unknown as AccountSnapshot;
    // The ahead mark forced extra scanning but never hid the funds; the final
    // (complete) scan found them and corrected the mark to the real high index.
    expect(flags).toContain(true);
    expect(snap.confirmedSats).toBe(10_000n);
    expect(snap.receiveHighWater).toBe(3);
    expect(getCachedHighWater('testnet')).toEqual({ receive: 3, change: -1 });
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — single-run pacing: concurrency 2 + a jittered inter-wave delay,
// spreading a run out so it stops looking like a burst. Safe ONLY with the
// cross-run cache (§1b): a paced run the deadline cuts resumes, never restarts.
// ---------------------------------------------------------------------------

describe('Stage 2 — single-run pacing', () => {
  it('the production default is concurrency 2 with a ~200ms wave delay', () => {
    // (waveDelayMs is forced to 0 in beforeEach for the count tests; the real
    // default is asserted from the source constant directly.)
    expect(DEFAULT_DISCOVERY_OPTIONS.concurrency).toBe(2);
    expect(PACING_WAVE_DELAY_MS).toBe(200);
  });

  it('caps peak in-flight requests at 2 per chain (~4 across both chains)', async () => {
    // A counting api: track the max number of stats requests in flight at once.
    let inFlight = 0;
    let peak = 0;
    const derive = (_chain: 0 | 1, index: number) =>
      deriveReceiveAddress(ABANDON, 'testnet', index); // shape only; address unused here
    const countingApi = {
      getAddressStats: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return { confirmedSats: 0n, pendingSats: 0n, fundedSats: 0n, spentSats: 0n };
      },
      getUtxos: async () => [],
      getAddressTxs: async () => [],
    };
    await discoverAccount('testnet', derive, countingApi, { waveDelayMs: 0 });
    // concurrency 2 per chain × 2 chains scanned concurrently = ~4 peak, never 8.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThanOrEqual(2); // genuine parallelism, not serial
  });

  it('paces a full run across several seconds and still completes within the 20s deadline', async () => {
    vi.useFakeTimers();
    let complete = false;
    const handle = startDiscovery({
      network: 'testnet',
      waveDelayMs: PACING_WAVE_DELAY_MS, // opt back INTO pacing for this test
      onSnapshot: (_s, c) => {
        if (c) complete = true;
      },
      onError: vi.fn(),
    });

    // Pacing spreads the run out: it is NOT done almost immediately.
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).toBe(false);

    // ...but it completes comfortably before the 20s deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    await handle.done;
    expect(complete).toBe(true);
    vi.useRealTimers();
  });

  it('a paced run cut by the deadline RESUMES rather than restarts', async () => {
    vi.useFakeTimers();
    // Very slow pacing + a short deadline → the run is cut after landing only a
    // couple of waves.
    const h1 = startDiscovery({
      network: 'testnet',
      waveDelayMs: 2_000,
      deadlineMs: 3_000,
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(3_500); // deadline cuts it mid-scan
    await h1.done;
    const landed = mockNet.statsCalls.length;
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(40); // cut before the full scan

    // Resume with pacing off: it reuses what the cut run landed and pays only
    // the remainder — the paced scan converges instead of restarting.
    const before = mockNet.statsCalls.length;
    let complete = false;
    const h2 = startDiscovery({
      network: 'testnet',
      waveDelayMs: 0,
      onSnapshot: (_s, c) => {
        if (c) complete = true;
      },
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(100);
    await h2.done;
    const resumeCost = mockNet.statsCalls.length - before;
    expect(complete).toBe(true);
    expect(resumeCost).toBeLessThan(40); // did NOT restart the full burst
    expect(resumeCost).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// F17 — pacing must not starve deep wallets. Phase 1 AND phase 2 each re-walk
// 0..high-water under the SINGLE 20s deadline; if every wave is paced (including
// pure cache-hit re-walks), a moderately-deep wallet's phase 2 never completes
// and a very-deep wallet's phase 1 never paints — the "cue never clears" symptom
// the hotfix exists to cure, now on a perfectly healthy network. The fix paces
// ONLY waves that actually hit the network, so a cache-hit re-walk converges
// immediately while genuine cold bursts stay spaced. Timing is made deterministic
// by pinning Math.random (jitter), so these fake-timer budgets are exact.
// ---------------------------------------------------------------------------

/** Marks receive indices 0..count-1 as used on-chain in the mock. */
function fundDeepReceiveChain(count: number): void {
  for (let i = 0; i < count; i++) {
    mockNet.used.add(deriveReceiveAddress(ABANDON, 'testnet', i).address);
  }
}

describe('Stage 2 pacing — deep wallets (F17)', () => {
  it('(a) cold cache: genuine fetch waves are STILL spaced apart (anti-burst preserved)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // jitter 0 → exact 200ms gaps
    fundDeepReceiveChain(20);

    const handle = startDiscovery({
      network: 'testnet',
      waveDelayMs: PACING_WAVE_DELAY_MS,
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    // Wave 1 fires immediately (a first wave is never paced).
    await vi.advanceTimersByTimeAsync(0);
    const afterWave1 = mockNet.statsCalls.length;
    expect(afterWave1).toBeGreaterThan(0);

    // Cold cache ⇒ wave 1 hit the network ⇒ wave 2 IS paced: within the delay
    // window no further requests go out.
    await vi.advanceTimersByTimeAsync(PACING_WAVE_DELAY_MS - 1);
    expect(mockNet.statsCalls.length).toBe(afterWave1);

    // Past the delay the next fetch wave fires — pacing is intact for real bursts.
    await vi.advanceTimersByTimeAsync(2);
    expect(mockNet.statsCalls.length).toBeGreaterThan(afterWave1);

    handle.abort();
    vi.mocked(Math.random).mockRestore();
    vi.useRealTimers();
  });

  it('(b) a deep wallet (~80 used) completes phase 2 within the 20s deadline (reviewer regression)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic 250ms/wave
    fundDeepReceiveChain(80);

    const flags: boolean[] = [];
    const onError = vi.fn();
    const handle = startDiscovery({
      network: 'testnet',
      waveDelayMs: PACING_WAVE_DELAY_MS,
      onSnapshot: (_s, complete) => flags.push(complete),
      onError,
    });

    // Advance PAST the deadline so the run always settles (no hang regardless of
    // outcome). With pacing confined to genuine fetch waves, phase 1 (cold,
    // paced) then phase 2 (its 0..high-water re-walk now a free cache-hit pass)
    // both land BEFORE the 20s cut → a complete (true) snapshot. Before F17 the
    // paced cache-hit re-walk pushed phase 2 past 20s and it never completed.
    await vi.advanceTimersByTimeAsync(25_000);
    await handle.done;

    expect(flags).toContain(true); // phase 2 reached complete within the deadline
    expect(onError).not.toHaveBeenCalled();
    vi.mocked(Math.random).mockRestore();
    vi.useRealTimers();
  });

  it('(c) a very deep wallet (~170 used), warm cache: phase 1 still paints on a healthy network', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fundDeepReceiveChain(170);

    // Warm the cross-run cache with an UNPACED full run — models the scan having
    // converged over earlier resumed attempts, so every address is now cached.
    const warm = startDiscovery({
      network: 'testnet',
      waveDelayMs: 0,
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(50);
    await warm.done;

    // A paced run over the warm cache: phase 1's 0..high-water re-walk is all
    // cache hits, so it is NOT paced and paints almost immediately — WELL inside
    // the 20s deadline. Before F17, ~170 paced cache-hit waves blew past 20s and
    // phase 1 never painted (a false "couldn't reach the network" on a healthy
    // connection).
    let painted = false;
    const handle = startDiscovery({
      network: 'testnet',
      waveDelayMs: PACING_WAVE_DELAY_MS,
      onSnapshot: () => {
        painted = true;
      },
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(2_000); // far short of the 20s deadline
    expect(painted).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000); // let it settle fully
    await handle.done;
    vi.mocked(Math.random).mockRestore();
    vi.useRealTimers();
    // ~170 real address derivations across a warm + a paced full scan are
    // CPU-heavy; give this case a generous real-time budget (fake-time budgets
    // above are unaffected).
  }, 30_000);

  it('(d) a fully-cached re-walk issues zero fetches and inserts no pacing delay', async () => {
    vi.useFakeTimers();
    fundDeepReceiveChain(40);

    // Warm the cache with an unpaced full run.
    const warm = startDiscovery({
      network: 'testnet',
      waveDelayMs: 0,
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(50);
    await warm.done;
    const warmed = mockNet.statsCalls.length;
    expect(warmed).toBeGreaterThan(40); // genuinely deep: many addresses cached

    // Re-run WITH pacing on. Every wave is a pure cache hit, so NONE is paced:
    // the whole two-phase run finishes in ≲ a few hundred ms of fake time — NOT
    // (number-of-waves × ~250ms). Zero new fetches confirms it was fully cached.
    const before = mockNet.statsCalls.length;
    let complete = false;
    const handle = startDiscovery({
      network: 'testnet',
      waveDelayMs: PACING_WAVE_DELAY_MS,
      onSnapshot: (_s, c) => {
        if (c) complete = true;
      },
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(300);
    await handle.done;

    expect(complete).toBe(true);
    expect(mockNet.statsCalls.length - before).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// §7 regression — post-abort cache writes. A response that RESOLVED just before
// an abort has its continuation queued as a microtask; the poll's changed path
// runs invalidate → refresh → abort synchronously, so that continuation
// executes AFTER the invalidation. Without the write guard in withScanCache it
// would repopulate the freshly invalidated cache with a fresh-stamped but
// PRE-change response — un-detecting, for up to the TTL, the very change the
// poll just found.
// ---------------------------------------------------------------------------

describe('post-abort cache writes (§7 regression)', () => {
  it("an aborted run's post-abort landings never repopulate an invalidated cache", async () => {
    mockNet.mode = 'manual';
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    // Wave 1 in flight: concurrency 2 on each chain = 4 requests.
    await tick();
    expect(mockNet.pending.length).toBe(4);

    // The exact §7 interleaving, deterministically (same resolve-then-abort
    // technique as the F13 test above): the responses RESOLVE — pre-change
    // server data, continuations now queued — then, before any microtask can
    // run, a change signal invalidates the cache and aborts the run, exactly
    // as the poll's changed → invalidate → refresh → abort() sequence does
    // synchronously.
    for (const resolve of mockNet.pending.splice(0)) resolve();
    invalidateScanCache('testnet');
    handle.abort();

    // Flush: the queued continuations execute AFTER the invalidate + abort.
    // The write guard must drop them; the aborted run also issues no further
    // waves (the concurrency pool checks the signal before each pickup).
    await tick();
    await tick();
    await handle.done;
    const afterAborted = mockNet.statsCalls.length;
    expect(afterAborted).toBe(4);

    // Therefore a fresh run re-fetches EVERYTHING — the full 40-request scan.
    // Had any post-abort landing been cached, this run would cost 36 and could
    // serve fresh-stamped pre-change data for up to the TTL (the forbidden
    // "un-detect").
    mockNet.mode = 'instant';
    let complete = false;
    const h2 = startDiscovery({
      network: 'testnet',
      onSnapshot: (_s, c) => {
        if (c) complete = true;
      },
      onError: vi.fn(),
    });
    await h2.done;
    expect(complete).toBe(true);
    expect(mockNet.statsCalls.length - afterAborted).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// F16 — broadcast-path invalidation NOT paired with a synchronous abort. A
// broadcast (signAndBroadcast / bumpAndBroadcast) invalidates the cache in its
// own async frame; the aborting refreshAll only runs a microtask LATER, after
// the caller's await resumes. In that gap an in-flight run's already-resolved
// continuation runs while the run's OWN signal is not yet aborted — so the
// signal-only guard would let it write a PRE-broadcast response back into the
// just-cleared cache (the reviewer reproduced: the next run paid 36/40 and its
// complete snapshot reported $0 for a just-funded address). The generation
// counter closes the gap: any invalidation, abort-paired or not, drops the
// landing.
// ---------------------------------------------------------------------------

describe('broadcast-path invalidation drops in-flight landings (F16)', () => {
  it('an invalidation NOT paired with a synchronous abort still drops a run\'s queued landings', async () => {
    mockNet.mode = 'manual';
    const handle = startDiscovery({
      network: 'testnet',
      onSnapshot: vi.fn(),
      onError: vi.fn(),
    });

    // Wave 1 in flight: concurrency 2 on each chain = 4 requests.
    await tick();
    expect(mockNet.pending.length).toBe(4);

    // The responses RESOLVE — pre-broadcast server data, continuations queued.
    for (const resolve of mockNet.pending.splice(0)) resolve();

    // A BROADCAST-style invalidation: signAndBroadcast bumps the cache
    // generation in its own async frame, with NO synchronous abort of the run
    // (the aborting refreshAll runs a microtask later, after confirmSend's await
    // resumes). This is the exact F16 gap — and the crucial difference from the
    // §7 test above, which aborts in the SAME synchronous frame.
    invalidateScanCache('testnet');

    // Flush: the wave-1 continuations run NOW — after the invalidation, but while
    // the run's OWN signal is still NOT aborted. The signal-only guard alone would
    // let them write pre-broadcast data into the freshly-cleared cache (the
    // reviewer's 36/40 poisoning). The generation guard must drop them.
    await tick();

    // Only NOW does the delayed abort land, as refreshAll finally supersedes the
    // run. (Aborting after the flush is what isolates the generation guard: by
    // this point, under the old code, the poison would already be written.)
    handle.abort();

    // Drain any still-pending requests so the aborted run can settle (manual mode
    // doesn't reject on abort; each runner stops at its next signal check).
    while (mockNet.pending.length > 0) {
      for (const resolve of mockNet.pending.splice(0)) resolve();
      await tick();
    }
    await handle.done;

    // The post-broadcast refresh (R2) must re-fetch EVERYTHING — the full
    // 40-request scan. Had any of the run's wave-1 landings been cached, this
    // would cost 36 and its complete snapshot could report stale pre-broadcast
    // numbers for up to the TTL.
    mockNet.mode = 'instant';
    const before = mockNet.statsCalls.length;
    let complete = false;
    const h2 = startDiscovery({
      network: 'testnet',
      onSnapshot: (_s, c) => {
        if (c) complete = true;
      },
      onError: vi.fn(),
    });
    await h2.done;
    expect(complete).toBe(true);
    expect(mockNet.statsCalls.length - before).toBe(40);
  });
});
