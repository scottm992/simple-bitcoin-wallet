/**
 * Qr.tsx — renders a `bitcoin:` URI as a locally-generated SVG QR code.
 *
 * Uses the paulmillr `qr` package (zero-dependency) to produce an SVG string in
 * the browser. No network, no external image. On failure we show a fallback
 * telling the user to copy the address instead.
 */
import type { JSX } from 'react';
import { useMemo } from 'react';
import encodeQR from 'qr';
import { strings } from '../strings';

export function Qr(props: { data: string }): JSX.Element {
  const svg = useMemo<string | null>(() => {
    try {
      // Medium error correction is plenty for an address; optimized single-path SVG.
      return encodeQR(props.data, 'svg', { ecc: 'medium', border: 1 });
    } catch {
      return null;
    }
  }, [props.data]);

  if (svg === null) {
    return (
      <div className="qr qr--error" role="img" aria-label={strings.receive.qrError}>
        {strings.receive.qrError}
      </div>
    );
  }

  // The SVG is generated locally by the qr package (trusted, no user HTML), and
  // contains only <svg>/<path>/<rect> shapes — safe to inject.
  return (
    <div
      className="qr"
      role="img"
      aria-label={strings.receive.qrAlt}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
