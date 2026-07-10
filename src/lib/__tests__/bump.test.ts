/**
 * bump.test.ts — RBF fee-bump engine (Phase B: the Speed-up flow).
 *
 * Covers, against REAL originals built by buildAndSignTx (so oldFee/oldVsize
 * are exactly what the chain API would report for our own transaction):
 *  - the BIP125 economics floors (incremental-relay delta + strictly-greater
 *    effective rate), including the raise-and-report behavior;
 *  - dust-folding of a change output squeezed sub-dust by the increase;
 *  - the reduces-recipient path for no-change (sweep) originals;
 *  - the F1/F10 guards: hard rate cap, hard absolute cap, floors-past-ceiling,
 *    and the 25% consent rule with allowHighFee semantics;
 *  - CannotBumpError('insufficient-change') dead-ends;
 *  - byte-level verification (a self-contained wire parser, independent of the
 *    library that built the tx): the replacement spends EXACTLY the original
 *    outpoints, every input re-signals RBF_SEQUENCE, and output values match
 *    the estimate;
 *  - the F11 property: estimateBumpFee === buildRbfBumpTx across a rate sweep
 *    crossing the dust-fold boundary.
 */
import { describe, it, expect } from 'vitest';
import { hex } from '@scure/base';
import {
  buildAndSignTx,
  buildRbfBumpTx,
  estimateBumpFee,
  scriptForAddress,
  CannotBumpError,
  FeeTooHighError,
  InvalidTxParamsError,
  DUST_LIMIT_SATS,
  INCREMENTAL_RELAY_SAT_VB,
  MAX_FEE_RATE_SAT_VB,
  RBF_SEQUENCE,
  type BuiltTx,
  type WalletUtxo,
} from '../tx';
import { deriveReceiveAddress } from '../wallet';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const addr1 = deriveReceiveAddress(ABANDON, 'mainnet', 1);
// Recipient/change addresses: validity is what matters to the engine (the
// engine never classifies ownership — that is the actions layer's job).
const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address;

// --- Self-contained wire parser (independent of @scure/btc-signer) ----------

/** Reads a Bitcoin varint from `view` at byte offset `o`. */
function readVarint(view: DataView, o: number): { value: number; next: number } {
  const first = view.getUint8(o);
  if (first < 0xfd) return { value: first, next: o + 1 };
  if (first === 0xfd) return { value: view.getUint16(o + 1, true), next: o + 3 };
  if (first === 0xfe) return { value: view.getUint32(o + 1, true), next: o + 5 };
  throw new Error('varint too large for this test parser');
}

interface ParsedInput {
  readonly txid: string; // display order (big-endian hex)
  readonly vout: number;
  readonly sequence: number;
}
interface ParsedOutput {
  readonly value: bigint;
  readonly scriptHex: string;
}

/**
 * Parses the RAW wire bytes of a serialized signed transaction: every input's
 * outpoint + nSequence and every output's value + script. Walks the byte
 * stream itself, so assertions on its result prove what actually lands in the
 * final signed tx — not what an input object claimed.
 */
function parseTx(txHex: string): { inputs: ParsedInput[]; outputs: ParsedOutput[] } {
  const b = hex.decode(txHex);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 4; // version
  if (view.getUint8(o) === 0x00 && view.getUint8(o + 1) === 0x01) o += 2; // segwit marker+flag
  const inCount = readVarint(view, o);
  o = inCount.next;
  const inputs: ParsedInput[] = [];
  for (let i = 0; i < inCount.value; i++) {
    const txidLe = b.slice(o, o + 32);
    o += 32;
    const txid = hex.encode(Uint8Array.from(txidLe).reverse());
    const vout = view.getUint32(o, true);
    o += 4;
    const scriptSig = readVarint(view, o);
    o = scriptSig.next + scriptSig.value;
    const sequence = view.getUint32(o, true);
    o += 4;
    inputs.push({ txid, vout, sequence });
  }
  const outCount = readVarint(view, o);
  o = outCount.next;
  const outputs: ParsedOutput[] = [];
  for (let i = 0; i < outCount.value; i++) {
    const value = view.getBigUint64(o, true);
    o += 8;
    const script = readVarint(view, o);
    const scriptHex = hex.encode(b.slice(script.next, script.next + script.value));
    o = script.next + script.value;
    outputs.push({ value, scriptHex });
  }
  return { inputs, outputs };
}

