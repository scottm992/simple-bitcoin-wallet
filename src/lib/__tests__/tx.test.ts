import { describe, it, expect } from 'vitest';
import { hex } from '@scure/base';
import {
  buildAndSignTx,
  estimateSendFee,
  scriptForAddress,
  InsufficientFundsError,
  InvalidRecipientError,
  InvalidTxParamsError,
  FeeTooHighError,
  MAX_FEE_RATE_SAT_VB,
  DUST_LIMIT_SATS,
  RBF_SEQUENCE,
  type WalletUtxo,
} from '../tx';
import { deriveReceiveAddress } from '../wallet';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Two UTXOs owned by the abandon wallet's first two receive addresses.
const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const addr1 = deriveReceiveAddress(ABANDON, 'mainnet', 1);

function utxos(): WalletUtxo[] {
  return [
    { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
    { txid: 'b'.repeat(64), vout: 1, value: 50_000n, path: addr1.path, address: addr1.address },
  ];
}

// A valid mainnet recipient (the abandon change address — any valid addr works).
const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address;

describe('buildAndSignTx', () => {
  it('signs deterministically: stable txid, correct change and fee accounting', () => {
    const params = {
      mnemonic: ABANDON,
      network: 'mainnet' as const,
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 60_000n,
      feeRateSatVb: 10,
      changeAddress: CHANGE,
    };
    const a = buildAndSignTx(params);
    const b = buildAndSignTx(params);
    // Deterministic (RFC6979 ECDSA): same inputs → identical txid + hex.
    expect(a.txid).toBe(b.txid);
    expect(a.txHex).toBe(b.txHex);
    expect(a.txid).toHaveLength(64);

    // With a 60k send from a 100k UTXO, only one input is needed.
    expect(a.totalInputSats).toBe(100_000n);
    // Accounting identity: inputs = amount + change + fee.
    expect(a.totalInputSats).toBe(60_000n + a.changeSats + a.feeSats);
    expect(a.changeSats).toBeGreaterThan(DUST_LIMIT_SATS);

    // Fee ≈ vsize * rate. One input, two outputs ≈ 141 vB → ~1410 sats at 10 sat/vB.
    expect(a.feeSats).toBe(BigInt(Math.ceil(a.vsize * 10)));
    expect(a.vsize).toBeGreaterThan(100);
    expect(a.vsize).toBeLessThan(160);
  });

  it('sendMax spends everything with no change output', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 5,
      changeAddress: CHANGE,
      sendMax: true,
    });
    expect(res.changeSats).toBe(0n);
    expect(res.totalInputSats).toBe(150_000n);
    // amount sent = total − fee (fee folded fully into the single output).
    expect(res.feeSats).toBe(BigInt(Math.ceil(res.vsize * 5)));
  });

  it('folds dust-sized change into the fee (no dust output created)', () => {
    // Craft an amount so the leftover change would be below the dust limit.
    // One 100k input, 1-in/2-out fee at 1 sat/vB ≈ 141 sats. Aim change ≈ 100 sats.
    const single: WalletUtxo[] = [
      { txid: 'c'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
    ];
    // amount = 100000 - feeNoChange(1-in/1-out ~110vB=110) - 100  → change would be dust
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: single,
      recipient: RECIPIENT,
      amountSats: 99_800n,
      feeRateSatVb: 1,
      changeAddress: CHANGE,
    });
    // No change output → change folded into fee; fee = input − amount.
    expect(res.changeSats).toBe(0n);
    expect(res.feeSats).toBe(100_000n - 99_800n);
  });

  it('rejects a wrong-network recipient (testnet addr in mainnet mode)', () => {
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxos(),
        recipient: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        amountSats: 10_000n,
        feeRateSatVb: 5,
        changeAddress: CHANGE,
      }),
    ).toThrow(InvalidRecipientError);
  });

  it('throws InsufficientFundsError when funds cannot cover amount + fee', () => {
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxos(),
        recipient: RECIPIENT,
        amountSats: 1_000_000n,
        feeRateSatVb: 5,
        changeAddress: CHANGE,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it('throws on a non-positive fee rate and non-positive amount', () => {
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxos(),
        recipient: RECIPIENT,
        amountSats: 10_000n,
        feeRateSatVb: 0,
        changeAddress: CHANGE,
      }),
    ).toThrow(InvalidTxParamsError);
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxos(),
        recipient: RECIPIENT,
        amountSats: 0n,
        feeRateSatVb: 5,
        changeAddress: CHANGE,
      }),
    ).toThrow(InvalidTxParamsError);
  });

  it('accumulates multiple inputs when one UTXO is not enough', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 120_000n, // needs both the 100k and 50k inputs
      feeRateSatVb: 2,
      changeAddress: CHANGE,
    });
    expect(res.totalInputSats).toBe(150_000n);
    expect(res.totalInputSats).toBe(120_000n + res.changeSats + res.feeSats);
  });
});

