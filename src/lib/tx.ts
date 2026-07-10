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
 * nSequence set on EVERY input we build, to opt into BIP125 opt-in
 * Replace-By-Fee. A transaction signals replaceability when at least one input
 * has `nSequence < 0xfffffffe` (equivalently `<= 0xfffffffd`); we set it
 * uniformly on all inputs so the signal is unambiguous.
 *
 * Value rationale — `0xfffffffd` is `MAX_BIP125_RBF_SEQUENCE` (Bitcoin Core):
 * the LARGEST sequence that still signals RBF. Picking the maximum keeps the two
 * other sequence-driven behaviours OFF, so this value signals RBF and nothing
 * else:
 * - Its high bit (`0x80000000`, the BIP68 "disable" flag) is set, so it enables
 *   NO relative timelock (BIP68/CSV) — the input stays immediately spendable.
 * - It encodes no absolute-locktime constraint (our txs use lockTime 0 anyway).
 *   (`0xffffffff` is "final" and does NOT signal RBF; `0xfffffffe` signals no
 *   RBF but is locktime-enabling — 0xfffffffd sits just below it.)
 *
 * Signalling RBF makes a stuck, under-priced payment rescuable by the Speed-up
 * (fee-bump) flow added in Phase B. nSequence is committed in the BIP143
 * witness-v0 sighash, so this value is authenticated by every input signature
 * and lands in the final signed tx. It does not change vsize (nSequence is
 * always 4 bytes), so fee estimates are unaffected.
 */
export const RBF_SEQUENCE = 0xfffffffd;

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

/**
 * The network's incremental relay feerate (sat/vB), used by the BIP125 rule: a
 * replacement must pay at least the original's absolute fee PLUS this rate
 * times the replacement's vsize, or relays drop it. Bitcoin Core's default
 * (`incrementalrelayfee`) is 1000 sat/kvB = 1 sat/vB.
 */
export const INCREMENTAL_RELAY_SAT_VB = 1;

/**
 * Plausibility window for the ORIGINAL transaction's vsize handed to the bump
 * builder (it originates from the untrusted API's `weight`). The smallest real
 * 1-input/1-output P2WPKH tx is ~110 vB; the largest standard-relay tx is
 * 100,000 vB (MAX_STANDARD_TX_WEIGHT / 4). A value outside this window is a
 * hostile/broken input, not a real transaction of ours. The direction of risk
 * is fail-safe either way: an understated vsize just yields a replacement
 * relays reject (no funds move), and an overstated one inflates the fee INTO
 * the F1/F10 guards, which reject it.
 */
const MIN_BUMP_OLD_VSIZE = 100;
const MAX_BUMP_OLD_VSIZE = 100_000;

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

/**
 * Machine-readable reasons a pending payment cannot be sped up (fee-bumped).
 * The UI maps each to honest plain-English copy — never a dead-end without one.
 * - `confirmed` — the payment already confirmed; nothing to speed up.
 * - `not-signaling` — an input does not signal BIP125 (sent before v1.1).
 * - `foreign-inputs` — an input isn't provably ours (not our derived address).
 * - `insufficient-change` — nothing left in the payment to raise the fee from
 *   (change can't absorb the increase / a sweep would push the recipient
 *   amount below dust).
 * - `unsupported-shape` — the transaction isn't a shape this wallet builds
 *   (multiple recipients, address-less outputs, ambiguous self-send).
 */
export type CannotBumpReason =
  | 'confirmed'
  | 'not-signaling'
  | 'foreign-inputs'
  | 'insufficient-change'
  | 'unsupported-shape';

/**
 * Thrown when a transaction cannot be replaced (sped up). Carries a
 * machine-readable {@link CannotBumpReason} so the UI can show the specific
 * honest explanation rather than a generic failure.
 */