const RECIPIENT_SCRIPT = hex.encode(scriptForAddress(RECIPIENT, 'mainnet'));
const CHANGE_SCRIPT = hex.encode(scriptForAddress(CHANGE, 'mainnet'));

// --- Fixture originals (real fee/vsize, exactly as the API would report) ----

function utxo(id: string, value: bigint): WalletUtxo {
  return { txid: id.repeat(64), vout: 0, value, path: addr0.path, address: addr0.address };
}

/** Builds a real 1-in/2-out original: `value` in, `amount` to RECIPIENT at `rate`. */
function buildChangeOriginal(value: bigint, amount: bigint, rate: number): BuiltTx & { utxos: WalletUtxo[] } {
  const utxos = [utxo('a', value)];
  const built = buildAndSignTx({
    mnemonic: ABANDON,
    network: 'mainnet',
    utxos,
    recipient: RECIPIENT,
    amountSats: amount,
    feeRateSatVb: rate,
    changeAddress: CHANGE,
  });
  expect(built.changeSats).toBeGreaterThan(0n); // fixture sanity: it HAS change
  return { ...built, utxos };
}

/** Common bump-estimate params for a change-carrying original. */
function bumpParamsFor(orig: BuiltTx & { utxos: WalletUtxo[] }, amount: bigint, rate: number) {
  return {
    utxos: orig.utxos,
    recipientAmountSats: amount,
    hasChangeOutput: true,
    oldFeeSats: orig.feeSats,
    oldVsize: orig.vsize,
    feeRateSatVb: rate,
  };
}

