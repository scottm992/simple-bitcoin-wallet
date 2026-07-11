/**
 * Unlock.faceid.test.tsx — Bug B2: with Face ID unlock enabled, the Unlock
 * screen auto-triggers exactly ONE Face ID attempt on mount (never a loop),
 * keeps the password field visible below, and falls back to the password
 * silently when the attempt fails/cancels — no scary error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Unlock } from '../screens/Unlock';
import { strings } from '../strings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: {
  passkeyEnabled: boolean;
  passkeySupported: boolean;
  onUnlockPasskey: () => Promise<boolean>;
}): Promise<void> {
  return act(async () => {
    root = createRoot(container);
    root.render(
      <Unlock
        network="mainnet"
        passkeyEnabled={props.passkeyEnabled}
        passkeySupported={props.passkeySupported}
        onUnlockPassword={async () => false}
        onUnlockPasskey={props.onUnlockPasskey}
        onRestore={() => {}}
        onWipe={() => {}}
      />,
    );
  });
}

describe('Unlock — passkey auto-trigger (Bug B2)', () => {
  it('triggers exactly one attempt on mount and falls back to password silently on failure', async () => {
    const onUnlockPasskey = vi.fn(async () => false); // user cancelled / failed
    await render({ passkeyEnabled: true, passkeySupported: true, onUnlockPasskey });

    // Exactly one auto-attempt — not a loop.
    expect(onUnlockPasskey).toHaveBeenCalledTimes(1);

    // Re-renders must not re-trigger it.
    await act(async () => {
      root.render(
        <Unlock
          network="mainnet"
          passkeyEnabled
          passkeySupported
          onUnlockPassword={async () => false}
          onUnlockPasskey={onUnlockPasskey}
          onRestore={() => {}}
          onWipe={() => {}}
        />,
      );
    });
    expect(onUnlockPasskey).toHaveBeenCalledTimes(1);

    // The password path is right there: field visible + Unlock button.
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).toContain(strings.unlock.unlock);

    // Silent fallback: no error copy anywhere after the failed attempt.
    expect(container.textContent).not.toContain(strings.unlock.passkeyFailed);
    expect(container.textContent).not.toContain(strings.unlock.wrongPassword);

    // A manual retry stays available, labelled in the app's own words.
    const retry = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === strings.unlock.usePasskey,
    );
    expect(retry).not.toBeUndefined();
    // "passkey" is now the deliberate user-facing word (it names the thing the
    // device actually creates). What must never leak is implementation jargon,
    // or a platform-specific biometric name — this is a web app and the unlock
    // gesture may be a face, a fingerprint, or a PIN.
    expect(container.textContent).not.toMatch(/webauthn|\bPRF\b|iCloud|Face ID|Touch ID/i);
  });

  it('does not auto-trigger when the passkey is not enabled or not supported', async () => {
    const onUnlockPasskey = vi.fn(async () => true);
    await render({ passkeyEnabled: false, passkeySupported: true, onUnlockPasskey });
    expect(onUnlockPasskey).not.toHaveBeenCalled();
    act(() => root.unmount());

    await render({ passkeyEnabled: true, passkeySupported: false, onUnlockPasskey });
    expect(onUnlockPasskey).not.toHaveBeenCalled();
    // Password path always present.
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });
});
