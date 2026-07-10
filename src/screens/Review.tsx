import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { AddressChunk, CheckRow, Sheet, Toast, copyToClipboard } from '../components/ui';
import { fmtBtc, fmtSats, fmtUsd } from '../display';
import { ApiResponseError, MAX_FEE_ABSOLUTE_SATS, type Network } from '../lib';
import type { FeeTier, PendingSend } from '../state';

/**
 * The result of the Review dry-run build. `ok: false` means the build could not
 * be completed, so Review must block sending rather than show fake numbers (F4).
 * The reason keeps the copy honest (F10): `'fee-too-high'` when the engine's fee
 * guard tripped (carrying the real numbers so the blocked state can explain and
 * offer recovery, F11), `'stale'` for everything else (e.g. the UTXO set changed
 * under a poll between compose and review).
 */
export type ReviewNumbers =
  | { ok: true; amountSats: bigint; feeSats: bigint; totalSats: bigint }
  | { ok: false; reason: 'stale' }
  | { ok: false; reason: 'fee-too-high'; feeSats: bigint; comparedToSats: bigint };

/** Fee-time label for the review row, matching the compose chips. */
function tierTime(tier: FeeTier): string {
  return tier === 'faster'
    ? strings.send.feeFasterTime
    : tier === 'economy'
      ? strings.send.feeEconomyTime
      : strings.send.feeStandardTime;
}

/**
 * Whether a broadcast failure is the node REJECTING the transaction because
 * its fee rate is below the node's minimum relay fee — reachable now that a
 * custom rate may go sub-1 sat/vB and the node's floor can rise when the
 * network gets busy. Recognizes Bitcoin Core's two message forms ("min relay
 * fee not met" and "mempool min fee not met"), which Esplora relays verbatim
 * in the error body. Deliberately NARROW: anything unrecognized keeps the
 * generic connection-problem sheet (with its safe retry) — the raw error is
 * classified here, never swallowed into a different failure story.
 */
export function isFeeBelowRelayFloorError(err: unknown): boolean {
  return (
    err instanceof ApiResponseError &&
    /min relay fee not met|mempool min fee not met/i.test(err.body)
  );
}

/**
 * The unskippable Send review. Shows the amount, chunked destination, fee, and
 * total, plus the verbatim irreversibility line. On Live mode the "I've checked
 * the address" checkbox gates the Send now button. Broadcast failures show a
 * non-destructive retry sheet (money did NOT leave).
 *
 * If the dry-run build failed (`numbers.ok === false`), we render a blocking
 * "re-check this payment" state with NO amounts and NO enabled Send button (F4).
 */
