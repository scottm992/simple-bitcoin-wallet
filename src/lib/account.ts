/**
 * account.ts — account orchestration on top of the wallet engine.
 *
 * This is the one "engine-ish" module the UI programmer owns. It ties together
 * address derivation (wallet.ts) and the chain API (api.ts) into the aggregate
 * data the UI renders: balance, spendable UTXOs, the next receive/change
 * addresses, and combined recent activity.
 *
 * Design goals:
 * - Pure and testable: {@link discoverAccount} takes the network plus a small
 *   address-derivation source and an api implementation, and returns plain data.
 *   Nothing here reaches into React, localStorage, or a global api singleton, so
 *   tests can inject a mocked api and a mocked deriver.
 * - Correct after sends: change returns to chain-1 (change) addresses, so we scan
 *   BOTH chains with a gap limit and always surface the next-unused change
 *   address for `buildAndSignTx`.
 * - Secrets stay out: the deriver hands us plain {@link DerivedAddress}es (address
 *   + path + public key). The mnemonic never enters this module.
 */
import type { Chain, DerivedAddress, Network } from './wallet';
import type { AddressStats, AddressTx, ApiUtxo } from './api';
import type { WalletUtxo } from './tx';

/**
 * The subset of the api used for discovery. Declaring it as an interface lets the
 * caller pass the real `../lib` api or a mock; nothing here imports the api
 * singleton directly.
 */
export interface AccountApi {
  getAddressStats(network: Network, address: string, signal?: AbortSignal): Promise<AddressStats>;
  getUtxos(network: Network, address: string, signal?: AbortSignal): Promise<ApiUtxo[]>;
  getAddressTxs(network: Network, address: string, signal?: AbortSignal): Promise<AddressTx[]>;
}

/**
 * Default per-entry lifetime for a {@link ScanCache}, in milliseconds. Long
 * enough that a run cut by the deadline can RESUME within a tick or two paying
 * only for the remainder (the heart of the v1.1.1 fix), short enough that a
 * cached "unused" response can't mask a landed payment for long — and every
 * change signal invalidates the cache outright regardless (see the
 * cross-run cache owner + invalidation API in `actions.ts`). ~100s sits inside
 * the 90–120s band the hotfix brief specifies.
 */
export const SCAN_CACHE_TTL_MS = 100_000;

/** One cached response, stamped with the time it was stored, for TTL expiry. */
interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
}

/**
 * A response cache shared between the fast phase-1 scan and the full phase-2
 * scan, so phase 2 only pays for the EXTENSION of the scan window rather than
 * re-fetching everything phase 1 already saw.
 *
 * v1.1.1: this cache now also survives ACROSS runs (the owner in `actions.ts`
 * holds one per network in memory — never persisted, see the handoff §7/§8), so
 * a run the deadline cut at 25/40 resumes and pays only the remaining ~15
 * instead of restarting the 40-request burst forever. Two invariants keep that
 * safe: every entry carries a {@link SCAN_CACHE_TTL_MS} TTL (a stale response is
 * ignored and re-fetched), and any on-chain change signal must call the owner's
 * invalidation API — a cached "unused" response must never un-detect a payment
 * the cheap poll just found.
 */
