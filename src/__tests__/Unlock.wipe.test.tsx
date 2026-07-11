/**
 * Unlock.wipe.test.tsx — the locked-out last resort (owner request,
 * 2026-07-10): the forgot-password sheet offers "remove and start fresh",
 * gated by the heaviest consent flow in the app. Pins:
 *  - the wipe is reachable ONLY through forgot → wipe sheet → checkbox →
 *    danger button (disabled until checked);
 *  - the consent checkbox resets every time the sheet opens (never remembered);
 *  - cancel paths never call onWipe; the confirm calls it exactly once.
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

async function renderUnlock(onWipe: () => void): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Unlock
        network="mainnet"
        passkeyEnabled={false}
        passkeySupported={false}
        onUnlockPassword={async () => false}
        onUnlockPasskey={async () => false}
        onRestore={() => {}}
        onWipe={onWipe}
      />,
    );
  });
}

function btn(text: string): HTMLButtonElement | null {
  for (const b of container.querySelectorAll('button')) {
    if (b.textContent?.trim() === text) return b as HTMLButtonElement;
  }
  return null;
}

async function click(text: string): Promise<void> {
  const b = btn(text);
  expect(b, `button "${text}"`).not.toBeNull();
  await act(async () => b!.click());
}

/** The consent CheckRow renders as a button whose text is "✓" + label. */
async function clickCheckbox(): Promise<void> {
  const b = container.querySelector<HTMLButtonElement>('.check-row');
  expect(b, 'consent checkbox').not.toBeNull();
  await act(async () => b!.click());
}

async function openWipeSheet(): Promise<void> {
  await click(strings.unlock.forgot);
  await click(strings.unlock.forgotWipe);
}

describe('Unlock — the wipe-and-start-fresh last resort', () => {
  it('is reachable only via the forgot sheet, and the danger button starts disabled', async () => {
    await renderUnlock(vi.fn());
    // Not on the base screen.
    expect(btn(strings.unlock.wipeConfirm)).toBeNull();
    await openWipeSheet();
    expect(container.textContent).toContain(strings.unlock.wipeHeading);
    expect(btn(strings.unlock.wipeConfirm)!.disabled).toBe(true);
  });

  it('checkbox gates the confirm; confirming calls onWipe exactly once', async () => {
    const onWipe = vi.fn();
    await renderUnlock(onWipe);
    await openWipeSheet();

    // A disabled-button click is a no-op.
    await click(strings.unlock.wipeConfirm);
    expect(onWipe).not.toHaveBeenCalled();

    await clickCheckbox();
    expect(btn(strings.unlock.wipeConfirm)!.disabled).toBe(false);
    await click(strings.unlock.wipeConfirm);
    expect(onWipe).toHaveBeenCalledTimes(1);
  });

  it('cancel never wipes, and consent is forgotten between opens', async () => {
    const onWipe = vi.fn();
    await renderUnlock(onWipe);
    await openWipeSheet();

    // Check the box, then cancel instead of confirming.
    await clickCheckbox();
    await click(strings.common.cancel);
    expect(onWipe).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(strings.unlock.wipeHeading);

    // Re-open: the checkbox must be fresh (danger button disabled again).
    await openWipeSheet();
    expect(btn(strings.unlock.wipeConfirm)!.disabled).toBe(true);
    expect(onWipe).not.toHaveBeenCalled();
  });
});
