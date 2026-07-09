import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { Toast } from '../components/ui';
import { fmtBtc, fmtSats, fmtUsd, usdToSats } from '../display';
import {
  DUST_LIMIT_SATS,
  InvalidRecipientError,
  MAX_FEE_FRACTION,
  btcStringToSats,
  estimateFeeSats,
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

  // Estimate how many inputs the engine's largest-first selection would use, so
  // the compose-time fee estimate tracks the real build closely (F10). Mirrors
  // selectCoins: accumulate descending values until amount + the fee for the
  // current input count (with change) is covered. Any residual mismatch at the
  // no-change/dust boundary is caught honestly at Review.
  const estInputs = useMemo<number>(() => {
    const utxos = props.account.utxos;
    if (utxos.length === 0) return 1;
    if (sendMax) return utxos.length; // sendMax sweeps every UTXO
    if (amountSats === null || amountSats <= 0n) return 1;
    const sorted = [...utxos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    let total = 0n;
    let n = 0;
    for (const u of sorted) {
      n++;
      total += u.value;
      if (total >= amountSats + estimateFeeSats(n, 2, feeRate)) break;
    }
    return n;
  }, [sendMax, amountSats, props.account.utxos, feeRate]);

  // Sum of every UTXO — what the engine compares a sendMax fee against.
  const totalUtxoSats = useMemo<bigint>(
    () => props.account.utxos.reduce((sum, u) => sum + u.value, 0n),
    [props.account.utxos],
  );

  // Estimated fee for the selected tier, using the engine's own vsize math.
  const feeSats = estimateFeeSats(estInputs, sendMax ? 1 : 2, feeRate);
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

  // F10 informed consent: would this payment trip the engine's fee-vs-amount
  // percentage rule? Mirrors buildAndSignTx exactly — fee compared against
  // amount + fee for a normal send, or the total swept input for Send Max. When
  // true, the normal Review button is held back and an inline notice with the
  // real numbers plus a "Send anyway" option (allowHighFee) is shown instead.
  const fractionCeiling = (comparedTo: bigint): bigint =>
    (comparedTo * BigInt(Math.round(MAX_FEE_FRACTION * 1000))) / 1000n;
  const highFee: boolean = (() => {
    if (props.fees === null || !amountReady) return false;
    if (sendMax) return feeSats > fractionCeiling(totalUtxoSats);
    if (amountSats === null) return false;
    return feeSats > fractionCeiling(amountSats + feeSats);
  })();

  const canReview = addressReady && amountReady && props.fees !== null && !highFee;

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

  /**
   * Proceeds to Review. `allowHighFee` is true only via the explicit
   * "Send anyway" action shown with the high-fee notice (F10); the flag rides
   * the PendingSend through the Review dry-run and the broadcast build so all
   * three use identical params. It never bypasses the engine's hard limits.
   */
  function review(allowHighFee: boolean): void {
    if (!(addressReady && amountReady && props.fees !== null)) return;
    if (highFee && !allowHighFee) return;
    const pending: PendingSend = {
      recipient: address.trim(),
      amountSats: sendMax ? spendableSats : (amountSats ?? 0n),
      feeRateSatVb: feeRate,
      feeTier: tier,
      sendMax,
      allowHighFee,
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

  // Real numbers for the high-fee notice: the fee (in USD, or sats when the
  // price is unavailable) and what share of the sent amount it represents.
  const highFeeFeeStr = props.btcUsd !== null ? fmtUsd(feeSats, props.btcUsd) : fmtSats(feeSats);
  const highFeePct =
    previewAmountSats > 0n ? Number((feeSats * 100n) / previewAmountSats) : 0;

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

        {/* --- High-fee informed consent (F10) --- */}
        {highFee ? (
          <div className="warn" role="alert">
            <div className="warn__text">
              {strings.send.highFeeNotice(highFeeFeeStr, String(highFeePct))}{' '}
              {strings.send.highFeeOptions}
            </div>
            <button
              className="btn btn--secondary btn--block"
              style={{ marginTop: 'var(--sp-3)' }}
              onClick={() => review(true)}
            >
              {strings.send.sendAnyway}
            </button>
          </div>
        ) : null}

        <div className="bottom-actions">
          <button
            className="btn btn--primary btn--block"
            onClick={() => review(false)}
            disabled={!canReview}
          >
            {strings.send.review}
          </button>
        </div>
      </div>

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
