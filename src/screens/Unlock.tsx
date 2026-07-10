import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { PasswordInput, Sheet } from '../components/ui';
import type { Network } from '../lib';

/**
 * Unlock (returning user). The password field is ALWAYS visible. When Face ID
 * unlock is enabled (and the device supports it), the Face ID prompt is
 * auto-triggered exactly once on mount — never in a loop — with the password
 * path right below as the obvious fallback. A failed/cancelled Face ID attempt
 * falls back to the password silently: no scary error (Bug B). On success the
 * parent stores the mnemonic in session.ts; this screen never sees it.
 */
export function Unlock(props: {
  network: Network;
  passkeyEnabled: boolean;
  passkeySupported: boolean;
  onUnlockPassword: (password: string) => Promise<boolean>;
  onUnlockPasskey: () => Promise<boolean>;
  onRestore: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  // Face ID is offered only when it's both enabled for this vault AND the
  // device actually supports platform authenticators (feature detection).
  const faceId = props.passkeyEnabled && props.passkeySupported;

  async function tryPassword(): Promise<void> {
    if (password.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const ok = await props.onUnlockPassword(password);
    if (!ok) {
      setError(strings.unlock.wrongPassword);
      setBusy(false);
    }
  }

  async function tryPasskey(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = await props.onUnlockPasskey();
    if (!ok) {
      // Cancelled or failed: fall back to the password silently — the field is
      // right below, and Face ID can be retried with the button (Bug B).
      setBusy(false);
    }
  }

  // Auto-trigger Face ID exactly once on mount. The ref guard makes this
  // single-shot even under StrictMode's double-effect and across re-renders.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (!faceId || autoTriedRef.current) return;
    autoTriedRef.current = true;
    void tryPasskey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Chrome network={props.network} brand>
      <div className="screen-body">
        <div className="center-col" style={{ flex: '0 0 auto', marginTop: 'var(--sp-8)' }}>
          <div className="logo-mark" aria-hidden="true">
            ₿
          </div>
          <h1 className="h1">{strings.unlock.heading}</h1>
        </div>

        <div style={{ marginTop: 'var(--sp-8)' }}>
          <label className="label" htmlFor="unlock-pw">
            {strings.unlock.passwordLabel}
          </label>
          <div id="unlock-pw">
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              ariaLabel={strings.unlock.passwordLabel}
              invalid={error !== null}
              autoFocus={!faceId}
              onEnter={tryPassword}
            />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
        </div>

        <div className="bottom-actions">
          <button
            className="btn btn--primary btn--block"
            onClick={tryPassword}
            disabled={busy || password.length === 0}
          >
            {strings.unlock.unlock}
          </button>
          {faceId ? (
            <button className="btn btn--secondary btn--block" onClick={tryPasskey} disabled={busy}>
              {strings.unlock.usePasskey}
            </button>
          ) : null}
          <button className="btn btn--text btn--block" onClick={() => setShowForgot(true)}>
            {strings.unlock.forgot}
          </button>
        </div>
      </div>

      {showForgot ? (
        <Sheet onScrim={() => setShowForgot(false)}>
          <h2 className="sheet__title">{strings.unlock.forgotHeading}</h2>
          <p className="sheet__body">{strings.unlock.forgotBody}</p>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              onClick={() => {
                setShowForgot(false);
                props.onRestore();
              }}
            >
              {strings.unlock.forgotRestore}
            </button>
            <button className="btn btn--text btn--block" onClick={() => setShowForgot(false)}>
              {strings.unlock.forgotRetry}
            </button>
          </div>
        </Sheet>
      ) : null}
    </Chrome>
  );
}