describe('estimateBumpFee — BIP125 economics floors', () => {
  it('raises the fee to the incremental-relay floor when the requested rate is too low, and reports it', () => {
    const orig = buildChangeOriginal(100_000n, 60_000n, 10);
    // Re-request the SAME rate the original paid: the target fee alone cannot
    // clear BIP125 rule 4, so the estimate must raise to oldFee + 1 sat/vB ×
    // newVsize — never describe a replacement relays would reject.
    const est = estimateBumpFee(bumpParamsFor(orig, 60_000n, 10));
    expect(est.newFeeSats).toBe(orig.feeSats + BigInt(orig.vsize * INCREMENTAL_RELAY_SAT_VB));
    expect(est.rateWasRaised).toBe(true);
    // The raised fee clears both floors.
    expect(est.newFeeSats - est.oldFeeSats).toBeGreaterThanOrEqual(BigInt(est.newVsize));
    expect(est.effectiveRateSatVb).toBeGreaterThan(Number(orig.feeSats) / orig.vsize);
  });

  it('raises above a requested rate BELOW the original rate (strictly-greater effective rate)', () => {
    const orig = buildChangeOriginal(100_000n, 60_000n, 10);
    const est = estimateBumpFee(bumpParamsFor(orig, 60_000n, 1));
    expect(est.rateWasRaised).toBe(true);
    expect(est.effectiveRateSatVb).toBeGreaterThan(Number(orig.feeSats) / orig.vsize);
    expect(est.newFeeSats).toBeGreaterThanOrEqual(
      orig.feeSats + BigInt(est.newVsize * INCREMENTAL_RELAY_SAT_VB),
    );
  });

  it('honours a requested rate that clears the floors; the increase comes out of change', () => {
    const orig = buildChangeOriginal(100_000n, 60_000n, 10);
    const est = estimateBumpFee(bumpParamsFor(orig, 60_000n, 30));
    // Target at 30 sat/vB over the ORIGINAL's actual vsize (same structure).
    expect(est.newFeeSats).toBe(BigInt(Math.ceil(orig.vsize * 30)));
    expect(est.rateWasRaised).toBe(false);
    expect(est.newVsize).toBe(orig.vsize);
    // Recipient untouched; change absorbs the entire increase.
    expect(est.newRecipientAmountSats).toBe(60_000n);
    expect(est.reducesRecipientBy).toBe(0n);
    expect(est.hasChange).toBe(true);
    expect(est.newChangeSats).toBe(100_000n - 60_000n - est.newFeeSats);
    expect(est.newChangeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    expect(est.extraFeeSats).toBe(est.newFeeSats - orig.feeSats);
    expect(est.needsHighFeeConsent).toBe(false);
    expect(est.exceedsRateCeiling).toBe(false);
  });

  it('folds change squeezed below dust into the fee (no dust output, recipient untouched)', () => {
    // 100k in, 93k to recipient at 10 sat/vB → change ≈ 5,590. A 48 sat/vB
    // bump wants ~6.7k fee, leaving sub-dust change → fold.
    const orig = buildChangeOriginal(100_000n, 93_000n, 10);
    const est = estimateBumpFee(bumpParamsFor(orig, 93_000n, 48));
    expect(est.hasChange).toBe(false);
    expect(est.newChangeSats).toBe(0n);
    // Folded fee = everything left after paying the recipient in full.
    expect(est.newFeeSats).toBe(100_000n - 93_000n);
    expect(est.newRecipientAmountSats).toBe(93_000n);
    expect(est.reducesRecipientBy).toBe(0n);
    // The replacement dropped one P2WPKH output.
    expect(est.newVsize).toBe(orig.vsize - 31);
  });

  it("throws CannotBumpError('insufficient-change') when change cannot absorb the increase (never touches the recipient)", () => {
    // Change ≈ 5,590; a 60 sat/vB bump needs ~8.4k — more than change + old fee.
    const orig = buildChangeOriginal(20_000n, 13_000n, 10);
    const err = (() => {
      try {
        estimateBumpFee(bumpParamsFor(orig, 13_000n, 60));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CannotBumpError);
    expect((err as CannotBumpError).reason).toBe('insufficient-change');
  });
});

describe('estimateBumpFee — no-change (sweep) originals reduce the recipient amount', () => {
  function buildSweepOriginal(values: bigint[], rate: number): BuiltTx & { utxos: WalletUtxo[]; amount: bigint } {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const utxos = values.map((v, i) => ({
      txid: (ids[i] ?? '0').repeat(64),
      vout: i,
      value: v,
      path: i % 2 === 0 ? addr0.path : addr1.path,
      address: i % 2 === 0 ? addr0.address : addr1.address,
    }));
    const built = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos,
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: rate,
      changeAddress: CHANGE,
      sendMax: true,
    });
    expect(built.changeSats).toBe(0n);
    return { ...built, utxos, amount: built.totalInputSats - built.feeSats };
  }

  it('reports reducesRecipientBy = extra fee, and the exact new recipient amount', () => {
    const orig = buildSweepOriginal([100_000n, 50_000n], 5);
    const est = estimateBumpFee({
      utxos: orig.utxos,
      recipientAmountSats: orig.amount,
      hasChangeOutput: false,
      oldFeeSats: orig.feeSats,
      oldVsize: orig.vsize,
      feeRateSatVb: 20,
    });
    expect(est.newFeeSats).toBe(BigInt(Math.ceil(orig.vsize * 20)));
    expect(est.hasChange).toBe(false);
    expect(est.newRecipientAmountSats).toBe(150_000n - est.newFeeSats);
    expect(est.reducesRecipientBy).toBe(est.newFeeSats - orig.feeSats);
    expect(est.reducesRecipientBy).toBeGreaterThan(0n);
    // Sweep consent semantics: compared against total input (well under 25% here).
    expect(est.needsHighFeeConsent).toBe(false);
  });

  it("throws CannotBumpError('insufficient-change') when the bump would push the swept amount below dust", () => {
    const orig = buildSweepOriginal([2_000n], 1);
    const err = (() => {
      try {
        estimateBumpFee({
          utxos: orig.utxos,
          recipientAmountSats: orig.amount,
          hasChangeOutput: false,
          oldFeeSats: orig.feeSats,
          oldVsize: orig.vsize,
          feeRateSatVb: 30,
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CannotBumpError);
    expect((err as CannotBumpError).reason).toBe('insufficient-change');
  });
});

describe('estimateBumpFee — parameter validation (reconciliation)', () => {
  const utxos = [utxo('a', 100_000n)];

  it('rejects params that do not reconcile (inputs ≠ amount + change + fee)', () => {
    // Claims no change, but 100k − 60k − 1410 leaves 38,590 unexplained.
    expect(() =>
      estimateBumpFee({
        utxos,
        recipientAmountSats: 60_000n,
        hasChangeOutput: false,
        oldFeeSats: 1_410n,
        oldVsize: 141,
        feeRateSatVb: 20,
      }),
    ).toThrow(InvalidTxParamsError);
    // Claims MORE than the inputs contained.
    expect(() =>
      estimateBumpFee({
        utxos,
        recipientAmountSats: 99_000n,
        hasChangeOutput: true,
        oldFeeSats: 1_410n,
        oldVsize: 141,
        feeRateSatVb: 20,
      }),
    ).toThrow(InvalidTxParamsError);
  });

  it('rejects an implausible oldVsize, bad rates, and empty/invalid amounts', () => {
    const good = {
      utxos,
      recipientAmountSats: 60_000n,
      hasChangeOutput: true,
      oldFeeSats: 1_410n,
      oldVsize: 141,
      feeRateSatVb: 20,
    };
    expect(() => estimateBumpFee({ ...good, oldVsize: 50 })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, oldVsize: 200_000 })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, oldVsize: 141.5 })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, feeRateSatVb: 0 })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, feeRateSatVb: NaN })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, utxos: [] })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, recipientAmountSats: 0n })).toThrow(InvalidTxParamsError);
    expect(() => estimateBumpFee({ ...good, oldFeeSats: -1n })).toThrow(InvalidTxParamsError);
  });
});

