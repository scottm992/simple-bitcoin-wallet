/**
 * actions.ts — impure operations that touch the engine + network, kept out of
 * the pure reducer. These functions read the secret mnemonic from session.ts at
 * the moment of use and let it go out of scope; they never return it or store it.
 */
import {
  broadcastTx,
  buildAndSignTx,
  createScanCache,
  deriveAddress,
  discoverAccount,
  getAddressStats,
  getAddressTxs,
  getBtcUsdPrice,
  getCachedHighWater,
  getFeeEstimates,
  getUtxos,
  mapWithConcurrency,
  MAX_ACCEPTED_FEE_RATE,
  MIN_ACCEPTED_FEE_RATE,
  setCachedHighWater,
  setCachedReceiveIndex,
  type AccountSnapshot,
  type FeeEstimates,
  type Network,
  type WalletUtxo,
} from './lib';
import type { AddressDeriver } from './lib/account';
import { getMnemonic } from './session';
import type { FeeTier } from './state';

/** Gap window for the fast first-paint scan (phase 1 of a discovery run). */
const FAST_GAP_LIMIT = 5;

/** Gap window for the full correctness scan (phase 2; BIP44 standard, F8). */
const FULL_GAP_LIMIT = 20;

/** Overall deadline for one discovery run: the skeleton is NEVER open-ended. */
const DISCOVERY_DEADLINE_MS = 20_000;

/** Concurrency for the cheap poll's stats re-checks. */
const POLL_CONCURRENCY = 4;

/**
 * The concrete api object passed into discovery. We import the named functions
 * from the barrel and shape them into the AccountApi interface.
 */
const accountApi = {
  getAddressStats,
  getUtxos,
  getAddressTxs,
};

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
  /** Settles when the run is finished (full scan done, deadline hit, or error). */
  readonly done: Promise<void>;
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
 * The whole run is bounded by {@link DISCOVERY_DEADLINE_MS}: at the deadline it
 * settles deterministically — a completed phase-1 result stays on screen, and
 * with no result at all `onError` fires. The skeleton is never open-ended.
 */
export function startDiscovery(params: {
  network: Network;
  onSnapshot: (snapshot: AccountSnapshot) => void;
  onError: () => void;
  deadlineMs?: number;
}): DiscoveryHandle {
  const { network, onSnapshot, onError } = params;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), params.deadlineMs ?? DISCOVERY_DEADLINE_MS);
  let gotSnapshot = false;
  // An externally aborted (superseded) run must stay silent: the aborter owns
  // the UI state now. Only a deadline expiry / genuine failure with no result
  // may settle the UI to the error state.
  let externallyAborted = false;

  const done = (async () => {
    try {
      const derive = makeDeriver(network);
      const highWater = getCachedHighWater(network) ?? undefined;
      const cache = createScanCache();
      const shared = {
        ...(highWater !== undefined ? { highWater } : {}),
        signal: controller.signal,
        cache,
      };

      const fast = await discoverAccount(network, derive, accountApi, {
        ...shared,
        gapLimit: FAST_GAP_LIMIT,
      });
      gotSnapshot = true;
      persistScanMarks(network, fast);
      onSnapshot(fast);

      const full = await discoverAccount(network, derive, accountApi, {
        ...shared,
        gapLimit: FULL_GAP_LIMIT,
      });
      persistScanMarks(network, full);
      onSnapshot(full);
    } catch {
      // Deadline expiry or network failure. With a phase-1 result already on
      // screen we keep it; with nothing, settle to error so the UI never sits
      // on an open-ended skeleton. A superseded (externally aborted) run stays
      // silent — its replacement owns the UI state.
      if (!gotSnapshot && !externallyAborted) onError();
    } finally {
      clearTimeout(deadline);
    }
  })();

  return {
    done,
    abort: (): void => {
      externallyAborted = true;
      clearTimeout(deadline);
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
 * Single-flight coordinator for discovery + polling (Bug A):
 * - at most ONE full discovery run in flight; a new `refresh` aborts the old
 *   run and starts fresh (Try again / unlock / network switch semantics);
 * - `pollTick` is skipped entirely while a discovery or a previous poll is
 *   still running, so 30s ticks can never pile bursts on top of a slow crawl.
 *
 * Headless (no React) so the piling/skipping behavior is directly testable.
 */
export class DiscoveryController {
  private current: DiscoveryHandle | null = null;
  private pollBusy = false;

  /** True while a full discovery run is in flight. */
  get busy(): boolean {
    return this.current !== null;
  }

  /** Aborts any in-flight run and starts a fresh two-phase discovery. */
  refresh(params: {
    network: Network;
    onSnapshot: (snapshot: AccountSnapshot) => void;
    onError: () => void;
    deadlineMs?: number;
  }): void {
    this.current?.abort();
    const handle = startDiscovery(params);
    this.current = handle;
    void handle.done.finally(() => {
      if (this.current === handle) this.current = null;
    });
  }

  /**
   * One cheap poll tick. Skipped (zero requests) while a discovery run or a
   * previous poll is still in flight. On a detected change, `onChanged` fires —
   * the caller reacts by scheduling a full refresh.
   */
  pollTick(params: {
    network: Network;
    account: AccountSnapshot;
    onChanged: () => void;
  }): void {
    if (this.current !== null || this.pollBusy) return;
    this.pollBusy = true;
    void pollAccount(params.network, params.account)
      .then((changed) => {
        if (changed) params.onChanged();
      })
      .catch(() => {
        /* transient network failure — the next tick simply tries again */
      })
      .finally(() => {
        this.pollBusy = false;
      });
  }

  /** Aborts any in-flight discovery run (e.g. on lock / unmount). */
  abort(): void {
    this.current?.abort();
    this.current = null;
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
 * Signs and broadcasts a payment. Reads the mnemonic at call time, builds the
 * tx, broadcasts it, and returns the txid. The mnemonic is not returned.
 *
 * Idempotency: buildAndSignTx over the same UTXO set + params yields the same
 * signed tx, and mempool.space treats a re-broadcast of an already-accepted tx
 * as success (returns the same txid), so a retry cannot double-spend.
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
}): Promise<string> {
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
  return broadcastTx(params.network, built.txHex);
}
