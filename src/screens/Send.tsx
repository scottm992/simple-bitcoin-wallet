import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { Toast } from '../components/ui';
import { fmtBtc, fmtSats, fmtUsd, usdToSats } from '../display';
import {
  DUST_LIMIT_SATS,
  InvalidRecipientError,
  MAX_ACCEPTED_FEE_RATE,
  btcStringToSats,
  estimateSendFee,
  scriptForAddress,
  satsToUsdString,
  type FeeEstimates,
  type FeeSelection,
  type Network,
} from '../lib';
import { feeRateForTier } from '../actions';
import type { AccountSnapshot } from '../lib/account';
import type { FeeChoice, FeeTier, PendingSend } from '../state';

/** Estimated vsize of a typical 1-in/2-out P2WPKH tx, for fee-in-USD hints. */
const TYPICAL_VSIZE = 141;

/**
 * The floor for a USER-TYPED custom fee rate, in sat/vB — deliberately below
 * the `MIN_ACCEPTED_FEE_RATE = 1` floor the recommended tiers keep.
 *
 * WHY 0.1: Bitcoin Core 30 (Oct 2025) lowered the default `minrelaytxfee` to
 * 0.1 sat/vB, and our broadcast node honors it — live probe 2026-07-10 of
 * blockstream.info: `/api/mempool`'s fee_histogram bottom buckets carry large
 * ACCEPTED volume at ≈0.1 sat/vB (e.g. [0.10000050, 99130 vB]), and its
 * `/api/fee-estimates` itself returns sub-1 rates (0.747 for 144+ block
 * targets). Accepted ≠ confirmed, though — a sub-1 payment can wait a very
 * long time or be dropped when the network gets busy — so the UI pairs any
 * sub-1 rate with the slow-lane hint, and Speed up (RBF) is the rescue.
 *
 * WHY only here: this constant governs ONLY user-typed intent. API-derived
 * tier estimates stay on the audited `feeRateForTier` clamp
 * [MIN_ACCEPTED_FEE_RATE, MAX_ACCEPTED_FEE_RATE] — mempool.space's own
 * recommended minimumFee is 1, consistent with that clamp staying put. This is
 * THE single relaxation point the roadmap reserved for the sub-1 decision:
 * the engine beneath accepts any positive finite rate (its hard guards are the
 * 500 sat/vB ceiling and the 1M-sat absolute cap, both untouched), so nothing
 * below this line re-floors or re-clamps a custom rate. F1 surface — reviewed
 * territory (Round 14).
 */
export const MIN_CUSTOM_FEE_RATE = 0.1;

/** The classification of the custom fee-rate text (see classifyCustomFeeRate). */
export type CustomFeeRateClass =
  | { kind: 'empty' }
  | { kind: 'malformed' }
  | { kind: 'out-of-range' }
  | { kind: 'valid'; rate: number };

/**
 * Strictly classifies the custom fee-rate text — a user-typed number headed
 * for the fee engine, so this is money-path validation (Round 14 territory).
 *
 * Mirrors btcStringToSats's house strict-parse style: ONE plain decimal form
 * only — digits with at most one dot. Everything else is `malformed`, never
 * coerced: signs, spaces inside, grouping commas ('1,5'), multiple dots
 * ('1.2.3'), hex, and SCIENTIFIC NOTATION ('1e3') — rejected by design even
 * though Number() could parse it, because a money number must read exactly as
 * typed, with no notation that lets one stray keystroke change its magnitude
 * a thousandfold.
 *
 * The accepted window is [MIN_CUSTOM_FEE_RATE, MAX_ACCEPTED_FEE_RATE] — the
 * ceiling REFERENCES the F1 constant (never a re-typed literal, so the two
 * can never drift). Decimals are allowed: the engine's fee math is
 * fraction-safe (`ceil(vsize × rate)`). Out-of-range input is REJECTED, never
 * clamped — silently editing a number the user typed for money would make the
 * display lie about the transmission. The parse happens ONCE, here; only the
 * returned validated number ever reaches component state or PendingSend.
 */