export interface ScanCache {
  readonly stats: Map<string, CacheEntry<AddressStats>>;
  readonly utxos: Map<string, CacheEntry<ApiUtxo[]>>;
  readonly txs: Map<string, CacheEntry<AddressTx[]>>;
  /** Per-entry lifetime in ms; a hit older than this is ignored (re-fetched). */
  readonly ttlMs: number;
  /** Clock source, injectable for tests; defaults to `Date.now`. */
  readonly now: () => number;
  /**
   * Monotonic generation counter, bumped by {@link clear} (F16). A wrapped-api
   * write captures this value BEFORE its `await` and stores the response only if
   * the generation is unchanged when the response lands. This makes invalidation
   * authoritative ON ITS OWN — it never depends on being paired with a
   * synchronous abort of the in-flight run by every future call site. The two
   * BROADCAST paths (`signAndBroadcast` / `bumpAndBroadcast`) invalidate a
   * microtask BEFORE their abort fires, a gap the signal-only guard cannot cover:
   * a run's already-resolved continuation would otherwise write pre-broadcast
   * data back into the just-cleared cache. Bumping the generation on every
   * `clear()` closes that gap for any invalidation, abort-paired or not.
   */
  readonly generation: number;
  /**
   * Count of REAL network fetches made through this cache — a cache MISS that
   * hit the wrapped api, recorded by {@link recordFetch} (F17). `scanChain`
   * reads it to pace ONLY waves that actually issued requests: a fully-cached
   * wave (a warm re-walk, or a resumed run's already-fetched range) advances
   * nothing, so there is nothing to burst and no reason to wait — pacing it
   * would starve deep wallets (phase 1 AND phase 2 each re-walk 0..high-water
   * under the single 20s deadline; before this, a moderately deep wallet's
   * cache-hit re-walk was paced to death and phase 2 never completed). Monotonic
   * — {@link clear} does NOT reset it, because `scanChain` compares per-wave
   * DELTAS, not absolute values, so an interleaved reset could only mislead.
   */
  readonly fetches: number;
  /** Records one real network fetch (called by `withScanCache` on a miss). */
  recordFetch(): void;
  /**
   * Drops every cached entry AND bumps {@link generation} — call on ANY change
   * signal (see `actions.ts`). The generation bump is what makes an
   * invalidation drop even the in-flight landings whose writes are still queued.
   */
  clear(): void;
}

/**
 * Creates an empty {@link ScanCache}. `ttlMs`/`now` are injectable for tests;
 * production uses {@link SCAN_CACHE_TTL_MS} and the wall clock.
 */
export function createScanCache(
  ttlMs: number = SCAN_CACHE_TTL_MS,
  // Looked up at call time (not captured) so a cache created once at module
  // scope still reads the live clock — including a test's fake timers.
  now: () => number = () => Date.now(),
): ScanCache {
  const stats = new Map<string, CacheEntry<AddressStats>>();
  const utxos = new Map<string, CacheEntry<ApiUtxo[]>>();
  const txs = new Map<string, CacheEntry<AddressTx[]>>();
  // F16: bumped by clear(); read (as a getter) by withScanCache to fence any
  // in-flight write against an invalidation that landed during its await.
  let generation = 0;
  // F17: incremented on every real network fetch; read (as a getter) by
  // scanChain to pace only waves that actually hit the network.
  let fetches = 0;
  return {
    stats,
    utxos,
    txs,
    ttlMs,
    now,
    get generation(): number {
      return generation;
    },
    get fetches(): number {
      return fetches;
    },
    recordFetch(): void {
      fetches++;
    },
    clear(): void {
      stats.clear();
      utxos.clear();
      txs.clear();
      generation++;
    },
  };
}

/** Known highest USED index per chain from a previous scan (-1 = none known). */
export interface ChainHighWater {
  readonly receive: number;
  readonly change: number;
}

/**
 * Derives one address for a chain + index. The caller closes over the (secret)
 * mnemonic so this module never touches it. Must be synchronous and pure.
 */
export type AddressDeriver = (chain: Chain, index: number) => DerivedAddress;

