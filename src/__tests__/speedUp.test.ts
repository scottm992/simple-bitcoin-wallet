/**
 * speedUp.test.ts — unit tests for the pure decision helpers behind the
 * "Speed up this payment" flow (src/screens/speedUp.ts). These cover the small
 * choices the sheet makes — eligibility, dead-end mapping, hard-cap detection,
 * which consents to collect, and the honest copy — without a DOM. The fee math,
 * signing, and network fetch they sit on top of are covered by the engine tests.
 */
import { describe, it, expect } from 'vitest';
import {
  bumpConsents,
  deadEndCopy,
  deadEndFromReason,
  isHardFeeCap,
  isSpeedUpEligible,
} from '../screens/speedUp';
import { strings } from '../strings';
import { MAX_FEE_ABSOLUTE_SATS, type BumpFeeEstimate } from '../lib';
import type { ActivityItem } from '../lib/account';

function makeItem(over: Partial<ActivityItem>): ActivityItem {
  return { txid: 'a'.repeat(64), confirmed: false, netSats: -61_000n, ...over };
}

function makeEst(over: Partial<BumpFeeEstimate>): BumpFeeEstimate {
  return {
    newFeeSats: 2_820n,
    oldFeeSats: 1_000n,
    extraFeeSats: 1_820n,
    newVsize: 141,
    effectiveRateSatVb: 20,
    requestedRateSatVb: 20,
    rateWasRaised: false,
    hasChange: true,
    newChangeSats: 37_180n,
    newRecipientAmountSats: 60_000n,
    reducesRecipientBy: 0n,
    totalInputSats: 100_000n,
    needsHighFeeConsent: false,
    exceedsRateCeiling: false,
    ...over,
  };
}

describe('isSpeedUpEligible', () => {
  it('is true only for a pending, outgoing payment', () => {
    expect(isSpeedUpEligible(makeItem({ confirmed: false, netSats: -61_000n }))).toBe(true);
  });

  it('is false once the payment has confirmed', () => {
    expect(isSpeedUpEligible(makeItem({ confirmed: true, netSats: -61_000n }))).toBe(false);
  });

  it('is false for an incoming payment (we can only bump our own sends)', () => {
    expect(isSpeedUpEligible(makeItem({ confirmed: false, netSats: 25_000n }))).toBe(false);
  });

  it('is false for a zero net delta (not outgoing)', () => {
    expect(isSpeedUpEligible(makeItem({ confirmed: false, netSats: 0n }))).toBe(false);
  });
});

describe('deadEndFromReason', () => {
  it('maps confirmed / not-signaling / insufficient-change one-to-one', () => {
    expect(deadEndFromReason('confirmed')).toBe('confirmed');
    expect(deadEndFromReason('not-signaling')).toBe('not-signaling');
    expect(deadEndFromReason('insufficient-change')).toBe('insufficient-change');
  });

  it('collapses foreign-inputs and unsupported-shape into a single honest "cannot"', () => {
    expect(deadEndFromReason('foreign-inputs')).toBe('cannot');
    expect(deadEndFromReason('unsupported-shape')).toBe('cannot');
  });

  it('maps the F15 verification reasons to their own dead-ends (never collapsed)', () => {
    expect(deadEndFromReason('recipient-mismatch')).toBe('mismatch');
    expect(deadEndFromReason('unverified')).toBe('unverified');
  });
});

describe('isHardFeeCap', () => {
  it('trips when a compliant replacement would exceed the hard rate ceiling', () => {
    expect(isHardFeeCap(makeEst({ exceedsRateCeiling: true }))).toBe(true);
  });

  it('trips when the fee exceeds the absolute ceiling', () => {
    expect(isHardFeeCap(makeEst({ newFeeSats: MAX_FEE_ABSOLUTE_SATS + 1n }))).toBe(true);
  });

  it('is false for an ordinary in-bounds bump', () => {
    expect(isHardFeeCap(makeEst({}))).toBe(false);
  });
});

describe('bumpConsents', () => {
  it('requires the "receive less" consent only when the sweep reduces the recipient', () => {
    expect(bumpConsents(makeEst({ reducesRecipientBy: 0n })).reducesLess).toBe(false);
    expect(bumpConsents(makeEst({ reducesRecipientBy: 3_000n })).reducesLess).toBe(true);
  });

  it('requires the high-fee consent only when the 25% rule trips', () => {
    expect(bumpConsents(makeEst({ needsHighFeeConsent: false })).highFee).toBe(false);
    expect(bumpConsents(makeEst({ needsHighFeeConsent: true })).highFee).toBe(true);
  });
});

describe('deadEndCopy', () => {
  it('returns the matching plain-English string for each dead-end kind', () => {
    expect(deadEndCopy('confirmed')).toBe(strings.speedUp.deadConfirmed);
    expect(deadEndCopy('not-signaling')).toBe(strings.speedUp.deadNotSignaling);
    expect(deadEndCopy('insufficient-change')).toBe(strings.speedUp.deadInsufficientChange);
    expect(deadEndCopy('cannot')).toBe(strings.speedUp.deadCannot);
    expect(deadEndCopy('fee-cap')).toBe(strings.speedUp.deadFeeCap);
    expect(deadEndCopy('mismatch')).toBe(strings.speedUp.deadMismatch);
    expect(deadEndCopy('unverified')).toBe(strings.speedUp.deadUnverified);
  });
});
