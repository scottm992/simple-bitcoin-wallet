import type { JSX } from 'react';
import { useState } from 'react';
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
