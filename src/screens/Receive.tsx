import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { Qr } from '../components/Qr';
import { AddressChunk, Toast, copyToClipboard } from '../components/ui';
import { bitcoinUri } from '../display';
import type { Network } from '../lib';

/** Receive: QR + chunked address + copy/share. */
export function Receive(props: {
  network: Network;
  address: string;
  /** Cycle to the next unused receive address (privacy-curious). */
  onNewAddress?: () => void;
  onBack: () => void;
}): JSX.Element {
  const [toast, setToast] = useState<string | null>(null);
  const practice = props.network === 'testnet';

  // Fresh-address nudge (roadmap, owner request): the ROTATION itself already
  // happens with zero new machinery — this screen renders the snapshot's
  // next-unused address, so when the 30s poll notices a payment and the
  // refreshed snapshot advances the index, the address/QR here updates on the
  // spot (derivation stays local; zero extra requests). What was missing is
  // the EXPLANATION: without it the address silently swaps under the user
  // mid-copy. So: remember the last (network, address) shown, and when the
  // address changes IN PLACE — same network, a real address before and after —
  // show a one-time reassurance notice. Guards, and why each exists:
  //  - same network only: a network switch shows a different chain's address,
  //    not a used one (unreachable while mounted today — Settings is another
  //    screen — but belt-and-braces against future navigation changes);
  //  - both addresses non-empty: the fallback→snapshot fill-in on a flaky
  //    first load is loading progress, not a rotation (F12-era lesson: never
  //    dress loading up as a state change);
  //  - the ref starts as the CURRENT props, so an ordinary mount can never
  //    fire it — only a change observed live counts.
  // The notice is honest for the rare cross-device case too: if a snapshot
  // advances because another device's copy of this wallet got paid, the shown
  // address really was used — the copy stays true.
  const [rotated, setRotated] = useState(false);
  const lastShown = useRef({ network: props.network, address: props.address });
  useEffect(() => {
    const prev = lastShown.current;
    lastShown.current = { network: props.network, address: props.address };
    if (
      prev.network === props.network &&
      prev.address !== props.address &&
      prev.address.trim() !== '' &&
      props.address.trim() !== ''
    ) {
      setRotated(true);
    }
  }, [props.network, props.address]);

  async function copy(): Promise<void> {
    const ok = await copyToClipboard(props.address);
    if (ok) setToast(strings.receive.copyToast);
  }

  async function share(): Promise<void> {
    const uri = bitcoinUri(props.address);
    // Use the Web Share API where available; otherwise fall back to copy.
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: strings.receive.heading, text: props.address, url: uri });
        return;
      } catch {
        /* user cancelled or share failed; fall through to copy */
      }
    }
    await copy();
  }

  // No address at all (should not normally happen — the parent falls back to a
  // locally derived address even offline). Never render an empty address row
  // or a QR that encodes nothing a payer could mistakenly scan.
  if (props.address.trim() === '') {
    return (
      <Chrome network={props.network} onBack={props.onBack} title={strings.receive.title}>
        <div className="screen-body">
          <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
            {strings.receive.heading}
          </h1>
          <div className="callout">
            <div className="callout__body">{strings.receive.unavailable}</div>
          </div>
        </div>
      </Chrome>
    );
  }

  return (
    <Chrome network={props.network} onBack={props.onBack} title={strings.receive.title}>
      <div className="screen-body">
        <h1 className="h1" style={{ fontSize: 'var(--fs-heading)' }}>
          {strings.receive.heading}
        </h1>
        <p className="sub">{strings.receive.body}</p>

        {rotated ? (
          // role="status": screen readers announce the rotation politely
          // without stealing focus from whatever the user was doing.
          <div className="callout" role="status">
            <div className="callout__body">{strings.receive.rotatedNotice}</div>
          </div>
        ) : null}

        <Qr data={bitcoinUri(props.address)} />

        <AddressChunk address={props.address} onCopy={copy} />

        {props.onNewAddress ? (
          <button
            className="btn btn--text"
            style={{ alignSelf: 'center', fontSize: 'var(--fs-small)' }}
            onClick={props.onNewAddress}
          >
            {strings.receive.newAddress}
          </button>
        ) : null}

        <div className="bottom-actions">
          <button className="btn btn--primary btn--block" onClick={copy}>
            {strings.receive.copy}
          </button>
          <button className="btn btn--secondary btn--block" onClick={share}>
            {strings.receive.share}
          </button>
          <p className="small" style={{ textAlign: 'center' }}>
            {strings.receive.note}
            {practice ? ` ${strings.receive.practiceNote}` : ''}
          </p>
        </div>
      </div>

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