// --- F1: fee sanity cap (engine-level guard) -------------------------------

describe('buildAndSignTx — fee sanity cap (F1)', () => {
  // The reviewer's exploit: a hostile /v1/fees/recommended returns fastestFee:
  // 5000 (sane is ~5–50). With Send Max on a ~600k balance the OLD code would
  // build a valid tx that sends ~50k and burns ~550k to miners. The engine guard
  // must now reject this before signing.
  it('rejects a hostile 5000 sat/vB rate on Send Max (would have burned ~550k)', () => {
    const balance: WalletUtxo[] = [
      { txid: 'd'.repeat(64), vout: 0, value: 600_000n, path: addr0.path, address: addr0.address },
    ];
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: balance,
        recipient: RECIPIENT,
        amountSats: 0n,
        feeRateSatVb: 5000,
        changeAddress: CHANGE,
        sendMax: true,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('rejects a fee rate above the ceiling on a normal send', () => {
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxos(),
        recipient: RECIPIENT,
        amountSats: 60_000n,
        feeRateSatVb: MAX_FEE_RATE_SAT_VB + 1,
        changeAddress: CHANGE,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('rejects a fee that dwarfs a small send even when the RATE is in range', () => {
    // 20,000-sat send at 400 sat/vB: fee ≈ ceil(141 * 400) ≈ 56,400 sats > 25%.
    // The rate (400) is under the 500 ceiling, so only the fraction guard catches this.
    const err = (() => {
      try {
        buildAndSignTx({
          mnemonic: ABANDON,
          network: 'mainnet',
          utxos: utxos(),
          recipient: RECIPIENT,
          amountSats: 20_000n,
          feeRateSatVb: 400,
          changeAddress: CHANGE,
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(FeeTooHighError);
    expect((err as FeeTooHighError).feeRateSatVb).toBe(400);
    expect((err as FeeTooHighError).feeSats).toBeGreaterThan(0n);
  });

  it('allows an unusually high fee when allowHighFee is set (informed override)', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 20_000n,
      feeRateSatVb: 400,
      changeAddress: CHANGE,
      allowHighFee: true,
    });
    // Override honoured: the tx builds and the fee really is large.
    expect(res.feeSats).toBeGreaterThan(20_000n / 4n);
  });

  // --- F10: allowHighFee bypasses ONLY the percentage rule ------------------

  it('F10: a legitimate small send at an honest rate is blocked without consent, allowed with it', () => {
    // The reviewer's F10 scenario: a small (~$8–13) send at an honest, in-window
    // 30 sat/vB. fee ≈ ceil(141 × 30) = 4,230 sats > 25% of a 10,000-sat send.
    const params = {
      mnemonic: ABANDON,
      network: 'mainnet' as const,
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 10_000n,
      feeRateSatVb: 30,
      changeAddress: CHANGE,
    };
    // Without informed consent: the percentage rule blocks it.
    expect(() => buildAndSignTx(params)).toThrow(FeeTooHighError);
    // With informed consent ("Send anyway"): it builds and signs fine.
    const res = buildAndSignTx({ ...params, allowHighFee: true });
    expect(res.totalInputSats).toBe(10_000n + res.changeSats + res.feeSats);
  });

  it('F10: the hostile 5000 sat/vB sendMax drain stays blocked EVEN WITH allowHighFee', () => {
    const balance: WalletUtxo[] = [
      { txid: 'e'.repeat(64), vout: 0, value: 600_000n, path: addr0.path, address: addr0.address },
    ];
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: balance,
        recipient: RECIPIENT,
        amountSats: 0n,
        feeRateSatVb: 5000,
        changeAddress: CHANGE,
        sendMax: true,
        allowHighFee: true, // the override must NOT unlock a hostile rate
      }),
    ).toThrow(FeeTooHighError);
  });

  it('F10: the 1,000,000-sat absolute fee ceiling stays hard EVEN WITH allowHighFee', () => {
    // 30 inputs at the max in-window rate (500 sat/vB): vsize ≈ 11 + 30×68 + 31
    // = 2,082 vB → fee ≈ 1,041,000 sats. That fee is only ~0.35% of the 3-BTC
    // input total (percentage rule passes), so only the absolute ceiling fires —
    // and it must fire regardless of allowHighFee.
    const many: WalletUtxo[] = [];
    for (let i = 0; i < 30; i++) {
      many.push({
        txid: i.toString(16).padStart(64, '0'),
        vout: 0,
        value: 10_000_000n,
        path: addr0.path,
        address: addr0.address,
      });
    }
    expect(() =>
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: many,
        recipient: RECIPIENT,
        amountSats: 0n,
        feeRateSatVb: 500,
        changeAddress: CHANGE,
        sendMax: true,
        allowHighFee: true,
      }),
    ).toThrow(FeeTooHighError);
  });

  it('F10: Review dry-run numbers under allowHighFee match the signed tx exactly', () => {
    // The Review screen dry-runs buildAndSignTx with the same params the
    // broadcast build uses. Deterministic signing (RFC6979) means the fee,
    // txid, and accounting must be identical between the two calls.
    const params = {
      mnemonic: ABANDON,
      network: 'mainnet' as const,
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 10_000n,
      feeRateSatVb: 30,
      changeAddress: CHANGE,
      allowHighFee: true,
    };
    const dryRun = buildAndSignTx(params);
    const broadcastBuild = buildAndSignTx(params);
    expect(broadcastBuild.txid).toBe(dryRun.txid);
    expect(broadcastBuild.txHex).toBe(dryRun.txHex);
    expect(broadcastBuild.feeSats).toBe(dryRun.feeSats);
    expect(broadcastBuild.totalInputSats).toBe(dryRun.totalInputSats);
    expect(broadcastBuild.changeSats).toBe(dryRun.changeSats);
  });

  it('still accepts an ordinary in-range fee (no false positive)', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 60_000n,
      feeRateSatVb: 10,
      changeAddress: CHANGE,
    });
    expect(res.feeSats).toBeGreaterThan(0n);
    expect(res.feeSats).toBeLessThan(60_000n / 4n);
  });
});

