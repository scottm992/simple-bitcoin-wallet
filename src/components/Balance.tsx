import type { JSX } from 'react';
import { strings } from '../strings';
import { fmtBtcCompact, fmtSats, fmtUsd, nextUnit, type DisplayUnit } from '../display';

/**
 * The balance hero. USD leads; the secondary line shows BTC (or, when the hero
 * is BTC/sats, the appropriate alternate). Tapping cycles USD → BTC → sats.
 */
export function Balance(props: {
  confirmedSats: bigint;
  btcUsd: number | null;
  unit: DisplayUnit;
  onCycle: (next: DisplayUnit) => void;
  showHint: boolean;
  practice: boolean;
  loading: boolean;
}): JSX.Element {
  const sats = props.confirmedSats;

  let hero: string;
  let secondary: string;
  if (props.unit === 'usd') {
    hero = fmtUsd(sats, props.btcUsd);
    secondary = props.btcUsd === null ? '' : fmtBtcCompact(sats);
  } else if (props.unit === 'btc') {
    hero = fmtBtcCompact(sats);
    secondary = fmtUsd(sats, props.btcUsd);
  } else {
    hero = fmtSats(sats);
    secondary = fmtUsd(sats, props.btcUsd);
  }

  const priceLine =
    props.unit === 'usd' && props.btcUsd === null ? ` · ${strings.home.priceUnavailable}` : '';

  return (
    <div className="balance">
      <div className="balance__label">{strings.home.balanceLabel}</div>
      {props.loading ? (
        <div
          className="skeleton"
          style={{ height: 44, width: 160, margin: '10px auto 0' }}
          aria-label="Loading balance"
        />
      ) : (
        <button
          className={`balance__hero ${props.practice ? 'balance__hero--practice' : ''}`}
          onClick={() => props.onCycle(nextUnit(props.unit))}
          aria-label={`Balance ${hero}. Tap to change units.`}
        >
          {hero}
          {priceLine ? <span style={{ fontSize: 13, fontWeight: 500 }}>{priceLine}</span> : null}
        </button>
      )}
      {secondary ? <div className="balance__secondary">{secondary}</div> : null}
      {props.showHint ? <div className="balance__hint">{strings.home.switchHint}</div> : null}
    </div>
  );
}