/** Tuning knobs for gap-limit discovery. */
export interface DiscoveryOptions {
  /**
   * Consecutive never-used addresses that end a chain scan. Default 20 — the
   * standard BIP44 gap limit (F8). The previous default of 5 could miss funds
   * received to an address a few slots past the last used one; 20 matches what
   * other wallets do, so a wallet restored elsewhere finds the same funds here.
   */
  readonly gapLimit: number;
  /**
   * Hard cap on index scanned per chain, for speed/safety. Default 200 (F8),
   * comfortably above the gap limit so a legitimately deep chain is still found.
   */
  readonly maxIndex: number;
  /**
   * How many address lookups to run at once. Default 2 (Stage 2, v1.1.1),
   * lowered from 4: the receive + change chains scan concurrently, so a run's
   * peak in-flight is ~4 rather than ~8 — gentler on mempool.space's
   * stall-throttle, which hangs bursts silently.
   */
  readonly concurrency: number;
  /** Cap on merged activity items returned. Default 25. */
  readonly activityLimit: number;
  /**
   * Known highest used index per chain from a previous scan. Indices up to the
   * mark are always scanned (their balances are needed regardless), and the
   * gap-limit window counts from there — so a fast (small-gap) scan can never
   * terminate before reaching funds that were already known to exist.
   */
  readonly highWater?: ChainHighWater;
  /** Aborts the whole discovery run (threaded into every request). */
  readonly signal?: AbortSignal;
  /** Response cache shared between phases and across runs (see {@link ScanCache}). */
  readonly cache?: ScanCache;
  /**
   * Delay (ms, plus jitter) inserted BETWEEN scan waves within a chain (Stage 2,
   * v1.1.1). Paces a full run over several seconds so the request pattern stops
   * looking like a burst. Default {@link PACING_WAVE_DELAY_MS}; tests pass 0.
   * Safe only WITH the cross-run cache (§1b): a slower run cut by the deadline
   * resumes rather than restarts. The overall run stays bounded by
   * `DISCOVERY_DEADLINE_MS` (20s) — the pacing never lengthens the deadline.
   */
  readonly waveDelayMs?: number;
  /**
   * Optional progress callback for the Home "Checking address N of ~M…" cue
   * (scan-progress feature; DISPLAY-ONLY). Invoked as each address is EVALUATED
   * during the gap-limit scan:
   *  - `checked` = addresses evaluated so far across BOTH chains. Cache hits
   *    COUNT — the user cares about scan position, not network traffic — because
   *    we count evaluations, not fetches. Never decreases within a run.
   *  - `estimatedTotal` = the current COMBINED window estimate across both
   *    chains, which GROWS when a used address extends a chain's gap window (so
   *    the honest cue form is "N of ~M", never a percent that could move
   *    backwards). Only ever grows within a run.
   * {@link discoverAccount} owns the cross-chain aggregation. ABSENT ⇒ ZERO
   * behavior change: no aggregation runs and the request pattern is byte-for-byte
   * identical. This is pure instrumentation — it touches nothing about WHEN or
   * HOW requests are made (the handoff §8 do-nots hold).
   */
  readonly onProgress?: (checked: number, estimatedTotal: number) => void;
}

/**
 * Base delay between scan waves (Stage 2). ~200 ms plus up to
 * {@link PACING_JITTER_MS} jitter spreads a full 40-request run over several
 * seconds. NEVER raise `DISCOVERY_DEADLINE_MS` to compensate — a bigger deadline
 * only increases offered load against a stall-throttler.
 */
export const PACING_WAVE_DELAY_MS = 200;

/** Additive jitter (0..this ms) on each inter-wave delay, to de-correlate. */
const PACING_JITTER_MS = 100;

/** Default discovery options. Gap limit follows the BIP44 standard (F8). */
export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  gapLimit: 20,
  maxIndex: 200,
  concurrency: 2,
  activityLimit: 25,
  waveDelayMs: PACING_WAVE_DELAY_MS,
};

/** One merged activity item: a transaction with the wallet's net delta. */
export interface ActivityItem {
  readonly txid: string;
  readonly confirmed: boolean;
  /** Unix seconds of the confirming block, if confirmed. */
  readonly blockTime?: number;
  /** Net change to the whole wallet for this tx, in sats (>0 received, <0 sent). */
  readonly netSats: bigint;
}