// --- F11: the compose pre-check and the build share one selection path ------

describe('estimateSendFee — exact agreement with buildAndSignTx (F11)', () => {
  /**
   * Asserts the drift-killing property for one scenario: the dry-run fee and
   * consent flag must EXACTLY match what buildAndSignTx does — same fee, and
   * consent-needed if-and-only-if the unconsented build throws FeeTooHighError.
   */
  function assertEstimateMatchesBuild(utxoSet: WalletUtxo[], amountSats: bigint, rate: number): void {
    const est = estimateSendFee({ utxos: utxoSet, amountSats, feeRateSatVb: rate });
    const built = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxoSet,
      recipient: RECIPIENT,
      amountSats,
      feeRateSatVb: rate,
      changeAddress: CHANGE,
      allowHighFee: true, // bypass only the consent rule so the build completes
    });
    // The estimate IS the build's fee — exactly, dust-fold included.
    expect(est.feeSats).toBe(built.feeSats);
    expect(est.totalInputSats).toBe(built.totalInputSats);
    expect(est.changeSats).toBe(built.changeSats);
    // The consent flag agrees exactly with the unconsented build's behavior.
    let threwConsent = false;
    try {
      buildAndSignTx({
        mnemonic: ABANDON,
        network: 'mainnet',
        utxos: utxoSet,
        recipient: RECIPIENT,
        amountSats,
        feeRateSatVb: rate,
        changeAddress: CHANGE,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(FeeTooHighError);
      threwConsent = true;
    }
    expect(est.needsHighFeeConsent).toBe(threwConsent);
  }

  it("reproduces the reviewer's Round-3 scenario exactly (17,500-sat UTXO, 13,000-sat send, 30 sat/vB)", () => {
    const single: WalletUtxo[] = [
      { txid: 'f'.repeat(64), vout: 0, value: 17_500n, path: addr0.path, address: addr0.address },
    ];
    const est = estimateSendFee({ utxos: single, amountSats: 13_000n, feeRateSatVb: 30 });
    // The change (270) is dust → folded → the REAL fee is 4,500, not the
    // 2-output 4,230 the old parallel estimate reported — and that crosses 25%.
    expect(est.feeSats).toBe(4_500n);
    expect(est.hasChange).toBe(false);
    expect(est.needsHighFeeConsent).toBe(true);
    assertEstimateMatchesBuild(single, 13_000n, 30);
  });

  it('property sweep: estimate == built fee across the dust-fold boundary (single UTXO)', () => {
    // Single 17,500-sat UTXO at 30 sat/vB. Sweeping the amount walks through:
    // change well above dust → change crossing the dust threshold (fold) →
    // no-change territory. The estimate must equal the built fee at EVERY step.
    const single: WalletUtxo[] = [
      { txid: 'f'.repeat(64), vout: 0, value: 17_500n, path: addr0.path, address: addr0.address },
    ];
    for (let amt = 12_000n; amt <= 14_200n; amt += 100n) {
      assertEstimateMatchesBuild(single, amt, 30);
    }
  });

  it('property sweep: estimate == built fee across the boundary with multiple UTXOs', () => {
    // Two UTXOs so the sweep also crosses the 1-input → 2-input selection edge
    // while the dust-fold band moves with it.
    const pair: WalletUtxo[] = [
      { txid: 'a'.repeat(64), vout: 0, value: 9_000n, path: addr0.path, address: addr0.address },
      { txid: 'b'.repeat(64), vout: 1, value: 8_500n, path: addr1.path, address: addr1.address },
    ];
    for (let amt = 3_000n; amt <= 12_000n; amt += 500n) {
      assertEstimateMatchesBuild(pair, amt, 20);
    }
  });

  it('sendMax: estimate matches the built sweep exactly, including the consent flag', () => {
    const small: WalletUtxo[] = [
      { txid: 'c'.repeat(64), vout: 0, value: 10_000n, path: addr0.path, address: addr0.address },
    ];
    const est = estimateSendFee({ utxos: small, amountSats: 0n, feeRateSatVb: 30, sendMax: true });
    const built = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: small,
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 30,
      changeAddress: CHANGE,
      sendMax: true,
      allowHighFee: true,
    });
    expect(est.feeSats).toBe(built.feeSats);
    expect(est.sendAmountSats).toBe(built.totalInputSats - built.feeSats);
    expect(est.needsHighFeeConsent).toBe(true); // 3,300 > 25% of 10,000
  });
});

