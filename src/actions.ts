/**
 * actions.ts — impure operations that touch the engine + network, kept out of
 * the pure reducer. These functions read the secret mnemonic from session.ts at
 * the moment of use and let it go out of scope; they never return it or store it.
 */
import {
  broadcastTx,
  buildAndSignTx,
  buildRbfBumpTx,
  CannotBumpError,
  createScanCache,
  deriveAddress,
  deriveAddressRange,
  discoverAccount,
  getAddressStats,
  getAddressTxs,
  getBtcUsdPrice,
  getCachedHighWater,
  getFeeEstimates,
  getSendRecord,
  getTransaction,
  getUtxos,
  mapWithConcurrency,
  MAX_ACCEPTED_FEE_RATE,
  MIN_ACCEPTED_FEE_RATE,
  normalizeRecipientAddress,
  recordSend,
  setCachedHighWater,
  setCachedReceiveIndex,
  type AccountSnapshot,
  type ApiTxVout,
  type FeeEstimates,
  type Network,
  type ScanCache,
  type WalletUtxo,
} from './lib';
import type { AddressDeriver } from './lib/account';
import { getMnemonic } from './session';
import type { FeeTier } from './state';

/** Gap window for the fast first-paint scan (phase 1 of a discovery run). */
const FAST_GAP_LIMIT = 5;

/** Gap window for the full correctness scan (phase 2; BIP44 standard, F8). */
const FULL_GAP_LIMIT = 20;

// ---------------------------------------------------------------------------
// Progress-aware run deadline (v1.1.2) — replaces the single fixed 20s wall.
//
// Field report (owner's phone, 2026-07-10): a scan reached "22 of ~40", stopped
// on the "may be behind" wait state for ~a minute, then finished. Diagnosis: the
// network served slowly (a decaying mempool.space throttle — a stalled request
// eats the 8s api timeout), and the FIXED 20s `DISCOVERY_DEADLINE_MS` cut the run
// mid-phase-2. A single fixed wall can't tell "slow but still landing" from
// "wedged": it guillotines a run that is genuinely making progress. Pacing the
// run slower under that same wall would only cut it EARLIER — not the fix.
//
// Two timers now bound a run, both aborting the SAME AbortController the old
// deadline used (so the settle semantics are unchanged — a landed phase-1 result
// is kept, nothing → onError, a superseded run stays silent):
//   • an INACTIVITY cutoff, reset by every landed api response, so a
//     slow-but-MOVING run completes in ONE run and only a genuine stall is cut;
//   • a HARD CAP that a run never outlives regardless of activity, preserving the
//     round-5 F12 property that the run settles deterministically — the skeleton
//     is NEVER open-ended.
// ---------------------------------------------------------------------------

/**
 * Inactivity cutoff for a discovery run: it is aborted only after this long with
 * NO api response landing. Every landed response resets it (via the engine's
 * `onResponse` hook), so a network that serves each wave in a few seconds but
 * keeps landing finishes the whole scan in one run instead of being cut at "22
 * of ~40". Chosen at 12s — comfortably ABOVE the api layer's 8s per-request
 * timeout (a single slow-but-successful request can't trip it) yet BELOW the old
 * fixed 20s wall, so a true total stall is now cut FASTER than before, not slower.
 */
const DISCOVERY_INACTIVITY_MS = 12_000;

/**
 * Hard overall cap on a discovery run: it NEVER lives past this, regardless of
 * activity. This is what preserves round-5 F12's load-bearing property now that
 * the primary cutoff is activity-based — the run settles deterministically and
 * the skeleton is never open-ended. Sized generously (2 min) so a genuinely
 * slow-but-moving deep scan still completes in one run; a PATHOLOGICAL drip that
 * keeps landing just inside the inactivity window forever is settled here. A
 * capped run keeps its landed phase-1 result and resumes from the cross-run
 * cache — it pays only the shrinking remainder, never a restart.
 */
const DISCOVERY_HARD_CAP_MS = 120_000;

/** Concurrency for the cheap poll's stats re-checks. */
const POLL_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Automatic-refresh backoff ladder (§1a/§1f, v1.1.1)
//
// The App's 30s interval is a dumb clock; THIS controller decides whether an
// automatic (self-heal / poll-triggered) tick may act. A run that ends in error
// or is cut incomplete escalates the ladder; any successful complete (phase-2)
// snapshot resets it. The gate sits ONLY on the automatic path — a manual
// refresh (Try again / unlock / network switch / post-broadcast) is always
// instant. Without this, an empty wallet re-fired its full 40-request burst
// every 30s forever, deepening mempool.space's stall-throttle into a self-DoS.
// ---------------------------------------------------------------------------

/** Base cadence of the automatic path — matches the App's 30s clock. */
const BACKOFF_BASE_MS = 30_000;

/** Ceiling on the automatic backoff interval (~8 minutes). */
const BACKOFF_CAP_MS = 480_000;

/** Escalation level cap (guards the `2 ** level` term; the interval caps sooner). */
const MAX_BACKOFF_LEVEL = 8;

/**
 * Additive jitter (0..this) on each backoff interval, to de-correlate our retry
 * cadence from mempool.space's own throttle window so we don't lock-step into it.
 */
const BACKOFF_JITTER_MS = 10_000;