/** The aggregate account snapshot the UI renders. */
export interface AccountSnapshot {
  /** Confirmed balance summed across all used addresses, in sats. */
  readonly confirmedSats: bigint;
  /** Net pending (mempool) balance summed across all used addresses, in sats. */
  readonly pendingSats: bigint;
  /** All spendable UTXOs, each tagged with derivation path + address. */
  readonly utxos: readonly WalletUtxo[];
  /** THE address shown on Receive: the next unused receive (chain-0) address. */
  readonly receiveAddress: string;
  /**
   * The derivation index of {@link receiveAddress}. Cached (non-secret) by the
   * UI so Receive can fall back to a locally-derived address at the last-known
   * index when discovery is unavailable (flaky network), rather than showing
   * nothing.
   */
  readonly receiveIndex: number;
  /** The next unused change (chain-1) address, for `buildAndSignTx`. */
  readonly changeAddress: string;
  /** Combined recent activity, newest first, deduped, capped. */
  readonly activity: readonly ActivityItem[];
  /** Every address discovered as used (either chain), for reference/debugging. */
  readonly usedAddresses: readonly string[];
  /** Highest used receive (chain-0) index found, -1 when none. Cached as a high-water mark. */
  readonly receiveHighWater: number;
  /** Highest used change (chain-1) index found, -1 when none. Cached as a high-water mark. */
  readonly changeHighWater: number;
}

/**
 * A typed failure the UI can render as "couldn't reach the network". Wraps the
 * underlying api error (transport or response) without leaking secrets — there
 * are none in this module to leak.
 */
export class AccountDiscoveryError extends Error {
  override readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('Could not reach the bitcoin network');
    this.name = 'AccountDiscoveryError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, preserving
 * order. Settles deterministically: a rejected worker rejects the aggregate via
 * `Promise.all` (which holds a handler on every runner, so no rejection is ever
 * left stranded/unhandled), and an aborted signal stops runners from picking up
 * further items. There is no path on which the returned promise never settles.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  async function runner(): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new AccountDiscoveryError(new Error('aborted'));
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await worker(item, i);
    }
  }
  const runners: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

/** Whether an address has ever been touched on-chain (funded or in mempool). */
function isUsed(stats: AddressStats): boolean {
  return stats.fundedSats > 0n || stats.spentSats > 0n || stats.pendingSats !== 0n;
}

/**
 * A short, jittered delay between scan waves (Stage 2 pacing). Resolves early if
 * `signal` aborts, so the run's deadline can still cut a paced scan cleanly.
 */
function pacedDelay(baseMs: number, signal?: AbortSignal): Promise<void> {
  const ms = baseMs + Math.floor(Math.random() * PACING_JITTER_MS);
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    if (signal?.aborted) {
      done();
      return;
    }
    signal?.addEventListener('abort', done);
  });
}

/** A used address plus the metadata we gathered while scanning it. */
interface ScannedAddress {
  readonly derived: DerivedAddress;
  readonly stats: AddressStats;
}

/**
 * Scans one chain (receive or change) with a gap limit: derive addresses in
 * batches, look up each address's stats, and stop once `gapLimit` consecutive
 * never-used addresses are seen (or `maxIndex` is reached). Indices up to a
 * known high-water mark are always scanned regardless of the gap counter, so a
 * small-gap fast scan can never terminate below funds a previous scan already
 * found. Returns the used addresses, the first-unused index (THE next address),
 * and the highest used index seen (-1 when none) for high-water caching.
 */
