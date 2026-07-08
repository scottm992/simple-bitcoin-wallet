import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { Toast } from '../components/ui';
import { fmtBtc, fmtUsd, usdToSats } from '../display';
import {
  DUST_LIMIT_SATS,
  InvalidRecipientError,
  btcStringToSats,
  scriptForAddress,
  satsToUsdString,
  type FeeEstimates,
  type Network,
} from '../lib';
import { feeRateForTier } from '../actions';
import type { AccountSnapshot } from '../lib/account';
import type { FeeTier, PendingSend } from '../state';

/** Estimated vsize of a typical 1-in/2-out P2WPKH tx, for fee-in-USD hints. */
const TYPICAL_VSIZE = 141;

type EntryUnit = 'usd' | 'btc';

/** Classifies a recipient address for the active network. */
function classifyAddress(
  address: string,
  network: Network,
): 'empty' | 'valid' | 'wrong-network' | 'malformed' {
  if (address.trim() === '') return 'empty';
  try {
    scriptForAddress(address.trim(), network);
    return 'valid';
  } catch (err) {
    if (err instanceof InvalidRecipientError && /wrong network/i.test(err.message)) {
      return 'wrong-network';
    }
    return 'malformed';
  }
}

export function Send(props: {
  network: Network;
  account: AccountSnapshot;
  btcUsd: number | null;
  fees: FeeEstimates | null;
  onReview: (pending: PendingSend) => void;
  onBack: () => void;
}): JSX.Element {
  const [address, setAddress] = useState('');
  const [entryUnit, setEntryUnit] = useState<EntryUnit>('usd');
  const [amountText, setAmountText] = useState('');
  const [tier, setTier] = useState<FeeTier>('standard');
  const [sendMax, setSendMax] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const spendableSats = props.account.confirmedSats;
  const addrClass = classifyAddress(address, props.network);
  const feeRate = props.fees ? feeRateForTier(props.fees, tier) : 1;

  // Parse the entered amount into sats (from whichever unit is active).
  const amountSats = useMemo<bigint | null>(() => {
    if (sendMax) return spendableSats; // display only; real value computed at build
    const t = amountText.trim();
    if (t === '') return null;
    try {
      if (entryUnit === 'usd') {
        const usd = Number(t.replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(usd) || usd <= 0 || props.btcUsd === null) return usd === 0 ? 0n : null;
        return usdToSats(usd, props.btcUsd);
      }
      return btcStringToSats(t);
    } catch {
      return null;
    }
  }, [amountText, entryUnit, sendMax, spendableSats, props.btcUsd]);

  // Live conversion line under the amount.
  const conversion = useMemo<string>(() => {
    if (amountSats === null) return '';
    if (entryUnit === 'usd') return strings.send.convBtc(fmtBtc(amountSats));
    return strings.send.convUsd(fmtUsd(amountSats, props.btcUsd));
  }, [amountSats, entryUnit, props.btcUsd]);

  // Estimated fee in sats/USD for the running total.
  const feeSats = BigInt(Math.ceil(TYPICAL_VSIZE * feeRate));
  const feeUsd = props.btcUsd === null ? null : satsToUsdString(feeSats, props.btcUsd);

  // Validation for enabling Review + inline errors.
  let amountError: string | null = null;
  if (!sendMax) {
    if (amountSats === null) amountError = null; // empty → helper, not error
    else if (amountSats === 0n) amountError = strings.send.needAmount;
    else if (amountSats < DUST_LIMIT_SATS) {
      const minUsd = props.btcUsd === null ? '0.50' : satsToUsdString(DUST_LIMIT_SATS, props.btcUsd);
      amountError = strings.send.dust(props.btcUsd === null ? '$0.50' : minUsd);
    } else if (amountSats + feeSats > spendableSats) {
      const maxSpendable = spendableSats > feeSats ? spendableSats - feeSats : 0n;
      amountError = strings.send.overBalance(fmtUsd(maxSpendable, props.btcUsd));
    }
  }

  const addressReady = addrClass === 'valid';
  const amountReady = sendMax
    ? spendableSats > feeSats + DUST_LIMIT_SATS
    : amountSats !== null && amountSats >= DUST_LIMIT_SATS && amountError === null;
  const canReview = addressReady && amountReady && props.fees !== null;

  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) setAddress(text.trim());
    } catch {
      setToast(strings.send.scanUnsupported);
    }
  }

  function pickMax(): void {
    setSendMax(true);
    setAmountText('');
  }

  function review(): void {
    if (!canReview) return;
    const pending: PendingSend = {
      recipient: address.trim(),
      amountSats: sendMax ? spendableSats : (amountSats ?? 0n),
      feeRateSatVb: feeRate,
      feeTier: tier,
      sendMax,
    };
    props.onReview(pending);
  }

  const feeChips: { tier: FeeTier; title: string; time: string }[] = [
    { tier: 'standard', title: strings.send.feeStandard, time: strings.send.feeStandardTime },
    { tier: 'faster', title: strings.send.feeFaster, time: strings.send.feeFasterTime },
    { tier: 'economy', title: strings.send.feeEconomy, time: strings.send.feeEconomyTime },
  ];

  // Total preview.
  const previewAmountSats = sendMax
    ? spendableSats > feeSats
      ? spendableSats - feeSats
      : 0n
    : (amountSats ?? 0n);
  const totalSats = sendMax ? spendableSats : previewAmountSats + feeSats;

  return (
    <Chrome network={props.network} onBack={props.onBack} title={strings.send.title}>
      <div className="screen-body">
        <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
          {strings.send.heading}
        </h1>

        {/* --- To --- */}
        <div className="field-group">
          <label className="label" htmlFor="send-to">
            {strings.send.toLabel}
          </label>
          <div
            className={`input-wrap ${addrClass === 'valid' ? 'input-wrap--valid' : ''} ${
              addrClass === 'malformed' || addrClass === 'wrong-network' ? 'input-wrap--error' : ''
            }`}
          >
            <input
              id="send-to"
              className="input input--mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={strings.send.addressPlaceholder}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label={strings.send.toLabel}
            />
            <button className="chip-btn" onClick={paste}>
              {strings.send.paste}
            </button>
            <button className="chip-btn" onClick={() => setToast(strings.send.scanUnsupported)}>
              {strings.send.scan}
            </button>
          </div>
          {addrClass === 'valid' ? (
            <div className="valid-note">✓ {strings.send.addressValid}</div>
          ) : addrClass === 'malformed' ? (
            <p className="error-text">{strings.send.malformedAddress}</p>
          ) : addrClass === 'wrong-network' ? (
            <p className="error-text">
              {strings.send.wrongNetwork(
                props.network === 'mainnet' ? 'Practice' : 'Live',
                props.network === 'mainnet' ? 'Live' : 'Practice',
              )}
            </p>
          ) : (
            <p className="small">{strings.send.needAddress}</p>
          )}
        </div>

        {/* --- Amount --- */}
        <div className="field-group">
          <label className="label" htmlFor="send-amt">
            {strings.send.amountLabel}
          </label>
          <div className="input-wrap" style={{ alignItems: 'baseline' }}>
            <input
              id="send-amt"
              className="amount-big"
              value={sendMax ? '' : amountText}
              onChange={(e) => {
                setSendMax(false);
                setAmountText(e.target.value);
              }}
              placeholder={entryUnit === 'usd' ? '$0.00' : '0.00000000'}
              inputMode="decimal"
              aria-label={strings.send.amountLabel}
            />
            <button
              className="chip-btn"
              onClick={() => setEntryUnit((u) => (u === 'usd' ? 'btc' : 'usd'))}
              disabled={props.btcUsd === null && entryUnit === 'btc'}
            >
              {strings.send.unitSwitch}
            </button>
            <button className="chip-btn" onClick={pickMax}>
              {strings.send.max}
            </button>
          </div>
          {sendMax ? (
            <div className="amount-conv">
              {fmtUsd(previewAmountSats, props.btcUsd)} · {fmtBtc(previewAmountSats)} BTC
            </div>
          ) : conversion ? (
            <div className="amount-conv">{conversion}</div>
          ) : null}
          {amountError ? (
            <p className="error-text">
              {amountError}{' '}
              {amountError.startsWith("That's more") ? (
                <button
                  className="btn btn--text"
                  style={{ padding: 0, fontSize: 'var(--fs-small)' }}
                  onClick={pickMax}
                >
                  {strings.send.sendMax}
                </button>
              ) : null}
            </p>
          ) : !sendMax && amountSats === null ? (
            <p className="small">{strings.send.needAmount}</p>
          ) : null}
        </div>

        {/* --- Fee --- */}
        <div className="field-group">
          <label className="label">{strings.send.feeLabel}</label>
          <p className="small" style={{ marginTop: 'var(--sp-1)' }}>
            {strings.send.feeExplainer}
          </p>
          <div className="fees">
            {feeChips.map((c) => {
              const rate = props.fees ? feeRateForTier(props.fees, c.tier) : 1;
              const chipFeeSats = BigInt(Math.ceil(TYPICAL_VSIZE * rate));
              const chipFeeUsd = props.btcUsd === null ? '' : fmtUsd(chipFeeSats, props.btcUsd);
              return (
                <button
                  key={c.tier}
                  className={`fee ${tier === c.tier ? 'fee--sel' : ''}`}
                  onClick={() => setTier(c.tier)}
                  aria-pressed={tier === c.tier}
                >
                  <div className="fee__title">{c.title}</div>
                  <div className="fee__sub">
                    {c.time}
                    <br />
                    {chipFeeUsd ? `≈ ${chipFeeUsd}` : ''}
                  </div>
                </button>
              );
            })}
          </div>
          {props.btcUsd !== null && (amountReady || sendMax) ? (
            <div className="total-line">
              {strings.send.totalLine(
                fmtUsd(previewAmountSats, props.btcUsd),
                feeUsd ?? '',
                fmtUsd(totalSats, props.btcUsd),
              )}
            </div>
          ) : null}
        </div>

        <div className="bottom-actions">
          <button className="btn btn--primary btn--block" onClick={review} disabled={!canReview}>
            {strings.send.review}
          </button>
        </div>
      </div>

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