describe('buildRbfBumpTx — fee guards (F1/F10, unchanged semantics)', () => {
  it('hard rate cap: a requested rate above the ceiling is rejected EVEN WITH allowHighFee', () => {
    const orig = buildChangeOriginal(100_000n, 60_000n, 10);
    expect(() =>
      buildRbfBumpTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: orig.utxos,
        recipient: RECIPIENT,
        recipientAmountSats: 60_000n,
        changeAddress: CHANGE,
        oldFeeSats: orig.feeSats,
        oldVsize: orig.vsize,
        feeRateSatVb: MAX_FEE_RATE_SAT_VB + 1,
        allowHighFee: true,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('hard absolute cap: a >1,000,000-sat replacement fee is rejected EVEN WITH allowHighFee', () => {
    // 30-input sweep: ~2,082 vB. At the max in-window rate (500) the bump fee
    // is ~1.04M sats — over the absolute ceiling, under the 25% rule (~0.35%
    // of 3 BTC), so only the absolute cap can fire. It must, despite consent.
    const utxos: WalletUtxo[] = [];
    for (let i = 0; i < 30; i++) {
      utxos.push({
        txid: i.toString(16).padStart(64, '0'),
        vout: 0,
        value: 10_000_000n,
        path: addr0.path,
        address: addr0.address,
      });
    }
    const orig = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos,
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 10,
      changeAddress: CHANGE,
      sendMax: true,
    });
    expect(() =>
      buildRbfBumpTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos,
        recipient: RECIPIENT,
        recipientAmountSats: orig.totalInputSats - orig.feeSats,
        changeAddress: null,
        oldFeeSats: orig.feeSats,
        oldVsize: orig.vsize,
        feeRateSatVb: 500,
        allowHighFee: true,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('hard floors-past-ceiling: an original already at the rate ceiling cannot be bumped, EVEN WITH allowHighFee', () => {
    // Synthetic original at exactly 500 sat/vB effective (141 vB, 70,500 sats
    // fee): any compliant replacement must exceed 500 sat/vB — hard dead-end.
    const utxos = [utxo('a', 100_000n)];
    const params = {
      utxos,
      recipientAmountSats: 20_000n,
      hasChangeOutput: true,
      oldFeeSats: 70_500n,
      oldVsize: 141,
      feeRateSatVb: 500,
    };
    const est = estimateBumpFee(params);
    expect(est.exceedsRateCeiling).toBe(true);
    expect(() =>
      buildRbfBumpTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos,
        recipient: RECIPIENT,
        recipientAmountSats: 20_000n,
        changeAddress: CHANGE,
        oldFeeSats: 70_500n,
        oldVsize: 141,
        feeRateSatVb: 500,
        allowHighFee: true,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('25% consent rule: blocked without allowHighFee, allowed with it — same semantics as sends', () => {
    // Small payment, plenty of change: a 40 sat/vB bump fee (~5.6k) dwarfs the
    // 10k amount → consent required, but the hard caps are not in play.
    const orig = buildChangeOriginal(100_000n, 10_000n, 10);
    const buildParams = {
      mnemonic: ABANDON,
      network: 'mainnet' as const,
      utxos: orig.utxos,
      recipient: RECIPIENT,
      recipientAmountSats: 10_000n,
      changeAddress: CHANGE,
      oldFeeSats: orig.feeSats,
      oldVsize: orig.vsize,
      feeRateSatVb: 40,
    };
    const est = estimateBumpFee(bumpParamsFor(orig, 10_000n, 40));
    expect(est.needsHighFeeConsent).toBe(true);
    expect(() => buildRbfBumpTx(buildParams)).toThrow(FeeTooHighError);
    const built = buildRbfBumpTx({ ...buildParams, allowHighFee: true });
    expect(built.feeSats).toBe(est.newFeeSats);
  });
});

describe('buildRbfBumpTx — byte-level replacement correctness', () => {
  it('spends EXACTLY the original outpoints, re-signals RBF on every input, and pays the estimated outputs', () => {
    const orig = buildChangeOriginal(100_000n, 60_000n, 10);
    const est = estimateBumpFee(bumpParamsFor(orig, 60_000n, 30));
    const built = buildRbfBumpTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: orig.utxos,
      recipient: RECIPIENT,
      recipientAmountSats: 60_000n,
      changeAddress: CHANGE,
      oldFeeSats: orig.feeSats,
      oldVsize: orig.vsize,
      feeRateSatVb: 30,
    });
    const parsed = parseTx(built.txHex);

    // Inputs: the identical outpoint set (BIP125 conflict set unchanged), each
    // re-signalling so the replacement can itself be sped up.
    expect(parsed.inputs).toHaveLength(orig.utxos.length);
    const wantOutpoints = new Set(orig.utxos.map((u) => `${u.txid}:${u.vout}`));
    const gotOutpoints = new Set(parsed.inputs.map((i) => `${i.txid}:${i.vout}`));
    expect(gotOutpoints).toEqual(wantOutpoints);
    for (const input of parsed.inputs) {
      expect(input.sequence).toBe(RBF_SEQUENCE);
    }

    // Outputs: same recipient script + amount; change carries the decrease.
    expect(parsed.outputs).toHaveLength(2);
    const recipientOut = parsed.outputs.find((o) => o.scriptHex === RECIPIENT_SCRIPT);
    const changeOut = parsed.outputs.find((o) => o.scriptHex === CHANGE_SCRIPT);
    expect(recipientOut?.value).toBe(est.newRecipientAmountSats);
    expect(changeOut?.value).toBe(est.newChangeSats);

    // Wire-level fee identity: inputs − outputs = the estimated fee.
    const outSum = parsed.outputs.reduce((s, o) => s + o.value, 0n);
    expect(100_000n - outSum).toBe(est.newFeeSats);
    expect(built.feeSats).toBe(est.newFeeSats);
  });

  it('reduces the recipient output in the sweep case — byte-verified', () => {
    const utxos = [utxo('a', 100_000n)];
    const orig = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos,
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 5,
      changeAddress: CHANGE,
      sendMax: true,
    });
    const amount = orig.totalInputSats - orig.feeSats;
    const est = estimateBumpFee({
      utxos,
      recipientAmountSats: amount,
      hasChangeOutput: false,
      oldFeeSats: orig.feeSats,
      oldVsize: orig.vsize,
      feeRateSatVb: 25,
    });
    const built = buildRbfBumpTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos,
      recipient: RECIPIENT,
      recipientAmountSats: amount,
      changeAddress: null,
      oldFeeSats: orig.feeSats,
      oldVsize: orig.vsize,
      feeRateSatVb: 25,
    });
    const parsed = parseTx(built.txHex);
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0]?.scriptHex).toBe(RECIPIENT_SCRIPT);
    expect(parsed.outputs[0]?.value).toBe(est.newRecipientAmountSats);
    expect(parsed.outputs[0]?.value).toBe(amount - est.reducesRecipientBy);
    expect(parsed.inputs[0]?.sequence).toBe(RBF_SEQUENCE);
  });
});

