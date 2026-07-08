import type { JSX } from 'react';
import { strings } from '../strings';
import { StatusPill } from './ui';
import { fmtUsd } from '../display';
import type { ActivityItem } from '../lib/account';

/** Human relative time from a unix-seconds timestamp, or "Just now" for pending. */
export function relativeTime(blockTime: number | undefined): string {
  if (blockTime === undefined) return 'Just now';
  const then = blockTime * 1000;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A single activity row: direction icon, label, relative time, amount, status. */
export function ActivityRow(props: {
  item: ActivityItem;
  btcUsd: number | null;
  onClick?: () => void;
}): JSX.Element {
  const received = props.item.netSats >= 0n;
  const abs = received ? props.item.netSats : -props.item.netSats;
  const status = props.item.confirmed ? 'confirmed' : 'waiting';
  const sign = received ? '+' : '-';

  return (
    <button className="row" onClick={props.onClick}>
      <span className={`row__ico ${received ? 'row__ico--in' : 'row__ico--out'}`} aria-hidden="true">
        {received ? '↙' : '↗'}
      </span>
      <span className="row__main">
        <span className="row__title">
          {received ? strings.activity.received : strings.activity.sent}
        </span>
        <span className="row__sub">{relativeTime(props.item.blockTime)}</span>
      </span>
      <span className="row__val">
        <span className={`row__amount ${received ? 'row__amount--pos' : ''}`}>
          {sign}
          {fmtUsd(abs, props.btcUsd)}
        </span>
        <span className="row__status">
          <StatusPill status={status} />
        </span>
      </span>
    </button>
  );
}
