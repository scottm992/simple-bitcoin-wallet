import type { JSX } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { fmtBtc, fmtUsd } from '../display';
import type { Network } from '../lib';

/** Send success: a calm confirmation of what happens next. */
export function Sent(props: {
  network: Network;
  amountSats: bigint;
  btcUsd: number | null;
  onDone: () => void;
  onViewActivity: () => void;
}): JSX.Element {
  return (
    <Chrome network={props.network}>
      <div className="screen-body">
        <div className="center-col">
          <div className="success-mark" aria-hidden="true">
            ✓
          </div>
          <h1 className="h1">{strings.sent.heading}</h1>
          <p className="sub">
            {strings.sent.body(fmtUsd(props.amountSats, props.btcUsd), fmtBtc(props.amountSats))}
          </p>
          <p className="small">{strings.sent.note}</p>
        </div>
        <div className="bottom-actions">
          <button className="btn btn--primary btn--block" onClick={props.onDone}>
            {strings.sent.done}
          </button>
          <button className="btn btn--text btn--block" onClick={props.onViewActivity}>
            {strings.sent.viewActivity}
          </button>
        </div>
      </div>
    </Chrome>
  );
}