export function classifyCustomFeeRate(text: string): CustomFeeRateClass {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  // The btcStringToSats shape: optional integer part, optional fractional
  // part, at least one digit, and nothing else (anchored both ends).
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || trimmed === '.') return { kind: 'malformed' };
  if ((match[1] ?? '') === '' && (match[2] ?? '') === '') return { kind: 'malformed' };
  const rate = Number(trimmed);
  // A matched plain decimal can still overflow Number (an absurd digit run →
  // Infinity); non-finite is out-of-range, same as any other too-big value.
  if (!Number.isFinite(rate)) return { kind: 'out-of-range' };
  if (rate < MIN_CUSTOM_FEE_RATE || rate > MAX_ACCEPTED_FEE_RATE) {
    return { kind: 'out-of-range' };
  }
  return { kind: 'valid', rate };
}

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
  const [feeChoice, setFeeChoice] = useState<FeeChoice>('standard');
  // The raw text in the custom-rate input. Kept even while a tier is selected
  // (switching away and back shouldn't eat what was typed), but it is INERT
  // then: feeRate below derives from it only when feeChoice === 'custom', so a
  // stale custom entry can never leak into a tier send.
  const [customFeeText, setCustomFeeText] = useState('');
  const [sendMax, setSendMax] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const spendableSats = props.account.confirmedSats;
  const addrClass = classifyAddress(address, props.network);

  // The custom text, parsed ONCE and validated ONCE; only the validated number
  // inside a 'valid' result ever flows onward (into feeRate, below).
  const customFee = useMemo<CustomFeeRateClass>(
    () => classifyCustomFeeRate(customFeeText),
    [customFeeText],
  );

  // THE single point where a fee rate enters the compose flow (F11): the tier
  // path (feeRateForTier's clamped output) and the custom path (the validated
  // user-typed rate) converge on this one value, which then feeds the SAME
  // estimateSendFee dry-run below, the SAME PendingSend.feeRateSatVb in
  // review(), and — via App's reviewNumbers/confirmSend — the SAME
  // buildAndSignTx/signAndBroadcast. No parallel fee computation anywhere.
  //
  // `null` means "no usable rate yet", and now covers BOTH paths symmetrically:
  // custom chosen with an empty/invalid input, OR a tier chosen while fee
  // estimates are unavailable. Either way every rate-derived preview goes dark
  // (F21 law: never a number at a rate nobody chose — the old rate-1 tier
  // placeholder is gone) and Review stays disabled via `feeRate !== null`.
  // A tier therefore implies live estimates, and custom implies a validated
  // typed rate — the one null-check downstream encodes the whole gate.
  const feeRate: number | null =
    feeChoice === 'custom'
      ? customFee.kind === 'valid'
        ? customFee.rate
        : null
      : props.fees
        ? feeRateForTier(props.fees, feeChoice)
        : null;

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

  // Exact dry-run of the engine's coin selection for the current compose state
  // (F11): the SAME code path buildAndSignTx uses — dust-fold, sendMax sweep,
  // and the consent flag included — so the compose fee and the high-fee
  // pre-check can never drift from the real build. Null when no selection is
  // possible yet (no amount, or insufficient funds — handled by other errors).
  const feeSelection = useMemo<FeeSelection | null>(() => {
    const utxos = props.account.utxos;
    // No usable rate (custom chosen but not validly entered) → no dry-run: we
    // never estimate at a rate the user didn't type.
    if (feeRate === null) return null;
    if (utxos.length === 0) return null;
    try {
      if (sendMax) {
        return estimateSendFee({ utxos, amountSats: 0n, feeRateSatVb: feeRate, sendMax: true });
      }
      if (amountSats === null || amountSats <= 0n) return null;
      return estimateSendFee({ utxos, amountSats, feeRateSatVb: feeRate });
    } catch {
      // InsufficientFunds → surfaced via the over-balance / too-small errors.
      return null;
    }
  }, [sendMax, amountSats, feeRate, props.account.utxos]);

  // Fee for the selected choice: the exact engine fee when a selection exists,
  // else a typical-size placeholder for display before an amount is entered.
  // Null when there is no usable rate at all — the fee/total displays then
  // render nothing (an honest blank beats a number at a rate nobody chose).
  const feeSats: bigint | null =
    feeSelection?.feeSats ??
    (feeRate === null ? null : BigInt(Math.ceil(TYPICAL_VSIZE * feeRate)));
  const feeUsd =
    props.btcUsd === null || feeSats === null ? null : satsToUsdString(feeSats, props.btcUsd);

  // Validation for enabling Review + inline errors.
  let amountError: string | null = null;
  if (!sendMax) {
    if (amountSats === null) amountError = null; // empty → helper, not error
    else if (amountSats === 0n) amountError = strings.send.needAmount;
    else if (amountSats < DUST_LIMIT_SATS) {
      const minUsd = props.btcUsd === null ? '0.50' : satsToUsdString(DUST_LIMIT_SATS, props.btcUsd);
      amountError = strings.send.dust(props.btcUsd === null ? '$0.50' : minUsd);
    } else if (feeSats !== null && amountSats + feeSats > spendableSats) {
      // With no usable rate the over-balance check simply waits: there is no
      // honest max-spendable without a fee, and Review is already held back by
      // the custom input's own error state.
      const maxSpendable = spendableSats > feeSats ? spendableSats - feeSats : 0n;
      amountError = strings.send.overBalance(fmtUsd(maxSpendable, props.btcUsd));
    }
  }

  const addressReady = addrClass === 'valid';
  const amountReady = sendMax
    ? feeSats !== null && spendableSats > feeSats + DUST_LIMIT_SATS
    : amountSats !== null && amountSats >= DUST_LIMIT_SATS && amountError === null;

  // F10 informed consent: will the build trip the fee-vs-amount percentage
  // rule? The flag comes straight from the engine's own dry-run selection
  // (F11), so it is exact — including the dust-fold band that a 2-output
  // estimate used to miss. When true, the normal Review button is held back and
  // an inline notice with the real numbers plus a "Send anyway" option
  // (allowHighFee) is shown instead.
  // No `props.fees` term here: feeSelection existing already implies a REAL
  // rate (a tier's live estimate or a validated custom entry — feeRate is null
  // otherwise), so the consent rule guards custom sends even while the
  // estimate endpoint is down. Dropping the old fees-null short-circuit is
  // load-bearing for the relaxed gate below: without it, a high-fee custom
  // send composed during an estimates outage would skip straight past consent.
  const highFee: boolean =
    amountReady && feeSelection !== null && feeSelection.needsHighFeeConsent;

  // Review needs a valid destination, a valid amount, a usable rate, and no
  // un-consented high-fee condition. `feeRate !== null` IS the fee gate for
  // both paths: a tier requires live estimates (feeRate is null without them),
  // while a VALID CUSTOM rate sends even when estimates are unavailable.
  //
  // That second half DELIBERATELY REMOVES a fail-closed rail (owner decision,
  // 2026-07-10): the old gate also required `props.fees !== null` for custom
  // sends, treating estimate availability as an endpoint-health signal.
  // Availability won: the user typed an explicit rate, the whole downstream
  // path (Review dry-run, broadcast build) consumes only that rate, and the
  // estimate endpoint being down shouldn't block self-directed sending. The
  // engine's hard fee guards (F1/F10) don't depend on estimates and stand
  // unchanged beneath this gate.
  const canReview = addressReady && amountReady && feeRate !== null && !highFee;

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
    // feeRate !== null repeats canReview's gate for the "Send anyway" entry
    // path too: no PendingSend can ever be built without a usable rate. It
    // mirrors canReview exactly — including the relaxed custom-while-
    // estimates-down path (see canReview for the availability reasoning).
    if (!(addressReady && amountReady && feeRate !== null)) return;
    if (highFee && !allowHighFee) return;
    const pending: PendingSend = {
      recipient: address.trim(),
      amountSats: sendMax ? spendableSats : (amountSats ?? 0n),
      // The SAME value the compose dry-run above used — tier or custom, this
      // is the one field the Review dry-run and the broadcast build consume
      // (F11), so displayed, previewed, and signed rates are one number.
      feeRateSatVb: feeRate,
      feeTier: feeChoice,
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

  // Total preview. (With no usable rate, feeSats is null and the total line is
  // not rendered — these fall back to 0n only to keep the math total.)
  const previewAmountSats = sendMax
    ? feeSats !== null && spendableSats > feeSats
      ? spendableSats - feeSats
      : 0n
    : (amountSats ?? 0n);
  const totalSats = sendMax ? spendableSats : previewAmountSats + (feeSats ?? 0n);

  // Real numbers for the high-fee notice: the fee (in USD, or sats when the
  // price is unavailable) and what share of the sent amount it represents.
  // Rendered only when highFee is true, which requires a live feeSelection —
  // so the 0n fallback never actually reaches the screen.
  const highFeeFeeSats = feeSelection?.feeSats ?? 0n;
  const highFeeFeeStr =
    props.btcUsd !== null ? fmtUsd(highFeeFeeSats, props.btcUsd) : fmtSats(highFeeFeeSats);
  const highFeePct =
    previewAmountSats > 0n ? Number((highFeeFeeSats * 100n) / previewAmountSats) : 0;

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
          {sendMax && feeSats !== null ? (
            // F21: the sweep amount is spendable-minus-fee, so with no usable
            // rate (custom chosen, not validly entered) there is no honest
            // number to show — go dark like every other rate-derived preview,
            // never a fabricated $0.00.
            <div className="amount-conv">
              {fmtUsd(previewAmountSats, props.btcUsd)} · {fmtBtc(previewAmountSats)} BTC
            </div>
          ) : !sendMax && conversion ? (
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
              // The clamped rate this tier would actually use — the SAME value
              // feeRateForTier feeds the engine (its second F1 guard), so the
              // sat/vB shown on the chip can never disagree with the rate that
              // gets signed. Null while estimates are unavailable: the chip
              // then shows NO cost and NO rate (F21 law — the old rate-1
              // "typical" placeholder fabricated a cost nobody chose, which
              // matters more now that fees-null is a reachable SENDING state
              // via the custom path) and is disabled: a speed that cannot be
              // priced cannot be picked. The Custom chip below stays live —
              // it is the working path during an estimates outage.
              const tierRate = props.fees ? feeRateForTier(props.fees, c.tier) : null;
              const chipFeeUsd =
                tierRate === null || props.btcUsd === null
                  ? ''
                  : fmtUsd(BigInt(Math.ceil(TYPICAL_VSIZE * tierRate)), props.btcUsd);
              return (
                <button
                  key={c.tier}
                  className={`fee ${feeChoice === c.tier ? 'fee--sel' : ''}`}
                  onClick={() => setFeeChoice(c.tier)}
                  aria-pressed={feeChoice === c.tier}
                  disabled={props.fees === null}
                >
                  <div className="fee__title">{c.title}</div>
                  <div className="fee__sub">
                    {c.time}
                    <br />
                    {chipFeeUsd ? `≈ ${chipFeeUsd}` : ''}
                  </div>
                  {tierRate !== null ? (
                    <div className="fee__rate">{strings.send.feeRate(tierRate)}</div>
                  ) : null}
                </button>
              );
            })}
            {/* The fourth choice: the user's own rate. Its rate line and USD
                hint appear ONLY once the typed rate validates — the chip never
                previews a number the user didn't successfully enter (the same
                displayed = transmitted honesty rule as the tier chips). */}
            <button
              className={`fee ${feeChoice === 'custom' ? 'fee--sel' : ''}`}
              onClick={() => setFeeChoice('custom')}
              aria-pressed={feeChoice === 'custom'}
            >
              <div className="fee__title">{strings.send.feeCustom}</div>
              <div className="fee__sub">
                {strings.send.feeCustomSub}
                <br />
                {customFee.kind === 'valid' && props.btcUsd !== null
                  ? `≈ ${fmtUsd(BigInt(Math.ceil(TYPICAL_VSIZE * customFee.rate)), props.btcUsd)}`
                  : ''}
              </div>
              {customFee.kind === 'valid' ? (
                <div className="fee__rate">{strings.send.feeRate(customFee.rate)}</div>
              ) : null}
            </button>
          </div>
          {props.fees === null ? (
            // Estimates outage: name it and point at the one live path, so the
            // disabled tier chips read as "unavailable", never as broken.
            <p className="small" style={{ marginTop: 'var(--sp-2)' }}>
              {strings.send.feesUnavailable}
            </p>
          ) : null}
          {feeChoice === 'custom' ? (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <label className="label" htmlFor="send-custom-fee">
                {strings.send.customFeeLabel}
              </label>
              <div
                className={`input-wrap ${customFee.kind === 'valid' ? 'input-wrap--valid' : ''} ${
                  customFee.kind === 'malformed' || customFee.kind === 'out-of-range'
                    ? 'input-wrap--error'
                    : ''
                }`}
                style={{ alignItems: 'baseline' }}
              >
                <input
                  id="send-custom-fee"
                  className="input"
                  value={customFeeText}
                  onChange={(e) => setCustomFeeText(e.target.value)}
                  placeholder={strings.send.customFeePlaceholder}
                  inputMode="decimal"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={strings.send.customFeeLabel}
                />
                <span className="small">{strings.send.customFeeUnit}</span>
              </div>
              {customFee.kind === 'malformed' ? (
                <p className="error-text">{strings.send.customFeeMalformed}</p>
              ) : customFee.kind === 'out-of-range' ? (
                <p className="error-text">
                  {strings.send.customFeeOutOfRange(
                    String(MIN_CUSTOM_FEE_RATE),
                    String(MAX_ACCEPTED_FEE_RATE),
                  )}
                </p>
              ) : customFee.kind === 'valid' && customFee.rate < 1 ? (
                // Sub-1 slow-lane hint: informational only, never a consent
                // gate — Review stays enabled (the 25% fee-vs-amount rule is
                // the only consent flow on this screen).
                <p className="small">{strings.send.customFeeSlowHint}</p>
              ) : (
                <p className="small">
                  {strings.send.customFeeExplainer(
                    String(MIN_CUSTOM_FEE_RATE),
                    String(MAX_ACCEPTED_FEE_RATE),
                  )}
                </p>
              )}
            </div>
          ) : null}
          {props.btcUsd !== null && feeSats !== null && (amountReady || sendMax) ? (
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
