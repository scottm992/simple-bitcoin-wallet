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

/**
 * True when a QR payload carries no real content: empty/whitespace, or a bare
 * URI scheme with nothing after the colon (e.g. `bitcoin:`). Such a QR would
 * still render as a scannable code encoding nothing useful — a beginner could
 * show it to a payer — so we refuse to draw it at all.
 */
function isEmptyPayload(data: string): boolean {
  const trimmed = data.trim();
  return trimmed === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(trimmed);
}

export function Qr(props: { data: string }): JSX.Element {
  const svg = useMemo<string | null>(() => {
    // Never render a QR for an empty payload — a scannable code that encodes
    // nothing is worse than no code (belt-and-braces; the screen should have
    // handled this already).
    if (isEmptyPayload(props.data)) return null;
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
