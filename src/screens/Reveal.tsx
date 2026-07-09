import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { strings } from '../strings';
import { Sheet, Toast } from '../components/ui';
import { Chrome } from '../components/Chrome';
import type { Network } from '../lib';

/** How long a copied recovery phrase is allowed to linger on the clipboard. */
const CLIPBOARD_CLEAR_MS = 30_000;

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

  // Track a scheduled clipboard-clear so we can cancel it on unmount and clear
  // immediately when leaving the screen (F5: don't let the seed linger).
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedPhraseRef = useRef<string | null>(null);

  /**
   * Overwrites the clipboard with a harmless string, but only if it still holds
   * the phrase we put there (so we never clobber something the user copied
   * afterwards). Best-effort: clipboard reads can be denied, in which case we
   * overwrite unconditionally rather than leave the seed sitting there.
   */
  async function clearClipboardIfSeed(): Promise<void> {
    const phrase = copiedPhraseRef.current;
    copiedPhraseRef.current = null;
    if (phrase === null) return;
    try {
      let current: string | null = null;
      try {
        current = (await navigator.clipboard?.readText()) ?? null;
      } catch {
        current = null; // read denied — fall through and overwrite anyway
      }
      if (current === null || current === phrase) {
        await navigator.clipboard?.writeText('');
      }
    } catch {
      /* clipboard unavailable; nothing more we can do */
    }
  }

  // On unmount (navigating away), cancel the pending timer and clear now.
  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      void clearClipboardIfSeed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleBack(): void {
    if (isCreate) setShowLeave(true);
    else props.onExit();
  }

  async function copyWords(): Promise<void> {
    const phrase = props.words.join(' ');
    try {
      await navigator.clipboard?.writeText(phrase);
      copiedPhraseRef.current = phrase;
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        void clearClipboardIfSeed();
      }, CLIPBOARD_CLEAR_MS);
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