async function scanChain(
  network: Network,
  chain: Chain,
  derive: AddressDeriver,
  api: AccountApi,
  opts: DiscoveryOptions,
  highWater: number,
  // Optional progress reporter (scan-progress feature). Called once per
  // EVALUATED address with this chain's current window basis — the furthest
  // index it now knows it must reach. `undefined` ⇒ no reporting AND
  // byte-identical scan behavior. See {@link discoverAccount} for aggregation.
  reportProgress?: (windowBasis: number) => void,
): Promise<{
  used: ScannedAddress[];
  nextUnusedIndex: number;
  nextUnusedAddress: string;
  highestUsedIndex: number;
}> {
  const used: ScannedAddress[] = [];
  let consecutiveUnused = 0;
  let nextUnusedIndex = 0;
  let nextUnusedAddress = derive(chain, 0).address;
  let firstUnusedRecorded = false;
  let highestUsedIndex = -1;

  const waveDelayMs = opts.waveDelayMs ?? 0;
  // F17: pace ONLY waves that follow a wave which actually hit the network. The
  // cache's monotonic real-fetch counter is snapshotted around each wave; if the
  // PREVIOUS wave advanced it, this one is a genuine burst and gets the
  // inter-wave delay; if the previous wave was fully cached (zero requests — a
  // warm re-walk or a resumed run's already-fetched range), there is nothing to
  // burst, so this wave proceeds immediately. That kills the dead air that had
  // phase 2's cache-hit re-walk of 0..high-water paced to death for deep wallets
  // (never completing within the 20s deadline), while preserving the anti-burst
  // property EXACTLY where it matters: cold fetching still spaces every wave. A
  // cold below-high-water walk after a TTL expiry re-fetches, so it advances the
  // counter and is still paced — we deliberately do NOT skip pacing by
  // index-below-mark alone. When no cache is present (`fetches` undefined),
  // `prevWaveFetched` stays true so pacing behaves as before (every wave paced).
  const fetchCount = (): number | undefined => opts.cache?.fetches;
  let prevWaveFetched = true; // the first wave is never paced regardless (see below)
  let firstWave = true;
  let index = 0;
  while (index <= opts.maxIndex && (consecutiveUnused < opts.gapLimit || index <= highWater)) {
    // A jittered pause BETWEEN genuine fetch waves (never before the first)
    // spreads a real burst out; the deadline (via `signal`) cuts a paced scan
    // cleanly. See the F17 note above for why cache-hit waves skip the pause.
    if (!firstWave && prevWaveFetched && waveDelayMs > 0) {
      await pacedDelay(waveDelayMs, opts.signal);
    }
    firstWave = false;

    // Derive a batch, but never scan past maxIndex; below the high-water mark
    // the gap counter must not shrink the batch (those indices are scanned
    // unconditionally — their balances are needed regardless).
    const remainingByGap =
      index <= highWater ? opts.concurrency : opts.gapLimit - consecutiveUnused;
    const remainingByCap = opts.maxIndex - index + 1;
    const batchSize = Math.max(1, Math.min(opts.concurrency, remainingByGap, remainingByCap));

    const batch: DerivedAddress[] = [];
    for (let k = 0; k < batchSize; k++) batch.push(derive(chain, index + k));

    const fetchesBefore = fetchCount();
    const statsList = await mapWithConcurrency(
      batch,
      opts.concurrency,
      (d) => api.getAddressStats(network, d.address, opts.signal),
      opts.signal,
    );
    // Did THIS wave hit the network? (Undefined counter ⇒ no cache ⇒ assume yes,
    // preserving the pre-F17 pace-every-wave behavior for the cacheless path.)
    const fetchesAfter = fetchCount();
    prevWaveFetched =
      fetchesBefore === undefined || fetchesAfter === undefined
        ? true
        : fetchesAfter > fetchesBefore;

    for (let k = 0; k < batch.length; k++) {
      const derived = batch[k];
      const stats = statsList[k];
      if (derived === undefined || stats === undefined) continue;
      if (isUsed(stats)) {
        used.push({ derived, stats });
        consecutiveUnused = 0;
        highestUsedIndex = index + k;
      } else {
        if (!firstUnusedRecorded) {
          nextUnusedIndex = index + k;
          nextUnusedAddress = derived.address;
          firstUnusedRecorded = true;
        }
        consecutiveUnused++;
      }
      // Report AFTER classification (scan-progress): every EVALUATED address
      // counts as "checked" (cache hits included — we count evaluations, not
      // fetches), and a used address that just extended this chain's window is
      // reflected in the estimate on the SAME tick, so M grows exactly when the
      // used address is seen. The basis is the furthest index this chain now
      // must reach: max(cached high-water, highest used seen). When absent this
      // is a no-op and the loop is byte-identical to before — the gap-limit
      // `break` still fires on exactly the same address (a used address resets
      // `consecutiveUnused` to 0, so the break can only trigger right after an
      // unused increment, precisely as when it lived inside the `else`).
      if (reportProgress !== undefined) reportProgress(Math.max(highWater, highestUsedIndex));
      if (consecutiveUnused >= opts.gapLimit && index + k > highWater) break;
    }
    index += batch.length;
  }

  // If every scanned address was used (never hit an unused one), the next address
  // is the one just past the last scanned index.
  if (!firstUnusedRecorded) {
    const nextIdx = Math.min(index, opts.maxIndex);
    nextUnusedIndex = nextIdx;
    nextUnusedAddress = derive(chain, nextIdx).address;
  }

  return { used, nextUnusedIndex, nextUnusedAddress, highestUsedIndex };
}

