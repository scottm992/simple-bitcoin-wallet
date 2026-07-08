import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { PasswordInput, Sheet } from '../components/ui';
import type { Network } from '../lib';

/**
 * Unlock (returning user). Password field, plus a Face ID button when passkey
 * unlock is enabled. The password lives only in local state and is handed to the
 * unlock callback (which calls vault.unlockVault). On success the parent stores
 * the mnemonic in session.ts; this screen never sees it.
 */
export function Unlock(props: {
  network: Network;
  passkeyEnabled: boolean;
  onUnlockPassword: (password: string) => Promise<boolean>;
  onUnlockPasskey: () => Promise<boolean>;
  onRestore: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [usePasswordFallback, setUsePasswordFallback] = useState(!props.passkeyEnabled);

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
      setError(strings.unlock.faceIdFailed);
      setUsePasswordFallback(true);
      setBusy(false);
    }
  }

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
          {props.passkeyEnabled && !usePasswordFallback ? (
            <>
              <button
                className="btn btn--primary btn--block"
                onClick={tryPasskey}
                disabled={busy}
              >
                {strings.unlock.useFaceId}
              </button>
              <button
                className="btn btn--text btn--block"
                onClick={() => setUsePasswordFallback(true)}
              >
                {strings.unlock.usePassword}
              </button>
            </>
          ) : (
            <>
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
                  autoFocus
                  onEnter={tryPassword}
                />
              </div>
              {error ? <p className="error-text">{error}</p> : null}
            </>
          )}
        </div>

        <div className="bottom-actions">
          {usePasswordFallback || !props.passkeyEnabled ? (
            <button
              className="btn btn--primary btn--block"
              onClick={tryPassword}
              disabled={busy || password.length === 0}
            >
              {strings.unlock.unlock}
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