/**
 * Progress-gated quick retry (§b, v1.1.2). When a cut run made progress (landed
 * ≥1 new response), the automatic self-heal becomes eligible again after just
 * this long — far shorter than any full ladder rung — because the cross-run cache
 * means the resume USUALLY pays only the shrinking remainder. ~8s: long enough
 * not to hammer a recovering connection, short enough that the "may be behind"
 * wait doesn't linger. HARD guardrails in
 * {@link DiscoveryController.settleIncomplete} keep this from re-creating the
 * v1.1.1 self-DoS: quick is granted ONLY on progress; a quick-retried run that
 * lands NOTHING walks the full ladder; and — because progress alone is NOT proof
 * of convergence (F18: against a partially-serving network, ~100s cache-TTL
 * expiry re-fetches can consume each run's landings WITHOUT advancing the scan
 * frontier, indefinitely) — at most {@link QUICK_RETRY_BUDGET} quick windows are
 * granted between complete snapshots. True worst case: ≤ budget cycles of
 * (inactivity cut + this window) of quick cadence — ~100s — then guaranteed
 * full-ladder decay.
 */
const QUICK_RETRY_MS = 8_000;

/**
 * Budget of quick retries grantable between COMPLETE snapshots (F18). Progress
 * alone cannot prove convergence — a partially-serving network can land one
 * response per run forever while TTL churn keeps the frontier still — so the
 * quick privilege is budgeted. 5 is generous for the real field case (a
 * genuinely converging resume completes in 1–2 quick retries, each paying only
 * the remainder) yet forces the F18 adversary onto the decaying full ladder
 * within about one cache TTL (~5 × ~20s cut+window cycles ≈ 100s). Only a
 * complete snapshot resets the budget ({@link DiscoveryController.resetBackoff}).
 */
const QUICK_RETRY_BUDGET = 5;

/**
 * The concrete api object passed into discovery. We import the named functions
 * from the barrel and shape them into the AccountApi interface.
 */
const accountApi = {
  getAddressStats,
  getUtxos,
  getAddressTxs,
};

// ---------------------------------------------------------------------------
// Cross-run scan cache (§1b, v1.1.1) — the heart of the fix.
//
// One ScanCache per network, held in module memory ONLY (NEVER localStorage /
// disk / across sessions — handoff §7/§8). Because it survives across runs, a
// run the deadline cut at 25/40 RESUMES and pays only the remaining ~15 instead
// of restarting the whole 40-request burst forever: the scan converges across
// attempts. Two safeguards keep it honest — each entry has a TTL
// (SCAN_CACHE_TTL_MS), and EVERY on-chain change signal must invalidate it via
// {@link invalidateScanCache}. Keyed per network (F13) so a Live response can
// never be reused on Practice or vice versa.
// ---------------------------------------------------------------------------

const scanCaches = new Map<Network, ScanCache>();

/** The (persistent, in-memory) scan cache for a network, created on first use. */
function scanCacheFor(network: Network): ScanCache {
  let cache = scanCaches.get(network);
  if (cache === undefined) {
    cache = createScanCache();
    scanCaches.set(network, cache);
  }
  return cache;
}

/**
 * Invalidates cached discovery responses. This MUST be called on every on-chain
 * change signal, because a cached "unused" response could otherwise mask a
 * landed payment — and, worse, a poll-detected change followed by a cached
 * rescan would *un-detect* it (handoff §7). Call sites:
 *  - the cheap poll detecting movement — BEFORE it triggers the full refresh;
 *  - a successful broadcast (signAndBroadcast / bumpAndBroadcast);
 *  - a network switch (the target network, from `App.switchNetwork`);
 *  - lock (all networks, from `App`'s lock handler).
 *
 * With no argument, clears every network's cache (lock / logout). This never
 * touches disk — the caches are in-memory only.
 */
export function invalidateScanCache(network?: Network): void {
  if (network === undefined) {
    for (const cache of scanCaches.values()) cache.clear();
    return;
  }
  scanCaches.get(network)?.clear();
}

/**
 * Builds a pure address deriver that closes over the current mnemonic. The
 * mnemonic is read once here; the returned closure only produces public
 * addresses (no private material leaves).
 */
function makeDeriver(network: Network): AddressDeriver {
  const mnemonic = getMnemonic();
  return (chain, index) => deriveAddress(mnemonic, network, chain, index);
}

/** Runs one full account discovery for the active network (no phases). */
export async function loadAccount(network: Network): Promise<AccountSnapshot> {
  const derive = makeDeriver(network);
  return discoverAccount(network, derive, accountApi);
}

/** A handle on an in-flight discovery run. */
export interface DiscoveryHandle {
  /** Settles when the run is finished (full scan done, cut short, or error). */
  readonly done: Promise<void>;
  /**
   * Whether this run LANDED at least one new api response (a network fetch that
   * resolved — cache hits don't count). Read by {@link DiscoveryController} once
   * the run settles to gate the backoff ladder: a cut-but-PROGRESSING run earns
   * a quick automatic retry (the cross-run cache means its resume pays only the
   * shrinking remainder), while a totally-stalled run (nothing landed) walks the
   * full ladder so a wedged network's offered load still decays.
   */
  madeProgress(): boolean;
  /** Aborts the run: every in-flight request is cancelled. */
  abort(): void;
}

/** Persists the non-secret scan marks a snapshot carries. */
function persistScanMarks(network: Network, snap: AccountSnapshot): void {
  setCachedReceiveIndex(network, snap.receiveIndex);
  setCachedHighWater(network, { receive: snap.receiveHighWater, change: snap.changeHighWater });
}

/**
 * Starts a two-phase discovery run:
 *
 * - **Phase 1 (first paint):** a fast scan with a small gap window
 *   ({@link FAST_GAP_LIMIT}) anchored at the cached high-water marks, so the UI
 *   renders a correct balance after a handful of requests instead of waiting
 *   for the full crawl.
 * - **Phase 2 (correctness):** quietly extends to the full
 *   {@link FULL_GAP_LIMIT} scan, reusing every phase-1 response via a
 *   run-scoped cache (only the window EXTENSION costs new requests), and
 *   dispatches the merged snapshot.
 *
 * The run is bounded by TWO timers (v1.1.2), both aborting the same
 * AbortController: an {@link DISCOVERY_INACTIVITY_MS} cutoff reset by every
 * landed response (so a slow-but-moving network completes in one run), and a
 * {@link DISCOVERY_HARD_CAP_MS} wall it never outlives. Either way it settles
 * deterministically — a completed phase-1 result stays on screen, and with no
 * result at all `onError` fires. The skeleton is never open-ended (F12).
 */