/**
 * Discovers the full account state for a network: scans receive + change chains
 * with a gap limit, aggregates balance and UTXOs, picks the next unused
 * addresses, and merges recent activity across all used addresses.
 *
 * @param network - The active network.
 * @param derive - Pure address deriver (closes over the secret mnemonic).
 * @param api - The chain API implementation (real or mocked).
 * @param options - Discovery tuning; defaults to {@link DEFAULT_DISCOVERY_OPTIONS}.
 * @returns The aggregate {@link AccountSnapshot}.
 * @throws {AccountDiscoveryError} If any network lookup fails.
 */
export async function discoverAccount(
  network: Network,
  derive: AddressDeriver,
  api: AccountApi,
  options: Partial<DiscoveryOptions> = {},
): Promise<AccountSnapshot> {
  const opts: DiscoveryOptions = { ...DEFAULT_DISCOVERY_OPTIONS, ...options };
  const cachedApi = opts.cache ? withScanCache(api, opts.cache) : api;

  // ---- Scan-progress aggregation (optional; onProgress absent ⇒ no-op) ------
  // discoverAccount owns the aggregation across the two CONCURRENTLY-scanning
  // chains: `checked` is every address EVALUATED on either chain (cache hits
  // included — we count evaluations, not fetches), and `estimatedTotal` is the
  // SUM of each chain's current window estimate — which GROWS when a used
  // address extends a chain's gap window. That growing M is why the cue is
  // "N of ~M": a raw percent was rejected because it would move BACKWARDS as M
  // grows. Both chains share these counters; JS is single-threaded, so the
  // interleaved increments are race-free.
  const onProgress = opts.onProgress;
  const receiveHw = opts.highWater?.receive ?? -1;
  const changeHw = opts.highWater?.change ?? -1;
  // A chain's window estimate = the furthest index it must reach, plus the full
  // gap window, clamped to maxIndex (we never scan past it). Seeded from the
  // high-water mark so the FIRST report's combined M is already the full initial
  // window (e.g. 20 + 20 = 40 for a fresh gap-20 run), not a half-populated sum.
  const chainEstimate = (windowBasis: number): number =>
    Math.min(windowBasis + 1 + opts.gapLimit, opts.maxIndex + 1);
  const estimates: [number, number] = [chainEstimate(receiveHw), chainEstimate(changeHw)];
  let checked = 0;
  const makeReporter = (chain: Chain): ((windowBasis: number) => void) | undefined => {
    if (onProgress === undefined) return undefined;
    return (windowBasis: number): void => {
      checked += 1;
      estimates[chain] = chainEstimate(windowBasis);
      onProgress(checked, estimates[0] + estimates[1]);
    };
  };

  let receive: Awaited<ReturnType<typeof scanChain>>;
  let change: Awaited<ReturnType<typeof scanChain>>;
  try {
    // Chains are independent; scan them concurrently.
    [receive, change] = await Promise.all([
      scanChain(network, 0, derive, cachedApi, opts, receiveHw, makeReporter(0)),
      scanChain(network, 1, derive, cachedApi, opts, changeHw, makeReporter(1)),
    ]);
  } catch (err) {
    throw new AccountDiscoveryError(err);
  }

  const usedScanned: ScannedAddress[] = [...receive.used, ...change.used];

  // Aggregate confirmed + pending across all used addresses.
  let confirmedSats = 0n;
  let pendingSats = 0n;
  for (const s of usedScanned) {
    confirmedSats += s.stats.confirmedSats;
    pendingSats += s.stats.pendingSats;
  }

  // Gather spendable UTXOs and merged activity, only for USED addresses.
  let utxos: WalletUtxo[] = [];
  let activity: ActivityItem[] = [];
  try {
    const usedDerived = usedScanned.map((s) => s.derived);

    const utxoLists = await mapWithConcurrency(
      usedDerived,
      opts.concurrency,
      (d) => cachedApi.getUtxos(network, d.address, opts.signal),
      opts.signal,
    );
    utxos = collectUtxos(usedDerived, utxoLists);

    const txLists = await mapWithConcurrency(
      usedDerived,
      opts.concurrency,
      (d) => cachedApi.getAddressTxs(network, d.address, opts.signal),
      opts.signal,
    );
    activity = mergeActivity(txLists, opts.activityLimit);
  } catch (err) {
    throw new AccountDiscoveryError(err);
  }

  return {
    confirmedSats,
    pendingSats,
    utxos,
    receiveAddress: receive.nextUnusedAddress,
    receiveIndex: receive.nextUnusedIndex,
    changeAddress: change.nextUnusedAddress,
    activity,
    usedAddresses: usedScanned.map((s) => s.derived.address),
    receiveHighWater: receive.highestUsedIndex,
    changeHighWater: change.highestUsedIndex,
  };
}

