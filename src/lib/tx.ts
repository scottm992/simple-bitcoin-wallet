/**
 * tx.ts — transaction construction and signing for P2WPKH (BIP84) wallets.
 *
 * Coin selection is intentionally simple and correct: sort UTXOs descending,
 * accumulate until amount + fee is covered, recomputing the fee as inputs are
 * added. Change below the dust threshold is folded into the fee rather than
 * creating an unspendable output.
 */
import { Transaction, p2wpkh, Address, OutScript } from '@scure/btc-signer';
import { pubECDSA } from '@scure/btc-signer/utils.js';
import { bech32, bech32m } from '@scure/base';
import { derivePrivateKeyForPath, btcNetwork } from './wallet';
import type { Network } from './wallet';

/** Dust threshold for P2WPKH outputs, in satoshis (Bitcoin Core policy). */
export const DUST_LIMIT_SATS = 546n;

/**
 * HARD ceiling on the fee rate (sat/vByte) the signer will accept. A sane rate
 * is ~1–50 sat/vB even in congestion; anything above this is treated as a
 * bad/hostile estimate and rejected unconditionally. NOT overridable via
 * {@link BuildTxParams.allowHighFee} (F10: the override is for legitimate small
 * sends, never for hostile rates).
 */
export const MAX_FEE_RATE_SAT_VB = 500;

/**
 * The largest share of the spent value the fee may consume before the build is
 * rejected (a guard against a fee that dwarfs the payment). For a Send Max this
 * is checked against the total input; for a normal send, against amount + fee.
 * This is the ONE guard {@link BuildTxParams.allowHighFee} can bypass: a small
 * send legitimately carries a proportionally large fee, so the UI collects an
 * informed confirmation at compose time and sets the flag (F10).
 */
export const MAX_FEE_FRACTION = 0.25;

/**
 * HARD absolute ceiling on the fee, in satoshis, applied independently of the
 * fraction guard so no build can quietly burn an unbounded amount. 1,000,000
 * sats (0.01 BTC) is far above any legitimate single-tx fee. NOT overridable
 * via {@link BuildTxParams.allowHighFee} (F10).
 */
export const MAX_FEE_ABSOLUTE_SATS = 1_000_000n;

/** Virtual-size constants (vBytes) used for fee estimation. */
const TX_OVERHEAD_VB = 11; // version + locktime + segwit marker/flag + counts (rounded up from 10.5)
const P2WPKH_INPUT_VB = 68; // per spending input
const OUTPUT_VB = 31; // per P2WPKH output (recipient / change)

/** A spendable UTXO owned by this wallet. */
export interface WalletUtxo {
  /** The funding transaction id (hex). */
  readonly txid: string;
  /** The output index within the funding transaction. */
  readonly vout: number;
  /** The value locked in this output, in satoshis. */
  readonly value: bigint;
  /** The BIP32 derivation path of the address that owns this UTXO. */
  readonly path: string;
  /** The address that owns this UTXO (P2WPKH, bech32). */
  readonly address: string;
}

/** Parameters for {@link buildAndSignTx}. */
export interface BuildTxParams {
  /** The wallet mnemonic (secret; used only to derive signing keys, then dropped). */
  readonly mnemonic: string;
  /** The active network. */
  readonly network: Network;
  /** The candidate UTXOs to spend from. */
  readonly utxos: readonly WalletUtxo[];
  /** The destination address (any valid on-network address type). */
  readonly recipient: string;
  /** The amount to send, in satoshis. Ignored when `sendMax` is true. */
  readonly amountSats: bigint;
  /** The fee rate in sat/vByte (must be > 0). */
  readonly feeRateSatVb: number;
  /** A change address owned by this wallet (P2WPKH). */
  readonly changeAddress: string;
  /** When true, sweep all UTXOs to the recipient with no change output. */
  readonly sendMax?: boolean;
  /**
   * Informed-consent opt-out of the {@link MAX_FEE_FRACTION} percentage rule
   * ONLY (F10) — for legitimate small sends where the fee is naturally a large
   * share of the amount. Set exclusively after the user has explicitly
   * confirmed the real fee numbers at compose time. The hard limits —
   * {@link MAX_FEE_RATE_SAT_VB} and {@link MAX_FEE_ABSOLUTE_SATS} — are NEVER
   * bypassed by this flag. Defaults to false.
   */
  readonly allowHighFee?: boolean;
}

/** The signed transaction and its accounting, returned by {@link buildAndSignTx}. */
export interface BuiltTx {
  /** The fully-signed, serialized transaction (hex). */
  readonly txHex: string;
  /** The transaction id (hex). */
  readonly txid: string;
  /** The fee paid, in satoshis. */
  readonly feeSats: bigint;
  /** The virtual size of the signed transaction, in vBytes. */
  readonly vsize: number;
  /** The sum of all selected input values, in satoshis. */
  readonly totalInputSats: bigint;
  /** The change returned to the wallet, in satoshis (0 when no change output). */
  readonly changeSats: bigint;
}

