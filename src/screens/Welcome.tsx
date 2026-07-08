import type { JSX } from 'react';
import { useState } from 'react';
import { strings } from '../strings';
import { Sheet } from '../components/ui';

export function Welcome(props: { onCreate: () => void; onRestore: () => void }): JSX.Element {
  const [showSafety, setShowSafety] = useState(false);
  return (
    <div className="screen-body">
      <div className="center-col">
        <div className="logo-mark" aria-hidden="true">
          ₿
        </div>
        <div>
          <h1 className="h1">{strings.welcome.heading}</h1>
          <p className="sub">{strings.welcome.body}</p>
        </div>
      </div>
      <div className="bottom-actions">
        <button className="btn btn--primary btn--block" onClick={props.onCreate}>
          {strings.welcome.create}
        </button>
        <button className="btn btn--text btn--block" onClick={props.onRestore}>
          {strings.welcome.restore}
        </button>
        <button
          className="btn btn--text btn--block"
          style={{ fontSize: 'var(--fs-small)' }}
          onClick={() => setShowSafety(true)}
        >
          {strings.welcome.safetyLink}
        </button>
      </div>

      {showSafety ? (
        <Sheet onScrim={() => setShowSafety(false)}>
          <h2 className="sheet__title">{strings.explainer.heading}</h2>
          <p className="sheet__body">{strings.explainer.body}</p>
          <div className="sheet__actions">
            <button className="btn btn--primary btn--block" onClick={() => setShowSafety(false)}>
              {strings.explainer.dismiss}
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