describe('scriptForAddress', () => {
  it('accepts native segwit, taproot (bech32m), and legacy base58 on mainnet', () => {
    expect(scriptForAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'mainnet')).toBeInstanceOf(Uint8Array);
    expect(
      scriptForAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'mainnet'),
    ).toBeInstanceOf(Uint8Array);
    expect(scriptForAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'mainnet')).toBeInstanceOf(Uint8Array);
  });

  it('rejects a mainnet bech32 address in testnet mode and vice versa', () => {
    expect(() => scriptForAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'testnet')).toThrow(
      InvalidRecipientError,
    );
    expect(() => scriptForAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet')).toThrow(
      InvalidRecipientError,
    );
  });

  it('rejects empty and garbage input', () => {
    expect(() => scriptForAddress('', 'mainnet')).toThrow(InvalidRecipientError);
    expect(() => scriptForAddress('not-an-address', 'mainnet')).toThrow(InvalidRecipientError);
  });
});

// --- Phase A: BIP125 opt-in RBF signaling -----------------------------------

/**
 * Reads a Bitcoin varint from `view` at byte offset `o`.
 * @returns The decoded value and the offset just past it.
 */
function readVarint(view: DataView, o: number): { value: number; next: number } {
  const first = view.getUint8(o);
  if (first < 0xfd) return { value: first, next: o + 1 };
  if (first === 0xfd) return { value: view.getUint16(o + 1, true), next: o + 3 };
  if (first === 0xfe) return { value: view.getUint32(o + 1, true), next: o + 5 };
  // 0xff (8-byte) inputs counts / script lengths never occur in these small test txs.
  throw new Error('varint too large for this test parser');
}

