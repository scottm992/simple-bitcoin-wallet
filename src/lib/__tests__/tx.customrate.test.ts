/**
 * tx.customrate.test.ts — engine behavior at FRACTIONAL and SUB-1 fee rates,
 * pinned for the custom fee-rate feature (Round-14 territory).
 *
 * The engine was NOT changed for this feature: its rate guards were already
 * "positive and finite" (never floored at 1), and its fee math is
 * fraction-safe (`ceil(vsize × rate)`). These tests pin that pre-existing
 * behavior so a future "tidy-up" can't quietly break sub-1 custom rates:
 *  - the F11 agreement property (estimateSendFee == buildAndSignTx, to the
 *    satoshi) holds at 0.1, 0.5, and 2.5 sat/vB exactly as it does at
 *    integer rates;
 *  - a 0.1 sat/vB send is BUMP-RESCUABLE: the existing BIP125 floors in
 *    estimateBumpFee/buildRbfBumpTx produce a valid, relayable replacement
 *    for a sub-1 original (this is the safety net the sub-1 slow lane
 *    depends on).
 */
import { describe, it, expect } from 'vitest';
import {
  buildAndSignTx,
  buildRbfBumpTx,
  estimateBumpFee,
  estimateSendFee,
  FeeTooHighError,
  INCREMENTAL_RELAY_SAT_VB,
  type WalletUtxo,
} from '../tx';
import { deriveReceiveAddress } from '../wallet';

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const addr0 = deriveReceiveAddress(ABANDON, 'mainnet', 0);
const RECIPIENT = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';
const CHANGE = deriveReceiveAddress(ABANDON, 'mainnet', 2).address;

/** One 100k-sat UTXO — a known single-input shape for exact assertions. */
function singleUtxo(): WalletUtxo[] {
  return [
    { txid: 'a'.repeat(64), vout: 0, value: 100_000n, path: addr0.path, address: addr0.address },
  ];
}

/**
 * The F11 drift-killer at one (amount, rate) point: the dry-run fee and
 * consent flag must EXACTLY match buildAndSignTx (same shape as the existing
 * agreement suite in tx.test.ts, here exercised at fractional rates).
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
  expect(est.feeSats).toBe(built.feeSats);
  expect(est.totalInputSats).toBe(built.totalInputSats);
  expect(est.changeSats).toBe(built.changeSats);
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

describe('fractional fee rates — F11 agreement (estimate == built)', () => {
  it('holds at 0.1, 0.5, and 2.5 sat/vB across a small amount sweep', () => {
    for (const rate of [0.1, 0.5, 2.5]) {
      for (let amt = 20_000n; amt <= 90_000n; amt += 17_500n) {
        assertEstimateMatchesBuild(singleUtxo(), amt, rate);
      }
    }
  });

  it('a 0.1 sat/vB build pays exactly ceil(vsize × 0.1) — fraction-safe, never zero', () => {
    const built = buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: singleUtxo(),
      recipient: RECIPIENT,
      amountSats: 60_000n,
      feeRateSatVb: 0.1,
      changeAddress: CHANGE,
    });
    // The engine's own formula, applied to the ACTUAL signed vsize: ~15 sats
    // for a 1-in/2-out P2WPKH tx. Never rounds down to a free transaction.
    expect(built.feeSats).toBe(BigInt(Math.ceil(built.vsize * 0.1)));
    expect(built.feeSats).toBeGreaterThan(0n);
    // Accounting identity still exact at a fractional rate.
    expect(built.totalInputSats).toBe(60_000n + built.changeSats + built.feeSats);
  });
});

describe('a sub-1 sat/vB send is Speed-up (RBF) rescuable', () => {
  /** Builds the 0.1 sat/vB original the rescue tests bump. */
  function buildSub1Original(): ReturnType<typeof buildAndSignTx> {
    return buildAndSignTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: singleUtxo(),
      recipient: RECIPIENT,
      amountSats: 60_000n,
      feeRateSatVb: 0.1,
      changeAddress: CHANGE,
    });
  }

  it('estimateBumpFee produces a relayable replacement for a 0.1-rate original', () => {
    const original = buildSub1Original();
    const est = estimateBumpFee({
      utxos: singleUtxo(),
      recipientAmountSats: 60_000n,
      hasChangeOutput: original.changeSats > 0n,
      oldFeeSats: original.feeSats,
      oldVsize: original.vsize,
      feeRateSatVb: 2, // a modest, ordinary rescue rate
    });
    // BIP125 rule 4: new fee ≥ old fee + incremental relay × new vsize.
    expect(est.newFeeSats).toBeGreaterThanOrEqual(
      original.feeSats + BigInt(est.newVsize * INCREMENTAL_RELAY_SAT_VB),
    );
    // Strictly-greater effective rate than the 0.1 original.
    expect(est.effectiveRateSatVb).toBeGreaterThan(Number(original.feeSats) / original.vsize);
    // The original had change, so the recipient is untouched by the rescue.
    expect(est.reducesRecipientBy).toBe(0n);
  });

  it('even a barely-higher sub-1 bump request is RAISED to the floors, never invalid', () => {
    const original = buildSub1Original();
    // Requesting 0.11 sat/vB alone could not clear the BIP125 floors — the
    // engine must raise the fee to the floor and say so, not emit a
    // replacement relays would reject (pre-existing raise-and-report logic,
    // proven here against a sub-1 original specifically).
    const est = estimateBumpFee({
      utxos: singleUtxo(),
      recipientAmountSats: 60_000n,
      hasChangeOutput: original.changeSats > 0n,
      oldFeeSats: original.feeSats,
      oldVsize: original.vsize,
      feeRateSatVb: 0.11,
    });
    expect(est.rateWasRaised).toBe(true);
    expect(est.newFeeSats).toBeGreaterThanOrEqual(
      original.feeSats + BigInt(est.newVsize * INCREMENTAL_RELAY_SAT_VB),
    );
  });

  it('buildRbfBumpTx signs the rescue with EXACTLY the estimated fee (F11)', () => {
    const original = buildSub1Original();
    const est = estimateBumpFee({
      utxos: singleUtxo(),
      recipientAmountSats: 60_000n,
      hasChangeOutput: original.changeSats > 0n,
      oldFeeSats: original.feeSats,
      oldVsize: original.vsize,
      feeRateSatVb: 2,
    });
    const bump = buildRbfBumpTx({
      mnemonic: ABANDON,
      network: 'mainnet',
      utxos: singleUtxo(),
      recipient: RECIPIENT,
      recipientAmountSats: 60_000n,
      changeAddress: CHANGE,
      oldFeeSats: original.feeSats,
      oldVsize: original.vsize,
      feeRateSatVb: 2,
    });
    expect(bump.feeSats).toBe(est.newFeeSats);
    expect(bump.txid).not.toBe(original.txid);
    // The replacement really replaces: same single input value, higher fee.
    expect(bump.totalInputSats).toBe(original.totalInputSats);
    expect(bump.feeSats).toBeGreaterThan(original.feeSats);
  });
});
