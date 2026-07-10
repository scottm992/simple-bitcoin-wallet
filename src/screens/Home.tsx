import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { Balance } from '../components/Balance';
import { ActivityRow } from '../components/ActivityRow';
import { fmtUsd, type DisplayUnit } from '../display';
import type { AccountSnapshot } from '../lib/account';
import type { LoadStatus } from '../state';
import type { Network } from '../lib';

/** Home: balance hero, Receive/Send, recent activity preview. */
export function Home(props: {
  network: Network;
  account: AccountSnapshot | null;
  accountStatus: LoadStatus;
  /** False while only the fast partial scan is on screen (F12): show a cue. */
  accountComplete: boolean;
  btcUsd: number | null;
  unit: DisplayUnit;
  onCycleUnit: (u: DisplayUnit) => void;
  firstVisit: boolean;
  onReceive: () => void;
  onSend: () => void;
  onSeeAll: () => void;
  onOpenActivity: (txid: string) => void;
  onSettings: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const [dismissedHint, setDismissedHint] = useState(false);
  const practice = props.network === 'testnet';
  const confirmed = props.account?.confirmedSats ?? 0n;
  const pending = props.account?.pendingSats ?? 0n;
  // F9: reflect net pending (including OUTGOING unconfirmed) in the hero, so
  // right after a send the balance no longer implies the money is still here.
  // Clamp at 0 so the amount formatters (which reject negatives) never throw;
  // in practice confirmed always covers an outgoing pending amount.
  const netSats = confirmed + pending;
  const totalSats = netSats > 0n ? netSats : 0n;
  // Break pending into its outgoing / incoming parts for an explicit label.
  const pendingOut = pending < 0n ? -pending : 0n;
  const pendingIn = pending > 0n ? pending : 0n;
  // §1e: gate on whether we HAVE an account snapshot, not on accountStatus.
  // A background refresh flips accountStatus to 'loading' every ~30s; keying the
  // empty-nudge/activity layout off that made Home visibly swap between them on
  // every poll. `account !== null` is stable across a background refresh, so the
  // layout holds steady while the balance quietly updates underneath.
  const isEmpty = props.account !== null && totalSats === 0n && pending === 0n;
  const activity = props.account?.activity ?? [];
  const recent = activity.slice(0, 3);

  return (
    <Chrome
      network={props.network}
      brand
      right={
        <button className="topbar__gear" onClick={props.onSettings} aria-label={strings.common.settings}>
          ⚙
        </button>
      }
    >
      <div className="screen-body">
        <Balance
          confirmedSats={totalSats}
          btcUsd={props.btcUsd}
          unit={props.unit}
          onCycle={(u) => {
            setDismissedHint(true);
            props.onCycleUnit(u);
          }}
          showHint={props.firstVisit && !dismissedHint}
          practice={practice}
          loading={props.accountStatus === 'loading' && props.account === null}
        />

        {props.account !== null && !props.accountComplete ? (
          <div className="pending-line pending-line--checking" role="status">
            {strings.home.stillChecking}
          </div>
        ) : null}
        {props.accountStatus === 'ready' && pendingOut > 0n ? (
          <div className="pending-line pending-line--out">
            {strings.home.pendingOut(fmtUsd(pendingOut, props.btcUsd))}
          </div>
        ) : null}
        {props.accountStatus === 'ready' && pendingIn > 0n ? (
          <div className="pending-line pending-line--in">
            {strings.home.pendingIn(fmtUsd(pendingIn, props.btcUsd))}
          </div>
        ) : null}

        <div className="verb-row">
          <button className="verb" onClick={props.onReceive}>
            <span className="verb__ico" aria-hidden="true">
              ↙
            </span>
            <span className="verb__title">{strings.home.receive}</span>
            <span className="verb__sub">{strings.home.receiveSub}</span>
          </button>
          <button className="verb" onClick={props.onSend}>
            <span className="verb__ico" aria-hidden="true">
              ↗
            </span>
            <span className="verb__title">{strings.home.send}</span>
            <span className="verb__sub">{strings.home.sendSub}</span>
          </button>
        </div>

        {props.accountStatus === 'error' ? (
          <div className="callout nudge">
            <div className="callout__body">{strings.errors.network}</div>
            <button
              className="btn btn--text"
              style={{ marginTop: 'var(--sp-2)', padding: 0 }}
              onClick={props.onRefresh}
            >
              {strings.common.tryAgain}
            </button>
          </div>
        ) : isEmpty ? (
          <div className="callout nudge">
            <div className="callout__title">{strings.home.emptyBalanceHeading}</div>
            <div className="callout__body">{strings.home.emptyBalanceBody}</div>
          </div>
        ) : null}

        {!isEmpty && props.accountStatus !== 'error' ? (
          <>
            <div className="act-head">
              <span className="act-head__title">{strings.home.recentActivity}</span>
              {activity.length > 0 ? (
                <button className="act-head__see" onClick={props.onSeeAll}>
                  {strings.home.seeAll}
                </button>
              ) : null}
            </div>
            {recent.length === 0 ? (
              <div className="small">
                {strings.home.emptyActivity} {strings.home.emptyActivityBody}
              </div>
            ) : (
              recent.map((item) => (
                <ActivityRow
                  key={item.txid}
                  item={item}
                  btcUsd={props.btcUsd}
                  onClick={() => props.onOpenActivity(item.txid)}
                />
              ))
            )}
          </>
        ) : null}
      </div>
    </Chrome>
  );
}
