/**
 * ui.tsx — small reusable presentational components used across screens.
 *
 * None of these ever receive or render a secret. The seed words rendered by the
 * confirm/reveal screens are passed transient, screen-local props that are
 * cleared on navigation (see those screens).
 */
import type { JSX, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { strings } from '../strings';
import { chunkAddress } from '../lib';

/** A top bar with an optional back button, title, and right-side slot. */
export function TopBar(props: {
  onBack?: (() => void) | undefined;
  title?: string | undefined;
  brand?: boolean | undefined;
  right?: ReactNode;
}): JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar__slot">
        {props.onBack ? (
          <button className="topbar__back" onClick={props.onBack} aria-label={strings.common.back}>
            ‹
          </button>
        ) : null}
      </div>
      {props.brand ? (
        <span className="topbar__brand">{strings.app.wordmark}</span>
      ) : (
        <span className="topbar__title">{props.title ?? ''}</span>
      )}
      <div className="topbar__slot topbar__slot--right">{props.right}</div>
    </div>
  );
}

/** The persistent Practice-mode banner (only rendered in Practice mode). */
export function PracticeBanner(): JSX.Element {
  return (
    <div className="practice-banner" role="status">
      <strong>Practice mode — these coins are worthless.</strong> You're testing safely. Nothing
      here is real money.
    </div>
  );
}

/** A bottom sheet / modal with a scrim. `onScrim` dismisses if provided. */
export function Sheet(props: { onScrim?: () => void; children: ReactNode }): JSX.Element {
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget && props.onScrim) props.onScrim();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true">
        {props.children}
      </div>
    </div>
  );
}

/** A transient toast that auto-dismisses. */
export function Toast(props: { message: string; onDone: () => void }): JSX.Element {
  useEffect(() => {
    const t = setTimeout(props.onDone, 2500);
    return () => clearTimeout(t);
  }, [props]);
  return (
    <div className="toast" role="status">
      {props.message}
    </div>
  );
}

/** A status pill: Confirmed / Waiting to confirm / Failed. */
export function StatusPill(props: { status: 'confirmed' | 'waiting' | 'failed' }): JSX.Element {
  const map = {
    confirmed: { cls: 'row__status--ok', text: strings.activity.confirmed },
    waiting: { cls: 'row__status--wait', text: strings.activity.waiting },
    failed: { cls: 'row__status--fail', text: strings.activity.failed },
  } as const;
  const it = map[props.status];
  return <span className={`status-pill ${it.cls}`}>{it.text}</span>;
}

/**
 * An address rendered in 4-character monospace groups, tappable to copy. The
 * address text is always the accessible source of truth.
 */
export function AddressChunk(props: { address: string; onCopy?: () => void }): JSX.Element {
  const chunked = chunkAddress(props.address);
  return (
    <button
      type="button"
      className="addr addr--button"
      onClick={props.onCopy}
      aria-label={`Address ${props.address}. Tap to copy.`}
    >
      {chunked}
    </button>
  );
}

/** Copies text to the clipboard, resolving true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A checkbox row used on Review + delete confirmation. */
export function CheckRow(props: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="check-row"
      onClick={props.onToggle}
      aria-pressed={props.checked}
    >
      <span className={`check-box ${props.checked ? 'check-box--on' : ''}`} aria-hidden="true">
        ✓
      </span>
      {props.label}
    </button>
  );
}

/** A password input with a show/hide eye toggle. Never autofilled beyond the given mode. */
export function PasswordInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete: 'new-password' | 'current-password';
  invalid?: boolean;
  autoFocus?: boolean;
  onEnter?: () => void;
  ariaLabel: string;
}): JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <div className={`input-wrap ${props.invalid ? 'input-wrap--error' : ''}`}>
      <input
        className="input"
        type={show ? 'text' : 'password'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder ?? ''}
        autoComplete={props.autoComplete}
        aria-label={props.ariaLabel}
        autoFocus={props.autoFocus ?? false}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && props.onEnter) props.onEnter();
        }}
      />
      <button
        type="button"
        className="input-eye"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
