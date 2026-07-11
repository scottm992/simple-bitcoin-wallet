import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { ActivityRow, relativeTime } from '../components/ActivityRow';
import { AddressChunk, CheckRow, Sheet, StatusPill } from '../components/ui';
import { fmtBtc, fmtSats, fmtUsd } from '../display';
import {
  apiBaseUrl,
  CannotBumpError,
  estimateBumpFee,
  InvalidTxParamsError,
  type BumpFeeEstimate,
} from '../lib';
import { feeRateForTier, type PreparedBump } from '../actions';
import type { AccountSnapshot, ActivityItem } from '../lib/account';
import type { FeeEstimates, Network } from '../lib';
import type { LoadStatus } from '../state';
import {
  bumpConsents,
  deadEndCopy,
  deadEndFromReason,
  isHardFeeCap,
  isSpeedUpEligible,
  type SpeedUpDeadEnd,
} from './speedUp';

/** Groups an item by a coarse date bucket for the section headers. */
function dateBucket(blockTime: number | undefined): string {
  if (blockTime === undefined) return 'Pending';
  const then = new Date(blockTime * 1000);
  const now = new Date();
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/** Full activity history, grouped by date, with a per-item detail sheet. */
export function Activity(props: {
  network: Network;
  items: readonly ActivityItem[];
  status: LoadStatus;
  btcUsd: number | null;
  /** The current account snapshot — needed to prepare a fee bump (owned-address map). */
  account: AccountSnapshot | null;
  /** Current fee estimates — the bump's new fee comes from the fast tier. */
  fees: FeeEstimates | null;
  /** Gathers everything needed to speed up a pending payment (one network fetch). */
  onPrepareBump: (txid: string, signal?: AbortSignal) => Promise<PreparedBump>;
  /** Builds + broadcasts the boosted replacement, then refreshes the account. */
  onBumpConfirm: (prepared: PreparedBump, feeRateSatVb: number, allowHighFee: boolean) => Promise<void>;
  onBack: () => void;
  onRefresh: () => void;
  /**
   * A transaction to open the detail sheet for ON ARRIVAL — set when the user
   * tapped a specific row on Home (which navigates here). One-shot: consumed
   * via {@link onInitialTxidShown} so closing the sheet or leaving and coming
   * back never re-opens it. Unknown txid (the list refreshed between tap and
   * mount) degrades to the plain list.
   */
  initialTxid?: string | null;
  /** Called once after mount when `initialTxid` was provided (consumed). */
  onInitialTxidShown?: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<ActivityItem | null>(
    // Seeded from the Home tap (if any): the user asked for THIS payment's
    // details, not the list — landing on the list instead was the bug.
    () => props.items.find((i) => i.txid === props.initialTxid) ?? null,
  );
  const consumeInitial = props.onInitialTxidShown;
  const hadInitial = props.initialTxid != null;
  useEffect(() => {
    if (hadInitial) consumeInitial?.();
    // One-shot on mount by design (the seed above only runs on first render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build ordered groups preserving the newest-first order of items.
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const item of props.items) {
    const label = dateBucket(item.blockTime);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <Chrome network={props.network} onBack={props.onBack} title={strings.activity.title}>
      <div className="screen-body">
        <h1 className="h1">{strings.activity.heading}</h1>

        {props.status === 'error' ? (
          <div className="callout nudge">
            <div className="callout__body">{strings.activity.loadError}</div>
            <button
              className="btn btn--text"
              style={{ marginTop: 'var(--sp-2)', padding: 0 }}
              onClick={props.onRefresh}
            >
              {strings.common.tryAgain}
            </button>
          </div>
        ) : props.items.length === 0 ? (
          <div className="callout nudge">
            <div className="callout__title">{strings.activity.empty}</div>
            <div className="callout__body">{strings.activity.emptyBody}</div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <div className="date-group">{g.label}</div>
              {g.items.map((item) => (
                <ActivityRow
                  key={item.txid}
                  item={item}
                  btcUsd={props.btcUsd}
                  onClick={() => setSelected(item)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {selected ? (
        <DetailSheet
          network={props.network}
          item={selected}
          btcUsd={props.btcUsd}
          account={props.account}
          fees={props.fees}
          onPrepareBump={props.onPrepareBump}
          onBumpConfirm={props.onBumpConfirm}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Chrome>
  );
}

/**
 * The per-item detail sheet, plus the self-contained "Speed up this payment"
 * sub-flow for pending outgoing payments. The sub-flow is a small local state
 * machine — never a new reducer action — because it is entirely contained in
 * this sheet: loading → offer / dead-end / error, then confirm → success / fail.
 * On success we keep the confirmation on screen and let the account refresh
 * underneath (see the flow comment on `phase`), so the moment the old payment is
 * replaced by a new id never flashes a scary intermediate state.
 */
type BumpOffer = { prepared: PreparedBump; est: BumpFeeEstimate; feeRate: number };

type Phase =
  | { k: 'detail' }
  | { k: 'loading' }
  | ({ k: 'offer' } & BumpOffer)
  | { k: 'deadend'; kind: SpeedUpDeadEnd }
  | { k: 'error' }
  | { k: 'success' }
  | ({ k: 'fail' } & BumpOffer);

function DetailSheet(props: {
  network: Network;
  item: ActivityItem;
  btcUsd: number | null;
  account: AccountSnapshot | null;
  fees: FeeEstimates | null;
  onPrepareBump: (txid: string, signal?: AbortSignal) => Promise<PreparedBump>;
  onBumpConfirm: (prepared: PreparedBump, feeRateSatVb: number, allowHighFee: boolean) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const received = props.item.netSats >= 0n;
  const abs = received ? props.item.netSats : -props.item.netSats;
  const explorerUrl = `${apiBaseUrl(props.network).replace(/\/api$/, '')}/tx/${props.item.txid}`;

  const [phase, setPhase] = useState<Phase>({ k: 'detail' });
  // Synchronous busy flag (the Review-screen house standard) — set true before
  // the await so a second tap of the confirm button can't fire a second bump.
  const [submitting, setSubmitting] = useState(false);
  const [reducesChecked, setReducesChecked] = useState(false);
  const [highFeeChecked, setHighFeeChecked] = useState(false);

  // Guard async setState after the sheet is dismissed, and cancel any in-flight
  // prepare fetch on unmount (funds are safe either way — nothing was sent).
  const aliveRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function startSpeedUp(): Promise<void> {
    // Fees + account come from the same network that fills this screen; if
    // either is momentarily missing, treat it as a transient hiccup with a
    // retry, rather than guessing a fee.
    if (props.account === null || props.fees === null) {
      setPhase({ k: 'error' });
      return;
    }
    setPhase({ k: 'loading' });
    setSubmitting(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const prepared = await props.onPrepareBump(props.item.txid, controller.signal);
      if (!aliveRef.current || controller.signal.aborted) return;
      const feeRate = feeRateForTier(props.fees, 'faster');
      // The estimate the sheet displays is the SAME one buildRbfBumpTx will
      // consume for this rate + prepared data (single code path, F11), so the
      // numbers on screen and the signed replacement cannot disagree.
      const est = estimateBumpFee({
        utxos: prepared.utxos,
        recipientAmountSats: prepared.recipientAmountSats,
        hasChangeOutput: prepared.changeAddress !== null,
        oldFeeSats: prepared.oldFeeSats,
        oldVsize: prepared.oldVsize,
        feeRateSatVb: feeRate,
      });
      if (isHardFeeCap(est)) {
        setPhase({ k: 'deadend', kind: 'fee-cap' });
        return;
      }
      setReducesChecked(false);
      setHighFeeChecked(false);
      setPhase({ k: 'offer', prepared, est, feeRate });
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof CannotBumpError) {
        setPhase({ k: 'deadend', kind: deadEndFromReason(err.reason) });
      } else if (err instanceof InvalidTxParamsError) {
        // The payment doesn't reconcile to a shape we can bump — honest dead-end.
        setPhase({ k: 'deadend', kind: 'cannot' });
      } else {
        // Network failure: funds are safe, nothing was sent.
        setPhase({ k: 'error' });
      }
    }
  }

  async function confirmBump(offer: BumpOffer): Promise<void> {
    if (submitting) return;
    const consents = bumpConsents(offer.est);
    if (consents.reducesLess && !reducesChecked) return;
    if (consents.highFee && !highFeeChecked) return;
    setSubmitting(true);
    try {
      // allowHighFee is true only when the 25% rule tripped AND the user checked
      // the acknowledgment (the button is gated on it); it never bypasses the
      // engine's hard rate/absolute caps.
      await props.onBumpConfirm(offer.prepared, offer.feeRate, consents.highFee);
      if (!aliveRef.current) return;
      setPhase({ k: 'success' });
    } catch {
      if (!aliveRef.current) return;
      setSubmitting(false);
      setPhase({ k: 'fail', ...offer });
    }
  }

  // ---- Speed-up sub-flow states (rendered inside the single Sheet) ----------

  if (phase.k === 'loading') {
    // Dismissable via scrim (aborts the fetch); no button needed for a transient.
    return (
      <Sheet onScrim={props.onClose}>
        <h2 className="sheet__title">{strings.speedUp.title}</h2>
        <p className="sheet__body">{strings.speedUp.checking}</p>
      </Sheet>
    );
  }

  if (phase.k === 'offer' || phase.k === 'fail') {
    const offer: BumpOffer = { prepared: phase.prepared, est: phase.est, feeRate: phase.feeRate };
    const { est } = offer;
    const consents = bumpConsents(est);
    const money = (sats: bigint): string =>
      props.btcUsd !== null ? fmtUsd(sats, props.btcUsd) : fmtSats(sats);
    const extraStr = money(est.extraFeeSats);
    const lessStr = money(est.reducesRecipientBy);
    const newFeeStr = money(est.newFeeSats);
    const pct =
      est.newRecipientAmountSats > 0n ? Number((est.newFeeSats * 100n) / est.newRecipientAmountSats) : 0;
    const canConfirm =
      !submitting &&
      (!consents.reducesLess || reducesChecked) &&
      (!consents.highFee || highFeeChecked);

    if (phase.k === 'fail') {
      // Broadcast failed: funds safe, nothing sent. Mirror Send's retry sheet.
      return (
        <Sheet {...(submitting ? {} : { onScrim: props.onClose })}>
          <h2 className="sheet__title">{strings.speedUp.failHeading}</h2>
          <p className="sheet__body">{strings.speedUp.failBody}</p>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              disabled={submitting}
              onClick={() => void confirmBump(offer)}
            >
              {submitting ? strings.speedUp.confirming : strings.common.tryAgain}
            </button>
            <button
              className="btn btn--text btn--block"
              disabled={submitting}
              onClick={() => setPhase({ k: 'offer', ...offer })}
            >
              {strings.common.goBack}
            </button>
          </div>
        </Sheet>
      );
    }

    return (
      <Sheet {...(submitting ? {} : { onScrim: props.onClose })}>
        <h2 className="sheet__title">{strings.speedUp.title}</h2>
        <p className="sheet__body">{strings.speedUp.offerBody}</p>

        {/* F15: re-confirm the DESTINATION, not just the fees. The address is
            the one the wallet verified against its own send record; showing it
            chunked (the Review-screen pattern) keeps the user in the loop even
            though the check is mechanical. */}
        <label className="label" style={{ marginTop: 'var(--sp-3)' }}>
          {strings.speedUp.destinationLabel}
        </label>
        <div style={{ marginTop: 'var(--sp-2)' }}>
          <AddressChunk address={offer.prepared.recipient} />
        </div>

        <div className="rev-block" style={{ marginTop: 'var(--sp-3)' }}>
          <FeeRow
            label={strings.speedUp.destinationAmountLabel}
            sats={est.newRecipientAmountSats}
            btcUsd={props.btcUsd}
          />
          <FeeRow label={strings.speedUp.feePaidLabel} sats={est.oldFeeSats} btcUsd={props.btcUsd} />
          <FeeRow label={strings.speedUp.newFeeLabel} sats={est.newFeeSats} btcUsd={props.btcUsd} />
          <FeeRow
            label={strings.speedUp.extraCostLabel}
            sats={est.extraFeeSats}
            btcUsd={props.btcUsd}
            total
          />
        </div>

        {consents.reducesLess ? (
          <>
            <div className="warn" role="alert">
              <div className="warn__text">{strings.speedUp.reducesWarning(lessStr)}</div>
            </div>
            <CheckRow
              checked={reducesChecked}
              onToggle={() => setReducesChecked((c) => !c)}
              label={strings.speedUp.reducesCheckbox}
            />
          </>
        ) : null}

        {consents.highFee ? (
          <>
            <div className="warn" role="alert">
              <div className="warn__text">{strings.speedUp.highFeeNotice(newFeeStr, String(pct))}</div>
            </div>
            <CheckRow
              checked={highFeeChecked}
              onToggle={() => setHighFeeChecked((c) => !c)}
              label={strings.speedUp.highFeeCheckbox}
            />
          </>
        ) : null}

        <div className="sheet__actions">
          <button
            className="btn btn--primary btn--block"
            disabled={!canConfirm}
            onClick={() => void confirmBump(offer)}
          >
            {submitting ? strings.speedUp.confirming : strings.speedUp.confirm(extraStr)}
          </button>
          <button
            className="btn btn--text btn--block"
            disabled={submitting}
            onClick={() => setPhase({ k: 'detail' })}
          >
            {strings.speedUp.notNow}
          </button>
        </div>
      </Sheet>
    );
  }

  if (phase.k === 'deadend') {
    return (
      <Sheet onScrim={props.onClose}>
        <h2 className="sheet__title">{strings.speedUp.title}</h2>
        <p className="sheet__body">{deadEndCopy(phase.kind)}</p>
        <div className="sheet__actions">
          <button className="btn btn--primary btn--block" onClick={props.onClose}>
            {strings.speedUp.close}
          </button>
        </div>
      </Sheet>
    );
  }

  if (phase.k === 'error') {
    return (
      <Sheet onScrim={props.onClose}>
        <h2 className="sheet__title">{strings.speedUp.errorHeading}</h2>
        <p className="sheet__body">{strings.speedUp.errorBody}</p>
        <div className="sheet__actions">
          <button className="btn btn--primary btn--block" onClick={() => void startSpeedUp()}>
            {strings.common.tryAgain}
          </button>
          <button className="btn btn--text btn--block" onClick={props.onClose}>
            {strings.speedUp.close}
          </button>
        </div>
      </Sheet>
    );
  }

  if (phase.k === 'success') {
    return (
      <Sheet onScrim={props.onClose}>
        <h2 className="sheet__title">{strings.speedUp.successHeading}</h2>
        <p className="sheet__body">{strings.speedUp.successBody}</p>
        <div className="sheet__actions">
          <button className="btn btn--primary btn--block" onClick={props.onClose}>
            {strings.common.done}
          </button>
        </div>
      </Sheet>
    );
  }

  // ---- Default: the payment detail (with the Speed-up entry point) ----------
  const canSpeedUp = props.account !== null && isSpeedUpEligible(props.item);

  return (
    <Sheet onScrim={props.onClose}>
      <h2 className="sheet__title">{received ? strings.activity.received : strings.activity.sent}</h2>
      <div className="rev-block" style={{ marginTop: 'var(--sp-3)' }}>
        <div className="rev-row">
          <span className="rev-row__k">Amount</span>
          <span className="rev-row__v">
            {received ? '+' : '-'}
            {fmtUsd(abs, props.btcUsd)}
            <br />
            <span className="rev-row__v-sub">{fmtBtc(abs)} BTC</span>
          </span>
        </div>
        <div className="rev-row">
          <span className="rev-row__k">Status</span>
          <span className="rev-row__v">
            <StatusPill status={props.item.confirmed ? 'confirmed' : 'waiting'} />
          </span>
        </div>
        <div className="rev-row">
          <span className="rev-row__k">When</span>
          <span className="rev-row__v">{relativeTime(props.item.blockTime)}</span>
        </div>
      </div>

      <p className="small" style={{ marginTop: 'var(--sp-3)' }}>
        {props.item.confirmed ? strings.activity.statusConfirmed : strings.activity.statusWaiting}
      </p>

      <div className="sheet__actions">
        {canSpeedUp ? (
          <button className="btn btn--primary btn--block" onClick={() => void startSpeedUp()}>
            {strings.speedUp.cta}
          </button>
        ) : null}
        <a
          className="btn btn--secondary btn--block"
          href={explorerUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {strings.activity.viewExplorer}
        </a>
        <button className="btn btn--text btn--block" onClick={props.onClose}>
          {strings.common.done}
        </button>
      </div>
    </Sheet>
  );
}

/** One offer row: a label with USD as the hero and sats beneath (per DESIGN §3). */
function FeeRow(props: {
  label: string;
  sats: bigint;
  btcUsd: number | null;
  total?: boolean;
}): JSX.Element {
  return (
    <div className={`rev-row ${props.total ? 'rev-row--total' : ''}`}>
      <span className="rev-row__k">{props.label}</span>
      <span className="rev-row__v">
        {fmtUsd(props.sats, props.btcUsd)}
        <br />
        <span className="rev-row__v-sub">{fmtSats(props.sats)}</span>
      </span>
    </div>
  );
}
