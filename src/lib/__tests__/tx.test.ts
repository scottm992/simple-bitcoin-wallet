import { describe, it, expect } from 'vitest';
import {
  buildAndSignTx,
  scriptForAddress,
  InsufficientFundsError,
  InvalidRecipientError,
  InvalidTxParamsError,
  FeeTooHighError,
  MAX_FEE_RATE_SAT_VB,
  DUST_LIMIT_SATS,
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