/**
 * Parses the RAW wire bytes of a serialized (signed) transaction and returns
 * every input's nSequence as an unsigned 32-bit number. This walks the byte
 * stream itself — version, optional SegWit marker/flag, input vector — and never
 * consults the `Transaction` object that produced the hex. So an assertion on
 * its output proves the sequence actually landed in the FINAL signed tx, not
 * merely in the input object we handed to the builder.
 */
function nSequencesFromTxHex(txHex: string): number[] {
  const b = hex.decode(txHex);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  o += 4; // version (int32 LE)
  // Optional SegWit marker (0x00) + flag (0x01) precede the input count.
  if (view.getUint8(o) === 0x00 && view.getUint8(o + 1) === 0x01) o += 2;
  const count = readVarint(view, o);
  o = count.next;
  const seqs: number[] = [];
  for (let i = 0; i < count.value; i++) {
    o += 32; // prev txid (32 bytes)
    o += 4; // prev vout (uint32 LE)
    const scriptSig = readVarint(view, o);
    o = scriptSig.next + scriptSig.value; // skip scriptSig bytes (empty for native P2WPKH)
    seqs.push(view.getUint32(o, true)); // nSequence (uint32 LE)
    o += 4;
  }
  return seqs;
}

/** Builds `txHex`, byte-parses it, and asserts every input signals RBF. */
function expectEveryInputSignalsRbf(txHex: string, expectedInputs: number): void {
  const seqs = nSequencesFromTxHex(txHex);
  expect(seqs).toHaveLength(expectedInputs);
  for (const seq of seqs) {
    expect(seq).toBe(RBF_SEQUENCE);
    expect(seq).toBeLessThan(0xfffffffe); // BIP125: replaceable iff < 0xfffffffe
  }
}

// Testnet fixtures (own addresses + a valid on-network recipient/change).
const tAddr0 = deriveReceiveAddress(ABANDON, 'testnet', 0);
const tAddr1 = deriveReceiveAddress(ABANDON, 'testnet', 1);
const TEST_RECIPIENT = deriveReceiveAddress(ABANDON, 'testnet', 5).address;
const TEST_CHANGE = deriveReceiveAddress(ABANDON, 'testnet', 2).address;

