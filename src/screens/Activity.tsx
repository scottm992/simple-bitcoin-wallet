import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { ActivityRow, relativeTime } from '../components/ActivityRow';
import { Sheet, StatusPill } from '../components/ui';
import { fmtBtc, fmtUsd } from '../display';
import { apiBaseUrl } from '../lib';
import type { ActivityItem } from '../lib/account';
import type { LoadStatus } from '../state';
import type { Network } from '../lib';

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
  onBack: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<ActivityItem | null>(null);

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
          <p className="sub">{strings.activity.loadError}</p>
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
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Chrome>
  );
}

function DetailSheet(props: {
  network: Network;
  item: ActivityItem;
  btcUsd: number | null;
  onClose: () => void;
}): JSX.Element {
  const received = props.item.netSats >= 0n;
  const abs = received ? props.item.netSats : -props.item.netSats;
  const explorerUrl = `${apiBaseUrl(props.network).replace(/\/api$/, '')}/tx/${props.item.txid}`;

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