export function Review(props: {
  network: Network;
  pending: PendingSend;
  /** Amount/fee/total from the dry-run build, or a blocked marker on failure. */
  numbers: ReviewNumbers;
  btcUsd: number | null;
  onConfirm: () => Promise<void>;
  onBack: () => void;
  /**
   * Called when the user chooses "Send anyway" from the fee-blocked state
   * (F11): the parent re-composes the same payment with `allowHighFee: true`,
   * after which this screen re-renders with the real numbers and the normal
   * full review gate. Never reachable when the block was a hard fee limit.
   */
  onAcceptHighFee: () => void;
}): JSX.Element {
  const live = props.network === 'mainnet';
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  // Broadcast-failure state: null = no failure sheet. 'fee-too-low' is the
  // node rejecting the fee rate (below its relay floor) — a DIFFERENT sheet
  // from the generic connection failure, because retrying the identical bytes
  // is guaranteed the identical rejection.
  const [failed, setFailed] = useState<'generic' | 'fee-too-low' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // F4: a failed dry-run blocks the whole screen. Render a recheck state with no
  // fabricated numbers and no enabled Send. The copy names the real cause (F10),
  // and a consent-gated fee block offers a working recovery right here (F11) —
  // this state must never again be a dead end.
  if (!props.numbers.ok) {
    if (props.numbers.reason === 'fee-too-high') {
      const { feeSats, comparedToSats } = props.numbers;
      // Recoverable = the consent (percentage) rule tripped: consent wasn't
      // given yet and the fee is inside the hard limits. A hard-limit trip
      // (hostile rate → feeSats 0n from the rate guard, or fee > absolute
      // ceiling, or consent already given yet still blocked) is NOT recoverable
      // — offering "Send anyway" there would loop, so we say so honestly.
      const recoverable =
        !props.pending.allowHighFee && feeSats > 0n && feeSats <= MAX_FEE_ABSOLUTE_SATS;
      const sentBase = comparedToSats - feeSats; // what would actually be sent
      const pct = sentBase > 0n ? Number((feeSats * 100n) / sentBase) : 0;
      const feeStr = props.btcUsd !== null ? fmtUsd(feeSats, props.btcUsd) : fmtSats(feeSats);
      return (
        <Chrome network={props.network} onBack={props.onBack} title={strings.review.title}>
          <div className="screen-body">
            <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
              {strings.review.recheckHeading}
            </h1>
            <div className="warn">
              <div className="warn__text">
                {recoverable
                  ? strings.review.recheckFeeBody(feeStr, String(pct))
                  : strings.review.recheckFeeHardBody}
              </div>
            </div>
            <div className="bottom-actions">
              <button className="btn btn--primary btn--block" onClick={props.onBack}>
                {strings.review.recheckGoBack}
              </button>
              {recoverable ? (
                <button className="btn btn--secondary btn--block" onClick={props.onAcceptHighFee}>
                  {strings.send.sendAnyway}
                </button>
              ) : null}
            </div>
          </div>
        </Chrome>
      );
    }
    return (
      <Chrome network={props.network} onBack={props.onBack} title={strings.review.title}>
        <div className="screen-body">
          <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
            {strings.review.recheckHeading}
          </h1>
          <div className="warn">
            <div className="warn__text">{strings.review.recheckBody}</div>
          </div>
          <div className="bottom-actions">
            <button className="btn btn--primary btn--block" onClick={props.onBack}>
              {strings.review.recheckGoBack}
            </button>
          </div>
        </div>
      </Chrome>
    );
  }

  const { amountSats, feeSats, totalSats } = props.numbers;
  const canSend = (!live || checked) && !busy;

  async function send(): Promise<void> {
    if (!canSend) return;
    setBusy(true);
    setFailed(null);
    try {
      await props.onConfirm();
      // On success the parent navigates away; nothing more to do here.
    } catch (err) {
      // Broadcast failed: money did NOT leave, either way. A recognized
      // fee-below-relay-floor rejection gets its own sheet (no retry — the
      // identical bytes would get the identical answer; the fix is a higher
      // fee); everything else keeps the generic sheet with its safe retry.
      setFailed(isFeeBelowRelayFloorError(err) ? 'fee-too-low' : 'generic');
      setBusy(false);
    }
  }

  async function copyAddr(): Promise<void> {
    const ok = await copyToClipboard(props.pending.recipient);
    if (ok) setToast(strings.receive.copyToast);
  }

  return (
    <Chrome network={props.network} onBack={props.onBack} title={strings.review.title}>
      <div className="screen-body">
        <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
          {strings.review.heading}
        </h1>

        <div className="rev-amt">
          <div className="rev-amt__hero">{fmtUsd(amountSats, props.btcUsd)}</div>
          <div className="rev-amt__btc">{fmtBtc(amountSats)} BTC</div>
        </div>

        <label className="label">{strings.review.toLabel}</label>
        <div style={{ marginTop: 'var(--sp-2)' }}>
          <AddressChunk address={props.pending.recipient} onCopy={copyAddr} />
        </div>

        <div className="rev-block">
          <div className="rev-row">
            <span className="rev-row__k">{strings.review.feeLabel}</span>
            <span className="rev-row__v">
              {props.pending.feeTier === 'custom'
                ? // A custom rate can't honestly promise an arrival time, so the
                  // row shows the rate itself — String() of the SAME number the
                  // build will consume (feeRateSatVb), never a re-derivation.
                  strings.review.feeValueCustom(
                    fmtUsd(feeSats, props.btcUsd),
                    String(props.pending.feeRateSatVb),
                  )
                : strings.review.feeValue(
                    fmtUsd(feeSats, props.btcUsd),
                    tierTime(props.pending.feeTier),
                  )}
            </span>
          </div>
          <div className="rev-row rev-row--total">
            <span className="rev-row__k">{strings.review.totalLabel}</span>
            <span className="rev-row__v">
              {fmtUsd(totalSats, props.btcUsd)}
              <br />
              <span className="rev-row__v-sub">{fmtBtc(totalSats)} BTC</span>
            </span>
          </div>
        </div>

        <div className="warn">
          <div className="warn__text">
            {live ? (
              <>
                <strong>Sending bitcoin cannot be undone.</strong> If the address is wrong, your
                money is gone for good. Take a moment to compare the address above with the one you
                were given.
              </>
            ) : (
              strings.review.warningPractice
            )}
          </div>
        </div>

        {live ? (
          <CheckRow checked={checked} onToggle={() => setChecked((c) => !c)} label={strings.review.checkbox} />
        ) : null}

        <div className="bottom-actions">
          <button className="btn btn--primary btn--block" onClick={send} disabled={!canSend}>
            {busy ? '…' : strings.review.sendNow}
          </button>
          <button className="btn btn--text btn--block" onClick={props.onBack} disabled={busy}>
            {strings.review.goBack}
          </button>
        </div>
      </div>

      {failed !== null ? (
        <Sheet>
          <h2 className="sheet__title">{strings.review.failHeading}</h2>
          <p className="sheet__body">
            {failed === 'fee-too-low' ? strings.review.failFeeTooLowBody : strings.review.failBody}
          </p>
          <div className="sheet__actions">
            {failed === 'fee-too-low' ? (
              // No retry here: re-broadcasting the identical transaction is
              // guaranteed the identical rejection. The way forward is a
              // higher fee, so the primary action goes back to compose.
              <button className="btn btn--primary btn--block" onClick={props.onBack}>
                {strings.review.goBack}
              </button>
            ) : (
              <button
                className="btn btn--primary btn--block"
                onClick={() => {
                  setFailed(null);
                  void send();
                }}
              >
                {strings.common.tryAgain}
              </button>
            )}
            <button className="btn btn--text btn--block" onClick={() => setFailed(null)}>
              {strings.common.goBack}
            </button>
          </div>
        </Sheet>
      ) : null}

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