describe('estimateBumpFee === buildRbfBumpTx (F11 property, across the dust-fold boundary)', () => {
  it('the estimate IS the build, and the consent flag agrees with the unconsented build, at every rate', () => {
    // Original: 20k in, 13k out at 10 sat/vB (change ≈ 5,590). Sweeping the
    // bump rate walks: comfortable change → consent boundary (~31 sat/vB) →
    // dust-fold band (~46-49 sat/vB). Every step must agree exactly.
    const orig = buildChangeOriginal(20_000n, 13_000n, 10);
    const rates = [11, 15, 20, 25, 30, 31, 35, 40, 45, 46, 47, 48, 49];
    for (const rate of rates) {
      const est = estimateBumpFee(bumpParamsFor(orig, 13_000n, rate));
      const buildParams = {
        mnemonic: ABANDON,
        network: 'mainnet' as const,
        utxos: orig.utxos,
        recipient: RECIPIENT,
        recipientAmountSats: 13_000n,
        changeAddress: CHANGE,
        oldFeeSats: orig.feeSats,
        oldVsize: orig.vsize,
        feeRateSatVb: rate,
      };
      const built = buildRbfBumpTx({ ...buildParams, allowHighFee: true });

      // The estimate IS the build — fee, change, structure, byte-for-byte.
      expect(built.feeSats).toBe(est.newFeeSats);
      expect(built.changeSats).toBe(est.newChangeSats);
      const parsed = parseTx(built.txHex);
      expect(parsed.outputs).toHaveLength(est.hasChange ? 2 : 1);
      const recipientOut = parsed.outputs.find((o) => o.scriptHex === RECIPIENT_SCRIPT);
      expect(recipientOut?.value).toBe(est.newRecipientAmountSats);
      for (const input of parsed.inputs) expect(input.sequence).toBe(RBF_SEQUENCE);

      // BIP125 economics hold at every step.
      expect(est.newFeeSats).toBeGreaterThan(orig.feeSats);
      expect(est.newFeeSats - orig.feeSats).toBeGreaterThanOrEqual(
        BigInt(est.newVsize * INCREMENTAL_RELAY_SAT_VB),
      );
      expect(est.effectiveRateSatVb).toBeGreaterThan(Number(orig.feeSats) / orig.vsize);

      // Consent flag agrees exactly with the unconsented build's behavior.
      let threwConsent = false;
      try {
        buildRbfBumpTx(buildParams);
      } catch (e) {
        expect(e).toBeInstanceOf(FeeTooHighError);
        threwConsent = true;
      }
      expect(est.needsHighFeeConsent).toBe(threwConsent);
    }
  });
});
