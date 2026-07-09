import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { AddressChunk, CheckRow, Sheet, Toast, copyToClipboard } from '../components/ui';
import { fmtBtc, fmtUsd } from '../display';
import type { Network } from '../lib';
import type { FeeTier, PendingSend } from '../state';

/**
 * The result of the Review dry-run build. `ok: false` means the build could not
 * be completed, so Review must block sending rather than show fake numbers (F4).
 * The reason keeps the copy honest (F10): `'fee-too-high'` when the engine's fee
 * guard tripped, `'stale'` for everything else (e.g. the UTXO set changed under
 * a poll between compose and review).
 */
export type ReviewNumbers =
  | { ok: true; amountSats: bigint; feeSats: bigint; totalSats: bigint }
  | { ok: false; reason: 'fee-too-high' | 'stale' };

/** Fee-time label for the review row, matching the compose chips. */
function tierTime(tier: FeeTier): string {
  return tier === 'faster'
    ? strings.send.feeFasterTime
    : tier === 'economy'
      ? strings.send.feeEconomyTime
      : strings.send.feeStandardTime;
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
}): JSX.Element {
  const live = props.network === 'mainnet';
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // F4: a failed dry-run blocks the whole screen. Render a recheck state with no
  // fabricated numbers and no way to send. The copy names the real cause (F10):
  // only a genuine build failure blames the balance; a fee-guard trip explains
  // the fee instead.
  if (!props.numbers.ok) {
    const body =
      props.numbers.reason === 'fee-too-high'
        ? strings.review.recheckFeeBody
        : strings.review.recheckBody;
    return (
      <Chrome network={props.network} onBack={props.onBack} title={strings.review.title}>
        <div className="screen-body">
          <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
            {strings.review.recheckHeading}
          </h1>
          <div className="warn">
            <div className="warn__text">{body}</div>
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
    setFailed(false);
    try {
      await props.onConfirm();
      // On success the parent navigates away; nothing more to do here.
    } catch {
      // Broadcast failed: money did NOT leave. Offer a safe retry.
      setFailed(true);
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
              {strings.review.feeValue(fmtUsd(feeSats, props.btcUsd), tierTime(props.pending.feeTier))}
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

      {failed ? (
        <Sheet>
          <h2 className="sheet__title">{strings.review.failHeading}</h2>
          <p className="sheet__body">{strings.review.failBody}</p>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              onClick={() => {
                setFailed(false);
                void send();
              }}
            >
              {strings.common.tryAgain}
            </button>
            <button className="btn btn--text btn--block" onClick={() => setFailed(false)}>
              {strings.common.goBack}
            </button>
          </div>
        </Sheet>
      ) : null}

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