export function startDiscovery(params: {
  network: Network;
  /**
   * Receives each snapshot as it lands. `complete` is false for the fast
   * phase-1 result and true for the full gap-20 result (F12): the UI keeps a
   * subtle "checking for updates" cue up while only an incomplete snapshot is
   * on screen, and the poll tick completes the scan if this run is cut off.
   */
  onSnapshot: (snapshot: AccountSnapshot, complete: boolean) => void;
  onError: () => void;
  /**
   * Optional progress callback for the Home scan-progress cue (display-only).
   * Fires as each address is evaluated during EITHER phase's gap scan, forwarding
   * `discoverAccount`'s aggregated (checked, estimatedTotal). Like `onSnapshot`,
   * it is SILENCED the instant the run is superseded/aborted (the
   * `externallyAborted` guard below) — the aborter owns the UI now, so no stale
   * or cross-run count can leak past an abort (F13-style).
   */
  onProgress?: (checked: number, estimatedTotal: number) => void;
  /** Inactivity cutoff (ms); omitted → {@link DISCOVERY_INACTIVITY_MS}. Tests
   *  inject a small value to exercise the stall path deterministically. */
  inactivityMs?: number;
  /** Hard overall cap (ms); omitted → {@link DISCOVERY_HARD_CAP_MS}. The legacy
   *  name `deadlineMs` still sets this (back-compat for existing tests that
   *  inject a single wall). */
  hardCapMs?: number;
  /** @deprecated Alias for {@link hardCapMs} — kept so pre-v1.1.2 tests that
   *  inject a small fixed wall keep working. `hardCapMs` takes precedence. */
  deadlineMs?: number;
  /** Inter-wave pacing delay (Stage 2); omitted → the production default. Tests
   *  pass 0 to keep request-count assertions fast and deterministic. */
  waveDelayMs?: number;
}): DiscoveryHandle {
  const { network, onSnapshot, onError } = params;
  const controller = new AbortController();
  const inactivityMs = params.inactivityMs ?? DISCOVERY_INACTIVITY_MS;
  const hardCapMs = params.hardCapMs ?? params.deadlineMs ?? DISCOVERY_HARD_CAP_MS;
  let gotSnapshot = false;
  // An externally aborted (superseded) run must stay silent: the aborter owns
  // the UI state now. Only a cutoff / genuine failure with no result may settle
  // the UI to the error state.
  let externallyAborted = false;
  // Guards late callbacks: once the run has settled or been aborted, a straggler
  // response landing must not re-arm the inactivity timer (a leaked timer) or
  // touch progress. Set in `finally` and in `abort()`.
  let settled = false;
  // §b progress signal: count of api responses that LANDED during this run (real
  // network fetches that resolved — cache hits don't count). ≥1 ⇒ the run made
  // forward progress; the controller reads this via {@link DiscoveryHandle.madeProgress}.
  let landedResponses = 0;

  // The HARD CAP: an unconditional wall so the run always settles (F12). Never
  // reset — a run never outlives it regardless of activity.
  const hardCap = setTimeout(() => controller.abort(), hardCapMs);
  // The INACTIVITY cutoff: (re-)armed on every landed response. A total stall
  // (nothing lands) fires it after one full window — faster than the old fixed
  // wall; a slow-but-moving run keeps resetting it and completes uncut.
  let inactivity = setTimeout(() => controller.abort(), inactivityMs);
  const onResponse = (): void => {
    if (settled) return;
    landedResponses++;
    clearTimeout(inactivity);
    inactivity = setTimeout(() => controller.abort(), inactivityMs);
  };

  const done = (async () => {
    try {
      const derive = makeDeriver(network);
      const highWater = getCachedHighWater(network) ?? undefined;
      // §1b: the PERSISTENT per-network cache, not a fresh per-run one. A run
      // the deadline cut short leaves its landed responses here, so the next
      // run resumes and pays only the remainder instead of re-bursting all 40.
      const cache = scanCacheFor(network);
      const shared = {
        ...(highWater !== undefined ? { highWater } : {}),
        ...(params.waveDelayMs !== undefined ? { waveDelayMs: params.waveDelayMs } : {}),
        signal: controller.signal,
        cache,
        // Engine-internal landing hook: reset the inactivity cutoff + count
        // progress on every response that lands (see startDiscovery's timers and
        // {@link DiscoveryOptions.onResponse}). Covers stats AND the utxo/txs
        // fetches uniformly, since all three go through `withScanCache`.
        onResponse,
        // Scan-progress (display-only): forward each aggregated tick to the
        // caller, but ONLY while this run still owns the UI. A superseded/aborted
        // run must fall silent (same rule as the onSnapshot dispatches below,
        // F13) — checked at dispatch time so a landing that resolves just after
        // an abort can't push a stale count onto the cue.
        ...(params.onProgress
          ? {
              onProgress: (checked: number, estimatedTotal: number): void => {
                if (externallyAborted) return;
                params.onProgress?.(checked, estimatedTotal);
              },
            }
          : {}),
      };

      const fast = await discoverAccount(network, derive, accountApi, {
        ...shared,
        gapLimit: FAST_GAP_LIMIT,
      });
      // F13: if the run was superseded while this phase's continuation was
      // still queued (e.g. a network switch on the same frame), do NOT
      // dispatch a stale snapshot — the aborter owns the screen now.
      if (externallyAborted) return;
      gotSnapshot = true;
      persistScanMarks(network, fast);
      onSnapshot(fast, false);

      const full = await discoverAccount(network, derive, accountApi, {
        ...shared,
        gapLimit: FULL_GAP_LIMIT,
      });
      if (externallyAborted) return;
      persistScanMarks(network, full);
      onSnapshot(full, true);
    } catch {
      // Inactivity/cap cutoff or network failure. With a phase-1 result already
      // on screen we keep it; with nothing, settle to error so the UI never sits
      // on an open-ended skeleton. A superseded (externally aborted) run stays
      // silent — its replacement owns the UI state.
      if (!gotSnapshot && !externallyAborted) onError();
    } finally {
      settled = true;
      clearTimeout(hardCap);
      clearTimeout(inactivity);
    }
  })();

  return {
    done,
    madeProgress: (): boolean => landedResponses > 0,
    abort: (): void => {
      externallyAborted = true;
      settled = true;
      clearTimeout(hardCap);
      clearTimeout(inactivity);
      controller.abort();
    },
  };
}

