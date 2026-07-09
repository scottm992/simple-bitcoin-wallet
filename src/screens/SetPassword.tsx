import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { PasswordInput } from '../components/ui';
import { assessPassword, type PasswordStrength } from '../password';
import type { Network } from '../lib';

/** Maps a strength band to its plain-English label + meter class. */
function bandLabel(strength: PasswordStrength): string {
  switch (strength) {
    case 'too-short':
      return strings.password.strengthTooShort;
    case 'weak':
      return strings.password.strengthWeak;
    case 'fair':
      return strings.password.strengthFair;
    case 'good':
      return strings.password.strengthGood;
    case 'strong':
      return strings.password.strengthStrong;
  }
}

/**
 * Set-a-password for this device. Optionally enables Face ID (passkey) unlock.
 * The password value lives only in this screen's local state and is passed to
 * the submit callback, which encrypts it via vault.ts. It is never lifted into
 * app state or logged.
 */
export function SetPassword(props: {
  network: Network;
  passkeySupported: boolean;
  onSubmit: (password: string, enableFaceId: boolean) => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [faceId, setFaceId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assessment = assessPassword(password);
  const matches = password === confirm && confirm.length > 0;
  const canSubmit = assessment.acceptable && matches && !busy;

  const confirmError = confirm.length > 0 && password !== confirm;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(password, faceId);
    } catch {
      setError(strings.errors.generic);
      setBusy(false);
    }
  }

  return (
    <Chrome network={props.network} onBack={props.onBack}>
      <div className="screen-body">
        <h1 className="h1">{strings.password.heading}</h1>
        <p className="sub">{strings.password.body}</p>

        <div className="field-group">
          <label className="label" htmlFor="pw">
            {strings.password.passwordLabel}
          </label>
          <div id="pw">
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              ariaLabel={strings.password.passwordLabel}
            />
          </div>
          {password.length > 0 ? (
            <div
              className={`pw-meter pw-meter--${assessment.strength}`}
              role="status"
              aria-label={strings.password.strengthLabel(bandLabel(assessment.strength))}
            >
              <div className="pw-meter__bar" aria-hidden="true">
                <span className={`pw-meter__fill pw-meter__fill--${assessment.strength}`} />
              </div>
              <div className={`hint ${assessment.acceptable ? 'hint--ok' : ''}`}>
                {assessment.hint}
              </div>
            </div>
          ) : (
            <div className="hint">{assessment.hint}</div>
          )}
        </div>

        <div className="field-group">
          <label className="label" htmlFor="pw2">
            {strings.password.confirmLabel}
          </label>
          <div id="pw2">
            <PasswordInput
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              invalid={confirmError}
              ariaLabel={strings.password.confirmLabel}
              onEnter={submit}
            />
          </div>
          {confirmError ? <p className="error-text">{strings.password.mismatch}</p> : null}
        </div>

        {props.passkeySupported ? (
          <div className="toggle-row">
            <div className="toggle-row__text">
              <div className="body" style={{ fontWeight: 600 }}>
                {strings.password.faceIdToggle}
              </div>
              <div className="small">{strings.password.faceIdSubtext}</div>
            </div>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={faceId}
              aria-label={strings.password.faceIdToggle}
              onClick={() => setFaceId((f) => !f)}
            >
              <span className="toggle__knob" />
            </button>
          </div>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}

        <div className="bottom-actions">
          <button className="btn btn--primary btn--block" onClick={submit} disabled={!canSubmit}>
            {busy ? '…' : strings.password.submit}
          </button>
          <p className="small" style={{ textAlign: 'center' }}>
            {strings.password.clarify}
          </p>
        </div>
      </div>
    </Chrome>
  );
}