/** Thrown when the wallet's UTXOs cannot cover the requested amount + fee. */
export class InsufficientFundsError extends Error {
  /** Total spendable balance available, in satoshis. */
  readonly available: bigint;
  /** Amount + estimated fee required, in satoshis. */
  readonly required: bigint;
  constructor(available: bigint, required: bigint) {
    super(`Insufficient funds: need ${required} sats, have ${available} sats`);
    this.name = 'InsufficientFundsError';
    this.available = available;
    this.required = required;
  }
}

/** Thrown when the recipient address is invalid or belongs to the wrong network. */
export class InvalidRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecipientError';
  }
}

/** Thrown when transaction parameters are invalid (amount, fee rate, etc.). */
export class InvalidTxParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTxParamsError';
  }
}

/**
 * Thrown when the fee trips a sanity bound: the hard {@link MAX_FEE_RATE_SAT_VB}
 * rate cap or hard {@link MAX_FEE_ABSOLUTE_SATS} ceiling (never bypassable), or
 * the {@link MAX_FEE_FRACTION} percentage rule (bypassable only via an informed
 * {@link BuildTxParams.allowHighFee}). This is the engine-level backstop against
 * a bad/hostile fee estimate draining the wallet (F1/F10). Carries the numbers
 * so the UI can explain them.
 */
export class FeeTooHighError extends Error {
  /** The computed fee, in satoshis. */
  readonly feeSats: bigint;
  /** The fee rate used, in sat/vByte. */
  readonly feeRateSatVb: number;
  /** The amount the fee is being compared against (send amount or total input). */
  readonly comparedToSats: bigint;
  constructor(message: string, feeSats: bigint, feeRateSatVb: number, comparedToSats: bigint) {
    super(message);
    this.name = 'FeeTooHighError';
    this.feeSats = feeSats;
    this.feeRateSatVb = feeRateSatVb;
    this.comparedToSats = comparedToSats;
  }
}

/** The expected bech32 human-readable prefix for a network's native addresses. */
function bech32Hrp(network: Network): string {
  return network === 'mainnet' ? 'bc' : 'tb';
}

/**
 * Validates that `address` is a well-formed address for `network` and returns
 * its output script. Accepts bech32 (P2WPKH/P2WSH), bech32m (taproot), and
 * legacy base58 (P2PKH/P2SH) destinations. Rejects addresses whose bech32 HRP
 * does not match the active network (e.g. a `tb1…` address in mainnet mode).
 *
 * `@scure/btc-signer`'s `Address().decode` does not reliably reject a
 * cross-network bech32 HRP, so the HRP is checked explicitly here first.
 *
 * @param address - The candidate destination address.
 * @param network - The active network.
 * @returns The output script bytes for the address.
 * @throws {InvalidRecipientError} If the address is malformed or wrong-network.
 */
export function scriptForAddress(address: string, network: Network): Uint8Array {
  const trimmed = address.trim();
  if (trimmed === '') {
    throw new InvalidRecipientError('Recipient address is empty');
  }

  // Cross-network HRP guard for bech32/bech32m addresses.
  const lower = trimmed.toLowerCase();
  const looksBech32 = lower.startsWith('bc1') || lower.startsWith('tb1') || lower.startsWith('bcrt1');
  if (looksBech32) {
    const expectedHrp = bech32Hrp(network);
    let prefix: string | undefined;
    try {
      prefix = bech32.decode(lower as `${string}1${string}`, 200).prefix;
    } catch {
      try {
        prefix = bech32m.decode(lower as `${string}1${string}`, 200).prefix;
      } catch {
        throw new InvalidRecipientError('Malformed bech32 address');
      }
    }
    if (prefix !== expectedHrp) {
      throw new InvalidRecipientError(
        `Address is for the wrong network (expected ${expectedHrp}… for ${network})`,
      );
    }
  } else {
    // Legacy base58: version byte encodes the network. `Address().decode`
    // below rejects a wrong-network version byte via its checksum/prefix table.
  }

  try {
    const decoded = Address(btcNetwork(network)).decode(trimmed);
    if (!decoded) {
      throw new InvalidRecipientError('Invalid recipient address for this network');
    }
    return OutScript.encode(decoded);
  } catch (err) {
    if (err instanceof InvalidRecipientError) throw err;
    throw new InvalidRecipientError('Invalid recipient address for this network');
  }
}