/**
 * Wraps an {@link AccountApi} with a {@link ScanCache} so a scan never re-fetches
 * a response that is still fresh — within one run (phase 2 reusing phase 1) and,
 * for the cross-run cache, across runs (a resumed run pays only the remainder).
 * A hit older than the cache's TTL is ignored and re-fetched, so a stale
 * "unused" answer can never be served past its lifetime.
 */
function withScanCache(api: AccountApi, cache: ScanCache): AccountApi {
  /** Returns a still-fresh cached value, or undefined (miss or expired). */
  function fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (entry === undefined) return undefined;
    return cache.now() - entry.storedAt < cache.ttlMs ? entry.value : undefined;
  }
  // WRITE GUARD (§7 + F16): every write is fenced by TWO complementary checks,
  // evaluated AFTER the await, against state captured BEFORE it. A response that
  // resolves just before an invalidation has its continuation sitting in the
  // microtask queue; writing it then would repopulate the freshly invalidated
  // cache with a fresh-stamped but PRE-change response — hiding, for up to the
  // TTL, the very change that invalidation exists to surface (the "un-detect"
  // the invalidation rule forbids, §7). The two guards cover the two ways that
  // race arrives:
  //
  //  1. GENERATION (F16). `clear()` bumps `cache.generation`; a write proceeds
  //     only if the generation is unchanged since the request was issued. This
  //     makes invalidation authoritative ON ITS OWN — it does NOT depend on
  //     being paired with a synchronous abort of the in-flight run. The two
  //     broadcast paths invalidate a microtask BEFORE their aborting refresh
  //     fires (the abort straddles an `await` in App.tsx), so at the moment the
  //     continuation runs the run's own signal is NOT yet aborted; only the
  //     generation bump catches it. Invalidation must never rely on every future
  //     call site remembering to abort in the same frame — the generation guard
  //     removes that fragility.
  //  2. SIGNAL (unchanged). A superseding refresh aborts the prior run WITHOUT
  //     invalidating the cache (resume semantics — the new run must reuse the
  //     old landings), so the generation is unchanged there; the abort guard is
  //     what drops that superseded run's post-abort landings, keeping the
  //     round-5 regression semantics intact.
  //
  // Either way, an aborted/superseded run's post-abort landings are returned to
  // their (doomed) scan but never cached: resume relies only on writes that
  // landed before the invalidation/abort.
  return {
    getAddressStats: async (network, address, signal) => {
      const hit = fresh(cache.stats.get(address));
      if (hit !== undefined) return hit;
      const gen = cache.generation;
      cache.recordFetch(); // F17: a real network hit — this wave paces.
      const value = await api.getAddressStats(network, address, signal);
      if (cache.generation === gen && signal?.aborted !== true) {
        cache.stats.set(address, { value, storedAt: cache.now() });
      }
      return value;
    },
    getUtxos: async (network, address, signal) => {
      const hit = fresh(cache.utxos.get(address));
      if (hit !== undefined) return hit;
      const gen = cache.generation;
      cache.recordFetch();
      const value = await api.getUtxos(network, address, signal);
      if (cache.generation === gen && signal?.aborted !== true) {
        cache.utxos.set(address, { value, storedAt: cache.now() });
      }
      return value;
    },
    getAddressTxs: async (network, address, signal) => {
      const hit = fresh(cache.txs.get(address));
      if (hit !== undefined) return hit;
      const gen = cache.generation;
      cache.recordFetch();
      const value = await api.getAddressTxs(network, address, signal);
      if (cache.generation === gen && signal?.aborted !== true) {
        cache.txs.set(address, { value, storedAt: cache.now() });
      }
      return value;
    },
  };
}