/**
 * The cheap 30-second poll (documented budget: a fresh wallet costs 2 requests).
 * Re-checks ONLY the known-used addresses plus the current receive/change tips —
 * never a full rescan. Returns true when something changed on-chain (a tip
 * became used, or the aggregate balance moved), in which case the caller should
 * run one full discovery.
 */
export async function pollAccount(
  network: Network,
  account: AccountSnapshot,
  signal?: AbortSignal,
): Promise<boolean> {
  const usedSet = new Set(account.usedAddresses);
  const targets = [...new Set([...account.usedAddresses, account.receiveAddress, account.changeAddress])];
  const statsList = await mapWithConcurrency(
    targets,
    POLL_CONCURRENCY,
    (address) => getAddressStats(network, address, signal),
    signal,
  );

  let confirmed = 0n;
  let pending = 0n;
  for (let i = 0; i < targets.length; i++) {
    const address = targets[i];
    const stats = statsList[i];
    if (address === undefined || stats === undefined) continue;
    const touched = stats.fundedSats > 0n || stats.spentSats > 0n || stats.pendingSats !== 0n;
    if (usedSet.has(address)) {
      confirmed += stats.confirmedSats;
      pending += stats.pendingSats;
    } else if (touched) {
      return true; // a tip address just became used — money moved
    }
  }
  return confirmed !== account.confirmedSats || pending !== account.pendingSats;
}

/**
 * Single-flight coordinator for discovery + polling (Bug A + v1.1.1):
 * - at most ONE full discovery run in flight; a new `refresh` aborts the old
 *   run and starts fresh (Try again / unlock / network switch semantics);
 * - `pollTick` is skipped entirely while a discovery or a previous poll is
 *   still running, so 30s ticks can never pile bursts on top of a slow crawl;
 * - the AUTOMATIC path (self-heal / poll) is gated by an exponential backoff
 *   ladder (§1a/§1f): a complete snapshot resets it, and while backed off the
 *   automatic tick issues ZERO requests so offered load decays instead of
 *   growing. A cut/errored run's escalation is PROGRESS-GATED (§b, v1.1.2): a run
 *   that LANDED new responses (made progress — the cross-run cache means its
 *   resume usually pays only the shrinking remainder) earns a QUICK retry instead
 *   of a full rung — BUDGETED to {@link QUICK_RETRY_BUDGET} grants between
 *   complete snapshots (F18) — while a run that landed nothing, or any cut once
 *   the budget is spent, walks the full ladder, so offered load is GUARANTEED to
 *   decay: a wedged network exactly as before, and a partially-serving one after
 *   at most the budgeted quick cadence. `refresh` — the MANUAL path — is never
 *   gated.
 *
 * Headless (no React) so the piling/skipping/backoff behavior is directly
 * testable.
 */
export class DiscoveryController {
  private current: DiscoveryHandle | null = null;
  private pollBusy = false;

  /** Backoff ladder state (§1a/§b). Level 0 = healthy; the automatic path is
   *  suppressed until `Date.now() >= nextEligibleAt`. A progress-cut run sets a
   *  short {@link QUICK_RETRY_MS} eligibility and resets the level (while the
   *  F18 budget below lasts); a no-progress or over-budget cut escalates the
   *  level (30s·2^level, capped). Manual refresh ignores both — it always runs
   *  now. */
  private backoffLevel = 0;
  private nextEligibleAt = 0;

  /** Quick windows granted since the last COMPLETE snapshot (F18). Once it
   *  reaches {@link QUICK_RETRY_BUDGET}, every subsequent cut — progress or
   *  not — walks the full ladder; only a complete snapshot resets it. */
  private quickRetriesGranted = 0;

