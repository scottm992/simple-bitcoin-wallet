import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { strings } from '../strings';
import { Chrome } from '../components/Chrome';
import { bip39Words } from '../display';
import type { Network } from '../lib';

/** Fisher–Yates shuffle (non-mutating). */
function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Picks `count` distinct positions (1-based) from 1..12. */
function pickPositions(count: number): number[] {
  const all = Array.from({ length: 12 }, (_, i) => i + 1);
  return shuffle(all).slice(0, count).sort((a, b) => a - b);
}

/**
 * Confirm-your-phrase: ask for 3 requested word positions in order. The chip
 * grid mixes the correct answer with believable decoys (from the user's own
 * phrase + the BIP39 list). Unlimited tries; wrong taps shake + explain.
 */
export function Confirm(props: {
  network: Network;
  words: readonly string[];
  onDone: () => void;
  onShowWords: () => void;
  onBack: () => void;
}): JSX.Element {
  const positions = useMemo(() => pickPositions(3), []);
  const [step, setStep] = useState(0); // 0..2
  const [wrongChip, setWrongChip] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const position = positions[step] ?? 1;
  const correctWord = props.words[position - 1] ?? '';

  // Build a stable shuffled chip set per step: correct + decoys.
  const chips = useMemo(() => {
    const own = props.words.filter((w) => w !== correctWord);
    const decoysFromOwn = shuffle(own).slice(0, 3);
    const externalPool = bip39Words.filter(
      (w) => !props.words.includes(w) && w !== correctWord,
    );
    const decoysExternal = shuffle(externalPool).slice(0, 4);
    const set = new Set<string>([correctWord, ...decoysFromOwn, ...decoysExternal]);
    return shuffle([...set]);
    // Rebuild when the target word changes (i.e. each step).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctWord]);

  function tap(word: string): void {
    if (word === correctWord) {
      setWrongChip(null);
      if (step === 2) {
        setSuccess(true);
        // brief confirmation, then advance
        setTimeout(props.onDone, 700);
      } else {
        setStep((s) => s + 1);
      }
    } else {
      setWrongChip(word);
    }
  }

  return (
    <Chrome network={props.network} onBack={props.onBack}>
      <div className="screen-body">
        <h1 className="h1">{strings.confirm.heading}</h1>
        <p className="sub">{strings.confirm.body}</p>

        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="h2">{strings.confirm.prompt(position)}</div>
          <div className="progress-dots" aria-label={strings.confirm.step(step + 1)}>
            <span className={step >= 0 ? 'on' : ''} />
            <span className={step >= 1 ? 'on' : ''} />
            <span className={step >= 2 ? 'on' : ''} />
          </div>
          <div className="small" style={{ marginTop: 'var(--sp-1)' }}>
            {strings.confirm.step(step + 1)}
          </div>
        </div>

        <div className="chip-grid">
          {chips.map((w) => (
            <button
              key={w}
              className={`chip ${wrongChip === w ? 'chip--wrong' : ''}`}
              onClick={() => tap(w)}
              onAnimationEnd={() => setWrongChip(null)}
            >
              {w}
            </button>
          ))}
        </div>

        {wrongChip !== null ? (
          <p className="error-text" role="alert">
            {strings.confirm.wrong(position)}
          </p>
        ) : null}

        {success ? (
          <p className="hint hint--ok" role="status" style={{ marginTop: 'var(--sp-4)' }}>
            {strings.confirm.success}
          </p>
        ) : null}

        <div className="bottom-actions">
          <button className="btn btn--text btn--block" onClick={props.onShowWords}>
            {strings.confirm.showAgain}
          </button>
        </div>
      </div>
    </Chrome>
  );
}