/** Estimates the vsize of a tx with the given input/output counts. */
function estimateVsize(numInputs: number, numOutputs: number): number {
  return TX_OVERHEAD_VB + numInputs * P2WPKH_INPUT_VB + numOutputs * OUTPUT_VB;
}

/** Rounds a fee up to the next whole satoshi. */
function feeForVsize(vsize: number, feeRateSatVb: number): bigint {
  return BigInt(Math.ceil(vsize * feeRateSatVb));
}

/**
 * Estimates the fee (sats) for a P2WPKH tx with the given input/output counts
 * at a fee rate, using the same vsize math as coin selection. Exported so the
 * compose screen can pre-check the fee-vs-amount ratio with the SAME numbers
 * the engine will use, and warn the user before Review instead of hitting the
 * engine guard cold (F10).
 */
export function estimateFeeSats(numInputs: number, numOutputs: number, feeRateSatVb: number): bigint {
  return feeForVsize(estimateVsize(numInputs, numOutputs), feeRateSatVb);
}

/**
 * Selects UTXOs (largest first) to cover `amountSats` plus the fee, iterating
 * the fee estimate as inputs are added.
 * @returns The selected UTXOs, the total selected value, and the final fee for
 *   a transaction with one recipient output plus (optionally) a change output.
 */
function selectCoins(
  utxos: readonly WalletUtxo[],
  amountSats: bigint,
  feeRateSatVb: number,
): { selected: WalletUtxo[]; totalInput: bigint; hasChange: boolean; feeSats: bigint; changeSats: bigint } {
  const sorted = [...utxos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const totalAvailable = sorted.reduce((sum, u) => sum + u.value, 0n);

  const selected: WalletUtxo[] = [];
  let totalInput = 0n;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    // Fee assuming a change output exists (2 outputs).
    const feeWithChange = feeForVsize(estimateVsize(selected.length, 2), feeRateSatVb);
    // Fee assuming no change (1 output).
    const feeNoChange = feeForVsize(estimateVsize(selected.length, 1), feeRateSatVb);

    // Can we cover amount + fee if we DO produce change?
    if (totalInput >= amountSats + feeWithChange) {
      const change = totalInput - amountSats - feeWithChange;
      if (change >= DUST_LIMIT_SATS) {
        return { selected, totalInput, hasChange: true, feeSats: feeWithChange, changeSats: change };
      }
      // Change would be dust: drop the change output and fold the dust into fee.
      // Actual fee = inputs - amount (no change output). vsize is the no-change size.
      const foldedFee = totalInput - amountSats;
      return { selected, totalInput, hasChange: false, feeSats: foldedFee, changeSats: 0n };
    }

    // Or: exactly cover amount + fee with NO change output?
    if (totalInput >= amountSats + feeNoChange) {
      const foldedFee = totalInput - amountSats;
      return { selected, totalInput, hasChange: false, feeSats: foldedFee, changeSats: 0n };
    }
  }

  // Not enough: report available vs. required (fee for the full input set + change).
  const requiredFee = feeForVsize(estimateVsize(sorted.length, 2), feeRateSatVb);
  throw new InsufficientFundsError(totalAvailable, amountSats + requiredFee);
}

/**
 * Builds and signs a P2WPKH transaction from the wallet's UTXOs.
 *
 * Behaviour:
 * - Validates the recipient address for the active network.
 * - `sendMax`: spends all UTXOs, no change, amount = total − fee.
 * - Otherwise runs largest-first coin selection with fee iteration.
 * - Change below {@link DUST_LIMIT_SATS} is folded into the fee.
 *
 * @param params - See {@link BuildTxParams}.
 * @returns The signed transaction and its accounting ({@link BuiltTx}).
 * @throws {InvalidTxParamsError} On non-positive fee rate or amount.
 * @throws {FeeTooHighError} When the fee rate/absolute fee exceeds a HARD limit
 *   (never bypassable), or the fee exceeds the percentage rule without an
 *   informed `allowHighFee` (F1/F10).
 * @throws {InvalidRecipientError} On a bad or wrong-network recipient.
 * @throws {InsufficientFundsError} When funds cannot cover amount + fee.
 */
