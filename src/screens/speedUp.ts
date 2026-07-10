/**
 * speedUp.ts — pure decision helpers for the "Speed up this payment" (opt-in
 * Replace-By-Fee fee bump) flow in the Activity detail sheet.
 *
 * No secrets, no network, no React: just the small choices that turn engine
 * results (a {@link BumpFeeEstimate} or a {@link CannotBumpReason}) into which
 * honest copy the sheet shows and which consents it must collect — so they can
 * be unit-tested without a DOM. The heavy lifting (fee math, signing, the single
 * network fetch) all lives in the untouched engine/actions layers.
 */
import { MAX_FEE_ABSOLUTE_SATS, type BumpFeeEstimate, type CannotBumpReason } from '../lib';
import type { ActivityItem } from '../lib/account';
import { strings } from '../strings';

/** The honest, no-recovery dead-end kinds the sheet can land on. */
export type SpeedUpDeadEnd =
  | 'confirmed'
  | 'not-signaling'
  | 'insufficient-change'
  | 'cannot'
  | 'fee-cap';

/**
 * Whether an activity item is a candidate for speed-up: a still-pending payment
 * this wallet SENT (a negative net delta). Received or already-confirmed items
 * are never bumpable. This is only the optimistic entry gate that decides
 * whether to show the button — `prepareBump` does the real, network-backed
 * eligibility check and returns an honest dead-end when it can't proceed.
 */
export function isSpeedUpEligible(item: ActivityItem): boolean {
  return !item.confirmed && item.netSats < 0n;
}

/** Maps an engine {@link CannotBumpReason} to the sheet's dead-end kind. */
export function deadEndFromReason(reason: CannotBumpReason): SpeedUpDeadEnd {
  switch (reason) {
    case 'confirmed':
      return 'confirmed';
    case 'not-signaling':
      return 'not-signaling';
    case 'insufficient-change':
      return 'insufficient-change';
    case 'foreign-inputs':
    case 'unsupported-shape':
      return 'cannot';
  }
}

/**
 * True when a prepared bump's compliant fee can't stay under the wallet's HARD
 * safety ceilings — the rate ceiling (`exceedsRateCeiling`) or the absolute cap.
 * `buildRbfBumpTx` would reject it unconditionally (never bypassable), so we
 * surface it as a no-recovery dead-end, mirroring Review's hard-block state.
 */
export function isHardFeeCap(est: BumpFeeEstimate): boolean {
  return est.exceedsRateCeiling || est.newFeeSats > MAX_FEE_ABSOLUTE_SATS;
}

/**
 * Which explicit consents the offer must collect before it can build:
 * - `reducesLess` — a full-balance (sweep) original where the fee increase eats
 *   into the amount the recipient receives (deliberate, checkbox-gated);
 * - `highFee` — the new fee trips the 25% informed-consent rule (F10), and the
 *   build needs `allowHighFee: true`.
 */
export function bumpConsents(est: BumpFeeEstimate): { reducesLess: boolean; highFee: boolean } {
  return { reducesLess: est.reducesRecipientBy > 0n, highFee: est.needsHighFeeConsent };
}

/** The honest, no-action copy for each dead-end kind. */
export function deadEndCopy(kind: SpeedUpDeadEnd): string {
  switch (kind) {
    case 'confirmed':
      return strings.speedUp.deadConfirmed;
    case 'not-signaling':
      return strings.speedUp.deadNotSignaling;
    case 'insufficient-change':
      return strings.speedUp.deadInsufficientChange;
    case 'cannot':
      return strings.speedUp.deadCannot;
    case 'fee-cap':
      return strings.speedUp.deadFeeCap;
  }
}