  /** True while a full discovery run is in flight. */
  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Aborts any in-flight run and starts a fresh two-phase discovery. This is
   * the MANUAL path (Try again / unlock / network switch / post-broadcast) — it
   * is ALWAYS instant and never gated by the backoff ladder. Its OUTCOME still
   * feeds the ladder, though: a completed full snapshot resets it; a cut/errored
   * run either earns a quick retry (it made progress, within the F18 budget) or
   * escalates the full ladder (it landed nothing, or the budget is spent) — so
   * the automatic path that shares this controller backs off (or recovers) based
   * on what actually happened.
   */
  refresh(params: {
    network: Network;
    onSnapshot: (snapshot: AccountSnapshot, complete: boolean) => void;
    onError: () => void;
    /** Display-only scan-progress ticks, forwarded to the run (see
     *  {@link startDiscovery}). */
    onProgress?: (checked: number, estimatedTotal: number) => void;
    /**
     * Fires exactly once when THIS run settles (complete, error, or cut) AND is
     * still the current run — never for a superseded run. The App clears the
     * stored scan-progress here, so a run cut mid-scan can't leave a frozen
     * "address N of ~M" on the cue: with no run in flight the cue must fall back
     * to its deliberate-wait (State B) text.
     */
    onSettled?: () => void;
    inactivityMs?: number;
    hardCapMs?: number;
    deadlineMs?: number;
    waveDelayMs?: number;
  }): void {
    this.current?.abort();
    // Observe whether this run produces a COMPLETE (phase-2) snapshot, to drive
    // the ladder when it settles.
    let sawComplete = false;
    const handle = startDiscovery({
      ...params,
      onSnapshot: (snapshot, complete) => {
        if (complete) sawComplete = true;
        params.onSnapshot(snapshot, complete);
      },
    });
    this.current = handle;
    void handle.done.finally(() => {
      // A superseded run (replaced by a newer refresh, or cleared by abort())
      // must not touch the ladder — nor clear progress — its replacement owns
      // the state now.
      if (this.current !== handle) return;
      this.current = null;
      if (sawComplete) this.resetBackoff();
      // §b: a cut/errored run is gated by whether it made forward progress —
      // read the run's landed-response count off the handle.
      else this.settleIncomplete(handle.madeProgress());
      // Settle signal: only the current run reaches here, so the App can safely
      // drop a stale scan-progress count without racing a newer run's ticks.
      params.onSettled?.();
    });
  }

  /**
   * One cheap poll tick — the AUTOMATIC path. Skipped (zero requests) while a
   * discovery run or a previous poll is still in flight, AND while the backoff
   * ladder says we're not yet eligible (§1a/§b): a stalled run cannot cause a
   * second run within the backoff window, and a wedged network sees offered load
   * decay instead of grow. Eligibility is the QUICK window ({@link QUICK_RETRY_MS})
   * after a progress-cut run, or a full ladder rung after a no-progress one. Once
   * eligible:
   *  - an INCOMPLETE on-screen snapshot (a cutoff/abort cut phase 2 short, F12)
   *    self-heals by requesting a full refresh (which RESUMES via the cross-run
   *    cache — see §1b); it does NOT invalidate the cache. Because the App's tick
   *    is a 30s clock, a quick-eligible self-heal is FELT at the next tick edge
   *    unless a faster follow-up nudge is pending (see `App.tsx`);
   *  - otherwise it runs the cheap used+tips check and, when money moved,
   *    invalidates the cache (§1b — so the following rescan re-fetches the moved
   *    address fresh and can never un-detect the change) and fires `onChanged`.
   */
  pollTick(params: {
    network: Network;
    account: AccountSnapshot;
    /** Whether the on-screen snapshot came from a full scan (F12). */
    accountComplete: boolean;
    onChanged: () => void;
  }): void {
    if (this.current !== null || this.pollBusy) return;
    // Backoff gate: while degraded, the automatic path issues NOTHING — not even
    // the 2-request cheap poll — so a wedged network's offered load decays.
    if (Date.now() < this.nextEligibleAt) return;
    if (!params.accountComplete) {
      // Self-heal: the last run never finished its full scan. Complete it now
      // (this tick issues zero requests itself; the refresh does the work, and
      // RESUMES from the cross-run cache rather than re-bursting). No cache
      // invalidation — resuming is the whole point.
      params.onChanged();
      return;
    }
    this.pollBusy = true;
    void pollAccount(params.network, params.account)
      .then((changed) => {
        if (changed) {
          // Something moved on-chain: the cached responses for the moved
          // address are now stale. Invalidate BEFORE triggering the refresh so
          // the rescan fetches it fresh and can never un-detect the change (§7).
          invalidateScanCache(params.network);
          params.onChanged();
        }
      })
      .catch(() => {
        /* transient network failure — the next tick simply tries again */
      })
      .finally(() => {
        this.pollBusy = false;
      });
  }

  /** Aborts any in-flight discovery run (e.g. on lock / unmount / network
   *  switch). Does NOT invalidate the cross-run cache — that is a separate
   *  signal (a superseding manual refresh must be able to RESUME) — nor does it
   *  touch the ladder (a superseded run is not a real outcome). */
  abort(): void {
    this.current?.abort();
    this.current = null;
  }

  /**
   * Accounts a cut/errored (non-complete) run against the backoff ladder,
   * PROGRESS-GATED (§b, v1.1.2) and BUDGETED (F18):
   *
   * - **Made progress** (landed ≥1 new response) AND the quick budget isn't
   *   spent: grant a QUICK retry ({@link QUICK_RETRY_MS}), reset the ladder
   *   level, and spend one unit of {@link QUICK_RETRY_BUDGET}. The resume
   *   usually pays only the shrinking remainder via the cross-run cache.
   * - **Otherwise** — no progress (a true stall), OR the budget is spent —
   *   escalate the FULL ladder one rung. Consecutive no-progress runs always
   *   decay, a wedged network is never quick-retried, and (F18) a
   *   partially-serving network that lands just enough per run to keep the
   *   privilege alive — TTL-expired re-fetches count as landings without
   *   advancing the scan frontier — is cut off after the budget and decays too.
   *
   * TRUE worst-case bound (corrects the pre-F18 "self-limiting" claim, which
   * overlooked TTL churn): at most {@link QUICK_RETRY_BUDGET} quick windows
   * between complete snapshots — ≈ budget × (inactivity cut + quick window) ≈
   * 100s of quick cadence — after which EVERY subsequent cut, progress or not,
   * walks the full ladder until a complete snapshot resets everything (budget
   * AND ladder, {@link resetBackoff}).
   */
  private settleIncomplete(madeProgress: boolean): void {
    if (madeProgress && this.quickRetriesGranted < QUICK_RETRY_BUDGET) {
      this.quickRetriesGranted++;
      this.backoffLevel = 0;
      this.nextEligibleAt = Date.now() + QUICK_RETRY_MS;
      return;
    }
    this.escalateBackoff();
  }