/** Tags each address's UTXOs with its derivation path + address for signing. */
function collectUtxos(
  used: readonly DerivedAddress[],
  utxoLists: readonly ApiUtxo[][],
): WalletUtxo[] {
  const out: WalletUtxo[] = [];
  for (let i = 0; i < used.length; i++) {
    const derived = used[i];
    const list = utxoLists[i];
    if (derived === undefined || list === undefined) continue;
    for (const u of list) {
      out.push({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        path: derived.path,
        address: derived.address,
      });
    }
  }
  return out;
}

/**
 * Merges per-address transaction lists into wallet-level activity: dedupe by
 * txid, SUM the per-address net deltas so a self-transfer or a spend that also
 * creates change nets correctly for the whole wallet, sort newest first, cap.
 */
function mergeActivity(txLists: readonly AddressTx[][], limit: number): ActivityItem[] {
  const byTxid = new Map<string, ActivityItem>();
  for (const list of txLists) {
    for (const tx of list) {
      const existing = byTxid.get(tx.txid);
      if (existing) {
        // Same tx touches multiple of our addresses: sum the deltas.
        byTxid.set(tx.txid, {
          ...existing,
          netSats: existing.netSats + tx.netSats,
          // Prefer the confirmed view / a known blockTime if any address has it.
          confirmed: existing.confirmed || tx.confirmed,
          ...(existing.blockTime !== undefined
            ? { blockTime: existing.blockTime }
            : tx.blockTime !== undefined
              ? { blockTime: tx.blockTime }
              : {}),
        });
      } else {
        byTxid.set(tx.txid, {
          txid: tx.txid,
          confirmed: tx.confirmed,
          netSats: tx.netSats,
          ...(tx.blockTime !== undefined ? { blockTime: tx.blockTime } : {}),
        });
      }
    }
  }

  const merged = [...byTxid.values()];
  merged.sort((a, b) => {
    // Unconfirmed (no blockTime) float to the top as "newest".
    const at = a.blockTime ?? Number.MAX_SAFE_INTEGER;
    const bt = b.blockTime ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return bt - at;
    // Stable-ish tiebreak by txid so ordering is deterministic in tests.
    return a.txid < b.txid ? 1 : a.txid > b.txid ? -1 : 0;
  });
  return merged.slice(0, limit);
}