function testnetUtxos(): WalletUtxo[] {
  return [
    { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: tAddr0.path, address: tAddr0.address },
    { txid: 'b'.repeat(64), vout: 1, value: 50_000n, path: tAddr1.path, address: tAddr1.address },
  ];
}

describe('buildAndSignTx — BIP125 RBF signaling (Phase A)', () => {
  it('exports RBF_SEQUENCE as the canonical MAX_BIP125_RBF_SEQUENCE (0xfffffffd)', () => {
    expect(RBF_SEQUENCE).toBe(0xfffffffd);
    // Signals replaceability (< 0xfffffffe) while keeping the BIP68 disable bit set
    // (0x80000000), so it enables no relative timelock.
    expect(RBF_SEQUENCE).toBeLessThan(0xfffffffe);
    expect(RBF_SEQUENCE >>> 31).toBe(1); // high (BIP68 "disable") bit set → no relative timelock
  });

  it('mainnet single-input send: the one input signals RBF in the signed tx', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 60_000n, // one 100k UTXO suffices → 1 input, 2 outputs
      feeRateSatVb: 10,
      changeAddress: CHANGE,
    });
    expect(res.totalInputSats).toBe(100_000n);
    expectEveryInputSignalsRbf(res.txHex, 1);
  });

  it('mainnet multi-input send: EVERY input signals RBF in the signed tx', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 120_000n, // needs both UTXOs → 2 inputs
      feeRateSatVb: 10,
      changeAddress: CHANGE,
    });
    expect(res.totalInputSats).toBe(150_000n);
    expectEveryInputSignalsRbf(res.txHex, 2);
  });

  it('mainnet sendMax sweep: every swept input signals RBF (no change output)', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: utxos(),
      recipient: RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 5,
      changeAddress: CHANGE,
      sendMax: true,
    });
    expect(res.changeSats).toBe(0n);
    expectEveryInputSignalsRbf(res.txHex, 2);
  });

  it('testnet multi-input send: EVERY input signals RBF in the signed tx', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'testnet',
      utxos: testnetUtxos(),
      recipient: TEST_RECIPIENT,
      amountSats: 120_000n, // needs both UTXOs → 2 inputs
      feeRateSatVb: 10,
      changeAddress: TEST_CHANGE,
    });
    expect(res.totalInputSats).toBe(150_000n);
    expectEveryInputSignalsRbf(res.txHex, 2);
  });

  it('testnet sendMax sweep: every swept input signals RBF (no change output)', () => {
    const res = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'testnet',
      utxos: testnetUtxos(),
      recipient: TEST_RECIPIENT,
      amountSats: 0n,
      feeRateSatVb: 5,
      changeAddress: TEST_CHANGE,
      sendMax: true,
    });
    expect(res.changeSats).toBe(0n);
    expectEveryInputSignalsRbf(res.txHex, 2);
  });

  it('RBF signaling does not change vsize/fee: build fee still matches the estimate', () => {
    const utxoSet = utxos();
    const params = {
      mnemonic: ABANDON,
      network: 'mainnet' as const,
      utxos: utxoSet,
      recipient: RECIPIENT,
      amountSats: 60_000n,
      feeRateSatVb: 10,
      changeAddress: CHANGE,
    };
    const built = buildAndSignTx(params);
    const est = estimateSendFee({ utxos: utxoSet, amountSats: 60_000n, feeRateSatVb: 10 });
    // nSequence is always 4 bytes, so vsize is unchanged and the fee identity holds.
    expect(built.feeSats).toBe(est.feeSats);
    expect(built.feeSats).toBe(BigInt(Math.ceil(built.vsize * 10)));
    // Same 1-in/2-out size band the deterministic test asserts (~141 vB).
    expect(built.vsize).toBeGreaterThan(100);
    expect(built.vsize).toBeLessThan(160);
  });
});