  /** Escalates the automatic-refresh backoff one rung: 30s → 1m → 2m → 4m →
   *  cap ~8m, plus jitter. Called for a no-progress cut/error (§b). */
  private escalateBackoff(): void {
    this.backoffLevel = Math.min(this.backoffLevel + 1, MAX_BACKOFF_LEVEL);
    const interval = Math.min(BACKOFF_BASE_MS * 2 ** this.backoffLevel, BACKOFF_CAP_MS);
    this.nextEligibleAt = Date.now() + interval + Math.floor(Math.random() * BACKOFF_JITTER_MS);
  }

  /** Resets the ladder to healthy — level 0 and immediately eligible, so the
   *  automatic path may act on the next tick. This also clears any pending
   *  quick-retry window (`nextEligibleAt = 0`) AND refills the F18 quick-retry
   *  budget. Called whenever a full (complete) snapshot lands: a complete
   *  snapshot resets EVERYTHING. */
  private resetBackoff(): void {
    this.backoffLevel = 0;
    this.nextEligibleAt = 0;
    this.quickRetriesGranted = 0;
  }
}

/** Fetches the BTC/USD price, returning null on any failure (offline-tolerant). */
export async function loadPrice(): Promise<number | null> {
  try {
    return await getBtcUsdPrice();
  } catch {
    return null;
  }
}

/** Fetches fee estimates for the network. */
export async function loadFees(network: Network): Promise<FeeEstimates> {
  return getFeeEstimates(network);
}

/**
 * Maps a fee tier to a sat/vByte rate from the estimates, clamped into the sane
 * `[MIN_ACCEPTED_FEE_RATE, MAX_ACCEPTED_FEE_RATE]` window (F1). Even though
 * getFeeEstimates already clamps, this is a second, independent guard so a rate
 * reaching tx.ts is always in-range and never zero/NaN.
 */
export function feeRateForTier(fees: FeeEstimates, tier: FeeTier): number {
  const raw = tier === 'faster' ? fees.fast : tier === 'economy' ? fees.slow : fees.medium;
  if (!Number.isFinite(raw) || raw < MIN_ACCEPTED_FEE_RATE) return MIN_ACCEPTED_FEE_RATE;
  if (raw > MAX_ACCEPTED_FEE_RATE) return MAX_ACCEPTED_FEE_RATE;
  return raw;
}

/**
 * What a broadcast returns: the txid, plus whether the local send record —
 * the Speed-up flow's verification baseline (F15) — was persisted.
 */
export interface BroadcastResult {
  /** The broadcast transaction id. */
  readonly txid: string;
  /**
   * Whether the local send record (txid → recipient + amount, sendLog.ts) was
   * persisted (F15). Best-effort BY DESIGN: a storage failure never fails the
   * broadcast — the payment is already out and unaffected — but a `false`
   * here means this payment cannot later be sped up (prepareBump will
   * dead-end `'unverified'`), so callers can see their verification coverage
   * instead of losing it silently.
   */
  readonly sendRecorded: boolean;
}

/**
 * Signs and broadcasts a payment. Reads the mnemonic at call time, builds the
 * tx, broadcasts it, and returns the txid. The mnemonic is not returned.
 *
 * Idempotency: buildAndSignTx over the same UTXO set + params yields the same
 * signed tx, and mempool.space treats a re-broadcast of an already-accepted tx
 * as success (returns the same txid), so a retry cannot double-spend (and its
 * record write just rewrites identical data).
 *
 * F15: immediately after a successful broadcast, the send is recorded locally
 * (returned txid → the USER-confirmed recipient + the exact amount the signed
 * tx pays them, from the engine's own accounting). This record is what lets
 * the Speed-up flow later prove the chain API isn't lying about where the
 * payment goes.
 */
export async function signAndBroadcast(params: {
  network: Network;
  utxos: readonly WalletUtxo[];
  recipient: string;
  amountSats: bigint;
  feeRateSatVb: number;
  changeAddress: string;
  sendMax: boolean;
  /** User's informed consent to a large fee-vs-amount ratio (F10). Only bypasses
   * the engine's percentage rule — never the hard rate/absolute limits. */
  allowHighFee: boolean;
}): Promise<BroadcastResult> {
  const mnemonic = getMnemonic();
  const built = buildAndSignTx({
    mnemonic,
    network: params.network,
    utxos: params.utxos,
    recipient: params.recipient,
    amountSats: params.amountSats,
    feeRateSatVb: params.feeRateSatVb,
    changeAddress: params.changeAddress,
    sendMax: params.sendMax,
    allowHighFee: params.allowHighFee,
  });
  const txid = await broadcastTx(params.network, built.txHex);
  // §1b: a broadcast changes our UTXO set and balances, so every cached
  // discovery response for this network is now potentially stale. Invalidate so
  // the post-send refresh re-fetches fresh rather than reusing pre-send data.
  invalidateScanCache(params.network);
  // The recipient-output value, exactly: inputs − fee − change covers normal
  // sends, sendMax sweeps, and the dust-fold alike.
  const sendRecorded = recordSend(params.network, txid, {
    recipient: params.recipient,
    amountSats: built.totalInputSats - built.feeSats - built.changeSats,
  });
  return { txid, sendRecorded };
}

// ---------------------------------------------------------------------------
// Speed-up (RBF fee bump)
// ---------------------------------------------------------------------------

/** The BIP125 signaling boundary: an input signals RBF iff sequence < this. */
const BIP125_NON_SIGNALING_MIN = 0xfffffffe;

