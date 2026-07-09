/**
 * actions.ts — impure operations that touch the engine + network, kept out of
 * the pure reducer. These functions read the secret mnemonic from session.ts at
 * the moment of use and let it go out of scope; they never return it or store it.
 */
import {
  broadcastTx,
  buildAndSignTx,
  deriveAddress,
  discoverAccount,
  getAddressStats,
  getAddressTxs,
  getBtcUsdPrice,
  getFeeEstimates,
  getUtxos,
  MAX_ACCEPTED_FEE_RATE,
  MIN_ACCEPTED_FEE_RATE,
  type AccountSnapshot,
  type FeeEstimates,
  type Network,
  type WalletUtxo,
} from './lib';
import type { AddressDeriver } from './lib/account';
import { getMnemonic } from './session';
import type { FeeTier } from './state';

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

/** Runs full account discovery for the active network. */
export async function loadAccount(network: Network): Promise<AccountSnapshot> {
  const derive = makeDeriver(network);
  return discoverAccount(network, derive, accountApi);
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
  });
  return broadcastTx(params.network, built.txHex);
}