export function buildAndSignTx(params: BuildTxParams): BuiltTx {
  const { mnemonic, network, utxos, recipient, amountSats, feeRateSatVb, changeAddress } = params;
  const sendMax = params.sendMax ?? false;
  const allowHighFee = params.allowHighFee ?? false;

  if (!(feeRateSatVb > 0) || !Number.isFinite(feeRateSatVb)) {
    throw new InvalidTxParamsError('feeRateSatVb must be a positive number');
  }
  // F1 defence-in-depth (engine layer): reject an implausibly high fee RATE
  // before we ever build/sign, so a bad/hostile estimate can't drain funds.
  // HARD limit — allowHighFee does NOT bypass this (F10).
  if (feeRateSatVb > MAX_FEE_RATE_SAT_VB) {
    throw new FeeTooHighError(
      `Fee rate ${feeRateSatVb} sat/vB exceeds the ${MAX_FEE_RATE_SAT_VB} sat/vB safety limit`,
      0n,
      feeRateSatVb,
      0n,
    );
  }
  if (utxos.length === 0) {
    throw new InsufficientFundsError(0n, sendMax ? 0n : amountSats);
  }
  if (!sendMax && amountSats <= 0n) {
    throw new InvalidTxParamsError('amountSats must be positive');
  }

  // Validate recipient up front (throws on wrong network / malformed).
  const recipientScript = scriptForAddress(recipient, network);

  const net = btcNetwork(network);

  let selected: WalletUtxo[];
  let feeSats: bigint;
  let changeSats: bigint;
  let sendAmount: bigint;
  let hasChange: boolean;
  let totalInput: bigint;

  if (sendMax) {
    selected = [...utxos];
    totalInput = selected.reduce((sum, u) => sum + u.value, 0n);
    const vsize = estimateVsize(selected.length, 1); // single output, no change
    feeSats = feeForVsize(vsize, feeRateSatVb);
    sendAmount = totalInput - feeSats;
    if (sendAmount < DUST_LIMIT_SATS) {
      throw new InsufficientFundsError(totalInput, feeSats + DUST_LIMIT_SATS);
    }
    changeSats = 0n;
    hasChange = false;
  } else {
    const result = selectCoins(utxos, amountSats, feeRateSatVb);
    selected = result.selected;
    totalInput = result.totalInput;
    feeSats = result.feeSats;
    changeSats = result.changeSats;
    hasChange = result.hasChange;
    sendAmount = amountSats;
  }

  // F1 defence-in-depth (engine layer): even with an in-range rate, bound the
  // computed fee. For a Send Max there is no separate amount, so we compare
  // against the total input; for a normal send, against the value actually
  // leaving the wallet (amount + fee).
  const comparedTo = sendMax ? totalInput : sendAmount + feeSats;

  // HARD absolute ceiling — allowHighFee does NOT bypass this (F10).
  if (feeSats > MAX_FEE_ABSOLUTE_SATS) {
    throw new FeeTooHighError(
      `Fee ${feeSats} sats exceeds the absolute ${MAX_FEE_ABSOLUTE_SATS}-sat safety limit`,
      feeSats,
      feeRateSatVb,
      comparedTo,
    );
  }

  // Percentage rule — the ONLY guard allowHighFee bypasses (F10): a legitimate
  // small send naturally carries a proportionally large fee, and the UI collects
  // an explicit informed confirmation before setting the flag.
  if (!allowHighFee) {
    const fractionCeiling = (comparedTo * BigInt(Math.round(MAX_FEE_FRACTION * 1000))) / 1000n;
    if (feeSats > fractionCeiling) {
      throw new FeeTooHighError(
        `Fee ${feeSats} sats exceeds ${Math.round(MAX_FEE_FRACTION * 100)}% of the amount being sent`,
        feeSats,
        feeRateSatVb,
        comparedTo,
      );
    }
  }

  // Build the transaction. `allowUnknownOutputs` is false (default) so any
  // malformed script would throw — we already validated the recipient.
  const tx = new Transaction();

  for (const utxo of selected) {
    const priv = derivePrivateKeyForPath(mnemonic, utxo.path);
    // Re-derive the P2WPKH script from the private key's public key so the
    // witnessUtxo script is authoritative and matches what we will sign.
    const pub = pubFromPriv(priv);
    const payment = p2wpkh(pub, net);
    if (!payment.script) {
      throw new InvalidTxParamsError('Failed to build input script');
    }
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.script, amount: utxo.value },
    });
  }

  // Recipient output.
  tx.addOutput({ script: recipientScript, amount: sendAmount });

  // Change output (only when above dust).
  if (hasChange) {
    const changeScript = scriptForAddress(changeAddress, network);
    tx.addOutput({ script: changeScript, amount: changeSats });
  }

  // Sign every input, then finalize. Derive keys again per-input and let them
  // fall out of scope immediately after use.
  for (let i = 0; i < selected.length; i++) {
    const utxo = selected[i];
    if (!utxo) continue;
    const priv = derivePrivateKeyForPath(mnemonic, utxo.path);
    tx.signIdx(priv, i);
  }
  tx.finalize();

  return {
    txHex: tx.hex,
    txid: tx.id,
    feeSats,
    vsize: tx.vsize,
    totalInputSats: totalInput,
    changeSats,
  };
}

/** Derives the 33-byte compressed public key from a private key. */
function pubFromPriv(priv: Uint8Array): Uint8Array {
  return pubECDSA(priv, true);
}