/**
 * Everything the Speed-up sheet and the bump build need about one pending
 * payment, assembled by {@link prepareBump}. Carries no secrets.
 */
export interface PreparedBump {
  /** The pending transaction being replaced. */
  readonly txid: string;
  /** EXACTLY the original inputs, mapped to our derivation paths for signing. */
  readonly utxos: readonly WalletUtxo[];
  /** The original recipient address (reused verbatim in the replacement). */
  readonly recipient: string;
  /** The amount the original pays that recipient, in sats. */
  readonly recipientAmountSats: bigint;
  /** The original change address (ours), or null when the original has none. */
  readonly changeAddress: string | null;
  /** The fee the original pays, in sats. */
  readonly oldFeeSats: bigint;
  /** The original's actual vsize, in vBytes. */
  readonly oldVsize: number;
  /** The original's effective fee rate (display only), in sat/vB. */
  readonly oldRateSatVb: number;
}

/** An owned address's derivation info, keyed by address in the local map. */
interface OwnedAddressInfo {
  readonly path: string;
  readonly chain: 0 | 1;
}

/**
 * Builds the address → derivation-path map used to recognize our own inputs
 * and outputs — by LOCAL derivation only, zero network requests. Covers both
 * chains from index 0 through the account's high-water mark plus the full
 * BIP44 gap window, which by construction contains every address discovery
 * has ever marked used (any input/output of our own pending tx is used, so it
 * lies at or below the mark).
 */
function ownedAddressMap(network: Network, account: AccountSnapshot): Map<string, OwnedAddressInfo> {
  const mnemonic = getMnemonic();
  const map = new Map<string, OwnedAddressInfo>();
  const receiveCount = Math.max(account.receiveHighWater, -1) + 1 + FULL_GAP_LIMIT;
  const changeCount = Math.max(account.changeHighWater, -1) + 1 + FULL_GAP_LIMIT;
  for (const d of deriveAddressRange(mnemonic, network, 0, 0, receiveCount)) {
    map.set(d.address, { path: d.path, chain: 0 });
  }
  for (const d of deriveAddressRange(mnemonic, network, 1, 0, changeCount)) {
    map.set(d.address, { path: d.path, chain: 1 });
  }
  return map;
}

/** One classified output of the transaction being bumped. */
interface ClassifiedVout {
  readonly value: bigint;
  readonly address: string;
  readonly owned: OwnedAddressInfo | undefined;
}

/**
 * Splits the original's outputs into (recipient, change) — the shape contract
 * this wallet's own builder guarantees: exactly one recipient plus at most one
 * change output.
 *
 * Classification rules (each violation → {@link CannotBumpError}
 * `unsupported-shape`, an honest dead-end — never a guess):
 * - every output must carry an address (we never build OP_RETURN-style outputs);
 * - at most 2 outputs, at most 1 of them foreign;
 * - 1 foreign output → it is the recipient; the remaining (ours) is change —
 *   whichever chain it is on: it is our money either way, and treating it as
 *   change (where the fee increase lands) can only move value between our own
 *   pocket and the fee, never to a third party;
 * - 0 foreign outputs (a self-send): the RECEIVE-chain output is the
 *   recipient — Receive only ever shows chain-0 addresses, so that is the
 *   output the user asked for — and the change-chain output is change. A
 *   single all-ours output is simply the recipient (self-sweep). Anything
 *   else (two same-chain outputs) is ambiguous → unsupported.
 */
function classifyBumpOutputs(
  vouts: readonly ApiTxVout[],
  owned: Map<string, OwnedAddressInfo>,
): { recipient: ClassifiedVout; change: ClassifiedVout | null } {
  if (vouts.length === 0 || vouts.length > 2) {
    throw new CannotBumpError('unsupported-shape', 'Not a transaction shape this wallet builds');
  }
  const classified: ClassifiedVout[] = vouts.map((o) => {
    if (o.address === undefined) {
      throw new CannotBumpError('unsupported-shape', 'Transaction has an output without an address');
    }
    return { value: o.value, address: o.address, owned: owned.get(o.address) };
  });

  const foreign = classified.filter((c) => c.owned === undefined);
  if (foreign.length > 1) {
    throw new CannotBumpError('unsupported-shape', 'Transaction pays more than one recipient');
  }

  if (foreign.length === 1) {
    const recipient = foreign[0];
    const change = classified.find((c) => c.owned !== undefined) ?? null;
    if (recipient === undefined) {
      throw new CannotBumpError('unsupported-shape', 'Could not identify the recipient output');
    }
    return { recipient, change };
  }

  // Self-send: every output is ours.
  const only = classified.length === 1 ? classified[0] : undefined;
  if (only !== undefined) {
    return { recipient: only, change: null };
  }
  const chain0 = classified.filter((c) => c.owned?.chain === 0);
  const chain1 = classified.filter((c) => c.owned?.chain === 1);
  const recipient = chain0.length === 1 ? chain0[0] : undefined;
  const change = chain1.length === 1 ? chain1[0] : undefined;
  if (recipient === undefined || change === undefined) {
    throw new CannotBumpError('unsupported-shape', 'Ambiguous self-send output shape');
  }
  return { recipient, change };
}

