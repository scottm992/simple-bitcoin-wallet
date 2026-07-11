import type { JSX } from 'react';
import { strings } from '../strings';
import { fmtSats, fmtUsd } from '../display';
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

/**
 * A single activity row. Information hierarchy (owner design pass, 2026-07-10):
 * - LEFT: direction icon; what happened ("Received"/"Sent"); WHEN — except for
 *   a pending payment, where the sub-line becomes "Waiting to confirm" in the
 *   waiting color (the time would only say "Just now", and status-as-sub-line
 *   reads cleaner than a pill floating in the amount column).
 * - RIGHT: how much, twice — USD primary, sats secondary (it IS a bitcoin
 *   wallet, and the sats line keeps rows meaningful when the price is offline
 *   and fmtUsd degrades to "$—"). Tabular numerals so columns of digits align.
 * - NO pill on settled rows: confirmed is the default state of the world;
 *   only the exception spends ink. The StatusPill still lives on the Activity
 *   detail screen, where explicit status belongs.
 */
export function ActivityRow(props: {
  item: ActivityItem;
  btcUsd: number | null;
  onClick?: () => void;
}): JSX.Element {
  const received = props.item.netSats >= 0n;
  const abs = received ? props.item.netSats : -props.item.netSats;
  const pending = !props.item.confirmed;
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
        {pending ? (
          <span className="row__sub row__sub--wait">{strings.activity.waiting}</span>
        ) : (
          <span className="row__sub">{relativeTime(props.item.blockTime)}</span>
        )}
      </span>
      <span className="row__val">
        <span className={`row__amount ${received ? 'row__amount--pos' : ''}`}>
          {sign}
          {fmtUsd(abs, props.btcUsd)}
        </span>
        <span className="row__btc">{fmtSats(abs)}</span>
      </span>
    </button>
  );
}
