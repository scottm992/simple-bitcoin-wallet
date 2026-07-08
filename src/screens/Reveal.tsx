import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Sheet, Toast } from '../components/ui';
import { Chrome } from '../components/Chrome';
import type { Network } from '../lib';

/**
 * The Recovery Phrase reveal. Words start BLURRED behind a shield and are only
 * rendered after an explicit tap. `words` is a transient prop owned by the
 * parent's local state and cleared on navigation, so nothing lingers in the DOM
 * after leaving. We do NOT offer copy for the seed from the Settings context.
 */
export function Reveal(props: {
  network: Network;
  words: readonly string[];
  /** 'create' shows Copy + "I've written them down"; 'settings' shows only Done. */
  mode: 'create' | 'settings';
  onContinue: () => void;
  onExit: () => void;
}): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const isCreate = props.mode === 'create';

  function handleBack(): void {
    if (isCreate) setShowLeave(true);
    else props.onExit();
  }

  async function copyWords(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(props.words.join(' '));
    } catch {
      /* ignore; still show the toast so the user isn't stuck */
    }
    setToast(strings.reveal.copyToast);
  }

  return (
    <Chrome network={props.network} onBack={handleBack}>
      <div className="screen-body">
        <h1 className="h1">{strings.reveal.heading}</h1>
        <p className="sub">{strings.reveal.body}</p>

        <div className="reveal-card">
          <div className="words" aria-hidden={!revealed}>
            {props.words.map((w, i) => (
              <div className="word" key={i}>
                <span className="word__n">{i + 1}</span>
                {revealed ? w : '•••••'}
              </div>
            ))}
          </div>
          {!revealed ? (
            <button
              className="reveal-card__shield"
              onClick={() => setRevealed(true)}
              aria-label={strings.reveal.revealButton}
            >
              <span className="reveal-card__shield-btn">{strings.reveal.revealButton}</span>
              <span className="small">{strings.reveal.revealNote}</span>
            </button>
          ) : null}
        </div>

        {revealed ? (
          <div className="callout">
            <div className="callout__title">{isCreate ? strings.reveal.calloutTitle : ''}</div>
            <div className="callout__body">
              {isCreate ? strings.reveal.calloutBody : strings.reveal.settingsNote}
            </div>
          </div>
        ) : null}

        <div className="bottom-actions">
          {isCreate ? (
            <>
              <button
                className="btn btn--secondary btn--block"
                onClick={copyWords}
                disabled={!revealed}
              >
                {strings.reveal.copyWords}
              </button>
              <button
                className="btn btn--primary btn--block"
                onClick={props.onContinue}
                disabled={!revealed}
              >
                {strings.reveal.continue}
              </button>
            </>
          ) : (
            <button className="btn btn--primary btn--block" onClick={props.onExit}>
              {strings.common.done}
            </button>
          )}
        </div>
      </div>

      {showLeave ? (
        <Sheet onScrim={() => setShowLeave(false)}>
          <h2 className="sheet__title">{strings.reveal.leaveHeading}</h2>
          <p className="sheet__body">{strings.reveal.leaveBody}</p>
          <div className="sheet__actions">
            <button className="btn btn--primary btn--block" onClick={() => setShowLeave(false)}>
              {strings.reveal.keepSetupUp}
            </button>
            <button
              className="btn btn--text btn--block"
              onClick={() => {
                setShowLeave(false);
                props.onExit();
              }}
            >
              {strings.reveal.leaveAnyway}
            </button>
          </div>
        </Sheet>
      ) : null}

      {toast ? <Toast message={toast} onDone={() => setToast(null)} /> : null}
    </Chrome>
  );
}
