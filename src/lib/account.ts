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
  getAddressStats(network: Network, address: string): Promise<AddressStats>;
  getUtxos(network: Network, address: string): Promise<ApiUtxo[]>;
  getAddressTxs(network: Network, address: string): Promise<AddressTx[]>;
}

/**
 * Derives one address for a chain + index. The caller closes over the (secret)
 * mnemonic so this module never touches it. Must be synchronous and pure.
 */
export type AddressDeriver = (chain: Chain, index: number) => DerivedAddress;

/** Tuning knobs for gap-limit discovery. Defaults match the DESIGN brief. */
export interface DiscoveryOptions {
  /** Consecutive never-used addresses that end a chain scan. Default 5. */
  readonly gapLimit: number;
  /** Hard cap on index scanned per chain, for speed/safety. Default 50. */
  readonly maxIndex: number;
  /** How many address lookups to run at once. Default 4. */
  readonly concurrency: number;
  /** Cap on merged activity items returned. Default 25. */
  readonly activityLimit: number;
}

/** Default discovery options per the DESIGN brief. */
export const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  gapLimit: 5,
  maxIndex: 50,
  concurrency: 4,
  activityLimit: 25,
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
  /** The next unused change (chain-1) address, for `buildAndSignTx`. */
  readonly changeAddress: string;
  /** Combined recent activity, newest first, deduped, capped. */
  readonly activity: readonly ActivityItem[];
  /** Every address discovered as used (either chain), for reference/debugging. */
  readonly usedAddresses: readonly string[];
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

/** Runs `worker` over `items` with at most `concurrency` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  async function runner(): Promise<void> {
    for (;;) {
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

/** A used address plus the metadata we gathered while scanning it. */
interface ScannedAddress {
  readonly derived: DerivedAddress;
  readonly stats: AddressStats;
}

/**
 * Scans one chain (receive or change) with a gap limit: derive addresses in
 * batches, look up each address's stats, and stop once `gapLimit` consecutive
 * never-used addresses are seen (or `maxIndex` is reached). Returns the used
 * addresses found, plus the index of the first unused address (THE next address).
 */
async function scanChain(
  network: Network,
  chain: Chain,
  derive: AddressDeriver,
  api: AccountApi,
  opts: DiscoveryOptions,
): Promise<{ used: ScannedAddress[]; nextUnusedIndex: number; nextUnusedAddress: string }> {
  const used: ScannedAddress[] = [];
  let consecutiveUnused = 0;
  let nextUnusedIndex = 0;
  let nextUnusedAddress = derive(chain, 0).address;
  let firstUnusedRecorded = false;

  let index = 0;
  while (index <= opts.maxIndex && consecutiveUnused < opts.gapLimit) {
    // Derive a batch, but never scan past maxIndex or past the gap.
    const remainingByGap = opts.gapLimit - consecutiveUnused;
    const remainingByCap = opts.maxIndex - index + 1;
    const batchSize = Math.max(1, Math.min(opts.concurrency, remainingByGap, remainingByCap));

    const batch: DerivedAddress[] = [];
    for (let k = 0; k < batchSize; k++) batch.push(derive(chain, index + k));

    const statsList = await mapWithConcurrency(batch, opts.concurrency, (d) =>
      api.getAddressStats(network, d.address),
    );

    for (let k = 0; k < batch.length; k++) {
      const derived = batch[k];
      const stats = statsList[k];
      if (derived === undefined || stats === undefined) continue;
      if (isUsed(stats)) {
        used.push({ derived, stats });
        consecutiveUnused = 0;
      } else {
        if (!firstUnusedRecorded) {
          nextUnusedIndex = index + k;
          nextUnusedAddress = derived.address;
          firstUnusedRecorded = true;
        }
        consecutiveUnused++;
        if (consecutiveUnused >= opts.gapLimit) break;
      }
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

  return { used, nextUnusedIndex, nextUnusedAddress };
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

  let receive: Awaited<ReturnType<typeof scanChain>>;
  let change: Awaited<ReturnType<typeof scanChain>>;
  try {
    // Chains are independent; scan them concurrently.
    [receive, change] = await Promise.all([
      scanChain(network, 0, derive, api, opts),
      scanChain(network, 1, derive, api, opts),
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

    const utxoLists = await mapWithConcurrency(usedDerived, opts.concurrency, (d) =>
      api.getUtxos(network, d.address),
    );
    utxos = collectUtxos(usedDerived, utxoLists);

    const txLists = await mapWithConcurrency(usedDerived, opts.concurrency, (d) =>
      api.getAddressTxs(network, d.address),
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
    changeAddress: change.nextUnusedAddress,
    activity,
    usedAddresses: usedScanned.map((s) => s.derived.address),
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
