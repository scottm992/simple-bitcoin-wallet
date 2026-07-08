import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { bip39Words, isBip39Word } from '../display';
import { validateMnemonic, normalizeMnemonic } from '../lib';
import type { Network } from '../lib';

const EMPTY12 = Array.from({ length: 12 }, () => '');

/**
 * Restore-from-phrase: 12 numbered inputs with BIP39 autocomplete + paste-all.
 * The typed words live only in this screen's local state; on a valid checksum we
 * hand the assembled phrase to the parent, which immediately routes to
 * SetPassword and encrypts it. We never store the phrase in app state.
 */
export function Restore(props: {
  network: Network;
  onValidPhrase: (phrase: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [wordsList, setWordsList] = useState<string[]>(EMPTY12);
  const [focused, setFocused] = useState<number | null>(null);
  const [checksumError, setChecksumError] = useState(false);

  function setWordAt(i: number, value: string): void {
    setChecksumError(false);
    setWordsList((prev) => {
      const next = [...prev];
      next[i] = value.trim().toLowerCase();
      return next;
    });
  }

  function pasteAll(text: string): void {
    const parts = normalizeMnemonic(text).split(' ').filter(Boolean).slice(0, 12);
    const next = [...EMPTY12];
    for (let i = 0; i < parts.length; i++) next[i] = parts[i] ?? '';
    setChecksumError(false);
    setWordsList(next);
  }

  async function handlePasteAll(): Promise<void> {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) pasteAll(text);
    } catch {
      /* clipboard read blocked; user can type instead */
    }
  }

  const allFilled = wordsList.every((w) => w.length > 0);
  const allValid = wordsList.every((w) => isBip39Word(w));
  const canSubmit = allFilled && allValid;

  function submit(): void {
    if (!canSubmit) return;
    const phrase = wordsList.join(' ');
    if (validateMnemonic(phrase)) {
      props.onValidPhrase(normalizeMnemonic(phrase));
    } else {
      setChecksumError(true);
    }
  }

  // Autocomplete suggestions for the focused field.
  const suggestions =
    focused !== null && wordsList[focused] && !isBip39Word(wordsList[focused] ?? '')
      ? bip39Words.filter((w) => w.startsWith(wordsList[focused] ?? '')).slice(0, 5)
      : [];

  return (
    <Chrome network={props.network} onBack={props.onBack}>
      <div className="screen-body">
        <h1 className="h1">{strings.restore.heading}</h1>
        <p className="sub">{strings.restore.body}</p>

        <div className="restore-grid">
          {wordsList.map((w, i) => {
            const invalid = w.length > 0 && !isBip39Word(w);
            return (
              <div className="restore-cell" key={i}>
                <span className="restore-cell__n">{i + 1}</span>
                <input
                  className={`restore-input ${invalid ? 'restore-input--error' : ''}`}
                  value={w}
                  onChange={(e) => setWordAt(i, e.target.value)}
                  onFocus={() => setFocused(i)}
                  onBlur={() => setTimeout(() => setFocused((f) => (f === i ? null : f)), 120)}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData('text');
                    if (text.trim().split(/\s+/).length > 1) {
                      e.preventDefault();
                      pasteAll(text);
                    }
                  }}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={`Word ${i + 1}`}
                  inputMode="text"
                />
                {focused === i && suggestions.length > 0 ? (
                  <div className="autocomplete">
                    {suggestions.map((s) => (
                      <button key={s} onMouseDown={() => setWordAt(i, s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
                {invalid ? <p className="error-text">{strings.restore.invalidWord}</p> : null}
              </div>
            );
          })}
        </div>

        {checksumError ? (
          <p className="error-text" role="alert" style={{ marginTop: 'var(--sp-4)' }}>
            {strings.restore.checksumFail}
          </p>
        ) : null}

        <div className="bottom-actions">
          <button className="btn btn--secondary btn--block" onClick={handlePasteAll}>
            {strings.restore.pasteAll}
          </button>
          <button className="btn btn--primary btn--block" onClick={submit} disabled={!canSubmit}>
            {strings.restore.restore}
          </button>
          {!canSubmit ? (
            <p className="small" style={{ textAlign: 'center' }}>
              {strings.restore.emptyHelper}
            </p>
          ) : null}
        </div>
      </div>
    </Chrome>
  );
}