/**
 * Gathers everything needed to speed up (fee-bump) a pending payment. Costs
 * exactly ONE network request — `getTransaction` — plus local-only address
 * derivation (no bursts; the discovery budget discipline is untouched).
 *
 * Checks, in order (each failure → typed {@link CannotBumpError}):
 * 1. the payment is still unconfirmed (`confirmed`);
 * 2. EVERY input signals BIP125 (sequence < 0xfffffffe) (`not-signaling`) —
 *    our own v1.1+ sends signal on all inputs, and only txs this wallet built
 *    are bumpable here;
 * 3. every input spends an address WE derive (both chains, index 0 through the
 *    high-water mark + gap — local derivation only) (`foreign-inputs`);
 * 4. the outputs match this wallet's own send shape (`unsupported-shape` —
 *    see {@link classifyBumpOutputs}, including the self-send rules);
 * 5. **F15 — the recipient is verified against the LOCAL send record** written
 *    at broadcast time (sendLog.ts). Inputs and change are provable ours by
 *    derivation, but the recipient is the one field of the fetched tx we
 *    cannot derive — without this check a hostile chain API could substitute
 *    an attacker's address and the bump would sign the full amount to it.
 *    Recorded recipient AND amount must match the classified recipient output
 *    exactly; a mismatch is `recipient-mismatch` (hard fail, no override
 *    anywhere). No record at all is `unverified` — an honest dead-end, and a
 *    legitimate one: only v1.1+ sends signal RBF, and v1.1 ships WITH this
 *    record-keeping, so every bumpable payment made by this app has a record.
 *    "No record" therefore means the wallet was restored from its 12 words on
 *    a new device (records don't travel) — never a silent bypass.
 *
 * @throws {CannotBumpError} Per the checks above.
 * @throws {ApiResponseError | ApiNetworkError} From the single fetch.
 */
export async function prepareBump(
  network: Network,
  txidToBump: string,
  account: AccountSnapshot,
  signal?: AbortSignal,
): Promise<PreparedBump> {
  const tx = await getTransaction(network, txidToBump, signal);

  if (tx.confirmed) {
    throw new CannotBumpError('confirmed', 'The payment has already confirmed');
  }
  for (const vin of tx.vin) {
    if (vin.sequence >= BIP125_NON_SIGNALING_MIN) {
      throw new CannotBumpError('not-signaling', 'An input does not signal BIP125 replaceability');
    }
  }

  const owned = ownedAddressMap(network, account);

  const utxos: WalletUtxo[] = tx.vin.map((vin) => {
    const address = vin.prevout?.address;
    const info = address !== undefined ? owned.get(address) : undefined;
    if (vin.prevout === undefined || address === undefined || info === undefined) {
      throw new CannotBumpError('foreign-inputs', 'An input does not belong to this wallet');
    }
    return {
      txid: vin.txid,
      vout: vin.vout,
      value: vin.prevout.value,
      path: info.path,
      address,
    };
  });

  const { recipient, change } = classifyBumpOutputs(tx.vout, owned);

  // F15: the recipient must be what THIS wallet originally broadcast — see the
  // doc comment (check 5). Both sides are normalized (bech32 is
  // case-insensitive; the record stores the canonical form) and the amount
  // must match to the satoshi.
  const record = getSendRecord(network, txidToBump);
  if (record === null) {
    throw new CannotBumpError(
      'unverified',
      'No local send record for this payment on this device',
    );
  }
  if (
    normalizeRecipientAddress(record.recipient) !== normalizeRecipientAddress(recipient.address) ||
    record.amountSats !== recipient.value
  ) {
    throw new CannotBumpError(
      'recipient-mismatch',
      "The reported recipient does not match this wallet's local record of the payment",
    );
  }

  return {
    txid: tx.txid,
    utxos,
    recipient: recipient.address,
    recipientAmountSats: recipient.value,
    changeAddress: change?.address ?? null,
    oldFeeSats: tx.feeSats,
    oldVsize: tx.vsize,
    oldRateSatVb: Number(tx.feeSats) / tx.vsize,
  };
}

/**
 * Builds, signs, and broadcasts the replacement for a prepared bump. Reads the
 * mnemonic at call time; never returns it.
 *
 * Idempotency: `buildRbfBumpTx` over the same prepared data + rate yields the
 * identical signed replacement (RFC6979 deterministic signatures), and
 * mempool.space treats a re-broadcast of an already-accepted tx as success —
 * so a retry cannot double-spend (and rewrites an identical record).
 * `allowHighFee` bypasses only the 25% consent rule, never the hard
 * rate/absolute caps (F10).
 *
 * F15: the replacement gets its OWN send record under the returned txid — the
 * recipient comes from `prepared`, which `prepareBump` verified against the
 * ORIGINAL's record, and the amount is the replacement's actual
 * recipient-output value (possibly reduced, for a sweep). A bump of a bump
 * therefore verifies against the replacement's own record, keeping the chain
 * of trust unbroken back to the user's original confirmation.
 */
export async function bumpAndBroadcast(params: {
  network: Network;
  prepared: PreparedBump;
  feeRateSatVb: number;
  allowHighFee: boolean;
}): Promise<BroadcastResult> {
  const mnemonic = getMnemonic();
  const built = buildRbfBumpTx({
    mnemonic,
    network: params.network,
    utxos: params.prepared.utxos,
    recipient: params.prepared.recipient,
    recipientAmountSats: params.prepared.recipientAmountSats,
    changeAddress: params.prepared.changeAddress,
    oldFeeSats: params.prepared.oldFeeSats,
    oldVsize: params.prepared.oldVsize,
    feeRateSatVb: params.feeRateSatVb,
    allowHighFee: params.allowHighFee,
  });
  const txid = await broadcastTx(params.network, built.txHex);
  // §1b: same as signAndBroadcast — a broadcast (here, the replacement) moves
  // our chain state, so drop the stale cached responses for this network.
  invalidateScanCache(params.network);
  const sendRecorded = recordSend(params.network, txid, {
    recipient: params.prepared.recipient,
    // The replacement's actual recipient-output value (inputs − fee − change):
    // unchanged when change absorbs the bump, reduced for a sweep.
    amountSats: built.totalInputSats - built.feeSats - built.changeSats,
  });
  return { txid, sendRecorded };
}