export class CannotBumpError extends Error {
  /** Why the transaction cannot be bumped. */
  readonly reason: CannotBumpReason;
  constructor(reason: CannotBumpReason, message: string) {
    super(message);
    this.name = 'CannotBumpError';
    this.reason = reason;
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

/** The ceiling the {@link MAX_FEE_FRACTION} consent rule compares a fee against. */
function feeFractionCeiling(comparedTo: bigint): bigint {
  return (comparedTo * BigInt(Math.round(MAX_FEE_FRACTION * 1000))) / 1000n;
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
 * The result of a fee/selection dry run — the EXACT numbers
 * {@link buildAndSignTx} will use, because both consume the same selection code
 * path (F11: no parallel estimate that can drift from the build).
 */
export interface FeeSelection {
  /** The UTXOs the build will spend, in selection order. */
  readonly selected: readonly WalletUtxo[];
  /** Number of inputs selected. */
  readonly numInputs: number;
  /** Sum of the selected input values, in sats. */
  readonly totalInputSats: bigint;
  /** The exact fee the built tx will pay, in sats (dust-fold included). */
  readonly feeSats: bigint;
  /** Change returned to the wallet (0 when folded into the fee or sendMax). */
  readonly changeSats: bigint;
  /** Whether the built tx will carry a change output. */
  readonly hasChange: boolean;
  /** The amount that will actually reach the recipient, in sats. */
  readonly sendAmountSats: bigint;
  /**
   * True when this fee trips the {@link MAX_FEE_FRACTION} informed-consent
   * rule — i.e. {@link buildAndSignTx} will throw {@link FeeTooHighError}
   * unless `allowHighFee` is set. Computed here, by the same code the build
   * runs, so a compose-screen pre-check can never disagree with the build.
   */
  readonly needsHighFeeConsent: boolean;
}

/**
 * Dry-runs the engine's coin selection and fee computation for a prospective
 * send — including the sub-dust change fold and the sendMax sweep — WITHOUT
 * touching any key material. This is the single source of truth for "what fee
 * would this payment pay": {@link buildAndSignTx} consumes this same function,
 * so a compose-screen pre-check built on it is exact by construction (F11).
 *
 * @throws {InvalidTxParamsError} On a non-positive fee rate or amount.
 * @throws {InsufficientFundsError} When funds cannot cover amount + fee.
 */
export function estimateSendFee(params: {
  utxos: readonly WalletUtxo[];
  amountSats: bigint;
  feeRateSatVb: number;
  sendMax?: boolean;
}): FeeSelection {
  const { utxos, amountSats, feeRateSatVb } = params;
  const sendMax = params.sendMax ?? false;

  if (!(feeRateSatVb > 0) || !Number.isFinite(feeRateSatVb)) {
    throw new InvalidTxParamsError('feeRateSatVb must be a positive number');
  }
  if (utxos.length === 0) {
    throw new InsufficientFundsError(0n, sendMax ? 0n : amountSats);
  }
  if (!sendMax && amountSats <= 0n) {
    throw new InvalidTxParamsError('amountSats must be positive');
  }

  if (sendMax) {
    const selected = [...utxos];
    const totalInput = selected.reduce((sum, u) => sum + u.value, 0n);
    const feeSats = feeForVsize(estimateVsize(selected.length, 1), feeRateSatVb);
    const sendAmount = totalInput - feeSats;
    if (sendAmount < DUST_LIMIT_SATS) {
      throw new InsufficientFundsError(totalInput, feeSats + DUST_LIMIT_SATS);
    }
    return {
      selected,
      numInputs: selected.length,
      totalInputSats: totalInput,
      feeSats,
      changeSats: 0n,
      hasChange: false,
      sendAmountSats: sendAmount,
      needsHighFeeConsent: feeSats > feeFractionCeiling(totalInput),
    };
  }

  const sel = selectCoins(utxos, amountSats, feeRateSatVb);
  return {
    selected: sel.selected,
    numInputs: sel.selected.length,
    totalInputSats: sel.totalInput,
    feeSats: sel.feeSats,
    changeSats: sel.changeSats,
    hasChange: sel.hasChange,
    sendAmountSats: amountSats,
    needsHighFeeConsent: sel.feeSats > feeFractionCeiling(amountSats + sel.feeSats),
  };
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

  // The ONE selection/fee code path, shared with the compose pre-check (F11):
  // any fee this build pays — dust-fold included — is exactly what
  // estimateSendFee reported for the same inputs.
  const sel = estimateSendFee({ utxos, amountSats, feeRateSatVb, sendMax });
  const { feeSats, changeSats, hasChange } = sel;
  const selected = sel.selected;
  const totalInput = sel.totalInputSats;
  const sendAmount = sel.sendAmountSats;

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

  // Percentage rule — the ONLY guard allowHighFee bypasses (F10). The flag is
  // computed inside estimateSendFee so the compose pre-check and this build can
  // never disagree about whether consent is needed (F11).
  if (!allowHighFee && sel.needsHighFeeConsent) {
    throw new FeeTooHighError(
      `Fee ${feeSats} sats exceeds ${Math.round(MAX_FEE_FRACTION * 100)}% of the amount being sent`,
      feeSats,
      feeRateSatVb,
      comparedTo,
    );
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
      // BIP125 opt-in RBF: signal replaceability on every input (see RBF_SEQUENCE).
      sequence: RBF_SEQUENCE,
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

// ---------------------------------------------------------------------------
// RBF fee bump (Speed-up flow)
// ---------------------------------------------------------------------------

/** Parameters for {@link estimateBumpFee} — pure numbers, no keys/addresses. */
export interface BumpEstimateParams {
  /**
   * EXACTLY the original transaction's inputs, as wallet UTXOs (the actions
   * layer maps prevout addresses to derivation paths; the engine stays pure
   * and never fetches). The replacement spends the identical outpoint set —
   * v1 deliberately adds NO inputs, so the replacement's conflict set equals
   * the original's and the BIP125 complexity around introducing new
   * unconfirmed inputs (rule 2) never arises.
   */
  readonly utxos: readonly WalletUtxo[];
  /** The amount the ORIGINAL transaction pays its recipient, in sats. */
  readonly recipientAmountSats: bigint;
  /** Whether the original transaction carries a change output. */
  readonly hasChangeOutput: boolean;
  /** The fee the original transaction pays, in sats (from the chain API). */
  readonly oldFeeSats: bigint;
  /** The original transaction's actual vsize in vBytes (ceil(weight/4)). */
  readonly oldVsize: number;
  /** The requested new fee rate, in sat/vByte. */
  readonly feeRateSatVb: number;
}

/**
 * The full fee picture for a prospective RBF bump — the EXACT numbers
 * {@link buildRbfBumpTx} will use, because the build consumes this same
 * function (F11: one code path, no parallel computation that can drift).
 */
export interface BumpFeeEstimate {
  /** The absolute fee the replacement will pay, in sats (dust-fold included). */
  readonly newFeeSats: bigint;
  /** The original fee, echoed for display. */
  readonly oldFeeSats: bigint;
  /** What the bump costs on top of the original fee: new − old. */
  readonly extraFeeSats: bigint;
  /** The vsize (vB) the fee was computed for (replacement structure). */
  readonly newVsize: number;
  /** The replacement's effective rate: newFeeSats / newVsize (display only). */
  readonly effectiveRateSatVb: number;
  /** The rate the caller asked for, echoed for display. */
  readonly requestedRateSatVb: number;
  /**
   * True when the BIP125 floors (old fee + incremental relay, and
   * strictly-greater effective rate) raised the fee ABOVE what the requested
   * rate alone would pay. The estimate reports the raised values — the engine
   * never silently builds a replacement relays would reject.
   */
  readonly rateWasRaised: boolean;
  /** Whether the replacement carries a change output. */
  readonly hasChange: boolean;
  /** The replacement's change value, in sats (0 when no change output). */
  readonly newChangeSats: bigint;
  /** The amount the replacement pays the recipient, in sats. */
  readonly newRecipientAmountSats: bigint;
  /**
   * How much LESS the recipient receives than in the original, in sats.
   * Non-zero only for a no-change (sweep-style) original, where the fee
   * increase has nowhere to come from but the recipient amount — the UI must
   * collect explicit consent before building. 0 when change absorbs the fee.
   */
  readonly reducesRecipientBy: bigint;
  /** Sum of the input values, in sats. */
  readonly totalInputSats: bigint;
  /**
   * True when the new fee trips the {@link MAX_FEE_FRACTION} informed-consent
   * rule (same semantics as sends: compared against amount + fee, or total
   * input for a no-change sweep). {@link buildRbfBumpTx} throws
   * {@link FeeTooHighError} unless `allowHighFee` is set.
   */
  readonly needsHighFeeConsent: boolean;
  /**
   * True when the floors pushed the fee above what the HARD
   * {@link MAX_FEE_RATE_SAT_VB} ceiling permits for this size — i.e. the
   * original already pays at/near the emergency ceiling and a compliant
   * replacement cannot stay under it. {@link buildRbfBumpTx} rejects this
   * unconditionally (never bypassable via `allowHighFee`).
   */
  readonly exceedsRateCeiling: boolean;
}

/** The three BIP125-economics floors, combined: the minimum compliant fee. */
function bumpFeeFloor(
  newVsize: number,
  oldFeeSats: bigint,
  oldVsize: number,
  feeRateSatVb: number,
): bigint {
  // What the requested rate alone would pay for the replacement.
  const target = feeForVsize(newVsize, feeRateSatVb);
  // BIP125 rule 4: replacement fee ≥ original fee + incremental relay fee ×
  // replacement vsize, or relays drop it.
  const relayFloor = oldFeeSats + BigInt(newVsize * INCREMENTAL_RELAY_SAT_VB);
  // BIP125 rule 6 (in spirit): the replacement's effective rate must EXCEED
  // the original's. Smallest integer fee with newFee/newVsize > oldFee/oldVsize.
  const rateFloor = (oldFeeSats * BigInt(newVsize)) / BigInt(oldVsize) + 1n;
  let fee = target;
  if (relayFloor > fee) fee = relayFloor;
  if (rateFloor > fee) fee = rateFloor;
  return fee;
}

/**
 * Dry-runs the RBF bump fee computation for a pending payment — the single
 * source of truth for "what would speeding this payment up cost".
 * {@link buildRbfBumpTx} consumes this same function, so a sheet built on it is
 * exact by construction (F11).
 *
 * Replacement structure: the SAME inputs and the SAME recipient/amount as the
 * original. The fee increase comes out of the change output; when the original
 * has no change (a sweep), it comes out of the recipient amount instead and
 * `reducesRecipientBy` reports by how much. Change left sub-dust by the
 * increase is folded into the fee (same dust rule as {@link estimateSendFee}).
 *
 * If the requested rate does not clear the BIP125 floors (old fee +
 * {@link INCREMENTAL_RELAY_SAT_VB} × new vsize; strictly greater effective
 * rate), the fee is RAISED to the floor and reported (`rateWasRaised`) — this
 * function never describes a replacement relays would reject.
 *
 * @throws {InvalidTxParamsError} On non-positive rate/amount, an implausible
 *   `oldVsize`, or params that don't reconcile (inputs ≠ amount + change + fee).
 * @throws {CannotBumpError} reason `insufficient-change` when nothing in the
 *   payment can absorb any fee increase.
 */
export function estimateBumpFee(params: BumpEstimateParams): BumpFeeEstimate {
  const { utxos, recipientAmountSats, hasChangeOutput, oldFeeSats, oldVsize, feeRateSatVb } = params;

  if (!(feeRateSatVb > 0) || !Number.isFinite(feeRateSatVb)) {
    throw new InvalidTxParamsError('feeRateSatVb must be a positive number');
  }
  if (utxos.length === 0) {
    throw new InvalidTxParamsError('bump requires the original inputs');
  }
  if (recipientAmountSats <= 0n) {
    throw new InvalidTxParamsError('recipientAmountSats must be positive');
  }
  if (oldFeeSats < 0n) {
    throw new InvalidTxParamsError('oldFeeSats must be non-negative');
  }
  if (
    !Number.isInteger(oldVsize) ||
    oldVsize < MIN_BUMP_OLD_VSIZE ||
    oldVsize > MAX_BUMP_OLD_VSIZE
  ) {
    throw new InvalidTxParamsError('oldVsize outside the plausible transaction range');
  }

  const totalInput = utxos.reduce((sum, u) => sum + u.value, 0n);

  // Reconciliation: the caller's numbers must describe a real transaction —
  // inputs = recipient + change + fee exactly. Catches any mapping bug in the
  // layer above before it can reach fee math or signing.
  const oldChange = totalInput - recipientAmountSats - oldFeeSats;
  if (oldChange < 0n || (!hasChangeOutput && oldChange !== 0n)) {
    throw new InvalidTxParamsError('bump params do not reconcile (inputs ≠ amount + change + fee)');
  }

  const requestedRateSatVb = feeRateSatVb;

  if (hasChangeOutput) {
    // Fee increase comes out of the change output. Same structure as the
    // original (same inputs, recipient + change), so the replacement's vsize
    // is the original's actual vsize — exact even for non-P2WPKH recipients.
    const keepVsize = oldVsize;
    const fee = bumpFeeFloor(keepVsize, oldFeeSats, oldVsize, feeRateSatVb);
    const rateWasRaised = fee > feeForVsize(keepVsize, feeRateSatVb);
    // Hard-ceiling accounting happens on the PRE-fold fee, mirroring sends
    // (the F1 rate guard applies to the requested/floored fee; the dust-fold
    // slop below is bounded by DUST_LIMIT_SATS, exactly as in selectCoins).
    const exceedsRateCeiling = fee > feeForVsize(keepVsize, MAX_FEE_RATE_SAT_VB);

    const newChange = totalInput - recipientAmountSats - fee;
    if (newChange < 0n) {
      throw new CannotBumpError(
        'insufficient-change',
        'The change output cannot absorb the required fee increase',
      );
    }

    if (newChange >= DUST_LIMIT_SATS) {
      return {
        newFeeSats: fee,
        oldFeeSats,
        extraFeeSats: fee - oldFeeSats,
        newVsize: keepVsize,
        effectiveRateSatVb: Number(fee) / keepVsize,
        requestedRateSatVb,
        rateWasRaised,
        hasChange: true,
        newChangeSats: newChange,
        newRecipientAmountSats: recipientAmountSats,
        reducesRecipientBy: 0n,
        totalInputSats: totalInput,
        needsHighFeeConsent: fee > feeFractionCeiling(recipientAmountSats + fee),
        exceedsRateCeiling,
      };
    }

    // Sub-dust change: drop the change output and fold the residue into the
    // fee (dust rule as in selectCoins). The folded fee still clears every
    // floor for the SMALLER structure: foldedFee ≥ fee ≥ each floor at
    // keepVsize > the same floor at foldVsize (all three floors shrink with
    // vsize), so relays accept the replacement.
    const foldVsize = oldVsize - OUTPUT_VB;
    const foldedFee = totalInput - recipientAmountSats;
    return {
      newFeeSats: foldedFee,
      oldFeeSats,
      extraFeeSats: foldedFee - oldFeeSats,
      newVsize: foldVsize,
      effectiveRateSatVb: Number(foldedFee) / foldVsize,
      requestedRateSatVb,
      rateWasRaised,
      hasChange: false,
      newChangeSats: 0n,
      newRecipientAmountSats: recipientAmountSats,
      reducesRecipientBy: 0n,
      totalInputSats: totalInput,
      needsHighFeeConsent: foldedFee > feeFractionCeiling(recipientAmountSats + foldedFee),
      exceedsRateCeiling,
    };
  }

  // No change output (sweep-style original): the fee increase has nowhere to
  // come from but the recipient amount. Structure unchanged (same inputs, one
  // output), so the replacement's vsize is the original's actual vsize.
  const newVsize = oldVsize;
  const fee = bumpFeeFloor(newVsize, oldFeeSats, oldVsize, feeRateSatVb);
  const rateWasRaised = fee > feeForVsize(newVsize, feeRateSatVb);
  const exceedsRateCeiling = fee > feeForVsize(newVsize, MAX_FEE_RATE_SAT_VB);

  const newRecipientAmount = totalInput - fee;
  if (newRecipientAmount < DUST_LIMIT_SATS) {
    throw new CannotBumpError(
      'insufficient-change',
      'Raising the fee would push the swept amount below the dust limit',
    );
  }

  return {
    newFeeSats: fee,
    oldFeeSats,
    extraFeeSats: fee - oldFeeSats,
    newVsize,
    effectiveRateSatVb: Number(fee) / newVsize,
    requestedRateSatVb,
    rateWasRaised,
    hasChange: false,
    newChangeSats: 0n,
    newRecipientAmountSats: newRecipientAmount,
    reducesRecipientBy: recipientAmountSats - newRecipientAmount,
    totalInputSats: totalInput,
    // Sweep semantics, as in estimateSendFee: compare against the total input.
    needsHighFeeConsent: fee > feeFractionCeiling(totalInput),
    exceedsRateCeiling,
  };
}

/** Parameters for {@link buildRbfBumpTx}. */
export interface BuildBumpParams {
  /** The wallet mnemonic (secret; used only to derive signing keys, then dropped). */
  readonly mnemonic: string;
  /** The active network. */
  readonly network: Network;
  /** EXACTLY the original transaction's inputs (see {@link BumpEstimateParams.utxos}). */
  readonly utxos: readonly WalletUtxo[];
  /** The ORIGINAL transaction's recipient address (reused verbatim). */
  readonly recipient: string;
  /** The amount the original pays that recipient, in sats. */
  readonly recipientAmountSats: bigint;
  /**
   * The ORIGINAL transaction's change address (ours), or null when the
   * original carries no change output. Reused verbatim so the replacement's
   * outputs match the original's — only the amounts shift toward the fee.
   */
  readonly changeAddress: string | null;
  /** The fee the original pays, in sats. */
  readonly oldFeeSats: bigint;
  /** The original's actual vsize, in vBytes. */
  readonly oldVsize: number;
  /** The requested new fee rate, in sat/vByte. */
  readonly feeRateSatVb: number;
  /** Informed consent for the {@link MAX_FEE_FRACTION} rule ONLY (F10). */
  readonly allowHighFee?: boolean;
}

/**
 * Builds and signs a BIP125 replacement for a pending payment: the SAME inputs
 * (each re-signalling with {@link RBF_SEQUENCE}, so a bump can itself be
 * re-bumped) and the SAME recipient, with the fee raised per
 * {@link estimateBumpFee} — which this function CONSUMES, never re-derives, so
 * the sheet's numbers and the signed transaction cannot disagree (F11).
 *
 * All send-path fee guards apply unchanged:
 * - a requested rate above {@link MAX_FEE_RATE_SAT_VB} — HARD reject (F1/F10);
 * - a floored fee that cannot stay under that ceiling for this size
 *   (`exceedsRateCeiling`) — HARD reject;
 * - a fee above {@link MAX_FEE_ABSOLUTE_SATS} — HARD reject;
 * - the {@link MAX_FEE_FRACTION} consent rule — bypassable ONLY via
 *   `allowHighFee`, same semantics as sends.
 *
 * @throws {InvalidTxParamsError} On invalid/unreconcilable params.
 * @throws {CannotBumpError} When the payment has nothing to raise the fee from.
 * @throws {FeeTooHighError} Per the guards above.
 * @throws {InvalidRecipientError} On a bad or wrong-network recipient/change.
 */
export function buildRbfBumpTx(params: BuildBumpParams): BuiltTx {
  const { mnemonic, network, utxos, recipient, changeAddress } = params;
  const allowHighFee = params.allowHighFee ?? false;

  if (!(params.feeRateSatVb > 0) || !Number.isFinite(params.feeRateSatVb)) {
    throw new InvalidTxParamsError('feeRateSatVb must be a positive number');
  }
  // F1 hard rate ceiling — allowHighFee does NOT bypass (F10).
  if (params.feeRateSatVb > MAX_FEE_RATE_SAT_VB) {
    throw new FeeTooHighError(
      `Fee rate ${params.feeRateSatVb} sat/vB exceeds the ${MAX_FEE_RATE_SAT_VB} sat/vB safety limit`,
      0n,
      params.feeRateSatVb,
      0n,
    );
  }

  // Validate destination scripts up front (throws on wrong network/malformed).
  const recipientScript = scriptForAddress(recipient, network);
  const changeScript = changeAddress !== null ? scriptForAddress(changeAddress, network) : null;

  // The ONE bump code path (F11): the sheet's estimate and this build share it.
  const est = estimateBumpFee({
    utxos,
    recipientAmountSats: params.recipientAmountSats,
    hasChangeOutput: changeAddress !== null,
    oldFeeSats: params.oldFeeSats,
    oldVsize: params.oldVsize,
    feeRateSatVb: params.feeRateSatVb,
  });

  const comparedTo = est.hasChange ? est.newRecipientAmountSats + est.newFeeSats : est.totalInputSats;

  // HARD: the BIP125 floors cannot push the effective rate past the F1 ceiling.
  if (est.exceedsRateCeiling) {
    throw new FeeTooHighError(
      `A compliant replacement fee would exceed the ${MAX_FEE_RATE_SAT_VB} sat/vB safety limit`,
      est.newFeeSats,
      params.feeRateSatVb,
      comparedTo,
    );
  }
  // HARD absolute ceiling — allowHighFee does NOT bypass (F10).
  if (est.newFeeSats > MAX_FEE_ABSOLUTE_SATS) {
    throw new FeeTooHighError(
      `Fee ${est.newFeeSats} sats exceeds the absolute ${MAX_FEE_ABSOLUTE_SATS}-sat safety limit`,
      est.newFeeSats,
      params.feeRateSatVb,
      comparedTo,
    );
  }
  // Percentage rule — the ONLY guard allowHighFee bypasses (F10). Computed
  // inside estimateBumpFee so the sheet and this build can never disagree (F11).
  if (!allowHighFee && est.needsHighFeeConsent) {
    throw new FeeTooHighError(
      `Fee ${est.newFeeSats} sats exceeds ${Math.round(MAX_FEE_FRACTION * 100)}% of the amount being sent`,
      est.newFeeSats,
      params.feeRateSatVb,
      comparedTo,
    );
  }
  if (est.hasChange && changeScript === null) {
    // Unreachable by construction (hasChange requires hasChangeOutput); kept
    // as a fail-closed invariant so a future refactor can't route change away.
    throw new InvalidTxParamsError('change output required but no change address provided');
  }

  const net = btcNetwork(network);
  const tx = new Transaction();

  for (const utxo of utxos) {
    const priv = derivePrivateKeyForPath(mnemonic, utxo.path);
    const pub = pubFromPriv(priv);
    const payment = p2wpkh(pub, net);
    if (!payment.script) {
      throw new InvalidTxParamsError('Failed to build input script');
    }
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.script, amount: utxo.value },
      // Re-signal BIP125 so the replacement can itself be sped up again.
      sequence: RBF_SEQUENCE,
    });
  }

  tx.addOutput({ script: recipientScript, amount: est.newRecipientAmountSats });
  if (est.hasChange && changeScript !== null) {
    tx.addOutput({ script: changeScript, amount: est.newChangeSats });
  }

  for (let i = 0; i < utxos.length; i++) {
    const utxo = utxos[i];
    if (!utxo) continue;
    const priv = derivePrivateKeyForPath(mnemonic, utxo.path);
    tx.signIdx(priv, i);
  }
  tx.finalize();

  return {
    txHex: tx.hex,
    txid: tx.id,
    feeSats: est.newFeeSats,
    vsize: tx.vsize,
    totalInputSats: est.totalInputSats,
    changeSats: est.newChangeSats,
  };
}

/** Derives the 33-byte compressed public key from a private key. */
function pubFromPriv(priv: Uint8Array): Uint8Array {
  return pubECDSA(priv, true);
}
