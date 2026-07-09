import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { CheckRow, PasswordInput, Sheet } from '../components/ui';
import type { Network } from '../lib';

const APP_VERSION = '1.0.0';

type SettingsSheet = 'none' | 'reauth' | 'switch' | 'delete' | 'safety' | 'faceid';

/**
 * Settings: lock, show phrase (password re-entry), Face ID toggle, network
 * switch (with confirm), delete wallet (checkbox-gated). All sensitive actions
 * route through the parent callbacks; no secrets live here. The re-auth password
 * lives only in this screen's local state.
 */
export function Settings(props: {
  network: Network;
  passkeySupported: boolean;
  passkeyEnabled: boolean;
  onBack: () => void;
  onLockNow: () => void;
  /** Verify password; on success the parent reveals the phrase screen. */
  onShowPhrase: (password: string) => Promise<boolean>;
  onToggleFaceId: (enable: boolean) => Promise<void>;
  onSwitchNetwork: (to: Network) => void;
  onDelete: () => void;
  onExplainer: () => void;
}): JSX.Element {
  const [sheet, setSheet] = useState<SettingsSheet>('none');
  const [reauthPw, setReauthPw] = useState('');
  const [reauthErr, setReauthErr] = useState(false);
  const [reauthBusy, setReauthBusy] = useState(false);
  const [deleteChecked, setDeleteChecked] = useState(false);
  const [faceIdBusy, setFaceIdBusy] = useState(false);
  const [faceIdErr, setFaceIdErr] = useState<string | null>(null);

  const targetNetwork: Network = props.network === 'mainnet' ? 'testnet' : 'mainnet';

  function closeSheet(): void {
    setSheet('none');
    setReauthPw('');
    setReauthErr(false);
    setDeleteChecked(false);
  }

  async function submitReauth(): Promise<void> {
    if (reauthPw.length === 0 || reauthBusy) return;
    setReauthBusy(true);
    setReauthErr(false);
    const ok = await props.onShowPhrase(reauthPw);
    setReauthBusy(false);
    if (ok) closeSheet();
    else setReauthErr(true);
  }

  async function toggleFaceId(): Promise<void> {
    setFaceIdBusy(true);
    setFaceIdErr(null);
    try {
      await props.onToggleFaceId(!props.passkeyEnabled);
    } catch {
      setFaceIdErr(strings.unlock.faceIdFailed);
    } finally {
      setFaceIdBusy(false);
    }
  }

  return (
    <Chrome network={props.network} onBack={props.onBack} title={strings.settings.title}>
      <div className="screen-body">
        <h1 className="h1">{strings.settings.heading}</h1>

        {/* Security */}
        <div className="settings-group">
          <div className="settings-group__label">{strings.settings.securityGroup}</div>
          <button className="settings-row" onClick={props.onLockNow}>
            {strings.settings.lockNow}
            <span className="settings-row__chevron">›</span>
          </button>
          <button className="settings-row" onClick={() => setSheet('reauth')}>
            {strings.settings.showPhrase}
            <span className="settings-row__chevron">›</span>
          </button>
          {props.passkeySupported ? (
            <div className="settings-row" style={{ cursor: 'default' }}>
              <span>
                {strings.password.faceIdToggle}
                {faceIdErr ? <div className="error-text">{faceIdErr}</div> : null}
              </span>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={props.passkeyEnabled}
                aria-label={strings.password.faceIdToggle}
                onClick={() => {
                  // Bug B: explain the system "passkey" sheet in plain English
                  // BEFORE triggering it. Disabling needs no explainer.
                  if (props.passkeyEnabled) void toggleFaceId();
                  else setSheet('faceid');
                }}
                disabled={faceIdBusy}
              >
                <span className="toggle__knob" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Network */}
        <div className="settings-group">
          <div className="settings-group__label">{strings.settings.networkGroup}</div>
          <div className="settings-row" style={{ cursor: 'default' }}>
            <span>
              {strings.settings.practiceMode}
              <div className="small">{strings.settings.practiceModeSub}</div>
            </span>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={props.network === 'testnet'}
              aria-label={strings.settings.practiceMode}
              onClick={() => setSheet('switch')}
            >
              <span className="toggle__knob" />
            </button>
          </div>
        </div>

        {/* This device */}
        <div className="settings-group">
          <div className="settings-group__label">{strings.settings.deviceGroup}</div>
          <button
            className="settings-row settings-row--danger"
            onClick={() => setSheet('delete')}
          >
            {strings.settings.removeWallet}
            <span className="settings-row__chevron">›</span>
          </button>
        </div>

        {/* About */}
        <div className="settings-group">
          <div className="settings-group__label">{strings.settings.aboutGroup}</div>
          <button className="settings-row" onClick={props.onExplainer}>
            {strings.settings.aboutSafety}
            <span className="settings-row__chevron">›</span>
          </button>
          <div className="small" style={{ padding: 'var(--sp-3) 0' }}>
            {strings.settings.version(APP_VERSION)}
          </div>
        </div>
      </div>

      {/* Re-auth sheet */}
      {sheet === 'reauth' ? (
        <Sheet onScrim={closeSheet}>
          <h2 className="sheet__title">{strings.settings.reauthHeading}</h2>
          <p className="sheet__body">{strings.settings.reauthBody}</p>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <PasswordInput
              value={reauthPw}
              onChange={setReauthPw}
              autoComplete="current-password"
              ariaLabel={strings.unlock.passwordLabel}
              invalid={reauthErr}
              autoFocus
              onEnter={submitReauth}
            />
            {reauthErr ? <p className="error-text">{strings.unlock.wrongPassword}</p> : null}
          </div>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              onClick={submitReauth}
              disabled={reauthPw.length === 0 || reauthBusy}
            >
              {strings.settings.reauthShow}
            </button>
            <button className="btn btn--text btn--block" onClick={closeSheet}>
              {strings.common.cancel}
            </button>
          </div>
        </Sheet>
      ) : null}

      {/* Face ID explainer sheet (Bug B): shown before the system passkey sheet. */}
      {sheet === 'faceid' ? (
        <Sheet onScrim={closeSheet}>
          <h2 className="sheet__title">{strings.faceId.explainHeading}</h2>
          <p className="sheet__body">{strings.faceId.explainBody}</p>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              onClick={() => {
                closeSheet();
                void toggleFaceId();
              }}
            >
              {strings.faceId.explainContinue}
            </button>
            <button className="btn btn--text btn--block" onClick={closeSheet}>
              {strings.faceId.explainNotNow}
            </button>
          </div>
        </Sheet>
      ) : null}

      {/* Network-switch sheet */}
      {sheet === 'switch' ? (
        <Sheet onScrim={closeSheet}>
          <h2 className="sheet__title">
            {targetNetwork === 'testnet'
              ? strings.settings.switchToPracticeHeading
              : strings.settings.switchToLiveHeading}
          </h2>
          <p className="sheet__body">
            {targetNetwork === 'testnet'
              ? strings.settings.switchToPracticeBody
              : strings.settings.switchToLiveBody}
          </p>
          <div className="sheet__actions">
            <button
              className="btn btn--primary btn--block"
              onClick={() => {
                closeSheet();
                props.onSwitchNetwork(targetNetwork);
              }}
            >
              {strings.settings.switchConfirm}
            </button>
            <button className="btn btn--text btn--block" onClick={closeSheet}>
              {strings.common.cancel}
            </button>
          </div>
        </Sheet>
      ) : null}

      {/* Delete sheet */}
      {sheet === 'delete' ? (
        <Sheet onScrim={closeSheet}>
          <h2 className="sheet__title">{strings.settings.deleteHeading}</h2>
          <p className="sheet__body">{strings.settings.deleteBody}</p>
          <CheckRow
            checked={deleteChecked}
            onToggle={() => setDeleteChecked((c) => !c)}
            label={strings.settings.deleteCheckbox}
          />
          <div className="sheet__actions">
            <button
              className="btn btn--danger btn--block"
              onClick={() => {
                closeSheet();
                props.onDelete();
              }}
              disabled={!deleteChecked}
            >
              {strings.settings.deleteConfirm}
            </button>
            <button className="btn btn--text btn--block" onClick={closeSheet}>
              {strings.common.cancel}
            </button>
          </div>
        </Sheet>
      ) : null}
    </Chrome>
  );
}
